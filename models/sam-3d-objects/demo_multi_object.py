import os
import uuid
import gc
import imageio
import numpy as np
from IPython.display import Image as ImageDisplay

import torch
from notebook.inference import (
    Inference,
    ready_gaussian_for_video_rendering,
    load_image,
    load_masks,
    display_image,
    make_scene,
    render_video,
    interactive_visualizer,
)


def log_vram(tag: str):
    """Log CUDA memory for debugging OOMs."""
    if not torch.cuda.is_available():
        print(f"[VRAM][{tag}] CUDA not available")
        return
    alloc = torch.cuda.memory_allocated() / (1024**2)
    reserved = torch.cuda.memory_reserved() / (1024**2)
    max_alloc = torch.cuda.max_memory_allocated() / (1024**2)
    print(f"[VRAM][{tag}] alloc={alloc:.0f}MB reserved={reserved:.0f}MB max_alloc={max_alloc:.0f}MB")


def cleanup_cuda():
    # Aggressively free unused CUDA memory to avoid fragmentation between objects.
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def gaussian_to_device(gs, device: str):
    """
    Move GaussianSplat internals to a target device.
    Needed to store per-object results on CPU and move back to GPU later.
    """
    if gs is None:
        return gs
    gs.device = device
    if hasattr(gs, "aabb") and isinstance(gs.aabb, torch.Tensor):
        gs.aabb = gs.aabb.to(device)
    for name in ["scale_bias", "rots_bias", "opacity_bias"]:
        t = getattr(gs, name, None)
        if isinstance(t, torch.Tensor):
            setattr(gs, name, t.to(device))
    for name in ["_xyz", "_features_dc", "_features_rest", "_scaling", "_rotation", "_opacity"]:
        t = getattr(gs, name, None)
        if isinstance(t, torch.Tensor):
            setattr(gs, name, t.to(device))
    return gs


def gaussian_to_float32(gs):
    """
    Ensure GaussianSplat tensors are float32.
    Fixes save_ply() error when tensors are bfloat16/float16.
    """
    if gs is None:
        return gs
    for name in ["aabb", "scale_bias", "rots_bias", "opacity_bias"]:
        t = getattr(gs, name, None)
        if isinstance(t, torch.Tensor):
            setattr(gs, name, t.float())
    for name in ["_xyz", "_features_dc", "_features_rest", "_scaling", "_rotation", "_opacity"]:
        t = getattr(gs, name, None)
        if isinstance(t, torch.Tensor):
            setattr(gs, name, t.float())
    return gs


def select_autocast_dtype(prefer_bf16=True):
    if not torch.cuda.is_available():
        return None
    if prefer_bf16 and torch.cuda.is_bf16_supported():
        return torch.bfloat16
    return torch.float16


def run_one_mask(inference, image, mask, seed, cfg, idx):
    """
    Run inference for a single mask with OOM fallback.
    Keeps only gaussian + pose and moves heavy tensors to CPU if configured.
    """
    # Merge mask into RGBA once to avoid redoing in fallbacks
    # Merge once so retries don't repeat work or keep extra tensors.
    rgba_image = inference.merge_mask_to_rgba(image, mask)
    pipe = inference._pipeline

    # Fallback schedule: progressively reduce memory use on OOM.
    attempts = []
    attempts.append(
        dict(
            decode_formats=cfg["decode_formats"],
            stage1_steps=cfg["stage1_steps"],
            stage2_steps=cfg["stage2_steps"],
        )
    )
    if cfg["decode_formats"] != ["gaussian"]:
        attempts.append(
            dict(
                decode_formats=["gaussian"],
                stage1_steps=cfg["stage1_steps"],
                stage2_steps=cfg["stage2_steps"],
            )
        )
    attempts.append(
        dict(
            decode_formats=["gaussian"],
            stage1_steps=cfg["fallback_stage1_steps"],
            stage2_steps=cfg["fallback_stage2_steps"],
        )
    )

    last_err = None
    for attempt_i, att in enumerate(attempts):
        try:
            if torch.cuda.is_available():
                torch.cuda.reset_peak_memory_stats()
            log_vram(f"obj{idx}-before-attempt{attempt_i}")

            autocast_dtype = cfg["autocast_dtype"]
            # Autocast reduces memory and can speed up on Ampere/ADA.
            if cfg["autocast"] and autocast_dtype is not None:
                ctx = torch.autocast("cuda", dtype=autocast_dtype)
            else:
                ctx = torch.no_grad()

            with torch.inference_mode(), ctx:
                # Run pipeline in inference mode (no grads) to reduce VRAM.
                out = pipe.run(
                    rgba_image,
                    None,
                    seed,
                    stage1_only=False,
                    with_mesh_postprocess=False,  # keep off to reduce memory
                    with_texture_baking=False,
                    with_layout_postprocess=False,
                    use_vertex_color=True,
                    stage1_inference_steps=att["stage1_steps"],
                    stage2_inference_steps=att["stage2_steps"],
                    pointmap=None,
                    decode_formats=att["decode_formats"],
                    estimate_plane=False,
                )

            # Extract only what make_scene needs; drop all other outputs.
            gs_list = out.get("gaussian", None)
            if gs_list is None:
                raise RuntimeError("No gaussian output found; set decode_formats=['gaussian']")

            gs = gs_list[0]
            minimal = {
                "gaussian": [gs],
                "rotation": out["rotation"].detach(),
                "translation": out["translation"].detach(),
                "scale": out["scale"].detach(),
            }

            # Store on CPU to keep VRAM low across multiple objects.
            if cfg["store_on_cpu"]:
                minimal["gaussian"][0] = gaussian_to_device(minimal["gaussian"][0], "cpu")
                minimal["rotation"] = minimal["rotation"].cpu()
                minimal["translation"] = minimal["translation"].cpu()
                minimal["scale"] = minimal["scale"].cpu()

            # Drop heavy outputs immediately to free VRAM.
            del out
            cleanup_cuda()
            log_vram(f"obj{idx}-after-attempt{attempt_i}")
            return minimal

        except RuntimeError as e:
            last_err = e
            if "out of memory" in str(e).lower():
                print(
                    f"[WARN] OOM at object {idx}, attempt {attempt_i}. "
                    f"Retrying with lower settings..."
                )
                cleanup_cuda()
                continue
            raise

    # If all attempts failed
    raise last_err

