# SAM3D Objects – Codebase Map and Pipeline Notes

This document summarizes the full module layout and how the inference pipeline is assembled. It also highlights where pose estimation, segmentation, and object detection live (or do not live) in this repo.

## Pipeline Overview (End-to-End)

1. **Entry point / public API**
   - `notebook/inference.py` defines `Inference`, which loads the Hydra config (`checkpoints/hf/pipeline.yaml`) and calls `InferencePipelinePointMap.run`.
   - `demo.py` is a small script that uses the notebook API.

2. **Mask ingestion**
   - The pipeline expects an RGBA input or a separate mask. `Inference.merge_mask_to_rgba` embeds a mask into the alpha channel.
   - `sam3d_objects.pipeline.inference_pipeline.InferencePipeline.merge_image_and_mask` replaces the alpha channel when `mask` is provided.
   - `sam3d_objects.data.dataset.tdfy.img_and_mask_transforms.get_mask` extracts the mask from the alpha channel or from a depth map.

3. **Preprocessing**
   - `sam3d_objects.pipeline.preprocess_utils.get_default_preprocessor` builds a `PreProcessor`.
   - `sam3d_objects.data.dataset.tdfy.preprocessor.PreProcessor` handles joint transforms (crop around mask, background removal) plus per-image/per-mask transforms.
   - `sam3d_objects.data.dataset.tdfy.img_and_mask_transforms.crop_around_mask_with_padding` crops around the mask; `rembg` applies the mask to zero out background.

4. **Depth / pointmap (optional but default in PointMap pipeline)**
   - `sam3d_objects.pipeline.inference_pipeline_pointmap.InferencePipelinePointMap.compute_pointmap` calls a depth model (MoGe) to get pointmaps.
   - `sam3d_objects.pipeline.depth_models.moge.MoGe` wraps MoGe inference and returns `pointmaps`.
   - `sam3d_objects.pipeline.utils.pointmap.infer_intrinsics_from_pointmap` infers camera intrinsics if not provided by the depth model.

5. **Stage 1: Sparse structure generation (SS)**
   - `sam3d_objects.pipeline.inference_pipeline.InferencePipeline.sample_sparse_structure` runs `ss_generator` + `ss_decoder` to produce sparse structure (voxel coordinates).
   - `sam3d_objects.pipeline.inference_utils.pose_decoder` converts model outputs into `rotation`, `translation`, and `scale` (pose).

6. **Stage 2: Sparse latent generation (SLAT) + decoding**
   - `sam3d_objects.pipeline.inference_pipeline.InferencePipeline.sample_slat` runs `slat_generator` to produce sparse latent features.
   - `sam3d_objects.pipeline.inference_pipeline.InferencePipeline.decode_slat` decodes to `mesh` and/or `gaussian` with `slat_decoder_mesh` and `slat_decoder_gs`.

7. **Post-processing**
   - `sam3d_objects.pipeline.inference_pipeline.InferencePipeline.postprocess_slat_output` calls `sam3d_objects.model.backbone.tdfy_dit.utils.postprocessing_utils.to_glb` to produce a GLB.
   - Optional mesh simplification, texture baking, and vertex colors are handled there.

8. **Optional layout post-optimization (pose refinement)**
   - `sam3d_objects.pipeline.inference_pipeline_pointmap.InferencePipelinePointMap.run` optionally runs layout refinement if `with_layout_postprocess=True`.
   - Mesh path uses `sam3d_objects.pipeline.inference_utils.layout_post_optimization` (ICP + render-and-compare).
   - Gaussian path uses `sam3d_objects.pipeline.inference_pipeline_pointmap.run_post_optimization_GS` and helpers in `sam3d_objects.pipeline.layout_post_optimization_utils`.

9. **Optional plane estimation**
   - `sam3d_objects.pipeline.inference_pipeline_pointmap.InferencePipelinePointMap.estimate_plane` uses the alpha mask and pointmap to estimate a ground plane.
   - Uses `sam3d_objects.pipeline.inference_utils.o3d_plane_estimation` and `estimate_plane_area`.

## Where Pose Estimation, Segmentation, and Object Detection Live

