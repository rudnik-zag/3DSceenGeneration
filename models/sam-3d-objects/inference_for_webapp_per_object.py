#!/usr/bin/env python3
"""SAM3D Objects webapp runner (per-object mesh path).

This entrypoint keeps the same CLI contract as inference_for_webapp.py and
uses generate_per_object.py for mesh-mode execution.
"""

from __future__ import annotations

import argparse
from datetime import datetime
import json
import traceback
from pathlib import Path


def _to_json_value(value):
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, list):
        return [_to_json_value(item) for item in value]
    if isinstance(value, tuple):
        return [_to_json_value(item) for item in value]
    if isinstance(value, dict):
        return {str(k): _to_json_value(v) for k, v in value.items()}
    return str(value)


def build_manifest(
    *,
    mode: str,
    config_tag: str,
    config_path: Path,
    image_path: Path,
    masks_dir: Path,
    output_dir: Path,
    scene_path: Path | None,
    masks_count: int,
    run_config: dict,
    mesh_parts_dir: Path | None = None,
    mesh_objects_dir: Path | None = None,
) -> dict:
    output_paths = {
        "output_dir": str(output_dir.resolve()),
    }
    if scene_path is not None:
        output_paths["scene"] = str(scene_path.resolve())
    if mesh_parts_dir is not None:
        output_paths["mesh_parts_dir"] = str(mesh_parts_dir.resolve())
    if mesh_objects_dir is not None:
        output_paths["mesh_objects_dir"] = str(mesh_objects_dir.resolve())

    return {
        "mode": mode,
        "config": config_tag,
        "scene_path": str(scene_path.resolve()) if scene_path is not None else None,
        "masks_count": int(masks_count),
        "image_path": str(image_path.resolve()),
        "masks_dir": str(masks_dir.resolve()),
        "input_paths": {
            "image": str(image_path.resolve()),
            "masks_dir": str(masks_dir.resolve()),
            "pipeline_config": str(config_path.resolve()),
        },
        "output_paths": output_paths,
        "run_config": _to_json_value(run_config),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="SAM3D Objects webapp runner (per-object mesh)")
    parser.add_argument("--mode", choices=["mesh", "gaussian"], required=True)
    parser.add_argument("--image", required=True, help="Input image path")
    parser.add_argument("--masks_dir", required=True, help="Directory with 0.png,1.png,... masks")
    parser.add_argument("--output", required=True, help="Output directory")
    parser.add_argument("--config", default="hf", help="Checkpoint tag under checkpoints/{config}")
    return parser.parse_args()


def ensure_inputs(image_path: Path, masks_dir: Path, config_path: Path) -> None:
    if not image_path.exists():
        raise FileNotFoundError(f"Input image not found: {image_path}")
    if not masks_dir.exists():
        raise FileNotFoundError(f"Masks directory not found: {masks_dir}")
    if not config_path.exists():
        raise FileNotFoundError(f"SAM3D pipeline config not found: {config_path}")


def run_gaussian(args: argparse.Namespace, config_path: Path, output_dir: Path) -> dict:
    from notebook.inference import Inference, load_image, load_masks, make_scene
    from demo_multi_object import (
        cleanup_cuda,
        gaussian_to_device,
        gaussian_to_float32,
        run_one_mask,
        select_autocast_dtype,
    )

    inference = Inference(str(config_path), compile=False)
    image = load_image(str(Path(args.image)))
    masks = load_masks(str(Path(args.masks_dir)), extension=".png")
    if not masks:
        raise RuntimeError(f"No masks found in {args.masks_dir}")

    cfg = {
        "max_objects": None,
        "decode_formats": ["gaussian"],
        "stage1_steps": None,
        "stage2_steps": None,
        "fallback_stage1_steps": 15,
        "fallback_stage2_steps": 15,
        "autocast": False,
        "autocast_dtype": select_autocast_dtype(prefer_bf16=False),
        "store_on_cpu": True,
    }

    outputs = []
    for idx, mask in enumerate(masks):
        obj = run_one_mask(inference, image, mask, seed=42, cfg=cfg, idx=idx)
        outputs.append(obj)
        cleanup_cuda()

    for obj in outputs:
        obj["gaussian"][0] = gaussian_to_device(obj["gaussian"][0], "cuda")

    scene_gs = make_scene(*outputs)
    scene_gs = gaussian_to_float32(scene_gs)
    scene_path = output_dir / "scene.ply"
    scene_gs.save_ply(str(scene_path))

    return build_manifest(
        mode="gaussian",
        config_tag=args.config,
        config_path=config_path,
        image_path=Path(args.image),
        masks_dir=Path(args.masks_dir),
        output_dir=output_dir,
        scene_path=scene_path,
        masks_count=len(masks),
        run_config=cfg,
    )


