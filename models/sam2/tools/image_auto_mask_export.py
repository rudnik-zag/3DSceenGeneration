#!/usr/bin/env python3
"""Generate binary PNG masks for each detected object in an image using SAM 2.

Example:
  python tools/image_auto_mask_export.py \
    --image ./assets/sa_v_dataset.jpg \
    --output ./outputs/masks \
    --sam2_cfg configs/sam2.1/sam2.1_hiera_l.yaml \
    --sam2_checkpoint ./checkpoints/sam2.1_hiera_large.pt
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys

import numpy as np
from PIL import Image

import torch

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    # Ensure we import the local repo package, not a site-packages install.
    sys.path.insert(0, str(REPO_ROOT))

from sam2.build_sam import build_sam2  # noqa: E402
from sam2.automatic_mask_generator import SAM2AutomaticMaskGenerator  # noqa: E402


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Export binary masks per object.")
    p.add_argument("--image", required=True, help="Path to input image (RGB).")
    p.add_argument("--output", required=True, help="Output directory for PNG masks.")
    p.add_argument(
        "--sam2_cfg",
        default="configs/sam2.1/sam2.1_hiera_l.yaml",
        help="Path to SAM 2 config yaml.",
    )
    p.add_argument(
        "--sam2_checkpoint",
        default="./checkpoints/sam2.1_hiera_large.pt",
        help="Path to SAM 2 checkpoint.",
    )
    p.add_argument(
        "--device",
        default="cuda" if torch.cuda.is_available() else "cpu",
        help="Device to run on (cuda or cpu).",
    )
    p.add_argument("--points-per-side", type=int, default=32)
    p.add_argument("--pred-iou-thresh", type=float, default=0.8)
    p.add_argument("--stability-score-thresh", type=float, default=0.95)
    p.add_argument("--box-nms-thresh", type=float, default=0.7)
    p.add_argument("--crop-n-layers", type=int, default=0)
    p.add_argument("--crop-nms-thresh", type=float, default=0.7)
    p.add_argument("--min-mask-region-area", type=int, default=0)
    p.add_argument(
        "--overlay",
        default="overlay.jpg",
        help="Filename for overlay JPG saved in output dir (set to empty to skip).",
    )
    p.add_argument(
        "--overlay-alpha",
        type=float,
        default=0.5,
        help="Alpha blending for overlay [0..1].",
    )
    return p.parse_args()


def main() -> None:
    args = _parse_args()

    image_path = Path(args.image)
    if not image_path.exists():
        raise FileNotFoundError(f"Image not found: {image_path}")

    cfg_path = Path(args.sam2_cfg)
    if cfg_path.exists():
        # Convert absolute/relative filesystem path to package-relative config name
        # expected by Hydra in build_sam2.
        try:
            rel_cfg = cfg_path.resolve().relative_to(REPO_ROOT / "sam2")
            cfg_name = str(rel_cfg).replace(os.sep, "/")
        except ValueError:
            raise FileNotFoundError(
                f"Config path must live under {REPO_ROOT / 'sam2'}: {cfg_path}"
            )
    else:
        # Assume caller passed a package-relative config name like
        # configs/sam2.1/sam2.1_hiera_l.yaml
        cfg_name = args.sam2_cfg

    ckpt_path = Path(args.sam2_checkpoint)
    if not ckpt_path.exists():
        raise FileNotFoundError(f"Checkpoint not found: {ckpt_path}")

    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)

    image = np.array(Image.open(image_path).convert("RGB"))

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

    for i, ann in enumerate(anns):
        mask = ann["segmentation"]  # HxW bool array
        mask_img = (mask.astype(np.uint8) * 255)
        out_path = out_dir / f"{i}.png"
        Image.fromarray(mask_img).save(out_path)

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

    print(f"Wrote {len(anns)} masks to {out_dir}")


if __name__ == "__main__":
    main()
