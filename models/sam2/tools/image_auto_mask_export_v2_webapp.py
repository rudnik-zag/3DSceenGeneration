#!/usr/bin/env python3
"""Webapp-oriented SAM2 guided mask export using GroundingDINO JSON config."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

import numpy as np
from PIL import Image
import torch

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from sam2.build_sam import build_sam2  # noqa: E402
from sam2.sam2_image_predictor import SAM2ImagePredictor  # noqa: E402
from webapp_common import (  # noqa: E402
    cfg_name_from_path,
    parse_boxes_xyxy,
    resolve_image_path,
    safe_label,
    to_rel_or_abs,
    write_manifest,
)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Webapp SAM2 guided mask export.")
    p.add_argument("--config", required=True, help="GroundingDINO json config path.")
    p.add_argument("--output", required=True, help="Output directory.")
    p.add_argument("--sam2_cfg", required=True, help="SAM2 config yaml.")
    p.add_argument("--sam2_checkpoint", required=True, help="SAM2 checkpoint.")
    p.add_argument(
        "--device",
        default="cuda" if torch.cuda.is_available() else "cpu",
        help="Device (cuda/cpu).",
    )
    p.add_argument("--overlay", default="overlay.jpg", help="Overlay filename.")
    p.add_argument("--overlay-alpha", type=float, default=0.6)
    p.add_argument("--multimask-output", action="store_true")
    return p.parse_args()


def main() -> None:
    args = parse_args()

    config_path = Path(args.config)
    if not config_path.exists():
        raise FileNotFoundError(f"Config not found: {config_path}")

    with config_path.open("r", encoding="utf-8") as f:
        cfg = json.load(f)
    if not isinstance(cfg, dict):
        raise ValueError("Config JSON must be an object.")

    image_path = resolve_image_path(cfg, config_path)
    boxes, labels = parse_boxes_xyxy(cfg)

    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)

    image = np.array(Image.open(image_path).convert("RGB"))
    image_h, image_w = image.shape[:2]

    cfg_name = cfg_name_from_path(args.sam2_cfg)
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

    if masks.ndim == 4:
        num_boxes = masks.shape[0]
        num_masks = masks.shape[1]
    else:
        num_boxes = masks.shape[0]
        num_masks = 1
        masks = masks[:, None, ...]

    mask_paths: list[Path] = []
    for i in range(num_boxes):
        label = safe_label(labels[i], f"obj_{i:04d}")
        for m in range(num_masks):
            mask = masks[i, m].astype(bool)
            mask_img = (mask.astype(np.uint8) * 255)
            suffix = f"_{m}" if num_masks > 1 else ""
            out_path = out_dir / f"{i}{suffix}.png"
            Image.fromarray(mask_img).save(out_path)
            mask_paths.append(out_path)

    overlay_path: Path | None = None
    if args.overlay:
        rng = np.random.default_rng(0)
        overlay = image.astype(np.float32)
        alpha = float(args.overlay_alpha)
        alpha = 0.0 if alpha < 0.0 else 1.0 if alpha > 1.0 else alpha
        for i in range(num_boxes):
            color = rng.integers(0, 255, size=(3,), dtype=np.int32)
            for m in range(num_masks):
                mask = masks[i, m].astype(bool)
                overlay[mask] = (1.0 - alpha) * overlay[mask] + alpha * color
        overlay = np.clip(overlay, 0, 255).astype(np.uint8)
        overlay_path = out_dir / args.overlay
        Image.fromarray(overlay).save(overlay_path, quality=95)

    boxes_payload = []
    for idx, raw_box in enumerate(boxes):
        boxes_payload.append(
            {
                "label": labels[idx],
                "box_xyxy": [float(raw_box[0]), float(raw_box[1]), float(raw_box[2]), float(raw_box[3])],
            }
        )

    manifest = {
        "mode": "guided",
        "config_path": str(config_path),
        "image_path": str(image_path),
        "image_size": {"width": image_w, "height": image_h},
        "boxes_count": len(boxes),
        "boxes": boxes_payload,
        "output_dir": str(out_dir),
        "masks_count": len(mask_paths),
        "mask_paths": to_rel_or_abs(mask_paths),
        "overlay_path": str(overlay_path) if overlay_path else None,
        "overlay_alpha": float(args.overlay_alpha),
        "multimask_output": bool(args.multimask_output),
        "ious_shape": list(np.asarray(ious).shape) if ious is not None else None,
    }
    write_manifest(out_dir, manifest)
    print(json.dumps(manifest))


if __name__ == "__main__":
    main()
