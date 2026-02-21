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
- Three.js (GLB/PLY) + Babylon.js Gaussian Splatting renderer
- BullMQ + Redis
- PostgreSQL + Prisma
- S3-compatible storage (MinIO in local dev)

## What Is Implemented (Current)
- Strict graph/node schema and typed ports.
- Node execution queue with BullMQ worker and run progress/logs.
- Caching: `hash(nodeType + params + orderedInputHashes + mode)`.
- GroundingDINO + SAM2 node flow with guided/full segmentation rules.
- Image upload directly in `input.image` node (drag/drop + preview).
- Node creation via canvas context menu (right-click or double-click).
- Edge-drop UX: drag connection to empty canvas -> add-node menu opens and auto-connects.
- Viewer renderer switch:
  - GLB/PLY -> Three.js
  - `.splat/.spz/.compressed.ply/.ksplat` and GS kinds -> Babylon GS
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
- `docs/IMPLEMENTATION_RUNBOOK.md` deeper implementation notes

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
```

## Concrete Run Instructions (Recommended)
This is the standard setup: infra in Docker, app+worker on host.

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

## Notes
- If S3/MinIO is unavailable, uploads/artifacts continue through local fallback at `.local-storage/`.
- Deleting a project now removes:
  - DB rows (`Project`, `Graph`, `Run`, `Artifact`, `CacheEntry`, `UploadAsset`)
  - stored objects under `projects/{projectId}/`.
