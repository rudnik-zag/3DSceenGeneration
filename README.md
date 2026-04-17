# TribalAI Workflow Studio

Full-stack workflow platform for AI/geometry pipelines:
- premium landing page (`/`)
- project dashboard (`/app`)
- infinite canvas editor (`/app/p/[projectId]/canvas`)
- run tracking (`/app/p/[projectId]/runs`)
- 3D viewer (`/app/p/[projectId]/viewer?artifactId=...`)

## Stack
- Next.js 14 (App Router) + TypeScript
- TailwindCSS + shadcn/ui
- Framer Motion
- React Flow
- Three.js (GLB/PLY) + Spark Gaussian Splatting runtime (with legacy fallback)
- BullMQ + Redis
- PostgreSQL + Prisma
- S3-compatible storage (MinIO in local dev)

## What Is Implemented (Current)
- Strict graph/node schema and typed ports.
- Node execution queue with BullMQ worker and run progress/logs.
- Caching: `hash(nodeType + params + orderedInputHashes + mode)`.
- GroundingDINO + SAM2 node flow with guided/full segmentation rules.
- SceneGeneration node (SAM3D Objects) for mesh GLB or Gaussian PLY export.
- Image upload directly in `input.image` node (drag/drop + preview).
- Node creation via canvas context menu (right-click or double-click).
- Edge-drop UX: drag connection to empty canvas -> add-node menu opens and auto-connects.
- Viewer renderer switch:
  - GLB/PLY -> Three.js
  - `.splat/.spz/.compressed.ply/.ksplat` and GS kinds -> Spark GS (fallback to legacy runtime if Spark load fails)
- Local file open in viewer (`.glb/.gltf/.ply/.splat/.spz/.ksplat`).
- Project deletion now deletes DB rows and related storage objects under `projects/{projectId}/`.
- Storage fallback when S3/MinIO is unreachable: uses `.local-storage/`.

## Key Paths
- `app/` routes + APIs
- `components/canvas/` editor + node UI
- `components/viewer/` Three.js + Babylon GS viewer modules
- `lib/execution/` run engine + executors
- `lib/graph/` node registry + planning + cache keys
- `lib/storage/s3.ts` storage, signed URLs, fallback, prefix delete
- `worker/index.ts` BullMQ worker
- `prisma/` schema, migrations, seed
- `docs/PROJECT_DOCUMENTATION.md` full architecture and extension guide
- `docs/IMPLEMENTATION_RUNBOOK.md` deeper implementation notes
- `docs/OBSERVABILITY_ANALYTICS_GUIDE.md` telemetry + analytics APIs
- `docs/METABASE_ANALYTICS_PLAYBOOK.md` Metabase setup and dashboard flow
- `docs/sql/METABASE_QUERIES.sql` ready SQL query pack
- `docs/sql/METABASE_VIEW_QUERIES.sql` view-based query pack
- `scripts/sql/analytics_views.sql` prebuilt DB analytics views

## Prerequisites (Ubuntu)
- Node.js 20+
- Corepack
- Docker + Docker Compose plugin
- `psql` client (recommended for DB checks)
- Optional for real GroundingDINO execution: Conda env `grounding_dino`

If `pnpm` is missing:
```bash
corepack enable
corepack prepare pnpm@9.15.0 --activate
pnpm -v
```

If corepack permission issues appear:
```bash
COREPACK_HOME=/tmp/corepack corepack prepare pnpm@9.15.0 --activate
COREPACK_HOME=/tmp/corepack corepack pnpm -v
```

## Environment Setup
Create `.env`:
```bash
cp .env.example .env
```

Default local values:
```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/tribalai3d?schema=public
REDIS_URL=redis://localhost:6379
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_BUCKET=artifacts
S3_REGION=us-east-1
S3_FORCE_PATH_STYLE=true
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_SPLAT_RUNTIME=auto
NEXT_PUBLIC_SPARK_ENABLED=true
```

