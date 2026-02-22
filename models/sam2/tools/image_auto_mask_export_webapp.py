#!/usr/bin/env python3
"""Webapp-oriented SAM2 full auto mask export.

This keeps the same core behavior as image_auto_mask_export.py while adding:
- deterministic output filenames
- result manifest json for downstream consumers
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys

import numpy as np
from PIL import Image
import torch

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from sam2.build_sam import build_sam2  # noqa: E402
from sam2.automatic_mask_generator import SAM2AutomaticMaskGenerator  # noqa: E402
from webapp_common import cfg_name_from_path, to_rel_or_abs, write_manifest  # noqa: E402


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Webapp SAM2 full auto mask export.")
    p.add_argument("--image", required=True, help="Path to input image.")
    p.add_argument("--output", required=True, help="Output directory.")
    p.add_argument("--sam2_cfg", required=True, help="SAM2 config yaml.")
    p.add_argument("--sam2_checkpoint", required=True, help="SAM2 checkpoint path.")
    p.add_argument(
        "--device",
        default="cuda" if torch.cuda.is_available() else "cpu",
        help="Device (cuda/cpu).",
    )
    p.add_argument("--points-per-side", type=int, default=64)
    p.add_argument("--pred-iou-thresh", type=float, default=0.7)
    p.add_argument("--stability-score-thresh", type=float, default=0.9)
    p.add_argument("--box-nms-thresh", type=float, default=0.7)
    p.add_argument("--crop-n-layers", type=int, default=1)
    p.add_argument("--crop-nms-thresh", type=float, default=0.7)
    p.add_argument("--min-mask-region-area", type=int, default=0)
    p.add_argument("--overlay", default="overlay.jpg", help="Overlay filename in output dir.")
    p.add_argument("--overlay-alpha", type=float, default=0.6)
    return p.parse_args()


def main() -> None:
    args = parse_args()

    image_path = Path(args.image)
    if not image_path.exists():
        raise FileNotFoundError(f"Image not found: {image_path}")

    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)

    cfg_name = cfg_name_from_path(args.sam2_cfg)
    ckpt_path = Path(args.sam2_checkpoint)
    if not ckpt_path.exists():
        raise FileNotFoundError(f"Checkpoint not found: {ckpt_path}")

    image = np.array(Image.open(image_path).convert("RGB"))
    image_h, image_w = image.shape[:2]

    sam2 = build_sam2(
        config_file=cfg_name,
        ckpt_path=str(ckpt_path),
        device=args.device,
    )

    mask_generator = SAM2AutomaticMaskGenerator(
        sam2,
        points_per_side=args.points_per_side,
        pred_iou_thresh=args.pred_iou_thresh,
        stability_score_thresh=args.stability_score_thresh,
        box_nms_thresh=args.box_nms_thresh,
        crop_n_layers=args.crop_n_layers,
        crop_nms_thresh=args.crop_nms_thresh,
        min_mask_region_area=args.min_mask_region_area,
        output_mode="binary_mask",
    )

    anns = mask_generator.generate(image)

    mask_paths: list[Path] = []
    for i, ann in enumerate(anns):
        mask = ann["segmentation"]
        mask_img = (mask.astype(np.uint8) * 255)
        out_path = out_dir / f"{i}.png"
        Image.fromarray(mask_img).save(out_path)
        mask_paths.append(out_path)

    overlay_path: Path | None = None
    if args.overlay:
        rng = np.random.default_rng(0)
        overlay = image.astype(np.float32)
        alpha = float(args.overlay_alpha)
        alpha = 0.0 if alpha < 0.0 else 1.0 if alpha > 1.0 else alpha
        for ann in anns:
            mask = ann["segmentation"]
            color = rng.integers(0, 255, size=(3,), dtype=np.int32)
            overlay[mask] = (1.0 - alpha) * overlay[mask] + alpha * color
        overlay = np.clip(overlay, 0, 255).astype(np.uint8)
        overlay_path = out_dir / args.overlay
        Image.fromarray(overlay).save(overlay_path, quality=95)

    manifest = {
        "mode": "full",
        "image_path": str(image_path),
        "image_size": {"width": image_w, "height": image_h},
        "sam2_cfg": str(args.sam2_cfg),
        "sam2_checkpoint": str(args.sam2_checkpoint),
        "output_dir": str(out_dir),
        "masks_count": len(mask_paths),
        "mask_paths": to_rel_or_abs(mask_paths),
        "overlay_path": str(overlay_path) if overlay_path else None,
        "points_per_side": int(args.points_per_side),
        "pred_iou_thresh": float(args.pred_iou_thresh),
        "stability_score_thresh": float(args.stability_score_thresh),
        "crop_n_layers": int(args.crop_n_layers),
        "overlay_alpha": float(args.overlay_alpha),
    }
    write_manifest(out_dir, manifest)
    print(json.dumps(manifest))


if __name__ == "__main__":
    main()
