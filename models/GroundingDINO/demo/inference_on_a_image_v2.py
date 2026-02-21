import argparse
import json
import os
import sys

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFont

import groundingdino.datasets.transforms as T
from groundingdino.models import build_model
from groundingdino.util.slconfig import SLConfig
from groundingdino.util.utils import clean_state_dict, get_phrases_from_posmap
from groundingdino.util.vl_utils import create_positive_map_from_span

DEFAULT_GROUNDING_DINO_CLASSES = [
    # People & animals
    "person", "man", "woman", "child", "baby",
    "dog", "cat", "bird", "horse", "cow", "sheep",
    
    # Vehicles
    "car", "truck", "bus", "van", "motorcycle", "bicycle",
    "train", "airplane", "boat", "ship",

    # Buildings & structures
    "house", "building", "skyscraper", "garage",
    "bridge", "tower", "fence", "wall", "gate",
    "window", "door", "roof", "balcony",

    # Outdoor environment
    "tree", "bush", "grass", "flower", "plant",
    "rock", "stone", "mountain", "hill",
    "road", "street", "sidewalk", "path",
    "bench", "lamp", "street lamp", "traffic light",
    "sign", "traffic sign", "pole",

    # Urban objects
    "trash", "trash can", "garbage bin", "container",
    "box", "crate", "barrel", "cart",
    "chair", "table", "sofa", "couch",
    "umbrella",

    # Indoor common objects
    "bed", "desk", "cabinet", "shelf", "bookshelf",
    "television", "monitor", "laptop", "keyboard",
    "mouse", "phone", "clock",
    "picture", "painting", "mirror",
    "lamp", "light",

    # Scene-level large objects
    "sky", "cloud", "sun",
    "water", "river", "lake",
    "ground", "floor", "ceiling"
]

def plot_boxes_to_image(image_pil, tgt):
    H, W = tgt["size"]
    boxes = tgt["boxes"]
    labels = tgt["labels"]
    assert len(boxes) == len(labels), "boxes and labels must have same length"

    draw = ImageDraw.Draw(image_pil)
    mask = Image.new("L", image_pil.size, 0)
    mask_draw = ImageDraw.Draw(mask)

    # draw boxes and masks
    for box, label in zip(boxes, labels):
        # from 0..1 to 0..W, 0..H
        box = box * torch.Tensor([W, H, W, H])
        # from xywh to xyxy
        box[:2] -= box[2:] / 2
        box[2:] += box[:2]
        # random color
        color = tuple(np.random.randint(0, 255, size=3).tolist())
        # draw
        x0, y0, x1, y1 = box
        x0, y0, x1, y1 = int(x0), int(y0), int(x1), int(y1)

        draw.rectangle([x0, y0, x1, y1], outline=color, width=6)

        font = ImageFont.load_default()
        if hasattr(font, "getbbox"):
            bbox = draw.textbbox((x0, y0), str(label), font)
        else:
            w, h = draw.textsize(str(label), font)
            bbox = (x0, y0, w + x0, y0 + h)
        draw.rectangle(bbox, fill=color)
        draw.text((x0, y0), str(label), fill="white")

        mask_draw.rectangle([x0, y0, x1, y1], fill=255, width=6)

    return image_pil, mask


def load_image(image_path):
    # load image
    image_pil = Image.open(image_path).convert("RGB")

    transform = T.Compose(
        [
            T.RandomResize([800], max_size=1333),
            T.ToTensor(),
            T.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
        ]
    )
    image, _ = transform(image_pil, None)  # 3, h, w
    return image_pil, image


def load_model(model_config_path, model_checkpoint_path, cpu_only=False):
    args = SLConfig.fromfile(model_config_path)
    args.device = "cuda" if not cpu_only else "cpu"
    model = build_model(args)
    checkpoint = torch.load(model_checkpoint_path, map_location="cpu")
    load_res = model.load_state_dict(clean_state_dict(checkpoint["model"]), strict=False)
    print(load_res)
    _ = model.eval()
    return model


