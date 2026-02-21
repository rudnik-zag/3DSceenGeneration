# TribalAI Workflow Studio: Implementation Runbook

This document is synced with the current repository behavior and `README.md`.

## 1) Current Implementation Status

### Product Surface
- Landing page: `/`
- Dashboard: `/app`
- Canvas editor: `/app/p/[projectId]/canvas`
- Runs page: `/app/p/[projectId]/runs`
- Viewer page: `/app/p/[projectId]/viewer?artifactId=...`

### Core Stack
- Next.js 14 App Router + TypeScript
- Tailwind + shadcn/ui
- React Flow (canvas)
- Three.js + Babylon.js Gaussian Splat renderer switch
- BullMQ + Redis
- PostgreSQL + Prisma
- S3-compatible storage (MinIO in dev)

### Graph/Execution
- Typed node registry and DAG planning.
- Worker executes topological plan with run logs/progress.
- Node-level caching with deterministic key:
  - `hash(nodeType + params + orderedInputArtifactHashes + mode)`
- Node-run supports `startNodeId` (run selected node + dependencies).
- `input.image` source handling:
  - Uses uploaded source directly (`storageKey`) instead of re-triggering fake processing.

### Canvas UX
- Right-click/double-click context menu for add-node.
- Node categories in menu: Inputs / Models / Geometry / Outputs.
- Drag edge to empty canvas -> add-node menu opens and auto-connects.
- Node delete works from toolbar/keyboard.

### Viewer
- Renderer auto-switch:
  - Three.js for `mesh_glb`, `point_ply` (and standard `.ply/.glb/.gltf`)
  - Babylon GS for `.splat/.spz/.compressed.ply/.ksplat` and GS kinds
- Local file load in viewer supports above formats.

### Storage
- Signed URL flow when MinIO is healthy.
- Automatic fallback to `.local-storage/` when S3 endpoint is unavailable.
- Project delete now also removes storage objects under `projects/{projectId}/`.

## 2) Prerequisites (Ubuntu)

- Node.js 20+
- Corepack
- Docker + Docker Compose plugin
- Optional: `psql`, `redis-cli`, Conda (`grounding_dino` env for real DINO runtime)

If `pnpm` is missing:
```bash
corepack enable
corepack prepare pnpm@9.15.0 --activate
pnpm -v
```

If corepack permission issues occur:
```bash
COREPACK_HOME=/tmp/corepack corepack prepare pnpm@9.15.0 --activate
COREPACK_HOME=/tmp/corepack corepack pnpm -v
```

## 3) Environment Configuration

Create env:
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
```

If port `9000` is bad/occupied, run MinIO on `9100` and change:
```env
S3_ENDPOINT=http://127.0.0.1:9100
```

## 4) Full Local Run (Recommended)

### Step 1: Start background infra
```bash
docker compose up -d postgres redis minio
```

### Step 2: Verify infra
```bash
curl -i http://localhost:9000/minio/health/live
psql "postgresql://postgres:postgres@localhost:5432/tribalai3d" -c "select 1;"
```

### Step 3: Install deps + DB
```bash
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm db:seed
```

### Step 4: Start app and worker
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
- MinIO console: `http://localhost:9001`

## 5) Alternative: Full Docker Run

```bash
docker compose up --build
```

This runs app + worker + postgres + redis + minio together.

## 6) GroundingDINO Runtime Notes

The GroundingDINO executor can call Python:
```bash
conda run -n grounding_dino python demo/inference_for_webapp.py ...
```

Expected:
- `models/GroundingDINO/demo/inference_for_webapp.py` exists
- model weights available in expected path

If Conda/weights are missing, run logs show failure in the run panel.

## 7) Smoke Test Checklist

1. Open `/app`, create a project, confirm it opens canvas.
2. Add `input.image`, upload image, confirm node preview appears.
3. Add `model.groundingdino`, connect and run node.
4. Add `model.sam2`, connect from DINO and verify guided mode.
5. Open runs page and verify logs/progress/artifacts.
6. Open viewer with artifact:
   - GLB/PLY -> Three renderer
   - splat formats -> Babylon GS renderer
7. Delete project and verify related files disappear from `.local-storage/projects/{projectId}`.

## 8) Known/Expected Warnings

- If MinIO is unavailable:
  - logs show S3 unavailable/fallback warnings
  - app still works using `.local-storage/`
- Redis warning about minimum recommended version:
  - non-blocking in current dev flow if queue still runs

## 9) Troubleshooting

### `curl: (1) Received HTTP/0.9 when not allowed`
Port is not serving valid MinIO HTTP API.

Check owner:
```bash
sudo lsof -nP -iTCP:9000 -sTCP:LISTEN
```

Run MinIO on clean ports:
```bash
minio server ~/minio-data --address :9100 --console-address :9101
```

Update `.env` to:
```env
S3_ENDPOINT=http://127.0.0.1:9100
```

Restart app + worker.

### `Parse Error: Expected HTTP/, RTSP/ or ICE/`
Usually wrong endpoint/protocol (`http` vs `https`) or wrong service behind configured S3 port.

### `relation "UploadAsset" does not exist`
Run:
```bash
pnpm db:migrate
```

### `Database ... does not exist`
Start/create Postgres database first, then migrate.

### `pnpm: command not found`
Use corepack setup above.

## 10) Operational Notes

- Project deletion flow now removes:
  - DB entities (`Project`, `Graph`, `Run`, `Artifact`, `CacheEntry`, `UploadAsset`)
  - Storage prefix `projects/{projectId}/` in S3 and local fallback.
- Storage module automatically throttles repeated fallback warnings.

