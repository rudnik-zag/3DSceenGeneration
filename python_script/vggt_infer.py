#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

import cv2
import numpy as np


MODEL_ID = "facebook/VGGT-1B"
MODEL_URL = "https://huggingface.co/facebook/VGGT-1B/resolve/main/model.pt"
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run VGGT on a single image or MP4 video and export a manifest for GraphEdit."
    )
    parser.add_argument("--repo-root", type=Path, required=True, help="Path to the VGGT repo root.")
    parser.add_argument("--input", type=Path, required=True, help="Path to the input image or MP4 video.")
    parser.add_argument("--output-dir", type=Path, required=True, help="Directory for exported outputs.")
    parser.add_argument("--device", choices=("auto", "cuda", "cpu"), default="auto")
    parser.add_argument("--video-fps", default="1.0", help="Frame sampling FPS for MP4 input, or 'auto'.")
    parser.add_argument("--max-frames", type=int, default=32)
    parser.add_argument("--save-npz", action="store_true")
    return parser


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def prepare_imports(repo_root: Path) -> None:
    sys.path.insert(0, str(repo_root))


def parse_video_fps_arg(raw_value: str) -> float | str:
    value = str(raw_value).strip().lower()
    if value in {"auto", "native", "full"}:
        return "auto"

    try:
        parsed = float(value)
    except ValueError as exc:
        raise ValueError("--video-fps must be a positive number or one of: auto, native, full") from exc

    if parsed <= 0:
        raise ValueError("--video-fps must be > 0")
    return parsed


def resolve_device(device_arg: str):
    import torch

    if device_arg == "cpu":
        return torch.device("cpu")
    if device_arg == "cuda":
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA was requested for VGGT but is not available.")
        return torch.device("cuda")
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def get_autocast_dtype(device) -> Any | None:
    import torch

    if device.type != "cuda":
        return None
    major_cc = torch.cuda.get_device_capability(device=device)[0]
    return torch.bfloat16 if major_cc >= 8 else torch.float16


def load_model(device):
    import torch

    from vggt.models.vggt import VGGT

    model = VGGT()
    state_dict = torch.hub.load_state_dict_from_url(MODEL_URL, map_location="cpu")
    model.load_state_dict(state_dict)
    model.eval()
    model.to(device)
    return model


def list_image_input(input_path: Path) -> list[Path]:
    if input_path.suffix.lower() not in IMAGE_SUFFIXES:
        raise ValueError(f"Unsupported image input: {input_path}")
    return [input_path]


def extract_video_frames(
    input_path: Path, frames_dir: Path, sample_fps: float | str, max_frames: int
) -> tuple[list[Path], list[dict[str, float | int]], float]:
    ensure_dir(frames_dir)
    capture = cv2.VideoCapture(str(input_path))
    if not capture.isOpened():
        raise RuntimeError(f"Unable to open video: {input_path}")

    native_fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
    use_native_fps = sample_fps == "auto"
    if use_native_fps:
        frame_step = 1
        effective_fps = native_fps if native_fps > 0 else 0.0
    else:
        assert isinstance(sample_fps, float)
        if native_fps > 0:
            effective_fps = min(sample_fps, native_fps)
            frame_step = max(int(round(native_fps / sample_fps)), 1)
        else:
            effective_fps = sample_fps
            frame_step = 1

    frame_paths: list[Path] = []
    frame_infos: list[dict[str, float | int]] = []
    frame_index = 0

    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            if frame_index % frame_step != 0:
                frame_index += 1
                continue

            output_path = frames_dir / f"frame_{len(frame_paths):06d}.png"
            cv2.imwrite(str(output_path), frame)
            frame_paths.append(output_path)
            frame_infos.append(
                {
                    "source_frame_index": frame_index,
                    "timestamp_sec": frame_index / native_fps if native_fps > 0 else float(len(frame_paths) - 1),
                }
            )
            frame_index += 1
            if len(frame_paths) >= max(1, max_frames):
                break
    finally:
        capture.release()

    if not frame_paths:
        raise RuntimeError(f"No frames extracted from video: {input_path}")

    return frame_paths, frame_infos, effective_fps


def load_inputs(input_path: Path, video_fps: float | str, max_frames: int, output_dir: Path):
    suffix = input_path.suffix.lower()
    if suffix == ".mp4":
        frame_paths, frame_infos, effective_fps = extract_video_frames(
            input_path, output_dir / "frames", video_fps, max_frames
        )
        return {
            "media_type": "video",
            "frame_paths": frame_paths,
            "frame_infos": frame_infos,
            "fps": effective_fps,
        }

    return {
        "media_type": "image",
        "frame_paths": list_image_input(input_path),
        "frame_infos": [{"source_frame_index": 0, "timestamp_sec": 0.0}],
        "fps": 0.0,
    }


