# SAM 3D Objects: Output Formats

This file summarizes what you can get from inference outputs.

## Main output keys

The pipeline returns a Python `dict` from `run(...)`:
- merge point: `sam3d_objects/pipeline/inference_pipeline_pointmap.py:504`
- decode options: `sam3d_objects/pipeline/inference_pipeline.py:591`
- postprocess aliases (`glb`, `gs`, `gs_4`): `sam3d_objects/pipeline/inference_pipeline.py:536`

## Available 3D formats

1. `mesh` (raw mesh result)
- Key: `output["mesh"]` (list, one per batch item)
- Type: `MeshExtractResult`
- Source: `sam3d_objects/model/backbone/tdfy_dit/models/structured_latent_vae/decoder_mesh.py:167`
- Mesh fields: `vertices`, `faces`, `vertex_attrs`
  - definition: `sam3d_objects/model/backbone/tdfy_dit/representations/mesh/cube2mesh.py:9`

2. `glb` (postprocessed/export-ready mesh object)
- Key: `output["glb"]`
- Type: `trimesh.Trimesh`
- Built from mesh (+ optional texture baking): `sam3d_objects/model/backbone/tdfy_dit/utils/postprocessing_utils.py:585`
- Added to outputs in postprocess: `sam3d_objects/pipeline/inference_pipeline.py:561`
- Typical export:
```python
output["glb"].export("mesh.glb")
output["glb"].export("mesh.obj")
```

3. `gaussian` (raw gaussian-splat representation)
- Key: `output["gaussian"]` (list, one per batch item)
- Type: list of `Gaussian` objects
- Source: `sam3d_objects/model/backbone/tdfy_dit/models/structured_latent_vae/decoder_gs.py:104`

4. `gs` (single gaussian object alias)
- Key: `output["gs"]`
- Type: `Gaussian` (same as `output["gaussian"][0]`)
- Alias creation: `sam3d_objects/pipeline/inference_pipeline.py:563`
- Typical export to PLY:
```python
output["gs"].save_ply("splat.ply")
```
- `save_ply` implementation: `sam3d_objects/model/backbone/tdfy_dit/representations/gaussian/gaussian_model.py:136`

5. `gaussian_4` / `gs_4` (optional extra gaussian decoder)
- Keys: `output["gaussian_4"]`, `output["gs_4"]`
- Generated only if `"gaussian_4"` is requested and checkpoint/decoder exists:
  - decode: `sam3d_objects/pipeline/inference_pipeline.py:613`
  - alias: `sam3d_objects/pipeline/inference_pipeline.py:566`

## Point-cloud-like outputs

1. `pointmap`
- Key: `output["pointmap"]`
- Type: `torch.Tensor` shaped `(H, W, 3)` (downsampled dense 3D map)
- Returned in pointmap pipeline: `sam3d_objects/pipeline/inference_pipeline_pointmap.py:507`

2. `pointmap_colors`
- Key: `output["pointmap_colors"]`
- Type: `torch.Tensor` shaped `(H, W, 3)` (RGB aligned to pointmap)
- Returned in pointmap pipeline: `sam3d_objects/pipeline/inference_pipeline_pointmap.py:508`

You can convert `pointmap` to a point cloud structure:
- helper: `sam3d_objects/utils/visualization/scene_visualizer.py:198`

## Pose/layout outputs (not a file format, but part of output)

Common keys:
- `translation`, `rotation` (quaternion), `scale`
- decoded in: `sam3d_objects/pipeline/inference_utils.py:563`

These are included in final output dict from `run(...)`.

## Stage-1-only output

If `stage1_only=True`, you get sparse-structure outputs plus:
- `voxel` at `sam3d_objects/pipeline/inference_pipeline_pointmap.py:442`
- `pointmap`, `pointmap_colors` at `sam3d_objects/pipeline/inference_pipeline_pointmap.py:445`

No decoded mesh/gaussian is produced in this mode.

## Special mode: plane estimation

If `estimate_plane=True`, output is a plane-focused dict:
- returns `glb`, `translation`, `rotation`, `scale`
- source: `sam3d_objects/pipeline/inference_pipeline_pointmap.py:574`

## `decode_formats` values

At pipeline level, valid decode strings are:
- `"mesh"`
- `"gaussian"`
- `"gaussian_4"` (optional model path)

Decoder switch:
- `sam3d_objects/pipeline/inference_pipeline.py:609`

Important wrapper note:
- Notebook API currently hardcodes `decode_formats=["mesh","gaussian"]`:
  - `notebook/inference.py:120`
- So `gaussian_4` is not returned unless you call pipeline directly and request it.