def get_grounding_output(
    model,
    image,
    caption,
    box_threshold,
    text_threshold=None,
    cpu_only=False,
    token_spans=None,
):
    assert text_threshold is not None or token_spans is not None, (
        "text_threshold and token_spans should not be None at the same time!"
    )
    caption = caption.lower()
    caption = caption.strip()
    if not caption.endswith("."):
        caption = caption + "."
    device = "cuda" if not cpu_only else "cpu"
    model = model.to(device)
    image = image.to(device)
    with torch.no_grad():
        outputs = model(image[None], captions=[caption])
    logits = outputs["pred_logits"].sigmoid()[0]  # (nq, 256)
    boxes = outputs["pred_boxes"][0]  # (nq, 4)

    if token_spans is None:
        logits_filt = logits.cpu().clone()
        boxes_filt = boxes.cpu().clone()
        filt_mask = logits_filt.max(dim=1)[0] > box_threshold
        logits_filt = logits_filt[filt_mask]
        boxes_filt = boxes_filt[filt_mask]

        tokenlizer = model.tokenizer
        tokenized = tokenlizer(caption)
        pred_phrases = []
        pred_scores = []
        for logit in logits_filt:
            pred_phrase = get_phrases_from_posmap(logit > text_threshold, tokenized, tokenlizer)
            pred_phrases.append(pred_phrase)
            pred_scores.append(logit.max().item())
    else:
        positive_maps = create_positive_map_from_span(
            model.tokenizer(caption),
            token_span=token_spans,
        ).to(image.device)

        logits_for_phrases = positive_maps @ logits.T  # n_phrase, nq
        all_logits = []
        all_phrases = []
        all_boxes = []
        for (token_span, logit_phr) in zip(token_spans, logits_for_phrases):
            phrase = " ".join([caption[_s:_e] for (_s, _e) in token_span])
            filt_mask = logit_phr > box_threshold
            all_boxes.append(boxes[filt_mask])
            all_logits.append(logit_phr[filt_mask])
            num_hits = int(filt_mask.sum().item())
            all_phrases.extend([phrase for _ in range(num_hits)])

        boxes_filt = torch.cat(all_boxes, dim=0).cpu()
        pred_phrases = all_phrases
        pred_scores = torch.cat(all_logits, dim=0).cpu().tolist()

    return boxes_filt, pred_phrases, pred_scores


def _clamp(value, min_value, max_value):
    return max(min_value, min(max_value, value))


def boxes_cxcywh_to_xyxy(boxes, width, height, clamp=True):
    out = []
    for box in boxes:
        cx, cy, w, h = [float(v) for v in box]
        x0 = (cx - w / 2.0) * width
        y0 = (cy - h / 2.0) * height
        x1 = (cx + w / 2.0) * width
        y1 = (cy + h / 2.0) * height
        if clamp:
            x0 = _clamp(x0, 0.0, width)
            y0 = _clamp(y0, 0.0, height)
            x1 = _clamp(x1, 0.0, width)
            y1 = _clamp(y1, 0.0, height)
        out.append([x0, y0, x1, y1])
    return out


def boxes_xyxy_to_xywh(boxes_xyxy):
    out = []
    for x0, y0, x1, y1 in boxes_xyxy:
        out.append([x0, y0, x1 - x0, y1 - y0])
    return out


def save_boxes_json(
    json_path,
    image_path,
    image_size,
    text_prompt,
    box_threshold,
    text_threshold,
    boxes_cxcywh_norm,
    labels,
    scores,
):
    width = image_size[0]
    height = image_size[1]
    boxes_xyxy = boxes_cxcywh_to_xyxy(boxes_cxcywh_norm, width, height)
    boxes_xyxy_norm = [
        [b[0] / width, b[1] / height, b[2] / width, b[3] / height] for b in boxes_xyxy
    ]
    boxes_xywh = boxes_xyxy_to_xywh(boxes_xyxy)

    items = []
    for idx, (label, score) in enumerate(zip(labels, scores)):
        x0, y0, x1, y1 = boxes_xyxy[idx]
        items.append(
            {
                "label": label,
                "score": float(score),
                "box_cxcywh_norm": [float(v) for v in boxes_cxcywh_norm[idx]],
                "box_xyxy": [float(x0), float(y0), float(x1), float(y1)],
                "box_xyxy_int": [int(round(x0)), int(round(y0)), int(round(x1)), int(round(y1))],
                "box_xyxy_norm": [float(v) for v in boxes_xyxy_norm[idx]],
                "box_xywh": [float(v) for v in boxes_xywh[idx]],
            }
        )

    payload = {
        "image_path": image_path,
        "image_size": {"width": width, "height": height},
        "text_prompt": text_prompt,
        "box_threshold": box_threshold,
        "text_threshold": text_threshold,
        "boxes": items,
    }

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)