**Pose Estimation**
- Main conversion from model outputs to pose is in `sam3d_objects/pipeline/inference_utils.py` (`pose_decoder`).
- Pose representations and conversions are in `sam3d_objects/data/dataset/tdfy/pose_target.py` and `sam3d_objects/data/dataset/tdfy/transforms_3d.py`.
- Pose refinement is done in `sam3d_objects/pipeline/layout_post_optimization_utils.py` and called by `sam3d_objects/pipeline/inference_utils.layout_post_optimization` and the GS post-optimization flow in `sam3d_objects/pipeline/inference_pipeline_pointmap.py`.

**Segmentation**
- There is **no segmentation model** in this repo. The pipeline **expects a mask** (usually from an external segmentation model like SAM) or uses the alpha channel of an RGBA image.
- Mask handling lives in `sam3d_objects/data/dataset/tdfy/img_and_mask_transforms.py` (`get_mask`, `rembg`, and cropping helpers).
- `sam3d_objects/pipeline/preprocess_utils.py` applies `crop_around_mask_with_padding` and `rembg` to focus on the object.

**Object Detection**
- There is **no object detection** module in this repo. Object detection must be done externally if you need to find objects automatically. This pipeline assumes you already have the object mask.

## Module Map (All Files)

### Root / Entry Points

| File | Purpose |
| --- | --- |
| `demo.py` | Minimal demo: loads pipeline, runs inference, saves Gaussian splat. |
| `notebook/inference.py` | Main Inference API + mask utilities + visualization helpers. |
| `checkpoints/hf/pipeline.yaml` | Hydra config for model assembly and weights. |
| `requirements.txt` | Base dependencies. |
| `requirements.p3d.txt` | PyTorch3D-related optional dependencies. |
| `requirements.inference.txt` | Inference dependencies. |
| `requirements.dev.txt` | Dev dependencies. |
| `pyproject.toml` | Build config, deps wiring, optional extras. |
| `README.md` | Project overview and usage. |

### Notebooks, Demos, and Setup Artifacts

| File | Purpose |
| --- | --- |
| `notebook/demo_single_object.ipynb` | Single-object inference demo. |
| `notebook/demo_multi_object.ipynb` | Multi-object inference demo. |
| `notebook/demo_3db_mesh_alignment.ipynb` | Aligns SAM 3D Body meshes with object output. |
| `notebook/mesh_alignment.py` | Utilities for SAM 3D Body mesh alignment using MoGe pointmaps. |
| `notebook/gaussians/` | Example Gaussian splat assets. |
| `notebook/meshes/` | Example mesh assets. |
| `notebook/images/` | Example input images and masks. |
| `patching/hydra` | Script that patches Hydra `utils.py` to a pinned upstream version. |
| `environments/default.yml` | Example environment spec. |
| `doc/setup.md` | Setup instructions. |
| `doc/arch.png` | Architecture figure. |
| `doc/intro.png` | Intro figure. |
| `doc/kidsroom_transparent.gif` | Demo media. |

### `sam3d_objects/` Package

#### Core Init / Config

| File | Purpose |
| --- | --- |
| `sam3d_objects/__init__.py` | Optional module init hook. |
| `sam3d_objects/config/__init__.py` | Config package init. |
| `sam3d_objects/config/utils.py` | Config helpers. |

#### Data Utilities and Dataset Transforms

| File | Purpose |
| --- | --- |
| `sam3d_objects/data/__init__.py` | Data package init. |
| `sam3d_objects/data/utils.py` | Tree utilities, dataset helpers, generic tensor ops. |
| `sam3d_objects/data/dataset/__init__.py` | Dataset package init. |
| `sam3d_objects/data/dataset/tdfy/__init__.py` | TDFY dataset init. |
| `sam3d_objects/data/dataset/tdfy/img_processing.py` | Padding/cropping/resize helpers for images & masks. |
| `sam3d_objects/data/dataset/tdfy/img_and_mask_transforms.py` | Mask extraction, background removal, crop helpers, pointmap masking. |
| `sam3d_objects/data/dataset/tdfy/preprocessor.py` | `PreProcessor` class; joint transforms for image/mask/pointmap. |
| `sam3d_objects/data/dataset/tdfy/transforms_3d.py` | 3D transform composition/decomposition utilities. |
| `sam3d_objects/data/dataset/tdfy/pose_target.py` | Pose target formats and conversions. |

