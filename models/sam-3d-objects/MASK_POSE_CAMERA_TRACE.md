# Mask, Pose, and Camera Parameter Trace

This document maps where the code gets:
- object masks,
- object pose (`translation`, `rotation`, `scale`),
- camera parameters (mainly intrinsics).

## 1) Mask: where it comes from

Key point: this repo expects a mask as input. It does not run a built-in object detector/segmenter in the inference path.

- `demo.py:14` loads the image and `demo.py:15` loads one mask file.
- `notebook/inference.py:360` and `notebook/inference.py:365` load masks from files like `0.png`, `1.png`, ...
- `notebook/inference.py:352` converts loaded mask image to binary.
- `notebook/inference.py:94` converts mask to alpha and `notebook/inference.py:98` merges it into RGBA.
- `notebook/inference.py:108` sends RGBA image into the pipeline (`mask` arg is set to `None` afterward).

Inside the pipeline:
- `sam3d_objects/pipeline/inference_pipeline.py:571` can also merge/replace alpha from a provided mask.
- `sam3d_objects/pipeline/inference_pipeline_pointmap.py:190` extracts mask from RGBA via `get_mask(..., "ALPHA_CHANNEL")`.
- `sam3d_objects/data/dataset/tdfy/img_and_mask_transforms.py:139` implements `get_mask`, and `sam3d_objects/data/dataset/tdfy/img_and_mask_transforms.py:163` selects alpha-channel mask.

How the mask is used:
- `sam3d_objects/pipeline/preprocess_utils.py:33` uses mask-aware crop + background removal transforms.
- `sam3d_objects/data/dataset/tdfy/preprocessor.py:90` applies joint image/mask transforms to build model inputs.

## 2) Object pose: where it is produced

Pose decoder setup:
- `sam3d_objects/pipeline/inference_pipeline.py:129` initializes pose decoder.
- `sam3d_objects/pipeline/inference_pipeline.py:294` chooses pose decoder by config (`pose_decoder_name` / pose convention).

Pose prediction flow:
- `sam3d_objects/pipeline/inference_pipeline_pointmap.py:420` runs sparse-structure model (`sample_sparse_structure`).
- `sam3d_objects/pipeline/inference_pipeline_pointmap.py:429` calls `self.pose_decoder(...)`.
- `sam3d_objects/pipeline/inference_utils.py:465` defines `pose_decoder(...)`.
- `sam3d_objects/pipeline/inference_utils.py:553` converts pose-target outputs into instance pose using `PoseTargetConverter`.
- `sam3d_objects/pipeline/inference_utils.py:563` returns:
  - `translation`
  - `rotation` (quaternion)
  - `scale`

Optional pose refinement:
- `sam3d_objects/pipeline/inference_pipeline_pointmap.py:467` enters layout post-optimization.
- `sam3d_objects/pipeline/inference_pipeline_pointmap.py:473` / `sam3d_objects/pipeline/inference_pipeline_pointmap.py:487` can overwrite pose with optimized values.

Returned to caller:
- `sam3d_objects/pipeline/inference_pipeline_pointmap.py:504` returns `ss_return_dict` merged into final output (includes pose keys).
- `notebook/inference.py:264` to `notebook/inference.py:279` consumes `output["rotation"]`, `output["translation"]`, `output["scale"]` to place gaussians in scene coordinates.

## 3) Camera parameters: where they come from

Main inference path uses camera intrinsics from pointmap/depth:
- `sam3d_objects/pipeline/inference_pipeline_pointmap.py:271` calls depth model.
- `sam3d_objects/pipeline/inference_pipeline_pointmap.py:279` reads `output.get("intrinsics", None)`.
- If missing, `sam3d_objects/pipeline/inference_pipeline_pointmap.py:299` infers intrinsics from pointmap using `infer_intrinsics_from_pointmap(...)`.
- `sam3d_objects/pipeline/inference_pipeline_pointmap.py:309` / `sam3d_objects/pipeline/inference_pipeline_pointmap.py:311` stores intrinsics in `point_map_tensor["intrinsics"]`.

How intrinsics are inferred:
- `sam3d_objects/pipeline/utils/pointmap.py:21` defines `infer_intrinsics_from_pointmap`.
- `sam3d_objects/pipeline/utils/pointmap.py:78` recovers focal/shift.
- `sam3d_objects/pipeline/utils/pointmap.py:86` builds intrinsics matrix with `intrinsics_from_focal_center`.

Depth model source:
- `sam3d_objects/pipeline/depth_models/moge.py:6` runs `self.model.infer(...)`.
- `sam3d_objects/pipeline/depth_models/moge.py:9` maps `output["points"]` to `output["pointmaps"]`.

Where intrinsics are used:
- `sam3d_objects/pipeline/inference_pipeline_pointmap.py:475` and `sam3d_objects/pipeline/inference_pipeline_pointmap.py:489` pass intrinsics into layout post-optimization.
- `sam3d_objects/pipeline/inference_pipeline_pointmap.py:321` and `sam3d_objects/pipeline/inference_pipeline_pointmap.py:350` normalize focal terms for optimization.

Important behavior:
- Current `run()` return in `sam3d_objects/pipeline/inference_pipeline_pointmap.py:504` does not include intrinsics explicitly; they are used internally.

## 4) Extra camera path for rendering utilities (not pose estimation)

- `notebook/inference.py:124` computes synthetic render-camera extrinsics/intrinsics from yaw/pitch/r/fov.
- `notebook/inference.py:180` uses those in `render_video(...)`.

## 5) 3DB alignment notebook path (separate utility)

- `notebook/mesh_alignment.py:193` can read focal length from JSON.
- `notebook/mesh_alignment.py:198` otherwise derives focal from MoGe intrinsics.
- `notebook/mesh_alignment.py:71` builds `PerspectiveCameras` with that focal.