Splat runtime env flags:
```env
NEXT_PUBLIC_SPLAT_RUNTIME=auto   # auto | spark | legacy
NEXT_PUBLIC_SPARK_ENABLED=true   # false forces legacy runtime
```

## One-command Local Stack (Recommended)
Use the process manager script:

```bash
bash scripts/dev-stack.sh start
```

Useful commands:
```bash
bash scripts/dev-stack.sh status
bash scripts/dev-stack.sh logs
bash scripts/dev-stack.sh restart
bash scripts/dev-stack.sh stop
bash scripts/dev-stack.sh down
```

Script env options:
```bash
CONDA_ENV_NAME=general_env
USE_DOCKER_INFRA=1
STOP_DOCKER_INFRA=1
COREPACK_HOME_DIR=/tmp/corepack
```

Examples:
```bash
USE_DOCKER_INFRA=0 bash scripts/dev-stack.sh start
STOP_DOCKER_INFRA=0 bash scripts/dev-stack.sh stop
```

Open:
- App: `http://localhost:3000`
- MinIO console: `http://localhost:9001` (`minioadmin` / `minioadmin`)

## Metabase Analytics (Users, Projects, Runs)
Start Metabase:

```bash
bash scripts/metabase-start.sh
```

Install prebuilt analytics views:

```bash
pnpm analytics:views
```

Then follow:
- `docs/METABASE_ANALYTICS_PLAYBOOK.md`
- `docs/sql/METABASE_QUERIES.sql`
- `docs/sql/METABASE_VIEW_QUERIES.sql`

## Concrete Run Instructions (Manual)
This is the manual setup: infra in Docker, app+worker on host.

### 1) Start background infra
```bash
docker compose up -d postgres redis minio
```

### 2) Verify services are alive
```bash
curl -i http://localhost:9000/minio/health/live
psql "postgresql://postgres:postgres@localhost:5432/tribalai3d" -c "select 1;"
```

### 3) Install deps + prepare DB
```bash
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm db:seed
```

### 4) Run app and worker (two terminals)
Terminal A:
```bash
pnpm dev
```
Terminal B:
```bash
pnpm worker
```

Open:
- App: `http://localhost:3000`
- MinIO console: `http://localhost:9001` (`minioadmin` / `minioadmin`)

## Alternative: Run Everything in Docker
```bash
docker compose up --build
```

## GroundingDINO Runtime (Optional but Supported)
`model.groundingdino` is wired to call:
```bash
conda run -n grounding_dino python demo/inference_for_webapp.py ...
```
Expected:
- script: `models/GroundingDINO/demo/inference_for_webapp.py`
- weights path available (for example `models/GroundingDINO/weights/groundingdino_swint_ogc.pth`)

If Conda/env/weights are missing, executor can fail and run will show error logs.

## SAM2 Node Runtime (Guided + Full Modes)
- SAM2 now supports:
  - `Guided (DINO config)` mode (uses GroundingDINO boxes JSON)
  - `Full auto segmentation` mode
- SAM2 produces a single downstream output handle: `config` (JSON).
  - This config JSON includes source image path/hash/storageKey, masksDir, mask paths/count, overlay preview path, selected cfg/checkpoint, and warnings.
- Image resolution order at execution:
  1. Direct SAM2 `Image` input
  2. Image path from connected boxes JSON (`image_path` / `sourceImagePath`)
  3. Error if neither exists
- Server-side config list endpoint for node dropdown:
  - `GET /api/sam2/configs`
- New env settings:
```env
SAM2_REPO_ROOT=/absolute/path/to/models/sam2
SAM2_CHECKPOINT=/absolute/path/to/models/sam2/checkpoints/sam2.1_hiera_large.pt
SAM2_TOOLS_DIR=/absolute/path/to/models/sam2/tools
LOCAL_STORAGE_ROOT=.local-storage
SAM2_EXECUTION_MODE=mock
SAM2_ALLOW_MOCK_FALLBACK=true
SAM2_USE_CONDA=true
SAM2_CONDA_COMMAND=conda
SAM2_CONDA_ENV=sam2
```
- Real execution command builder uses:
  - `conda run -n sam2 python ...` by default
  - `tools/image_auto_mask_export_v2.py` for guided mode
  - `tools/image_auto_mask_export.py` for full mode