if __name__ == "__main__":
    parser = argparse.ArgumentParser("Grounding DINO example (v2)", add_help=True)
    parser.add_argument("--config_file", "-c", type=str, required=True, help="path to config file")
    parser.add_argument(
        "--checkpoint_path", "-p", type=str, required=True, help="path to checkpoint file"
    )
    parser.add_argument("--image_path", "-i", type=str, required=True, help="path to image file")
    parser.add_argument("--text_prompt", "-t", type=str, required=True, help="text prompt")
    parser.add_argument(
        "--output_dir", "-o", type=str, default="outputs", required=True, help="output directory"
    )
    parser.add_argument(
        "--json_output",
        type=str,
        default=None,
        help="path to JSON output file (default: <output_dir>/pred_boxes.json)",
    )

    parser.add_argument("--box_threshold", type=float, default=0.3, help="box threshold")
    parser.add_argument("--text_threshold", type=float, default=0.25, help="text threshold")
    parser.add_argument(
        "--token_spans",
        type=str,
        default=None,
        help=(
            "The positions of start and end positions of phrases of interest. "
            "For example, a caption is 'a cat and a dog', "
            "if you would like to detect 'cat', the token_spans should be '[[[2, 5]], ]', "
            "since 'a cat and a dog'[2:5] is 'cat'. "
            "if you would like to detect 'a cat', the token_spans should be '[[[0, 1], [2, 5]], ]', "
            "since 'a cat and a dog'[0:1] is 'a', and 'a cat and a dog'[2:5] is 'cat'."
        ),
    )

    parser.add_argument("--cpu-only", action="store_true", help="running on cpu only!, default=False")
    args = parser.parse_args()

    config_file = args.config_file
    checkpoint_path = args.checkpoint_path
    image_path = args.image_path
    text_prompt = args.text_prompt
    output_dir = args.output_dir
    box_threshold = args.box_threshold
    text_threshold = args.text_threshold
    token_spans = args.token_spans

    os.makedirs(output_dir, exist_ok=True)

    image_pil, image = load_image(image_path)
    model = load_model(config_file, checkpoint_path, cpu_only=args.cpu_only)

    image_pil.save(os.path.join(output_dir, "raw_image.jpg"))

    if token_spans is not None:
        text_threshold = None
        print("Using token_spans. Set the text_threshold to None.")

    boxes_filt, pred_phrases, pred_scores = get_grounding_output(
        model,
        image,
        text_prompt,
        box_threshold,
        text_threshold,
        cpu_only=args.cpu_only,
        token_spans=eval(f"{token_spans}"),
    )

    plot_labels = [f"{p}({s:.4f})" for p, s in zip(pred_phrases, pred_scores)]
    size = image_pil.size  # (W, H)
    pred_dict = {
        "boxes": boxes_filt,
        "size": [size[1], size[0]],  # H, W
        "labels": plot_labels,
    }

    image_with_box = plot_boxes_to_image(image_pil, pred_dict)[0]
    image_with_box.save(os.path.join(output_dir, "pred.jpg"))

    json_output = args.json_output or os.path.join(output_dir, "pred_boxes.json")
    save_boxes_json(
        json_output,
        image_path,
        size,
        text_prompt,
        box_threshold,
        text_threshold,
        boxes_filt.tolist(),
        pred_phrases,
        pred_scores,
    )
