# Flora Workflow Studio

Production-ready full-stack app for building ML/geometry workflows on an infinite canvas and opening outputs in a 3D viewer.

## Stack
- Next.js 14 App Router + TypeScript
- TailwindCSS + shadcn/ui primitives
- Framer Motion for landing interactions
- React Flow for node editor
- Three.js for GLB/PLY viewer
- BullMQ + Redis for background execution
- PostgreSQL + Prisma for metadata
- MinIO (S3-compatible) for artifacts
- Docker Compose for local infra

## Architecture Overview
- `app/`: Next.js routes and API endpoints.
- `components/canvas/*`: React Flow editor, palette, custom nodes, inspector.
- `components/viewer/*`: Three.js viewer runtime (GLB/PLY + splat-ready hook).
- `lib/graph/*`: strict node registry, graph parsing, DAG/topological plan, cache key hashing.
- `lib/execution/*`: pluggable execution engine and `MockModelRunner`.
- `lib/queue/*`: BullMQ queue setup.
- `lib/storage/*`: S3/MinIO storage and signed URL helpers.
- `worker/index.ts`: BullMQ worker process executing queued runs.
- `prisma/*`: schema, migration, seed script.

## Routes
- `/` landing page (flora-style)
- `/app` dashboard (projects + create)
- `/app/p/[projectId]/canvas` node editor
- `/app/p/[projectId]/runs` run status/logs/artifacts
- `/app/p/[projectId]/viewer?artifactId=...` 3D viewer
- `/api/*` projects, graph versions, runs, artifacts, uploads, demo open

## Graph JSON Format
`GraphDocument`:
```ts
{
  nodes: Array<{
    id: string;
    type: WorkflowNodeType;
    position: { x: number; y: number };
    data: { label: string; params: Record<string, unknown>; status?: NodeRuntimeStatus };
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    sourceHandle?: string;
    targetHandle?: string;
  }>;
  viewport: { x: number; y: number; zoom: number };
}
```
Saved as JSONB in `Graph.graphJson` with immutable versions in `Graph.version`.

## Caching Model
Per-node cache key:
```txt
hash(nodeType + stable(params) + ordered inputArtifactHashes)
```
Implementation:
- `lib/graph/cache.ts` (`makeCacheKey`)
- Worker checks `CacheEntry.cacheKey` before execution.
- Cache hit reuses existing `Artifact` and marks node as cache-hit in run logs.

## Execution Engine and Extensibility
Current engine:
- Queue job payload: `{ projectId, graphId, runId, startNodeId? }`
- Worker compiles graph to DAG, runs tasks in topological order.
- Updates run progress/logs/status during execution.
- Stores artifacts in MinIO using key pattern:
  - `projects/{projectId}/runs/{runId}/nodes/{nodeId}/artifact_{artifactId}.ext`

Pluggable model execution:
- `MockModelRunner` in `lib/execution/mock-runner.ts` is the current implementation.
- Replace/extend with real executors that call Python/FastAPI/local binaries.
- Keep API contract: return artifact buffer + mime/kind/meta + optional preview.

## 3D Viewer Notes
Implemented:
- GLB via `GLTFLoader`
- KTX2/BasisU (`KTX2Loader`) lazy setup
- Meshopt decoder lazy setup
- Draco decoder lazy setup
- PLY point cloud via `PLYLoader` + point-size control
- Splat hook stub (`components/viewer/use-splat-loader.ts`) ready for ksplat/spz integration

Future real conversion pipeline:
- Add CLI bridge module for `gltfpack`, `gltf-transform`, `draco_encoder`.
- Call from execution/export node implementation.
- Persist conversion stats into `Artifact.meta`.

## Local Development
### 1) Environment
```bash
cp .env.example .env
```

### 2) Start infra
```bash
docker compose up -d postgres redis minio
```

### 3) Install and prepare DB
```bash
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm db:seed
```

### 4) Run app + worker
```bash
pnpm dev
pnpm worker
```

App: `http://localhost:3000`

MinIO console: `http://localhost:9001` (`minioadmin` / `minioadmin`)

## Full Repository Tree
```text
.
├── Dockerfile
├── README.md
├── app
│   ├── api
│   │   ├── artifacts
│   │   │   └── [artifactId]
│   │   │       └── route.ts
│   │   ├── demo
│   │   │   └── open
│   │   │       └── route.ts
│   │   ├── projects
│   │   │   ├── [projectId]
│   │   │   │   ├── graph
│   │   │   │   │   └── route.ts
│   │   │   │   ├── route.ts
│   │   │   │   └── runs
│   │   │   │       └── route.ts
│   │   │   └── route.ts
│   │   ├── runs
│   │   │   └── [runId]
│   │   │       └── route.ts
│   │   └── uploads
│   │       └── route.ts
│   ├── app
│   │   ├── layout.tsx
│   │   ├── p
│   │   │   └── [projectId]
│   │   │       ├── canvas
│   │   │       │   └── page.tsx
│   │   │       ├── layout.tsx
│   │   │       ├── page.tsx
│   │   │       ├── runs
│   │   │       │   └── page.tsx
│   │   │       └── viewer
│   │   │           └── page.tsx
│   │   └── page.tsx
│   ├── globals.css
│   ├── layout.tsx
│   └── page.tsx
├── components
│   ├── canvas
│   │   ├── canvas-editor.tsx
│   │   └── workflow-node.tsx
│   ├── landing
│   │   └── landing-page.tsx
│   ├── layout
│   │   ├── app-top-nav.tsx
│   │   ├── dashboard-client.tsx
│   │   └── runs-panel.tsx
│   ├── ui
│   │   ├── badge.tsx
│   │   ├── button.tsx
│   │   ├── card.tsx
│   │   ├── dialog.tsx
│   │   ├── dropdown-menu.tsx
│   │   ├── input.tsx
│   │   ├── label.tsx
│   │   ├── scroll-area.tsx
│   │   ├── select.tsx
│   │   ├── separator.tsx
│   │   ├── slider.tsx
│   │   ├── table.tsx
│   │   ├── tabs.tsx
│   │   ├── toast.tsx
│   │   ├── toaster.tsx
│   │   └── textarea.tsx
│   └── viewer
│       ├── use-splat-loader.ts
│       └── viewer-canvas.tsx
├── docker-compose.yml
├── hooks
│   └── use-toast.ts
├── lib
│   ├── db.ts
│   ├── default-user.ts
│   ├── env.ts
│   ├── execution
│   │   ├── mock-assets.ts
│   │   ├── mock-runner.ts
│   │   └── run-workflow.ts
│   ├── graph
│   │   ├── cache.ts
│   │   ├── node-specs.ts
│   │   └── plan.ts
│   ├── queue
│   │   ├── connection.ts
│   │   └── queues.ts
│   ├── storage
│   │   ├── keys.ts
│   │   └── s3.ts
│   └── utils.ts
├── next.config.mjs
├── package.json
├── postcss.config.js
├── prisma
│   ├── migrations
│   │   ├── 20260218000000_init
│   │   │   └── migration.sql
│   │   └── migration_lock.toml
│   ├── schema.prisma
│   └── seed.ts
├── public
│   └── demo-assets
│       ├── gallery-1.svg
│       ├── gallery-2.svg
│       └── gallery-3.svg
├── tailwind.config.ts
├── tsconfig.json
├── types
│   └── workflow.ts
└── worker
    └── index.ts
```
