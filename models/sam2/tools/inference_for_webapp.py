#!/usr/bin/env python3
"""SAM2 webapp wrapper.

This script is the stable entrypoint for the web app.
It dispatches to webapp-specific tools:
  - image_auto_mask_export_v2_webapp.py (guided mode)
  - image_auto_mask_export_webapp.py (full mode)
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="SAM2 webapp wrapper.")
    parser.add_argument("--mode", choices=["guided", "full"], required=True)
    parser.add_argument("--config", help="Boxes JSON config (guided mode).")
    parser.add_argument("--image", help="Input image path (full mode).")
    parser.add_argument("--output", required=True, help="Output directory.")
    parser.add_argument("--sam2_cfg", required=True, help="SAM2 config YAML.")
    parser.add_argument("--sam2_checkpoint", required=True, help="SAM2 checkpoint.")
    parser.add_argument("--points-per-side", type=int, default=64)
    parser.add_argument("--pred-iou-thresh", type=float, default=0.7)
    parser.add_argument("--stability-score-thresh", type=float, default=0.9)
    parser.add_argument("--crop-n-layers", type=int, default=1)
    parser.add_argument("--overlay-alpha", type=float, default=0.6)
    parser.add_argument("--device", default=None, help="Optional override for device (cuda/cpu).")
    parser.add_argument("--multimask-output", action="store_true", help="Guided mode: export multimask output.")
    parser.add_argument("--overlay", default="overlay.jpg", help="Overlay filename in output directory.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    tools_dir = Path(__file__).resolve().parent

    if args.mode == "guided":
        if not args.config:
            raise ValueError("--config is required for guided mode")
        script = tools_dir / "image_auto_mask_export_v2_webapp.py"
        cmd = [
            sys.executable,
            str(script),
            "--config",
            args.config,
            "--output",
            args.output,
            "--sam2_cfg",
            args.sam2_cfg,
            "--sam2_checkpoint",
            args.sam2_checkpoint,
            "--overlay",
            args.overlay,
            "--overlay-alpha",
            str(args.overlay_alpha),
        ]
        if args.device:
            cmd.extend(["--device", args.device])
        if args.multimask_output:
            cmd.append("--multimask-output")
    else:
        if not args.image:
            raise ValueError("--image is required for full mode")
        script = tools_dir / "image_auto_mask_export_webapp.py"
        cmd = [
            sys.executable,
            str(script),
            "--image",
            args.image,
            "--output",
            args.output,
            "--sam2_cfg",
            args.sam2_cfg,
            "--sam2_checkpoint",
            args.sam2_checkpoint,
            "--points-per-side",
            str(args.points_per_side),
            "--pred-iou-thresh",
            str(args.pred_iou_thresh),
            "--stability-score-thresh",
            str(args.stability_score_thresh),
            "--crop-n-layers",
            str(args.crop_n_layers),
            "--overlay",
            args.overlay,
            "--overlay-alpha",
            str(args.overlay_alpha),
        ]
        if args.device:
            cmd.extend(["--device", args.device])

    print(f"SAM2 COMMAND: {' '.join(cmd)}")
    result = subprocess.run(cmd, check=False, capture_output=True, text=True)
    if result.stdout.strip():
        print(result.stdout.strip())
    if result.stderr.strip():
        print(result.stderr.strip(), file=sys.stderr)

    if result.returncode != 0:
        raise RuntimeError(
            f"SAM2 wrapper failed (exit={result.returncode})\n"
            f"cmd={' '.join(cmd)}\n"
            f"stdout={result.stdout[-5000:]}\n"
            f"stderr={result.stderr[-5000:]}"
        )

    manifest = {
        "mode": args.mode,
        "output_dir": args.output,
        "wrapped_script": str(script),
        "stdout_tail": result.stdout[-2000:],
    }
    print(json.dumps(manifest))


if __name__ == "__main__":
    main()
