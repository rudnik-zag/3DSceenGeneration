# SAM 3D Objects Pipeline Graph

```mermaid
graph TD
  %% Inputs
  A[Input Image RGB] --> B[Mask Provided by User]
  B --> C[Merge Mask into Alpha Channel RGBA]
  A --> C

  %% Preprocess + depth
  C --> D[Preprocess Image and Mask]
  C --> E[Depth Model MoGe]
  E --> F[Pointmap HxWx3]
  E --> G[Camera Intrinsics K]
  F --> H[Pointmap Normalization and Mask Crop]
  D --> H

  %% Stage 1: Sparse structure
  H --> I[Sparse Structure Generator]
  I --> J[Sparse Structure Decoder]

  %% Pose estimation
  J --> K[Pose Decoder]
  H --> K
  K --> K1[Pose: Translation]
  K --> K2[Pose: Rotation Quaternion]
  K --> K3[Pose: Scale]

  %% Stage 2: Structured latent + decode
  J --> L[Structured Latent Generator]
  L --> M[Decode Formats]
  M --> M1[Mesh Decoder]
  M --> M2[Gaussian Decoder]
  M --> M3[Gaussian_4 Decoder Optional]

  %% Postprocess + export
  M1 --> N[Mesh Postprocess + Texture Baking]
  N --> O[GLB/OBJ Exportable Mesh]
  M2 --> P[Gaussian Splat PLY Exportable]
  M3 --> P2[Gaussian_4 Optional]

  %% Layout post-optimization
  G --> Q[Layout Post Optimization]
  H --> Q
  O --> Q
  P --> Q
  Q --> Q1[Refined Pose]

  %% Scene assembly
  O --> R[Scene Assembly Optional]
  P --> R
  Q1 --> R

  %% Outputs
  O --> S[Outputs: glb]
  M1 --> T[Outputs: mesh]
  M2 --> U[Outputs: gaussian and gs]
  M3 --> V[Outputs: gaussian_4 and gs_4]
  F --> W[Outputs: pointmap and pointmap_colors]
  K1 --> X[Outputs: translation]
  K2 --> Y[Outputs: rotation]
  K3 --> Z[Outputs: scale]
```

Notes:
- `Mask Provided by User` is required; there is no built-in segmentation step in this pipeline.
- `Camera Intrinsics (K)` are taken from MoGe if available; otherwise inferred from the pointmap.
- `Layout Post-Optimization` is optional and can refine pose using mask, pointmap, and intrinsics.