#### Pipeline

| File | Purpose |
| --- | --- |
| `sam3d_objects/pipeline/__init__.py` | Pipeline package init. |
| `sam3d_objects/pipeline/preprocess_utils.py` | Builds default preprocessing pipeline. |
| `sam3d_objects/pipeline/inference_pipeline.py` | Core 2-stage pipeline: SS + SLAT + decoding + GLB postprocess. |
| `sam3d_objects/pipeline/inference_pipeline_pointmap.py` | Adds pointmap depth model + layout post-optimization + plane estimation. |
| `sam3d_objects/pipeline/inference_utils.py` | Pose decoding, layout post-optimization wrappers, plane estimation utilities. |
| `sam3d_objects/pipeline/layout_post_optimization_utils.py` | ICP + render-and-compare post-optimization for pose refinement (mesh/GS). |
| `sam3d_objects/pipeline/depth_models/base.py` | Base class for depth models. |
| `sam3d_objects/pipeline/depth_models/moge.py` | MoGe depth model wrapper returning pointmaps. |
| `sam3d_objects/pipeline/utils/pointmap.py` | Intrinsics inference from pointmaps (MoGe-compatible). |

#### Model IO

| File | Purpose |
| --- | --- |
| `sam3d_objects/model/__init__.py` | Model package init. |
| `sam3d_objects/model/io.py` | Model weight loading utilities. |

#### Model Backbones and Generators

| File | Purpose |
| --- | --- |
| `sam3d_objects/model/backbone/__init__.py` | Backbone package init. |
| `sam3d_objects/model/backbone/dit/__init__.py` | DiT backbone init. |
| `sam3d_objects/model/backbone/dit/embedder/__init__.py` | Embedder init. |
| `sam3d_objects/model/backbone/dit/embedder/dino.py` | DINOv2 image embedder. |
| `sam3d_objects/model/backbone/dit/embedder/pointmap.py` | Pointmap embedding for conditioning. |
| `sam3d_objects/model/backbone/dit/embedder/point_remapper.py` | Pointmap remapping utilities. |
| `sam3d_objects/model/backbone/dit/embedder/embedder_fuser.py` | Fusion of multiple condition embeddings. |
| `sam3d_objects/model/backbone/generator/__init__.py` | Generator init. |
| `sam3d_objects/model/backbone/generator/base.py` | Base generator interface. |
| `sam3d_objects/model/backbone/generator/classifier_free_guidance.py` | CFG logic. |
| `sam3d_objects/model/backbone/generator/flow_matching/__init__.py` | Flow-matching generator init. |
| `sam3d_objects/model/backbone/generator/flow_matching/model.py` | Flow-matching generator model. |
| `sam3d_objects/model/backbone/generator/flow_matching/solver.py` | ODE/SDE solver for flow matching. |
| `sam3d_objects/model/backbone/generator/shortcut/__init__.py` | Shortcut generator init. |
| `sam3d_objects/model/backbone/generator/shortcut/model.py` | Shortcut generator model. |

#### TDFY DiT Models

| File | Purpose |
| --- | --- |
| `sam3d_objects/model/backbone/tdfy_dit/__init__.py` | TDFY DiT init. |
| `sam3d_objects/model/backbone/tdfy_dit/models/__init__.py` | Model registry init. |
| `sam3d_objects/model/backbone/tdfy_dit/models/mot_sparse_structure_flow.py` | Sparse structure flow model. |
| `sam3d_objects/model/backbone/tdfy_dit/models/sparse_structure_flow.py` | Sparse structure flow model. |
| `sam3d_objects/model/backbone/tdfy_dit/models/sparse_structure_vae.py` | VAE for sparse structure. |
| `sam3d_objects/model/backbone/tdfy_dit/models/structured_latent_flow.py` | SLAT flow model. |
| `sam3d_objects/model/backbone/tdfy_dit/models/mm_latent.py` | Multi-modal latent wrapper. |
| `sam3d_objects/model/backbone/tdfy_dit/models/timestep_embedder.py` | Timestep embedding. |
| `sam3d_objects/model/backbone/tdfy_dit/models/structured_latent_vae/__init__.py` | SLAT VAE init. |
| `sam3d_objects/model/backbone/tdfy_dit/models/structured_latent_vae/base.py` | Base VAE class. |
| `sam3d_objects/model/backbone/tdfy_dit/models/structured_latent_vae/encoder.py` | Encoder. |
| `sam3d_objects/model/backbone/tdfy_dit/models/structured_latent_vae/decoder_mesh.py` | Mesh decoder. |
| `sam3d_objects/model/backbone/tdfy_dit/models/structured_latent_vae/decoder_gs.py` | Gaussian splat decoder. |
| `sam3d_objects/model/backbone/tdfy_dit/models/structured_latent_vae/decoder_rf.py` | Radiance-field decoder. |

