#!/usr/bin/env python3
"""Shared helpers for SAM2 webapp inference scripts."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Iterable


REPO_ROOT = Path(__file__).resolve().parents[1]


def cfg_name_from_path(cfg_value: str) -> str:
    cfg_path = Path(cfg_value)
    if cfg_path.exists():
        try:
            rel_cfg = cfg_path.resolve().relative_to(REPO_ROOT / "sam2")
            return str(rel_cfg).replace(os.sep, "/")
        except ValueError as exc:
            raise FileNotFoundError(
                f"Config path must live under {REPO_ROOT / 'sam2'}: {cfg_path}"
            ) from exc
    return cfg_value


def safe_label(label: str, fallback: str) -> str:
    cleaned = "".join(ch if (ch.isalnum() or ch in "-_+") else "_" for ch in label)
    cleaned = cleaned.strip("_ ")
    return cleaned if cleaned else fallback


def _to_float_array(value: Any, length: int) -> list[float] | None:
    if not isinstance(value, list) or len(value) != length:
        return None
    casted = []
    for item in value:
        try:
            casted.append(float(item))
        except (TypeError, ValueError):
            return None
    return casted


def _resolve_image_size(cfg: dict[str, Any]) -> tuple[int, int] | None:
    image_size = cfg.get("image_size")
    if isinstance(image_size, dict):
        width = image_size.get("width")
        height = image_size.get("height")
        if isinstance(width, (int, float)) and isinstance(height, (int, float)):
            if width > 0 and height > 0:
                return int(width), int(height)

    size = cfg.get("size")
    if isinstance(size, list) and len(size) == 2:
        # GroundingDINO full json uses [height, width]
        height, width = size
        if isinstance(width, (int, float)) and isinstance(height, (int, float)):
            if width > 0 and height > 0:
                return int(width), int(height)

    return None


def _xyxy_from_box_payload(
    item: dict[str, Any],
    image_size: tuple[int, int] | None,
) -> list[float] | None:
    box_xyxy_int = _to_float_array(item.get("box_xyxy_int"), 4)
    if box_xyxy_int:
        return box_xyxy_int

    box_xyxy = _to_float_array(item.get("box_xyxy"), 4)
    if box_xyxy:
        return box_xyxy

    box_xyxy_norm = _to_float_array(item.get("box_xyxy_norm"), 4)
    if box_xyxy_norm and image_size:
        w, h = image_size
        return [
            box_xyxy_norm[0] * w,
            box_xyxy_norm[1] * h,
            box_xyxy_norm[2] * w,
            box_xyxy_norm[3] * h,
        ]

    box_cxcywh_norm = _to_float_array(item.get("box_cxcywh_norm"), 4)
    if box_cxcywh_norm and image_size:
        cx, cy, bw, bh = box_cxcywh_norm
        w, h = image_size
        x1 = (cx - bw / 2.0) * w
        y1 = (cy - bh / 2.0) * h
        x2 = (cx + bw / 2.0) * w
        y2 = (cy + bh / 2.0) * h
        return [x1, y1, x2, y2]

    # Fallback for web json where bbox is [cx, cy, w, h] normalized.
    bbox = _to_float_array(item.get("bbox"), 4)
    if bbox and image_size:
        cx, cy, bw, bh = bbox
        w, h = image_size
        x1 = (cx - bw / 2.0) * w
        y1 = (cy - bh / 2.0) * h
        x2 = (cx + bw / 2.0) * w
        y2 = (cy + bh / 2.0) * h
        return [x1, y1, x2, y2]

    return None


def parse_boxes_xyxy(cfg: dict[str, Any]) -> tuple[list[list[float]], list[str]]:
    boxes_cfg = cfg.get("boxes", [])
    if not isinstance(boxes_cfg, list) or len(boxes_cfg) == 0:
        raise ValueError("No boxes found in config JSON.")

    image_size = _resolve_image_size(cfg)
    boxes: list[list[float]] = []
    labels: list[str] = []
    for idx, raw_item in enumerate(boxes_cfg):
        if not isinstance(raw_item, dict):
            continue
        label = str(raw_item.get("label", f"obj_{idx:04d}"))
        xyxy = _xyxy_from_box_payload(raw_item, image_size)
        if xyxy is None:
            raise ValueError(f"Invalid box at index {idx}: {raw_item}")
        boxes.append([float(x) for x in xyxy])
        labels.append(label)

    if not boxes:
        raise ValueError("No valid boxes parsed from config JSON.")

    return boxes, labels


def resolve_image_path(cfg: dict[str, Any], config_path: Path) -> Path:
    raw = (
        cfg.get("image_path")
        or cfg.get("sourceImagePath")
        or cfg.get("source_image_path")
    )
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError(
            "Config JSON does not contain an image path (image_path/sourceImagePath/source_image_path)."
        )

    image_path = Path(raw)
    if not image_path.is_absolute():
        image_path = (config_path.parent / image_path).resolve()
    if not image_path.exists():
        raise FileNotFoundError(f"Image not found: {image_path}")
    return image_path


def write_manifest(output_dir: Path, payload: dict[str, Any], filename: str = "result_manifest.json") -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = output_dir / filename
    with manifest_path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    return manifest_path


def to_rel_or_abs(paths: Iterable[Path]) -> list[str]:
    return [str(p) for p in paths]