def run_mesh(args: argparse.Namespace, config_path: Path, output_dir: Path) -> dict:
    from notebook.inference import Inference, load_image, load_masks
    from generate_per_object import (
        cleanup_cuda,
        export_transformed_object_glb,
        run_one_mask,
        select_autocast_dtype,
    )

    inference = Inference(str(config_path), compile=False)
    image = load_image(str(Path(args.image)))
    masks = load_masks(str(Path(args.masks_dir)), extension=".png")
    if not masks:
        raise RuntimeError(f"No masks found in {args.masks_dir}")

    mesh_parts_dir = output_dir / "mesh_parts"
    mesh_objects_dir = output_dir / "mesh_objects_transformed"
    mesh_parts_dir.mkdir(parents=True, exist_ok=True)
    mesh_objects_dir.mkdir(parents=True, exist_ok=True)

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

    transformed_paths: list[Path] = []
    for idx, mask in enumerate(masks):
        obj = run_one_mask(inference, image, mask, seed=42, cfg=cfg, idx=idx, mesh_dir=str(mesh_parts_dir))

        pose_ok = (
            obj.get("rotation") is not None
            and obj.get("translation") is not None
            and obj.get("scale") is not None
        )
        mesh_data = obj.get("mesh_data")
        if not pose_ok or mesh_data is None:
            print(f"[WARN] Skip transformed export for object {idx} (missing pose/mesh).")
            cleanup_cuda()
            continue

        transformed_path = mesh_objects_dir / f"object_{idx:03d}_posed.glb"
        export_transformed_object_glb(
            mesh_data,
            obj["rotation"],
            obj["translation"],
            obj["scale"],
            str(transformed_path),
        )
        transformed_paths.append(transformed_path)
        cleanup_cuda()

    if not transformed_paths:
        raise RuntimeError("No mesh scene items were generated from provided masks.")

    # Mesh mode exports transformed per-object GLBs only.
    scene_path = transformed_paths[0]

    return build_manifest(
        mode="mesh",
        config_tag=args.config,
        config_path=config_path,
        image_path=Path(args.image),
        masks_dir=Path(args.masks_dir),
        output_dir=output_dir,
        scene_path=scene_path,
        masks_count=len(transformed_paths),
        run_config=cfg,
        mesh_parts_dir=mesh_parts_dir,
        mesh_objects_dir=mesh_objects_dir,
    )


def main() -> None:
    args = parse_args()
    repo_root = Path(__file__).resolve().parent
    output_dir = Path(args.output).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    config_path = (repo_root / "checkpoints" / args.config / "pipeline.yaml").resolve()
    image_path = Path(args.image).resolve()
    masks_dir = Path(args.masks_dir).resolve()
    ensure_inputs(image_path, masks_dir, config_path)

    if args.mode == "gaussian":
        manifest = run_gaussian(args, config_path, output_dir)
    else:
        manifest = run_mesh(args, config_path, output_dir)

    manifest["created_at"] = datetime.utcnow().isoformat() + "Z"
    manifest_path = output_dir / "result_manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps(manifest))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"SAM3D webapp per-object inference failed: {exc}", flush=True)
        traceback.print_exc()
        raise