## SceneGeneration (SAM3D Objects) Runtime
- Node type: `model.sam3d_objects` (label: `SceneGeneration`)
- Inputs:
  - `config` JSON (from SAM2 `config` output)
  - `masksDir` JSON legacy input is still accepted for older graphs
- Outputs:
  - `scene` as `mesh_glb` or `point_ply`
  - hidden `meta` JSON
- Config endpoint:
  - `GET /api/sam3d/configs` (reads checkpoint tags from `models/sam-3d-objects/checkpoints/*/pipeline.yaml`)
- Runtime env:
```env
SAM3D_REPO_ROOT=/absolute/path/to/models/sam-3d-objects
SAM3D_WEB_SCRIPT=inference_for_webapp_per_object.py
SAM3D_EXECUTION_MODE=mock
SAM3D_ALLOW_MOCK_FALLBACK=true
SAM3D_USE_CONDA=true
SAM3D_CONDA_COMMAND=conda
SAM3D_CONDA_ENV=sam3d-objects
```
- Real command shape:
  - `conda run -n sam3d-objects python models/sam-3d-objects/inference_for_webapp_per_object.py --mode mesh|gaussian --image ... --masks_dir ... --output ... --config hf`
- Local storage layout for model outputs:
  - GroundingDINO: `.local-storage/projects/{projectId}/runs/{runId}/nodes/{nodeId}/groundingdino/`
  - SAM2: `.local-storage/projects/{projectId}/runs/{runId}/nodes/{nodeId}/sam2/`
  - SceneGeneration: `.local-storage/projects/{projectId}/runs/{runId}/nodes/{nodeId}/scene_generation/`

## ComfyUI Runtime (Z-Image + Qwen Edit)
ComfyUI is integrated as an internal backend inference service called by worker executors.

Start ComfyUI in the dedicated conda env:
```bash
pnpm comfy:start
```

Optional launcher envs (for the script above):
```bash
export COMFYUI_CONDA_ENV=comfyui
export COMFYUI_APP_DIR=/absolute/path/to/ComfyUI
export COMFYUI_HOST=127.0.0.1
export COMFYUI_PORT=8188
```
`scripts/comfyui-start.sh` also loads values from project `.env`, so you can set them there instead of exporting each session.

Current real nodes:
- `input.image` with `sourceMode=generate` and `generatorModel=Qwen-Distill` (default)
- `input.image` with `sourceMode=generate` and `generatorModel=Z-Image-Turbo`
- `model.qwen_image_edit`

Required env:
```env
COMFYUI_ENABLED=true
COMFYUI_BASE_URL=http://127.0.0.1:8188
COMFYUI_MODE=on_demand
COMFYUI_ON_DEMAND_IDLE_MS=15000
COMFYUI_START_TIMEOUT_MS=120000
COMFYUI_AUTH_TOKEN=
COMFYUI_TIMEOUT_MS=180000
COMFYUI_ALLOW_MOCK_FALLBACK=true
```

Z-Image settings:
```env
COMFYUI_ZIMAGE_WORKFLOW_PATH=
COMFYUI_ZIMAGE_OUTPUT_NODE_ID=60
COMFYUI_ZIMAGE_TIMEOUT_MS=300000
COMFYUI_ZIMAGE_UNET=z_image_turbo_bf16.safetensors
COMFYUI_ZIMAGE_VAE=ae.safetensors
COMFYUI_ZIMAGE_CLIP=qwen_3_4b.safetensors
COMFYUI_ZIMAGE_CLIP_TYPE=lumina2
COMFYUI_ZIMAGE_CLIP_DEVICE=default
COMFYUI_ZIMAGE_UNET_WEIGHT_DTYPE=default
COMFYUI_ZIMAGE_STEPS=4
COMFYUI_ZIMAGE_CFG=1
COMFYUI_ZIMAGE_SAMPLER=res_multistep
COMFYUI_ZIMAGE_SCHEDULER=simple
COMFYUI_ZIMAGE_DENOISE=1
COMFYUI_ZIMAGE_AURAFLOW_SHIFT=3
COMFYUI_ZIMAGE_NEGATIVE_PROMPT=
# Backward-compatible alias:
COMFYUI_ZIMAGE_CHECKPOINT=
```
- If `COMFYUI_ZIMAGE_WORKFLOW_PATH` is empty, a built-in Comfy API workflow is used.
- Built-in defaults are aligned with blueprint `image_z_image_turbo`.