def run_inference(model, frame_paths: list[Path], device):
    import torch

    from vggt.utils.load_fn import load_and_preprocess_images
    from vggt.utils.pose_enc import pose_encoding_to_extri_intri

    def tensor_to_numpy(tensor: torch.Tensor) -> np.ndarray:
        detached = tensor.detach()
        if detached.dtype == torch.bfloat16:
            detached = detached.to(dtype=torch.float32)
        return detached.cpu().numpy()

    images = load_and_preprocess_images([str(path) for path in frame_paths]).to(device)
    dtype = get_autocast_dtype(device)

    with torch.no_grad():
        if device.type == "cuda":
            with torch.cuda.amp.autocast(dtype=dtype):
                batch_images = images.unsqueeze(0)
                aggregated_tokens_list, patch_start_idx = model.aggregator(batch_images)
                pose_enc = model.camera_head(aggregated_tokens_list)[-1]
                depth, depth_conf = model.depth_head(aggregated_tokens_list, batch_images, patch_start_idx)
        else:
            batch_images = images.unsqueeze(0)
            aggregated_tokens_list, patch_start_idx = model.aggregator(batch_images)
            pose_enc = model.camera_head(aggregated_tokens_list)[-1]
            depth, depth_conf = model.depth_head(aggregated_tokens_list, batch_images, patch_start_idx)

    extrinsic, intrinsic = pose_encoding_to_extri_intri(pose_enc, batch_images.shape[-2:])
    return {
        "images": tensor_to_numpy(batch_images.squeeze(0)),
        "pose_enc": tensor_to_numpy(pose_enc.squeeze(0)),
        "depth": tensor_to_numpy(depth.squeeze(0)),
        "depth_conf": tensor_to_numpy(depth_conf.squeeze(0)),
        "extrinsic": tensor_to_numpy(extrinsic.squeeze(0)),
        "intrinsic": tensor_to_numpy(intrinsic.squeeze(0)),
    }


def normalize_depth_stack(depth: np.ndarray) -> list[np.ndarray]:
    flattened = depth[..., 0] if depth.ndim == 4 else depth
    finite = flattened[np.isfinite(flattened)]
    if finite.size == 0:
        return [np.zeros(frame.shape[:2], dtype=np.uint8) for frame in flattened]

    low = float(np.percentile(finite, 2))
    high = float(np.percentile(finite, 98))
    if not np.isfinite(low):
        low = float(np.min(finite))
    if not np.isfinite(high):
        high = float(np.max(finite))
    if high <= low:
        high = low + 1e-6

    normalized: list[np.ndarray] = []
    for frame in flattened:
        clipped = np.clip(frame, low, high)
        scaled = (clipped - low) / (high - low)
        normalized.append(np.round(scaled * 255.0).astype(np.uint8))
    return normalized


def verify_video_file(output_path: Path) -> None:
    if not output_path.exists() or output_path.stat().st_size <= 0:
        raise RuntimeError(f"OpenCV did not create a video file: {output_path}")

    capture = cv2.VideoCapture(str(output_path))
    try:
        if not capture.isOpened():
            raise RuntimeError(f"OpenCV created an unreadable video file: {output_path}")
        ok, frame = capture.read()
        if not ok or frame is None or frame.size == 0:
            raise RuntimeError(f"OpenCV created a video with no readable frames: {output_path}")
    finally:
        capture.release()


def encode_depth_sequence_preview(depth_dir: Path, frame_count: int, output_path: Path, fps: float) -> str | None:
    if frame_count <= 1:
        return None

    first_frame = cv2.imread(str(depth_dir / "depth_000000.png"), cv2.IMREAD_UNCHANGED)
    if first_frame is None or first_frame.size == 0:
        raise RuntimeError("Failed to read the first VGGT depth preview frame for video encoding.")

    height, width = first_frame.shape[:2]
    writer = cv2.VideoWriter(
        str(output_path),
        cv2.VideoWriter_fourcc(*"mp4v"),
        float(fps if fps > 0 else 12.0),
        (width, height),
    )
    if not writer.isOpened():
        raise RuntimeError(f"Failed to open OpenCV video writer for {output_path}")

    try:
        for index in range(frame_count):
            frame_path = depth_dir / f"depth_{index:06d}.png"
            frame = cv2.imread(str(frame_path), cv2.IMREAD_UNCHANGED)
            if frame is None or frame.size == 0:
                raise RuntimeError(f"Failed to read VGGT depth preview frame: {frame_path}")
            if frame.ndim == 2:
                frame = cv2.cvtColor(frame, cv2.COLOR_GRAY2BGR)
            elif frame.shape[2] == 4:
                frame = cv2.cvtColor(frame, cv2.COLOR_BGRA2BGR)
            writer.write(frame)
    finally:
        writer.release()

    verify_video_file(output_path)
    return str(output_path)


def relativize(path_value: str | Path | None, output_dir: Path) -> str | None:
    if path_value is None:
        return None
    return os.path.relpath(str(path_value), str(output_dir))