if __name__ == "__main__":
    PATH = os.getcwd()
    TAG = "hf"
    config_path = f"./checkpoints/{TAG}/pipeline.yaml"
    inference = Inference(config_path, compile=False)
    
    IMAGE_PATH = f"./my_data_test/images/image_dino.jpg"#f"./notebook/images/shutterstock_stylish_kidsroom_1640806567/image.png"
    IMAGE_NAME = os.path.basename(os.path.dirname(IMAGE_PATH))
    GAUSS_DIR = os.path.join(PATH, "output")
    GAUSS_MULTI_DIR = os.path.join(PATH, "output", "my_test_dino")
    os.makedirs(GAUSS_DIR, exist_ok=True)
    os.makedirs(GAUSS_MULTI_DIR, exist_ok=True)

    image = load_image(IMAGE_PATH)
    masks = load_masks(os.path.dirname(IMAGE_PATH), extension=".png")
    #display_image(image, masks)

    # ---- Config knobs (adjust for your GPU) ----
    cfg = {
        "max_objects": None,  # e.g. 20 to cap masks
        "decode_formats": ["gaussian"],  # avoid mesh decoder OOM (spconv)
        "stage1_steps": None,  # None = default from config
        "stage2_steps": None,  # None = default from config
        "fallback_stage1_steps": 15,
        "fallback_stage2_steps": 15,
        "autocast": True,
        "autocast_dtype": select_autocast_dtype(prefer_bf16=True),
        "store_on_cpu": True,  # keep per-object gaussians on CPU until assembly
    }

    if cfg["max_objects"] is not None:
        masks = masks[: cfg["max_objects"]]

    outputs = []
    for i, mask in enumerate(masks):
        print(f"Run mask..{i}")
        obj = run_one_mask(inference, image, mask, seed=42, cfg=cfg, idx=i)
        outputs.append(obj)
        cleanup_cuda()

    # Move all gaussians back to GPU for scene assembly + rendering.
    for out in outputs:
        out["gaussian"][0] = gaussian_to_device(out["gaussian"][0], "cuda")
        out["rotation"] = out["rotation"].cuda()
        out["translation"] = out["translation"].cuda()
        out["scale"] = out["scale"].cuda()

    scene_gs = make_scene(*outputs)
    # Export posed gaussian splatting (point cloud). save_ply needs float32.
    # save_ply requires float32 tensors (bf16/fp16 will error)
    scene_gs = gaussian_to_float32(scene_gs)
    scene_gs.save_ply(os.path.join(GAUSS_DIR, f"{IMAGE_NAME}_posed.ply"))

    # Ensure scene on GPU for rendering, then export final gaussian splat.
    scene_gs = gaussian_to_device(scene_gs, "cuda")
    scene_gs = ready_gaussian_for_video_rendering(scene_gs)
    # export gaussian splatting (as point cloud)
    scene_gs = gaussian_to_float32(scene_gs)
    scene_gs.save_ply(os.path.join(GAUSS_MULTI_DIR, f"{IMAGE_NAME}.ply"))

    video = render_video(
        scene_gs,
        r=1,
        fov=60,
        resolution=512,
    )["color"]

    # save video as gif
    imageio.mimsave(
        os.path.join(GAUSS_MULTI_DIR, f"{IMAGE_NAME}.gif"),
        video,
        format="GIF",
        duration=1000 / 30,  # default assuming 30fps from the input MP4
        loop=0,  # 0 means loop indefinitely
    )

    # notebook display
    ImageDisplay(url=f"output/multi/{IMAGE_NAME}.gif?cache_invalidator={uuid.uuid4()}",)
    
    # might take a while to load (black screen)
    interactive_visualizer(os.path.join(GAUSS_MULTI_DIR, f"{IMAGE_NAME}.ply"))
