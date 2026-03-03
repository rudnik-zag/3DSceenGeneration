#!/usr/bin/env python3
"""SAM3D Objects webapp runner for gaussian-only export.

This script is used by the SceneGeneration node when output format is point_ply.
It only runs gaussian generation and writes scene.ply + result_manifest.json.
"""

from __future__ import annotations

import argparse
from datetime import datetime
import json
import traceback
from pathlib import Path

import torch


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
    config_tag: str,
    config_path: Path,
    image_path: Path,
    masks_dir: Path,
    output_dir: Path,
    scene_path: Path,
    masks_count: int,
    run_config: dict,
) -> dict:
    return {
        "mode": "gaussian",
        "config": config_tag,
        "scene_path": str(scene_path.resolve()),
        "masks_count": int(masks_count),
        "image_path": str(image_path.resolve()),
        "masks_dir": str(masks_dir.resolve()),
        "input_paths": {
            "image": str(image_path.resolve()),
            "masks_dir": str(masks_dir.resolve()),
            "pipeline_config": str(config_path.resolve()),
        },
        "output_paths": {
            "output_dir": str(output_dir.resolve()),
            "scene": str(scene_path.resolve()),
        },
        "run_config": _to_json_value(run_config),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="SAM3D gaussian-only webapp runner")
    parser.add_argument("--mode", choices=["gaussian"], required=True)
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
        "autocast": True,
        "autocast_dtype": select_autocast_dtype(prefer_bf16=True),
        "store_on_cpu": True,
    }

    if cfg["max_objects"] is not None:
        masks = masks[: cfg["max_objects"]]

    outputs = []
    for idx, mask in enumerate(masks):
        obj = run_one_mask(inference, image, mask, seed=42, cfg=cfg, idx=idx)
        outputs.append(obj)
        cleanup_cuda()

    if torch.cuda.is_available():
        for out in outputs:
            out["gaussian"][0] = gaussian_to_device(out["gaussian"][0], "cuda")
            out["rotation"] = out["rotation"].cuda()
            out["translation"] = out["translation"].cuda()
            out["scale"] = out["scale"].cuda()

    scene_gs = make_scene(*outputs)
    scene_gs = gaussian_to_float32(scene_gs)
    scene_path = output_dir / "scene.ply"
    scene_gs.save_ply(str(scene_path))
    cleanup_cuda()

    return build_manifest(
        config_tag=args.config,
        config_path=config_path,
        image_path=Path(args.image),
        masks_dir=Path(args.masks_dir),
        output_dir=output_dir,
        scene_path=scene_path,
        masks_count=len(outputs),
        run_config=cfg,
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

    manifest = run_gaussian(args, config_path, output_dir)
    manifest["created_at"] = datetime.utcnow().isoformat() + "Z"
    manifest_path = output_dir / "result_manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps(manifest))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"SAM3D gaussian webapp inference failed: {exc}", flush=True)
        traceback.print_exc()
        raise
