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