def save_json(path_value: Path, payload: dict[str, Any]) -> None:
    ensure_dir(path_value.parent)
    path_value.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def save_outputs(
    output_dir: Path,
    input_path: Path,
    loaded: dict[str, Any],
    predictions: dict[str, np.ndarray],
    save_npz: bool,
    device_label: str,
) -> None:
    ensure_dir(output_dir)
    depth_dir = output_dir / "depth_frames"
    raw_depth_dir = output_dir / "depth_raw"
    ensure_dir(depth_dir)
    ensure_dir(raw_depth_dir)

    frame_paths: list[Path] = loaded["frame_paths"]
    frame_infos: list[dict[str, float | int]] = loaded["frame_infos"]
    frame_names = [path.name for path in frame_paths]
    normalized_depth = normalize_depth_stack(predictions["depth"])

    sequence_entries: list[dict[str, Any]] = []
    for index, frame_name in enumerate(frame_names):
        preview_path = depth_dir / f"depth_{index:06d}.png"
        raw_depth_path = raw_depth_dir / f"depth_{index:06d}.npy"
        cv2.imwrite(str(preview_path), normalized_depth[index])
        np.save(raw_depth_path, predictions["depth"][index])
        sequence_entries.append(
            {
                "index": index,
                "frame_name": frame_name,
                "depth_preview_path": relativize(preview_path, output_dir),
                "raw_depth_path": relativize(raw_depth_path, output_dir),
                "source_frame_index": int(frame_infos[index]["source_frame_index"]),
                "timestamp_sec": float(frame_infos[index]["timestamp_sec"]),
            }
        )

    camera_payload = {
        "intrinsics": predictions["intrinsic"].tolist(),
        "extrinsics": predictions["extrinsic"].tolist(),
        "pose_enc": predictions["pose_enc"].tolist(),
        "frame_names": frame_names,
        "frame_count": len(frame_names),
        "input_type": loaded["media_type"],
        "preprocessed_image_shape": list(predictions["images"].shape[1:]),
        "model_id": MODEL_ID,
        "device": device_label,
    }
    camera_path = output_dir / "camera.json"
    save_json(camera_path, camera_payload)

    metadata = {
        "input_path": str(input_path),
        "media_type": loaded["media_type"],
        "frame_count": len(frame_names),
        "fps": float(loaded["fps"]),
        "frame_names": frame_names,
        "preprocessed_image_shape": list(predictions["images"].shape[1:]),
        "model_id": MODEL_ID,
        "device": device_label,
        "outputs": {
            "camera_json_path": "camera.json",
            "depth_preview_dir": "depth_frames",
            "raw_depth_dir": "depth_raw",
        },
    }
    metadata_path = output_dir / "metadata.json"
    save_json(metadata_path, metadata)

    sequence_manifest = {
        "media_type": loaded["media_type"],
        "frame_count": len(sequence_entries),
        "fps": float(loaded["fps"]),
        "frames": sequence_entries,
    }
    sequence_manifest_path = output_dir / "depth_sequence_manifest.json"
    save_json(sequence_manifest_path, sequence_manifest)

    npz_path: str | None = None
    if save_npz:
        raw_prediction_path = output_dir / "predictions.npz"
        np.savez_compressed(
            raw_prediction_path,
            images=predictions["images"],
            pose_enc=predictions["pose_enc"],
            depth=predictions["depth"],
            depth_conf=predictions["depth_conf"],
            extrinsic=predictions["extrinsic"],
            intrinsic=predictions["intrinsic"],
        )
        npz_path = str(raw_prediction_path)

    depth_video_path = encode_depth_sequence_preview(
        depth_dir=depth_dir,
        frame_count=len(sequence_entries),
        output_path=output_dir / "depth_preview.mp4",
        fps=float(loaded["fps"]),
    )

    result_manifest = {
        "status": "success",
        "model_id": MODEL_ID,
        "device": device_label,
        "media_type": loaded["media_type"],
        "input_path": str(input_path),
        "frame_count": len(sequence_entries),
        "fps": float(loaded["fps"]),
        "depth_preview_path": relativize(depth_dir / "depth_000000.png", output_dir),
        "depth_video_path": relativize(depth_video_path, output_dir),
        "camera_json_path": relativize(camera_path, output_dir),
        "sequence_manifest_path": relativize(sequence_manifest_path, output_dir),
        "npz_path": relativize(npz_path, output_dir),
        "metadata_path": relativize(metadata_path, output_dir),
    }
    save_json(output_dir / "result_manifest.json", result_manifest)
    print(json.dumps(result_manifest))


def main() -> int:
    args = build_parser().parse_args()
    repo_root = args.repo_root.resolve()
    input_path = args.input.resolve()
    output_dir = args.output_dir.resolve()

    if not input_path.exists():
        raise FileNotFoundError(f"Input path does not exist: {input_path}")

    ensure_dir(output_dir)
    prepare_imports(repo_root)
    loaded = load_inputs(
        input_path=input_path,
        video_fps=parse_video_fps_arg(args.video_fps),
        max_frames=max(1, int(args.max_frames)),
        output_dir=output_dir,
    )

    device = resolve_device(args.device)
    model = load_model(device)
    predictions = run_inference(model, loaded["frame_paths"], device)
    save_outputs(
        output_dir=output_dir,
        input_path=input_path,
        loaded=loaded,
        predictions=predictions,
        save_npz=bool(args.save_npz),
        device_label=str(device),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