#### TDFY DiT Representations

| File | Purpose |
| --- | --- |
| `sam3d_objects/model/backbone/tdfy_dit/representations/__init__.py` | Representations init. |
| `sam3d_objects/model/backbone/tdfy_dit/representations/mesh/__init__.py` | Mesh representation init. |
| `sam3d_objects/model/backbone/tdfy_dit/representations/mesh/cube2mesh.py` | Cube-to-mesh conversion. |
| `sam3d_objects/model/backbone/tdfy_dit/representations/mesh/utils_cube.py` | Mesh cube utilities. |
| `sam3d_objects/model/backbone/tdfy_dit/representations/mesh/flexicubes/flexicubes.py` | FlexiCubes mesh extraction. |
| `sam3d_objects/model/backbone/tdfy_dit/representations/mesh/flexicubes/tables.py` | FlexiCubes lookup tables. |
| `sam3d_objects/model/backbone/tdfy_dit/representations/gaussian/__init__.py` | Gaussian representation init. |
| `sam3d_objects/model/backbone/tdfy_dit/representations/gaussian/gaussian_model.py` | Gaussian splat model. |
| `sam3d_objects/model/backbone/tdfy_dit/representations/gaussian/general_utils.py` | Gaussian utilities. |
| `sam3d_objects/model/backbone/tdfy_dit/representations/octree/__init__.py` | Octree representation init. |
| `sam3d_objects/model/backbone/tdfy_dit/representations/octree/octree_dfs.py` | Octree implementation. |
| `sam3d_objects/model/backbone/tdfy_dit/representations/radiance_field/__init__.py` | Radiance field init. |
| `sam3d_objects/model/backbone/tdfy_dit/representations/radiance_field/strivec.py` | Strivec representation. |

#### TDFY DiT Renderers and Utilities

| File | Purpose |
| --- | --- |
| `sam3d_objects/model/backbone/tdfy_dit/renderers/__init__.py` | Renderers init. |
| `sam3d_objects/model/backbone/tdfy_dit/renderers/gaussian_render.py` | Gaussian renderer. |
| `sam3d_objects/model/backbone/tdfy_dit/renderers/octree_renderer.py` | Octree renderer. |
| `sam3d_objects/model/backbone/tdfy_dit/renderers/sh_utils.py` | Spherical harmonics utilities. |
| `sam3d_objects/model/backbone/tdfy_dit/utils/__init__.py` | Utility init. |
| `sam3d_objects/model/backbone/tdfy_dit/utils/postprocessing_utils.py` | GLB postprocess + texture baking. |
| `sam3d_objects/model/backbone/tdfy_dit/utils/render_utils.py` | Rendering helpers for mesh/GS/etc. |
| `sam3d_objects/model/backbone/tdfy_dit/utils/random_utils.py` | Sampling utilities. |

#### TDFY DiT Modules (Attention / Sparse Ops)

