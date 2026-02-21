import argparse
import ast
import json
import os

from inference_on_a_image_v2 import (
    DEFAULT_GROUNDING_DINO_CLASSES,
    get_grounding_output,
    load_image,
    load_model,
    plot_boxes_to_image,
    save_boxes_json,
)


def resolve_text_prompt(text_prompt: str) -> str:
    if text_prompt and text_prompt.strip():
        return text_prompt.strip()
    return ", ".join(DEFAULT_GROUNDING_DINO_CLASSES)


def main():
    parser = argparse.ArgumentParser("Grounding DINO webapp runner", add_help=True)
    parser.add_argument("--config_file", "-c", type=str, required=True, help="path to config file")
    parser.add_argument("--checkpoint_path", "-p", type=str, required=True, help="path to checkpoint file")
    parser.add_argument("--image_path", "-i", type=str, required=True, help="path to image file")
    parser.add_argument(
        "--text_prompt",
        "-t",
        type=str,
        default="",
        required=False,
        help="text prompt (optional, defaults to DEFAULT_GROUNDING_DINO_CLASSES)"
    )
    parser.add_argument("--output_dir", "-o", type=str, required=True, help="output directory")
    parser.add_argument("--box_threshold", type=float, default=0.3, help="box threshold")
    parser.add_argument("--text_threshold", type=float, default=0.25, help="text threshold")
    parser.add_argument("--token_spans", type=str, default=None, help="optional token spans")
    parser.add_argument("--cpu-only", action="store_true", help="run on CPU only")
    args = parser.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)

    text_prompt = resolve_text_prompt(args.text_prompt)
    image_pil, image = load_image(args.image_path)
    model = load_model(args.config_file, args.checkpoint_path, cpu_only=args.cpu_only)
    image_pil.save(os.path.join(args.output_dir, "raw_image.jpg"))

    text_threshold = args.text_threshold
    parsed_token_spans = None
    if args.token_spans is not None:
        parsed_token_spans = ast.literal_eval(args.token_spans)
        text_threshold = None

    boxes_filt, pred_phrases, pred_scores = get_grounding_output(
        model,
        image,
        text_prompt,
        args.box_threshold,
        text_threshold,
        cpu_only=args.cpu_only,
        token_spans=parsed_token_spans,
    )

    plot_labels = [f"{p}({s:.4f})" for p, s in zip(pred_phrases, pred_scores)]
    size = image_pil.size
    pred_dict = {
        "boxes": boxes_filt,
        "size": [size[1], size[0]],
        "labels": plot_labels,
    }

    overlay_path = os.path.join(args.output_dir, "detected_overlay.jpg")
    image_with_box = plot_boxes_to_image(image_pil, pred_dict)[0]
    image_with_box.save(overlay_path)

    raw_json_path = os.path.join(args.output_dir, "detections_full.json")
    save_boxes_json(
        raw_json_path,
        args.image_path,
        size,
        text_prompt,
        args.box_threshold,
        text_threshold if text_threshold is not None else 0.0,
        boxes_filt.tolist(),
        pred_phrases,
        pred_scores,
    )

    boxes_for_web = []
    for idx, label in enumerate(pred_phrases):
        score = float(pred_scores[idx])
        bbox = [float(v) for v in boxes_filt[idx].tolist()]
        boxes_for_web.append(
            {
                "label": label,
                "score": score,
                "bbox": bbox,  # cx, cy, w, h normalized
            }
        )

    web_json_payload = {
        "model": "GroundingDINO",
        "text_prompt": text_prompt,
        "box_threshold": float(args.box_threshold),
        "text_threshold": float(text_threshold) if text_threshold is not None else None,
        "image_path": args.image_path,
        "image_size": {"width": size[0], "height": size[1]},
        "boxes_count": len(boxes_for_web),
        "boxes": boxes_for_web,
        "raw_json_path": raw_json_path,
        "overlay_path": overlay_path,
    }
    web_json_path = os.path.join(args.output_dir, "detections_web.json")
    with open(web_json_path, "w", encoding="utf-8") as f:
        json.dump(web_json_payload, f, indent=2)

    result_manifest = {
        "overlay_path": overlay_path,
        "boxes_json_path": web_json_path,
        "raw_json_path": raw_json_path,
        "boxes_count": len(boxes_for_web),
        "text_prompt": text_prompt,
    }
    result_path = os.path.join(args.output_dir, "result_manifest.json")
    with open(result_path, "w", encoding="utf-8") as f:
        json.dump(result_manifest, f, indent=2)

    print(json.dumps(result_manifest))


if __name__ == "__main__":
    main()
