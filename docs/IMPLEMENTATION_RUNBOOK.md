# Flora Workflow Studio: Implementation + Runbook

This file documents what was implemented in this repository and how to install/run it on Ubuntu Linux.

## 1) What Was Implemented

### Core Product
- Next.js 14 App Router + TypeScript application with:
  - Landing page (`/`)
  - Dashboard (`/app`)
  - Canvas workflow editor (`/app/p/[projectId]/canvas`)
  - Runs view (`/app/p/[projectId]/runs`)
  - 3D viewer (`/app/p/[projectId]/viewer?artifactId=...`)
- API routes under `/api/*` for projects, graph versions, runs, artifacts, uploads, demo flow.

### Data + Infra
- Prisma + PostgreSQL models for `User`, `Project`, `Graph`, `Run`, `Artifact`, `CacheEntry`.
- BullMQ + Redis queue for workflow jobs.
- S3-compatible storage integration (MinIO in dev), signed URLs, existence checks, bucket auto-create.
- Docker Compose services for `app`, `worker`, `postgres`, `redis`, `minio`.

### Canvas Editor (React Flow)
- Infinite-canvas behavior with pan/zoom, minimap, controls, snap-to-grid.
- Custom node cards with status badges and output hints.
- Inspector tabs: Params / Outputs / Logs.
- Save graph versions, run workflow, run from selection, stop run.
- **Right-click node creation UX (latest):**
  - Class-first selector in context menu: `Inputs`, `Models`, `Geometry`, `Outputs`.
  - Node list filtered by selected class.
  - Additional “All Classes” quick switch section.
- Left node palette no longer contains add-node cards; node creation is intentionally centralized in right-click menu.

### Workflow Execution + Caching
- Graph compile -> DAG -> topological execution plan.
- Worker executes node tasks in dependency order.
- Run status/progress/log updates persisted during execution.
- Caching by hash key from `nodeType + params + ordered input artifact hashes`.
- Cache hits reuse artifacts and mark node as `cache-hit`.
- Mock runner architecture is pluggable for real model executors later.

### Viewer (Three.js)
- GLB loading with lazy decoders (Draco, Meshopt, KTX2/Basis).
- PLY point cloud rendering with point-size control.
- Splat hook module ready for future ksplat/spz integration.
- Scene graph panel, object picking, transform controls, fit/reset tools, screenshot, runtime stats.

### Viewer Enhancements Added During This Iteration
- Local file loading in viewer (open `.ply`, `.glb/.gltf`, `.ksplat/.spz`) even without pipeline artifact.
- Improved PLY handling:
  - Supports binary little-endian PLY with Gaussian-style fields (`f_dc_0`, `f_dc_1`, `f_dc_2`, etc.).
  - Converts SH DC channels to displayable RGB.
  - Downsamples very large point sets for interactive rendering.
- Point-size slider tuned to requested rule:
  - `min = 0.001`
  - `max = min * 5`
  - `step = 0.0001`

## 2) Project Structure (Key Paths)

- `app/` Next.js routes and APIs
- `components/canvas/` canvas editor and node UI
- `components/viewer/` 3D viewer modules
- `lib/graph/` node registry, planning, cache helpers
- `lib/execution/` mock execution engine
- `lib/storage/` S3/MinIO helpers
- `worker/index.ts` BullMQ worker process
- `prisma/` schema, migrations, seed
- `docker-compose.yml` local infra/services

## 3) Ubuntu Dependencies

### Required
- Node.js 20+
- Corepack (comes with Node 20)
- Docker + Docker Compose plugin (recommended)
- or local PostgreSQL + Redis + MinIO binaries if not using Docker

### Install Node 20 + Corepack (if missing)
```bash
node -v
corepack --version
```

If `pnpm` is missing, enable it through corepack:
```bash
corepack enable
corepack prepare pnpm@9.15.0 --activate
pnpm -v
```

If corepack home permission issues appear:
```bash
COREPACK_HOME=/tmp/corepack corepack prepare pnpm@9.15.0 --activate
COREPACK_HOME=/tmp/corepack corepack pnpm -v
```

## 4) Environment Setup

Create local env file:
```bash
cp .env.example .env
```

Default `.env.example` values already match local compose defaults:
- `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/flora3d?schema=public`
- `REDIS_URL=redis://localhost:6379`
- `S3_ENDPOINT=http://localhost:9000`
- etc.

If your MinIO runs on another port (example `9100`), update:
```env
S3_ENDPOINT=http://localhost:9100
```

## 5) Run (Recommended: Docker for Infra + Host App)

### 5.1 Start infra
```bash
docker compose up -d postgres redis minio
```

### 5.2 Install app dependencies
```bash
pnpm install
```

### 5.3 Prepare database
```bash
pnpm db:generate
pnpm db:migrate
pnpm db:seed
```

### 5.4 Start app + worker
In terminal 1:
```bash
pnpm dev
```

In terminal 2:
```bash
pnpm worker
```

Open:
- App: `http://localhost:3000`
- MinIO console: `http://localhost:9001`

## 6) Run Fully in Docker

```bash
docker compose up --build
```

This starts app + worker + postgres + redis + minio together.

## 7) First-Run Flow

1. Open `/` and click **Get started** or **Open demo**.
2. Open a project and go to **Canvas**.
3. Right-click on canvas, pick class (`Inputs/Models/Geometry/Outputs`), then select node.
4. Save and run workflow.
5. Open **Runs** to inspect progress/logs.
6. Open **Viewer** from artifact link, or upload local `.ply/.glb` directly in viewer.

## 8) Common Troubleshooting

### `pnpm: command not found`
Use corepack:
```bash
corepack enable
corepack prepare pnpm@9.15.0 --activate
```

### Prisma error: `Environment variable not found: DATABASE_URL`
- Ensure `.env` exists in repo root.
- Ensure `DATABASE_URL` is set correctly.

### Prisma `P1001: Can't reach database server`
- Start PostgreSQL (`docker compose up -d postgres`).
- Verify connectivity:
```bash
psql "postgresql://postgres:postgres@localhost:5432/flora3d" -c "select 1;"
```

### Viewer artifact URL returns 404
- Artifact metadata may exist but object file is missing in MinIO/S3.
- Re-run workflow to regenerate artifact.
- Confirm `S3_ENDPOINT`, `S3_BUCKET`, and MinIO process/port are correct.

### MinIO port conflict
If `9000` is occupied, run MinIO on another port and update `.env` `S3_ENDPOINT` accordingly.

## 9) Extending with Real Models

Current execution is intentionally modular:
- Keep graph planning + run orchestration in Node/worker.
- Replace mock node execution with calls to Python/FastAPI/local tools.
- Return artifacts via existing storage + metadata flow.

## 10) Extending Export Pipeline (meshopt/KTX2/Draco)

Future integration path:
- Add conversion module invoked by export node (`out.export_scene`).
- Use CLI wrappers for tools (e.g., `gltfpack`, `gltf-transform`, draco pipeline).
- Store conversion stats in `Artifact.meta`.

---
If you want, I can also generate a shorter `QUICKSTART.md` that only contains the minimal commands for daily development.