| File | Purpose |
| --- | --- |
| `sam3d_objects/model/backbone/tdfy_dit/modules/utils.py` | Module helpers. |
| `sam3d_objects/model/backbone/tdfy_dit/modules/spatial.py` | Sparse up/downsample. |
| `sam3d_objects/model/backbone/tdfy_dit/modules/norm.py` | Normalization layers. |
| `sam3d_objects/model/backbone/tdfy_dit/modules/transformer/__init__.py` | Transformer init. |
| `sam3d_objects/model/backbone/tdfy_dit/modules/transformer/blocks.py` | Transformer blocks. |
| `sam3d_objects/model/backbone/tdfy_dit/modules/transformer/modulated.py` | Modulated transformer blocks. |
| `sam3d_objects/model/backbone/tdfy_dit/modules/attention/__init__.py` | Attention init. |
| `sam3d_objects/model/backbone/tdfy_dit/modules/attention/modules.py` | Attention primitives. |
| `sam3d_objects/model/backbone/tdfy_dit/modules/attention/full_attn.py` | Full attention implementation. |
| `sam3d_objects/model/backbone/tdfy_dit/modules/sparse/__init__.py` | Sparse module init. |
| `sam3d_objects/model/backbone/tdfy_dit/modules/sparse/basic.py` | Sparse tensor basics. |
| `sam3d_objects/model/backbone/tdfy_dit/modules/sparse/linear.py` | Sparse linear ops. |
| `sam3d_objects/model/backbone/tdfy_dit/modules/sparse/spatial.py` | Sparse spatial ops. |
| `sam3d_objects/model/backbone/tdfy_dit/modules/sparse/nonlinearity.py` | Sparse activations. |
| `sam3d_objects/model/backbone/tdfy_dit/modules/sparse/norm.py` | Sparse normalization. |
| `sam3d_objects/model/backbone/tdfy_dit/modules/sparse/conv/__init__.py` | Sparse conv init. |
| `sam3d_objects/model/backbone/tdfy_dit/modules/sparse/conv/conv_spconv.py` | Sparse convolution via spconv. |
| `sam3d_objects/model/backbone/tdfy_dit/modules/sparse/transformer/__init__.py` | Sparse transformer init. |
| `sam3d_objects/model/backbone/tdfy_dit/modules/sparse/transformer/blocks.py` | Sparse transformer blocks. |
| `sam3d_objects/model/backbone/tdfy_dit/modules/sparse/transformer/modulated.py` | Sparse modulated blocks. |
| `sam3d_objects/model/backbone/tdfy_dit/modules/sparse/attention/__init__.py` | Sparse attention init. |
| `sam3d_objects/model/backbone/tdfy_dit/modules/sparse/attention/masked_sdpa.py` | Masked SDPA for sparse attention. |
| `sam3d_objects/model/backbone/tdfy_dit/modules/sparse/attention/windowed_attn.py` | Windowed attention. |
| `sam3d_objects/model/backbone/tdfy_dit/modules/sparse/attention/serialized_attn.py` | Serialized attention. |
| `sam3d_objects/model/backbone/tdfy_dit/modules/sparse/attention/full_attn.py` | Full sparse attention. |
| `sam3d_objects/model/backbone/tdfy_dit/modules/sparse/attention/modules.py` | Sparse attention utilities. |

#### Other Model Components

| File | Purpose |
| --- | --- |
| `sam3d_objects/model/layers/llama3/ff.py` | LLaMA3 FF layer utility. |

#### Visualization

| File | Purpose |
| --- | --- |
| `sam3d_objects/utils/__init__.py` | Utils init. |
| `sam3d_objects/utils/visualization/__init__.py` | Visualization init. |
| `sam3d_objects/utils/visualization/scene_visualizer.py` | Scene visualization helpers. |
| `sam3d_objects/utils/visualization/image_mesh.py` | Image + mesh visualization helpers. |
| `sam3d_objects/utils/visualization/plotly/plot_scene.py` | Plotly scene plotting. |
| `sam3d_objects/utils/visualization/plotly/save_scene.py` | Plotly scene export. |

## Quick Pointers (Where to Read First)

- Pipeline entry: `sam3d_objects/pipeline/inference_pipeline_pointmap.py`
- Pose decoding: `sam3d_objects/pipeline/inference_utils.py`
- Pose representation: `sam3d_objects/data/dataset/tdfy/pose_target.py`
- Mask handling: `sam3d_objects/data/dataset/tdfy/img_and_mask_transforms.py`
- Post-processing / GLB export: `sam3d_objects/model/backbone/tdfy_dit/utils/postprocessing_utils.py`
