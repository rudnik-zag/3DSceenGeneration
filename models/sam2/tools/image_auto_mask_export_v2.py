#!/usr/bin/env python3
"""Generate binary PNG masks for each object using boxes from a JSON config.

Example:
  python tools/image_auto_mask_export_v2.py \
    --config /path/to/boxes.json \
    --output ./outputs/masks \
    --sam2_cfg /path/to/sam2.1_hiera_l.yaml \
    --sam2_checkpoint /path/to/sam2.1_hiera_large.pt
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
    # Ensure we import the local repo package, not a site-packages install.
    sys.path.insert(0, str(REPO_ROOT))

from sam2.build_sam import build_sam2  # noqa: E402
from sam2.sam2_image_predictor import SAM2ImagePredictor  # noqa: E402


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Export masks using box prompts from JSON.")
    p.add_argument("--config", required=True, help="Path to JSON config with boxes.")
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
    p.add_argument(
        "--multimask-output",
        action="store_true",
        help="If set, output 3 masks per box (otherwise 1 best mask).",
    )
    return p.parse_args()


def _safe_label(label: str, fallback: str) -> str:
    cleaned = "".join(ch if (ch.isalnum() or ch in "-_+") else "_" for ch in label)
    cleaned = cleaned.strip("_ ")
    return cleaned if cleaned else fallback


def _cfg_name_from_path(cfg_path: Path) -> str:
    if cfg_path.exists():
        try:
            rel_cfg = cfg_path.resolve().relative_to(REPO_ROOT / "sam2")
            return str(rel_cfg).replace(os.sep, "/")
        except ValueError as exc:
            raise FileNotFoundError(
                f"Config path must live under {REPO_ROOT / 'sam2'}: {cfg_path}"
            ) from exc
    return str(cfg_path)


def main() -> None:
    args = _parse_args()

    config_path = Path(args.config)
    if not config_path.exists():
        raise FileNotFoundError(f"Config not found: {config_path}")

    with open(config_path, "r", encoding="utf-8") as f:
        cfg = json.load(f)

    image_path = Path(cfg.get("image_path", ""))
    if not image_path.exists():
        raise FileNotFoundError(f"Image not found: {image_path}")

    boxes_cfg = cfg.get("boxes", [])
    if not boxes_cfg:
        raise ValueError("No boxes found in config JSON.")

    boxes = []
    labels = []
    for i, b in enumerate(boxes_cfg):
        label = str(b.get("label", f"obj_{i:04d}"))
        box = b.get("box_xyxy_int")
        if box is None:
            box = b.get("box_xyxy")
        if box is None or len(box) != 4:
            raise ValueError(f"Invalid box for entry {i}: {b}")
        boxes.append([float(x) for x in box])
        labels.append(label)

    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)

    image = np.array(Image.open(image_path).convert("RGB"))

    cfg_name = _cfg_name_from_path(Path(args.sam2_cfg))
    ckpt_path = Path(args.sam2_checkpoint)
    if not ckpt_path.exists():
        raise FileNotFoundError(f"Checkpoint not found: {ckpt_path}")

    sam2 = build_sam2(
        config_file=cfg_name,
        ckpt_path=str(ckpt_path),
        device=args.device,
    )

    predictor = SAM2ImagePredictor(sam2)
    predictor.set_image(image)

    boxes_np = np.array(boxes, dtype=np.float32)
    masks, ious, _ = predictor.predict(
        box=boxes_np,
        multimask_output=bool(args.multimask_output),
    )

    # masks shape:
    # - [N, H, W] if single mask output (N boxes)
    # - [N, 3, H, W] if multimask_output
    if masks.ndim == 4:
        # [N, M, H, W]
        num_boxes = masks.shape[0]
        num_masks = masks.shape[1]
    else:
        num_boxes = masks.shape[0]
        num_masks = 1
        masks = masks[:, None, ...]

    for i in range(num_boxes):
        label = _safe_label(labels[i], f"obj_{i:04d}")
        for m in range(num_masks):
            mask = masks[i, m].astype(bool)
            mask_img = (mask.astype(np.uint8) * 255)
            suffix = f"_{m}" if num_masks > 1 else ""
            out_path = out_dir / f"{i}.png"#f"mask_{i:04d}_{label}{suffix}.png"
            Image.fromarray(mask_img).save(out_path)

    if args.overlay:
        rng = np.random.default_rng(0)
        overlay = image.astype(np.float32)
        alpha = float(args.overlay_alpha)
        alpha = 0.0 if alpha < 0.0 else 1.0 if alpha > 1.0 else alpha
        for i in range(num_boxes):
            label = _safe_label(labels[i], f"obj_{i:04d}")
            color = rng.integers(0, 255, size=(3,), dtype=np.int32)
            for m in range(num_masks):
                mask = masks[i, m].astype(bool)
                overlay[mask] = (1.0 - alpha) * overlay[mask] + alpha * color
        overlay = np.clip(overlay, 0, 255).astype(np.uint8)
        overlay_path = out_dir / args.overlay
        Image.fromarray(overlay).save(overlay_path, quality=95)

    print(f"Wrote masks for {num_boxes} boxes to {out_dir}")


if __name__ == "__main__":
    main()
