import os
import gc
import numpy as np

import torch
import trimesh

os.environ.setdefault("LIDRA_SKIP_INIT", "1")
from sam3d_objects.utils.visualization.scene_visualizer import SceneVisualizer
from notebook.inference import (
    Inference,
    load_image,
    load_masks,
)


def log_vram(tag: str):
    """Log CUDA memory for debugging OOMs."""
    if not torch.cuda.is_available():
        print(f"[VRAM][{tag}] CUDA not available")
        return
    alloc = torch.cuda.memory_allocated() / (1024**2)
    reserved = torch.cuda.memory_reserved() / (1024**2)
    max_alloc = torch.cuda.max_memory_allocated() / (1024**2)
    print(
        f"[VRAM][{tag}] alloc={alloc:.0f}MB reserved={reserved:.0f}MB max_alloc={max_alloc:.0f}MB"
    )


def cleanup_cuda():
    # Aggressively free unused CUDA memory to avoid fragmentation between objects.
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def select_autocast_dtype(prefer_bf16=True):
    if not torch.cuda.is_available():
        return None
    if prefer_bf16 and torch.cuda.is_bf16_supported():
        return torch.bfloat16
    return torch.float16


def export_mesh_glb(glb_obj, path):
    if glb_obj is None:
        return
    glb_obj.export(path)


def mesh_extract_to_cpu(mesh):
    """
    Convert MeshExtractResult to CPU numpy arrays.
    Keeps only vertices, faces, and optional vertex colors.
    """
    if mesh is None:
        return None
    vertices = mesh.vertices.detach().cpu().numpy()
    faces = mesh.faces.detach().cpu().numpy()
    colors = None
    if getattr(mesh, "vertex_attrs", None) is not None:
        colors = mesh.vertex_attrs[:, :3].detach().cpu().numpy()
    return {"vertices": vertices, "faces": faces, "colors": colors}


def trimesh_extract_to_cpu(mesh_obj):
    """
    Convert pipeline glb output to CPU numpy arrays.
    """
    if mesh_obj is None:
        return None
    if isinstance(mesh_obj, trimesh.Scene):
        # Preserve scene-node transforms while flattening.
        mesh_obj = mesh_obj.to_mesh()
    if not isinstance(mesh_obj, trimesh.Trimesh):
        return None

    colors = None
    if hasattr(mesh_obj.visual, "vertex_colors") and mesh_obj.visual.vertex_colors is not None:
        vc = np.asarray(mesh_obj.visual.vertex_colors)
        if vc.ndim == 2 and vc.shape[0] == len(mesh_obj.vertices):
            colors = vc[:, :3]

    return {
        "vertices": np.asarray(mesh_obj.vertices).copy(),
        "faces": np.asarray(mesh_obj.faces).copy(),
        "colors": None if colors is None else colors.copy(),
    }


def apply_pose_to_vertices_like_gaussian(vertices, rotation, translation, scale):
    """
    Apply pose with the same logic used by gaussian scene assembly (make_scene).
    """
    v = torch.as_tensor(vertices, dtype=torch.float32)

    t = translation
    if isinstance(t, torch.Tensor):
        t = t.detach().cpu()
    if t is None:
        raise ValueError("translation is None; pose output missing translation.")
    t = torch.as_tensor(t, dtype=torch.float32).view(-1)

    s = scale
    if isinstance(s, torch.Tensor):
        s = s.detach().cpu()
    if s is None:
        raise ValueError("scale is None; pose output missing scale.")
    s = torch.as_tensor(s, dtype=torch.float32).view(-1)
    if s.numel() == 1:
        s = s.repeat(3)

    rot = rotation
    if isinstance(rot, torch.Tensor):
        rot = rot.detach().cpu()
    rot = torch.as_tensor(rot, dtype=torch.float32)
    if rot.ndim == 1:
        rot = rot.unsqueeze(0)

    t = t.view(1, 3)
    s = s.view(1, 3)
    pc = SceneVisualizer.object_pointcloud(
        points_local=v.unsqueeze(0),
        quat_l2c=rot,
        trans_l2c=t,
        scale_l2c=s,
    )
    return pc.points_list()[0].cpu().numpy()


def export_transformed_object_glb(mesh_data, rotation, translation, scale, out_path):
    """
    Transform one object mesh to scene pose and export as standalone GLB.
    """
    verts = apply_pose_to_vertices_like_gaussian(
        mesh_data["vertices"],
        rotation,
        translation,
        scale,
    )

    # Keep OpenGL convention for Blender workflow.
    verts[:, [0, 2]] *= -1.0

    faces = mesh_data["faces"]
    mesh = trimesh.Trimesh(vertices=verts, faces=faces, process=False)

    colors = mesh_data.get("colors", None)
    if colors is not None:
        if colors.max() <= 1.0:
            colors = (colors * 255).clip(0, 255).astype(np.uint8)
        else:
            colors = colors.astype(np.uint8)
        mesh.visual.vertex_colors = colors

    mesh.export(out_path)