Qwen Edit settings:
```env
COMFYUI_QWEN_EDIT_WORKFLOW_PATH=
COMFYUI_QWEN_EDIT_OUTPUT_NODE_ID=60
COMFYUI_QWEN_EDIT_TIMEOUT_MS=360000
COMFYUI_QWEN_EDIT_UNET=qwen_image_edit_fp8_e4m3fn.safetensors
COMFYUI_QWEN_EDIT_VAE=qwen_image_vae.safetensors
COMFYUI_QWEN_EDIT_CLIP=qwen_2.5_vl_7b_fp8_scaled.safetensors
COMFYUI_QWEN_EDIT_CLIP_TYPE=qwen_image
COMFYUI_QWEN_EDIT_CLIP_DEVICE=default
COMFYUI_QWEN_EDIT_UNET_WEIGHT_DTYPE=default
COMFYUI_QWEN_EDIT_ENABLE_TURBO_MODE=false
COMFYUI_QWEN_EDIT_STEPS=20
COMFYUI_QWEN_EDIT_CFG=2.5
COMFYUI_QWEN_EDIT_TURBO_STEPS=4
COMFYUI_QWEN_EDIT_TURBO_CFG=1
COMFYUI_QWEN_EDIT_SAMPLER=euler
COMFYUI_QWEN_EDIT_SCHEDULER=simple
COMFYUI_QWEN_EDIT_DENOISE=1
COMFYUI_QWEN_EDIT_AURAFLOW_SHIFT=3
COMFYUI_QWEN_EDIT_NEGATIVE_PROMPT=
COMFYUI_QWEN_EDIT_LORA=Qwen-Image-Edit-Lightning-4steps-V1.0-bf16.safetensors
COMFYUI_QWEN_EDIT_LORA_STRENGTH=1
```
- If `COMFYUI_QWEN_EDIT_WORKFLOW_PATH` is empty, the app uses built-in API defaults extracted from Comfy blueprint `image_qwen_image_edit`.
- If you provide a custom path, it must point to ComfyUI `File -> Export (API)` JSON.
- Template placeholders supported in workflow JSON:
  - `__PROMPT__`
  - `__NEGATIVE_PROMPT__`
  - `__INPUT_IMAGE__`
  - `__FILENAME_PREFIX__`
  - `__SEED__`
  - `__STEPS__`, `__CFG__`, `__SAMPLER__`, `__SCHEDULER__`, `__DENOISE__`
  - `__UNET__`, `__VAE__`, `__CLIP__`, `__CLIP_TYPE__`, `__CLIP_DEVICE__`, `__UNET_WEIGHT_DTYPE__`
  - `__AURAFLOW_SHIFT__`, `__LORA__`, `__LORA_STRENGTH__`

