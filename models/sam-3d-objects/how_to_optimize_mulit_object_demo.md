# How to Optimize `demo_multi_object.py` for 24GB VRAM

This file describes the changes applied to `demo_multi_object.py`, why they reduce VRAM, and how they address the reported error.

## Summary of what was changed

1. **Sequential, streaming inference**  
   Each mask is processed one at a time. Only the **Gaussian** and **pose** are kept; everything else is discarded immediately.

2. **Explicit VRAM discipline**
   - `torch.inference_mode()` is used to avoid gradients.
   - `cleanup_cuda()` calls `gc.collect()` and `torch.cuda.empty_cache()` at safe points.
   - VRAM logging is added before/after each object.

3. **Gaussian-only decoding by default**
   - `decode_formats` is set to `["gaussian"]` by default.
   - This avoids the mesh decoder (spconv), which is the most common OOM source.

4. **Optional autocast**
   - If supported, bf16 is used; otherwise fp16.
   - This reduces VRAM without changing dependencies.

5. **OOM fallback**
   - If CUDA OOM occurs, the code automatically retries with lower steps.

6. **CPU storage of per-object outputs**
   - Gaussians and pose are moved to CPU right after each object.
   - They are moved back to GPU only for the final scene assembly.

7. **Fix for `save_ply` bf16 error**
   - Added a helper to cast Gaussian tensors to float32 before calling `save_ply`.

## New helper functions (and why)

### `log_vram(tag)`
Logs allocated, reserved, and peak CUDA memory to help identify OOM hotspots.

### `cleanup_cuda()`
Forces Python GC and clears CUDA cache to reduce fragmentation between objects.

### `gaussian_to_device(gs, device)`
Moves all Gaussian internal tensors to CPU or GPU.  
Used to store per-object gaussians on CPU, then move back to GPU for `make_scene`.

### `gaussian_to_float32(gs)`
Fixes:
```
TypeError: Got unsupported ScalarType BFloat16
```
`save_ply()` uses `.numpy()` internally, which does not accept bf16.  
We cast all Gaussian tensors to float32 before exporting.

## Where the OOM risk was

The largest peak is in the mesh decoder (`slat_decoder_mesh`) during:

```
outputs = self.decode_slat(...)
```

To avoid this, the demo now runs **gaussian-only** decoding by default.

## How to tune quality vs VRAM

Inside `cfg` in `demo_multi_object.py`:

- `decode_formats`
  - `["gaussian"]` = lowest VRAM, no mesh
  - `["mesh","gaussian"]` = higher VRAM, mesh output

- `stage1_steps`, `stage2_steps`
  - Lower values reduce VRAM and runtime, but also quality
  - Use `15` or `10` for fallback if OOM occurs

- `max_objects`
  - Hard cap on number of masks processed

- `autocast`
  - `True` for bf16/fp16 memory reduction
  - `False` for full precision (more stable but heavier)

## Error fix: `save_ply` bf16 crash

The reported error:
```
TypeError: Got unsupported ScalarType BFloat16
```

Cause:
- `Gaussian.save_ply()` calls `.numpy()` on bf16 tensors.

Fix:
- `gaussian_to_float32(scene_gs)` before `save_ply()`

Applied in:
- `demo_multi_object.py` just before both `.save_ply(...)` calls.

## Minimal usage example

Keep defaults for stability on 24GB:

- `decode_formats = ["gaussian"]`
- `autocast = True`
- `store_on_cpu = True`
- fallback steps `15`

This should avoid OOM for 10–30 masks on a 3090/4090‑class GPU.