def run_one_mask(inference, image, mask, seed, cfg, idx, mesh_dir):
    """
    Run inference for a single mask with OOM fallback.
    Keeps only pose + mesh data for standalone transformed export.
    """
    rgba_image = inference.merge_mask_to_rgba(image, mask)
    pipe = inference._pipeline

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
            if cfg["autocast"] and autocast_dtype is not None:
                ctx = torch.autocast("cuda", dtype=autocast_dtype)
            else:
                ctx = torch.no_grad()

            with torch.inference_mode(), ctx:
                out = pipe.run(
                    rgba_image,
                    None,
                    seed,
                    stage1_only=False,
                    with_mesh_postprocess=cfg["mesh_postprocess"],
                    with_texture_baking=cfg["texture_baking"],
                    with_layout_postprocess=False,
                    use_vertex_color=True,
                    stage1_inference_steps=att["stage1_steps"],
                    stage2_inference_steps=att["stage2_steps"],
                    pointmap=None,
                    decode_formats=att["decode_formats"],
                    estimate_plane=False,
                )

            if cfg["export_mesh_glb"]:
                glb = out.get("glb", None)
                export_mesh_glb(glb, os.path.join(mesh_dir, f"object_{idx:03d}.glb"))

            minimal = {
                "rotation": out["rotation"].detach(),
                "translation": out["translation"].detach(),
                "scale": out["scale"].detach(),
            }

            mesh_data = None
            # Working default from your tests: raw mesh aligns best.
            mesh_list = out.get("mesh", None)
            if mesh_list is not None:
                mesh_data = mesh_extract_to_cpu(mesh_list[0])
            if mesh_data is None:
                glb = out.get("glb", None)
                mesh_data = trimesh_extract_to_cpu(glb)

            if mesh_data is not None:
                minimal["mesh_data"] = mesh_data
            else:
                print(f"[WARN] Mesh output missing for object {idx}; skipping transformed export.")

            if cfg["store_on_cpu"]:
                minimal["rotation"] = minimal["rotation"].cpu()
                minimal["translation"] = minimal["translation"].cpu()
                minimal["scale"] = minimal["scale"].cpu()

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

    raise last_err


if __name__ == "__main__":
    PATH = os.getcwd()
    TAG = "hf"
    config_path = f"./checkpoints/{TAG}/pipeline.yaml"
    inference = Inference(config_path, compile=False)

    IMAGE_PATH = "./my_data_test/images/image_dino.jpg"
    IMAGE_NAME = os.path.basename(os.path.dirname(IMAGE_PATH))

    image = load_image(IMAGE_PATH)
    masks = load_masks(os.path.dirname(IMAGE_PATH), extension=".png")

    OUT_MESH_DIR = os.path.join(PATH, "output", "mesh")
    OUT_MESH_OBJECTS_DIR = os.path.join(PATH, "output", "mesh_objects_transformed")
    os.makedirs(OUT_MESH_DIR, exist_ok=True)
    os.makedirs(OUT_MESH_OBJECTS_DIR, exist_ok=True)

    cfg = {
        "max_objects": None,
        "export_mesh_glb": True,
        "mesh_postprocess": False,
        "texture_baking": False,
        "decode_formats": ["mesh", "gaussian"],
        "stage1_steps": None,
        "stage2_steps": None,
        "fallback_stage1_steps": 15,
        "fallback_stage2_steps": 15,
        "autocast": False,
        "autocast_dtype": select_autocast_dtype(prefer_bf16=False),
        "store_on_cpu": True,
    }

    if cfg["max_objects"] is not None:
        masks = masks[: cfg["max_objects"]]

    for i, mask in enumerate(masks):
        print(f"Run mask..{i}")
        obj = run_one_mask(inference, image, mask, seed=42, cfg=cfg, idx=i, mesh_dir=OUT_MESH_DIR)

        pose_ok = (
            obj.get("rotation", None) is not None
            and obj.get("translation", None) is not None
            and obj.get("scale", None) is not None
        )
        mesh_data = obj.get("mesh_data", None)
        if not pose_ok or mesh_data is None:
            print(f"[WARN] Skip transformed export for object {i} (missing pose/mesh).")
            cleanup_cuda()
            continue

        out_path = os.path.join(OUT_MESH_OBJECTS_DIR, f"{IMAGE_NAME}_object_{i:03d}_posed.glb")
        export_transformed_object_glb(
            mesh_data,
            obj["rotation"],
            obj["translation"],
            obj["scale"],
            out_path,
        )
        print(f"[OK] Exported transformed object: {out_path}")
        cleanup_cuda()
