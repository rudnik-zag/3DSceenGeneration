#!/usr/bin/env python3
"""SAM3D per-mask subprocess runner for web app.

This script runs scene generation for exactly one mask file.
It is intended to be invoked repeatedly from the Node executor to reduce OOM
pressure compared to running all masks in one long process.
"""

from __future__ import annotations

import argparse
from datetime import datetime
import json
import traceback
from pathlib import Path

import numpy as np
from PIL import Image


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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="SAM3D single-mask webapp runner")
    parser.add_argument("--mode", choices=["mesh"], default="mesh")
    parser.add_argument("--image", required=True, help="Input image path")
    parser.add_argument("--mask", required=True, help="Single mask png path")
    parser.add_argument("--output", required=True, help="Output directory")
    parser.add_argument("--config", default="hf", help="Checkpoint tag under checkpoints/{config}")
    parser.add_argument("--mask-index", type=int, default=0, help="Logical index for naming outputs")
    return parser.parse_args()


def ensure_inputs(image_path: Path, mask_path: Path, config_path: Path) -> None:
    if not image_path.exists():
        raise FileNotFoundError(f"Input image not found: {image_path}")
    if not mask_path.exists():
        raise FileNotFoundError(f"Mask not found: {mask_path}")
    if not config_path.exists():
        raise FileNotFoundError(f"SAM3D pipeline config not found: {config_path}")


def build_manifest(
    *,
    config_tag: str,
    config_path: Path,
    image_path: Path,
    mask_path: Path,
    output_dir: Path,
    scene_path: Path,
    mesh_parts_dir: Path,
    mesh_objects_dir: Path,
    run_config: dict,
) -> dict:
    return {
        "mode": "mesh",
        "config": config_tag,
        "scene_path": str(scene_path.resolve()),
        "masks_count": 1,
        "image_path": str(image_path.resolve()),
        "masks_dir": str(mask_path.parent.resolve()),
        "mask_path": str(mask_path.resolve()),
        "input_paths": {
            "image": str(image_path.resolve()),
            "mask": str(mask_path.resolve()),
            "pipeline_config": str(config_path.resolve()),
        },
        "output_paths": {
            "output_dir": str(output_dir.resolve()),
            "scene": str(scene_path.resolve()),
            "mesh_parts_dir": str(mesh_parts_dir.resolve()),
            "mesh_objects_dir": str(mesh_objects_dir.resolve()),
        },
        "run_config": _to_json_value(run_config),
    }


def run_mesh(args: argparse.Namespace, config_path: Path, output_dir: Path) -> dict:
    from notebook.inference import Inference, load_image
    from demo_multi_object_mesh import build_mesh_scene
    from generate_per_object import (
        cleanup_cuda,
        export_transformed_object_glb,
        run_one_mask,
        select_autocast_dtype,
    )

    inference = Inference(str(config_path), compile=False)
    image = load_image(str(Path(args.image)))
    mask = np.array(Image.open(args.mask).convert("L")) > 127

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

    idx = max(0, int(args.mask_index))
    obj = run_one_mask(inference, image, mask, seed=42, cfg=cfg, idx=idx, mesh_dir=str(mesh_parts_dir))
    pose_ok = (
        obj.get("rotation") is not None
        and obj.get("translation") is not None
        and obj.get("scale") is not None
    )
    mesh_data = obj.get("mesh_data")
    if not pose_ok or mesh_data is None:
        cleanup_cuda()
        raise RuntimeError(f"Single-mask export skipped index={idx} (missing pose/mesh).")

    transformed_path = mesh_objects_dir / f"object_{idx:03d}_posed.glb"
    export_transformed_object_glb(
        mesh_data,
        obj["rotation"],
        obj["translation"],
        obj["scale"],
        str(transformed_path),
    )

    scene_path = output_dir / "scene.glb"
    build_mesh_scene(
        [
            {
                "mesh": mesh_data,
                "rotation": obj["rotation"],
                "translation": obj["translation"],
                "scale": obj["scale"],
            }
        ],
        str(scene_path),
    )
    cleanup_cuda()

    return build_manifest(
        config_tag=args.config,
        config_path=config_path,
        image_path=Path(args.image),
        mask_path=Path(args.mask),
        output_dir=output_dir,
        scene_path=scene_path,
        mesh_parts_dir=mesh_parts_dir,
        mesh_objects_dir=mesh_objects_dir,
        run_config=cfg,
    )


def main() -> None:
    args = parse_args()
    repo_root = Path(__file__).resolve().parent
    output_dir = Path(args.output).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    config_path = (repo_root / "checkpoints" / args.config / "pipeline.yaml").resolve()
    image_path = Path(args.image).resolve()
    mask_path = Path(args.mask).resolve()
    ensure_inputs(image_path, mask_path, config_path)

    manifest = run_mesh(args, config_path, output_dir)
    manifest["created_at"] = datetime.utcnow().isoformat() + "Z"
    manifest_path = output_dir / "result_manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps(manifest))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"SAM3D webapp single-mask inference failed: {exc}", flush=True)
        traceback.print_exc()
        raise
