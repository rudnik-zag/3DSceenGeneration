# Optimize Inference Parameters

This file lists the main parameters you can change to reduce GPU memory usage and speed up inference.  
They are split into **YAML config** (persistent) and **runtime arguments** (per call).

## A) YAML config (`checkpoints/hf/pipeline.yaml`)

These are set once when the pipeline is instantiated.

### Core performance knobs

- `decode_formats`
  - Example: `["gaussian"]` or `["mesh","gaussian"]`
  - Effect: skipping `"mesh"` avoids the mesh decoder (spconv), usually the main OOM source.

- `ss_inference_steps`
  - Default is often `25`.
  - Effect: fewer steps = lower compute and memory in stage‑1.

- `slat_inference_steps`
  - Default is often `25`.
  - Effect: fewer steps = lower compute and memory in stage‑2 decode.

- `downsample_ss_dist`
  - Example: `1` → `2` or `3`.
  - Effect: increases downsampling of sparse structure; reduces memory in decoders.

- `dtype`
  - Example: `float16`, `bfloat16`, `float32`
  - Effect: `float16` uses less memory; `float32` is most stable but largest memory.

- `compile_model`
  - `true`/`false`
  - Effect: `true` can speed up after warmup but may increase memory spikes; `false` is safer.

### Input resolution and preprocessing

These are inside `ss_preprocessor` and `slat_preprocessor`.

- `img_transform.transforms[*].Resize.size`
- `mask_transform.transforms[*].Resize.size`
- `pointmap_transform.transforms[*].Resize.size`
  - Example: `518` → `384` or `320`
  - Effect: lower size reduces memory across the entire pipeline.

- `normalize_pointmap`
  - `true`/`false`
  - Effect: keeps pointmap normalization; not a big memory lever, mostly numerical stability.

- `pointmap_normalizer`
  - `ObjectCentricSSI` options like:
    - `use_scene_scale`
    - `allow_scale_and_shift_override`
  - Effect: affects pose/scale normalization, not a direct memory lever.

### Depth model

- `depth_model`
  - Default: MoGe (`moge-vitl`)
  - Effect: depth model choice affects speed and memory before reconstruction.

## B) Runtime arguments (`InferencePipelinePointMap.run`)

These are passed at call time.

- `decode_formats`
  - Overrides YAML (if you pass it).
  - Use `["gaussian"]` to skip mesh decoding.

- `stage1_only`
  - `true` returns only sparse structure + pointmap (no mesh/gaussian decode).

- `stage1_inference_steps`
  - Overrides `ss_inference_steps` per call.

- `stage2_inference_steps`
  - Overrides `slat_inference_steps` per call.

- `with_mesh_postprocess`
  - `true`/`false`
  - Effect: extra mesh cleanup and simplification; reduces quality artifacts but costs memory/time.

- `with_texture_baking`
  - `true`/`false`
  - Effect: heavy; disables if you just want geometry.

- `with_layout_postprocess`
  - `true`/`false`
  - Effect: optional pose refinement; extra compute.

- `use_vertex_color`
  - `true`/`false`
  - Effect: influences GLB visual output when texture baking is off.

- `estimate_plane`
  - `true`/`false`
  - Effect: early‑exit path that estimates a plane instead of full reconstruction.

## C) Wrapper note (important)

`notebook/inference.py` hardcodes `decode_formats=["mesh","gaussian"]`.  
If you want gaussian‑only to save memory, you must:
- change the wrapper, or
- call the pipeline directly and pass `decode_formats=["gaussian"]`.

## Minimal safe configuration for 24GB VRAM

If you want the highest chance of success on 24GB:

1. `decode_formats: ["gaussian"]`
2. `downsample_ss_dist: 2`
3. `ss_inference_steps: 15`
4. `slat_inference_steps: 15`
5. `Resize.size: 384` in all preprocessors
6. `compile_model: false`

This trades mesh output for stability and lower memory usage.