Qwen Distill preset settings (`input.image` -> `Qwen-Distill`):
```env
COMFYUI_QWEN_DISTILL_WORKFLOW_PATH=
COMFYUI_QWEN_DISTILL_OUTPUT_NODE_ID=60
COMFYUI_QWEN_DISTILL_TIMEOUT_MS=420000
COMFYUI_QWEN_DISTILL_UNET=qwen_image_distill_full_fp8_e4m3fn.safetensors
COMFYUI_QWEN_DISTILL_VAE=qwen_image_vae.safetensors
COMFYUI_QWEN_DISTILL_CLIP=qwen_2.5_vl_7b_fp8_scaled.safetensors
COMFYUI_QWEN_DISTILL_CLIP_TYPE=qwen_image
COMFYUI_QWEN_DISTILL_CLIP_DEVICE=default
COMFYUI_QWEN_DISTILL_UNET_WEIGHT_DTYPE=default
COMFYUI_QWEN_DISTILL_STEPS=10
COMFYUI_QWEN_DISTILL_CFG=1
COMFYUI_QWEN_DISTILL_SAMPLER=res_multistep
COMFYUI_QWEN_DISTILL_SCHEDULER=simple
COMFYUI_QWEN_DISTILL_DENOISE=1
COMFYUI_QWEN_DISTILL_WIDTH=1328
COMFYUI_QWEN_DISTILL_HEIGHT=1328
COMFYUI_QWEN_DISTILL_AURAFLOW_SHIFT=3
COMFYUI_QWEN_DISTILL_NEGATIVE_PROMPT=
```
- If `COMFYUI_QWEN_DISTILL_WORKFLOW_PATH` is empty, the app uses built-in workflow defaults extracted from ComfyUI blueprint `image_qwen_image_distill`.
- If you provide a custom path, it must be Comfy API JSON (`Workflow -> Export API`), not UI graph JSON.

Node usage rule:
- `input.image` generation supports `Qwen-Distill` and `Z-Image-Turbo`.
- `Qwen-Image-Edit` is available as dedicated model node: `model.qwen_image_edit` (requires image input).

Security recommendation:
- Keep ComfyUI private/internal only (no public ingress).
- Browser must never call ComfyUI directly.

Runtime modes:
- `COMFYUI_MODE=on_demand` (default): worker auto-starts ComfyUI for Comfy nodes and auto-stops it after `COMFYUI_ON_DEMAND_IDLE_MS`.
- `COMFYUI_MODE=always_on`: keep ComfyUI running as a managed service (`bash scripts/dev-stack.sh start|restart` will start it when `COMFYUI_ENABLED=true`).

## Common Troubleshooting
### `curl: (1) Received HTTP/0.9 when not allowed` on MinIO health URL
Port `9000` is serving something that is not valid MinIO HTTP API for your app.

Fix:
1. Check what owns port 9000:
```bash
sudo lsof -nP -iTCP:9000 -sTCP:LISTEN
```
2. Run MinIO on clean ports:
```bash
minio server ~/minio-data --address :9100 --console-address :9101
```
3. Update `.env`:
```env
S3_ENDPOINT=http://127.0.0.1:9100
```
4. Restart app + worker.

### `relation "UploadAsset" does not exist`
Run migrations:
```bash
pnpm db:migrate
```

### `Database ... does not exist`
Create/start DB service first, then migrate:
```bash
docker compose up -d postgres
pnpm db:migrate
```

### S3 endpoint unavailable / parse errors
Check `.env` endpoint and protocol (`http` vs `https`) and that MinIO is running on that exact port.

## Scripts
- `pnpm dev` start Next.js dev server
- `pnpm worker` start BullMQ worker
- `pnpm db:generate` Prisma client
- `pnpm db:migrate` run migrations
- `pnpm db:seed` seed demo data
- `pnpm build` production build
- `bash scripts/dev-stack.sh start` start infra + app + worker
- `bash scripts/dev-stack.sh stop` stop app + worker + infra, and free app/minio ports
- `bash scripts/dev-stack.sh restart` restart full stack
- `bash scripts/dev-stack.sh status` show process status
- `bash scripts/dev-stack.sh logs` tail app/worker logs
- Optional envs for stop behavior:
  - `APP_PORT` (default `3000`)
  - `EXTRA_STOP_PORTS` (space-separated additional ports to free)

## Notes
- If S3/MinIO is unavailable, uploads/artifacts continue through local fallback at `.local-storage/`.
- Deleting a project now removes:
  - DB rows (`Project`, `Graph`, `Run`, `Artifact`, `CacheEntry`, `UploadAsset`)
  - stored objects under `projects/{projectId}/`.
