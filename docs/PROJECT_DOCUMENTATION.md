# TribalAI Workflow Studio: Project Documentation

This document explains the current implementation of the web app, backend, database, workflow execution, 3D viewer, analytics, and how to extend the system (including adding a new node model).

## 1. What This System Is

TribalAI Workflow Studio is a full-stack workflow platform for image -> detection -> segmentation -> scene-generation pipelines, with:

- user auth and project workspaces
- a React Flow canvas to build node graphs
- queued run execution with BullMQ worker
- artifact storage in S3/MinIO with local fallback
- a multi-runtime 3D viewer (Three.js + Spark/legacy splat)
- built-in telemetry for run/event/step analytics

Main user routes:

- `/` landing
- `/app` dashboard
- `/app/p/[projectId]/canvas` workflow editor
- `/app/p/[projectId]/runs` run history
- `/app/p/[projectId]/viewer` artifact viewer

## 2. High-Level Architecture

### 2.1 Runtime Components

- Next.js app (API + pages)
- Worker process (`worker/index.ts`) for queue jobs
- PostgreSQL (Prisma ORM)
- Redis (rate limiting + BullMQ)
- S3-compatible object storage (MinIO in local dev)

### 2.2 Core Flow (Run Execution)

1. User builds graph in canvas.
2. Graph version saved in `Graph.graphJson`.
3. User starts run (`POST /api/projects/:projectId/runs` or node run endpoint).
4. Run row is created, usage reserved (if billing enabled), job queued.
5. Worker pulls job and executes DAG in topological order.
6. For each node:
   - resolve inputs from in-memory outputs or latest DB artifacts
   - compute cache key
   - return cache hit or execute node runtime
   - store artifacts + preview + cache entries
   - emit `RunEvent` and `RunStep`
7. Run status finalized and token usage settled.

## 3. Repository Map (Important Areas)

- `app/` Next.js pages and API routes
- `components/canvas/` graph editor and node UI
- `components/viewer/` viewer loader and unified renderer
- `lib/graph/` node specs, validation, execution planning, templates
- `lib/execution/` node runtime execution and telemetry
- `lib/auth/` auth/session/access control
- `lib/security/` audit, rate limit, API errors
- `lib/storage/` object key strategy and S3/local fallback
- `lib/billing/` plan entitlements and token accounting
- `lib/splats/` tileset build pipeline
- `worker/` BullMQ workers
- `prisma/schema.prisma` DB schema
- `scripts/` local tooling (`dev-stack.sh`, analytics views, metabase launcher)

## 4. Backend and API Design

### 4.1 Auth and Access

- Auth provider: NextAuth credentials (`lib/auth/options.ts`)
- Session strategy: JWT
- Middleware protects `/app`, `/billing`, `/settings` and redirects anonymous users to login.
- Access checks are centralized in `lib/auth/access.ts`:
  - `requireProjectAccess(projectId, role)`
  - `requireArtifactAccess(artifactId, role)`
  - `requireRunAccess(runId, role)`
  - `requireStorageObjectAccess(storageKey, role)`

Role model (`ProjectRole`): `viewer < editor < owner`.

### 4.2 Security Controls

- Validation: Zod schemas in `lib/validation/schemas.ts`
- Structured API errors: `HttpError` + `toApiErrorResponse`
- Rate limits (Redis counters) in `lib/security/rate-limit.ts`:
  - register/login
  - run creation
  - upload init
  - signed URL/storage read/write
- Audit trail table (`AuditLog`) written via `lib/security/audit.ts`

### 4.3 Important API Groups

Auth:

- `POST /api/auth/register`
- `app/api/auth/[...nextauth]/route.ts`

Projects and graphs:

- `GET/POST /api/projects`
- `GET/DELETE /api/projects/:projectId`
- `GET/POST /api/projects/:projectId/graph`

Runs and execution:

- `GET/POST /api/projects/:projectId/runs`
- `POST /api/projects/:projectId/nodes/:nodeId/run`
- `GET/PATCH /api/runs/:runId` (read details, cancel)

Artifacts and storage:

- `GET/DELETE /api/artifacts/:artifactId`
- `POST /api/uploads` (signed upload init)
- `GET/PUT /api/storage/object?key=...`

Viewer and splats:

- `GET /api/world/manifest`
- `GET/POST /api/world/transforms`
- `POST/GET /api/splats/buildTileset`

Analytics:

- `GET /api/projects/:projectId/analytics`

Billing (if enabled):

- `GET /api/billing/summary`
- `POST /api/billing/estimate`
- checkout/portal/webhook routes in `app/api/billing/*`

## 5. Database Model

Source of truth: `prisma/schema.prisma`.

### 5.1 Main Entities

Identity/auth:

- `User`
- `Account`, `Session`, `VerificationToken`, `Authenticator`

Workspace:

- `Project` (owner is `ownerId`, mapped to DB column `userId`)
- `ProjectMember` (role-based sharing)

Workflow:

- `Graph` (versioned graph JSON)
- `Run` (queued/running/success/error/canceled)
- `Artifact` (node outputs)
- `CacheEntry` (output cache key -> artifact)

Telemetry and security:

- `RunEvent` (timeline events)
- `RunStep` (node-level runtime rows)
- `AuditLog` (security/business audit)

Billing/usage:

- `Subscription`
- `TokenWallet`
- `TokenTransaction`
- `UsageEvent`
- `StripeWebhookEvent`

Uploads:

- `UploadAsset`

### 5.2 Tracking "Which User Created What"

Already modeled directly:

- Project owner: `Project.ownerId` (`Project.userId` in DB)
- Graph creator: `Graph.createdBy`
- Run creator: `Run.createdBy`
- Artifact owner: `Artifact.ownerId`
- Billing/usage actor: `TokenTransaction.userId`, `UsageEvent.userId`

For analytics, also use:

- `RunEvent.userId`
- `RunStep.userId`
- `AuditLog.userId`

### 5.3 Useful Built-In Analytics Views

Installed by `pnpm analytics:views` from `scripts/sql/analytics_views.sql`:

- `analytics.v_user_summary`
- `analytics.v_project_overview`
- `analytics.v_run_facts`
- `analytics.v_node_type_daily`
- `analytics.v_node_error_hotspots`
- `analytics.v_usage_daily`
- `analytics.v_token_transactions_daily`

These are the best source for Metabase dashboards.

## 6. Workflow Graph and Canvas

### 6.1 Node Type System

Node types are strongly typed in `types/workflow.ts` (`WorkflowNodeType`) and described in `lib/graph/node-specs.ts`:

- category, title, icon
- input/output port definitions
- parameter schema and UI fields
- default params
- UI hints (preview output, hidden outputs, node-run enabled)

### 6.2 Connection Validation

`lib/graph/connection-rules.ts` enforces:

- port compatibility (`ArtifactType`)
- handle normalization for legacy aliases
- domain rule: SAM2 descriptor input only from GroundingDINO descriptor

### 6.3 Graph Persistence

- Canvas saves graph versions via `/api/projects/:projectId/graph`
- Graph JSON is migrated/normalized on parse (`migrateGraphDocument` + `parseGraphDocument`)

## 7. Execution Engine Internals

### 7.1 Planning and Order

`buildExecutionPlan` in `lib/graph/plan.ts`:

- validates/sanitizes edges
- topologically sorts DAG
- supports `startNodeId` by selecting node ancestors only

### 7.2 Worker Processing

`executeWorkflowRun` in `lib/execution/run-workflow.ts`:

- marks run running
- loops tasks in sequence
- resolves input artifacts
- computes cache keys per node output
- executes via `MockModelRunner.executeNode`
- stores artifacts and preview objects
- updates run progress/logs
- writes `RunEvent` + `RunStep`
- finalizes status and usage

### 7.3 Cache Strategy

Cache key base:

- `nodeType`
- merged params
- ordered input artifact signatures (artifactId + hash)
- mode (if runtime mode applies)

Stored per output port using `makeOutputCacheKey`.

### 7.4 Template Pipeline Nodes

`pipeline.scene_generation` is a template wrapper defined in `lib/graph/pipeline-templates.ts`.

It expands into internal nodes:

- `model.groundingdino`
- `model.sam2`
- `model.sam3d_objects`

Internal outputs are persisted as hidden artifacts; final exposed outputs are aliased to wrapper node outputs.

## 8. Node Runtime Support (Backend)

Dispatch is centralized in `lib/execution/mock-runner.ts`.

### 8.1 GroundingDINO (`model.groundingdino`)

Executor: `lib/execution/executors/groundingdino.ts`

- materializes input image
- runs python script in conda env
- loads boxes JSON + overlay
- emits descriptor JSON artifact with image source metadata

### 8.2 SAM2 (`model.sam2`)

Executor: `lib/execution/executors/sam2.ts`

- modes: `guided` or `full` (`auto` picks based on descriptor input)
- resolves image from direct input or descriptor metadata/path fallback
- executes python pipeline
- emits config/mask outputs and overlay preview

### 8.3 Scene Generation (`model.sam3d_objects`)

Executor: `lib/execution/executors/scene-generation.ts`

- consumes SAM2 config (`masksDir`, source image context)
- mode derived from output format (`mesh` vs `gaussian`)
- can process all masks or per-mask fallback
- emits scene artifact (`mesh_glb` or `point_ply`) + metadata

## 9. Storage Design

Implementation: `lib/storage/s3.ts`.

### 9.1 Primary and Fallback

- Primary: S3/MinIO signed URL and object operations
- Fallback: local filesystem (`.local-storage`) when S3 endpoint is unavailable
- Temporary S3-disable window avoids repeated hard failures

### 9.2 Object Key Patterns

- Run artifacts: `projects/{projectSlug}/runs/{runId}/nodes/{nodeId}/...`
- Uploads: `projects/{projectSlug}/uploads/{projectId}/images/...`

### 9.3 Cleanup

Project delete removes DB rows and related storage prefixes (`/api/projects/:projectId` DELETE flow).

## 10. 3D Viewer Architecture

### 10.1 Server Side Selection

`app/app/p/[projectId]/viewer/page.tsx`:

- resolves selected artifact from query
- filters renderable artifacts
- builds picker options and initial artifact context

### 10.2 World Manifest API

`GET /api/world/manifest`:

- validates artifact access
- resolves mesh/splat bundles
- supports bundle mode:
  - `same_node`
  - `project_fallback`
- resolves tileset JSON for splat sources
- resolves viewer environment from `viewer.environment` node graph params + latest node artifact

### 10.3 Client Loader

`components/viewer/viewer-loader.tsx`:

- fetches world manifest
- supports local file load and external scene additions
- builds unified manifest and passes to viewer

### 10.4 Unified Viewer Runtime

`components/viewer/unified-world-viewer.tsx`:

- Three.js scene for meshes and control UI
- Splat runtime order from env (`NEXT_PUBLIC_SPLAT_RUNTIME` + `NEXT_PUBLIC_SPARK_ENABLED`)
- attempts Spark runtime, falls back to legacy when needed
- PLY inspection/downsample helpers for heavy splats
- transform gizmos (translate/rotate/scale, world/local space)
- scene/object grouping and selection tooling
- HDRI/environment controls
- ground-plane alignment utility (`alignSceneToGroundPlane`)
- persistence of mesh/splat/alignment transforms via `/api/world/transforms`

### 10.5 Renderer Decision Rules

`lib/viewer/renderer-switch.ts` maps by kind/extension:

- mesh kinds/extensions -> Three
- splat kinds/extensions -> Spark or Babylon legacy based on runtime preference

## 11. Analytics and Project Monitoring

### 11.1 Built-In Telemetry

Worker emits:

- `RunEvent` rows for lifecycle timeline
- `RunStep` rows per node execution (duration, status, cacheHit, summaries)

### 11.2 API-Level Analytics

`GET /api/projects/:projectId/analytics` returns:

- run status totals
- top run creators
- node summary stats (`successRate`, avg duration)
- recent timeline events

### 11.3 BI Layer

Recommended GUI: Metabase.

- start: `bash scripts/metabase-start.sh`
- apply views: `pnpm analytics:views`
- docs:
  - `docs/METABASE_ANALYTICS_PLAYBOOK.md`
  - `docs/sql/METABASE_QUERIES.sql`
  - `docs/sql/METABASE_VIEW_QUERIES.sql`

## 12. How To Add a New Node Model (Step-by-Step)

This is the canonical extension workflow.

### Step 1: Add type definition

File: `types/workflow.ts`

- Add new literal to `WorkflowNodeType`.
- If needed, add new `ArtifactType` value.

### Step 2: Register node spec

File: `lib/graph/node-specs.ts`

- Add `makeSpec("your.node_type", {...})` with:
  - input/output ports
  - param schema and fields
  - defaults
  - UI config

### Step 3: UI registration for canvas

File: `components/canvas/canvas-editor.tsx`

- Add node key in `nodeTypes` map.
- Add shortcut (optional) in `shortcutByNodeType`.

File: `components/canvas/workflow-node.tsx`

- Add icon mapping (`nodeIconMap`).
- Add label/tag mapping (`modelTagMap`) if desired.
- Add special UI logic only if your node needs custom behavior.

### Step 4: Artifact and connection rules (if needed)

Files:

- `lib/graph/artifact-types.ts`
- `lib/graph/connection-rules.ts`

Update if your node introduces a new artifact semantics or custom port constraints.

### Step 5: Implement executor

Create file: `lib/execution/executors/your-node.ts`.

Implement a function that accepts `NodeExecutionContext` and returns `NodeExecutionResult` with output artifacts.

### Step 6: Wire executor dispatch

File: `lib/execution/mock-runner.ts`

- Add new case in `executeNode` switch.
- Call your executor.

### Step 7: Add env/config surface (if runtime needs external tools)

File: `lib/env.ts`

- Add env keys and defaults.
- Use them in your executor.

### Step 8: Optional template support

If node is a wrapper pipeline node:

- add template in `lib/graph/pipeline-templates.ts`
- map exposed inputs/outputs/params to internal graph

### Step 9: DB changes (optional)

If new persistent state is needed:

- edit `prisma/schema.prisma`
- run `pnpm db:generate`
- run migration/push (`pnpm db:migrate` or `pnpm db:push`)

### Step 10: Verify end-to-end

1. Create node in canvas.
2. Connect required ports.
3. Run node-only (`/nodes/:nodeId/run`) and full run.
4. Confirm artifacts written and preview works.
5. Confirm `RunEvent` and `RunStep` rows exist.
6. Open resulting artifact in viewer if renderable.

## 13. Environment Variables You Should Know

Critical server envs:

- `DATABASE_URL`
- `AUTH_SECRET`
- `REDIS_URL`
- `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_REGION`

Viewer runtime flags:

- `NEXT_PUBLIC_SPLAT_RUNTIME=auto|spark|legacy`
- `NEXT_PUBLIC_SPARK_ENABLED=true|false`

Rate limit knobs:

- `AUTH_LOGIN_LIMIT`, `AUTH_LOGIN_WINDOW_SEC`
- `AUTH_REGISTER_LIMIT`, `AUTH_REGISTER_WINDOW_SEC`
- `RUN_CREATE_LIMIT`, `RUN_CREATE_WINDOW_SEC`
- `UPLOAD_INIT_LIMIT`, `UPLOAD_INIT_WINDOW_SEC`
- `SIGNED_URL_LIMIT`, `SIGNED_URL_WINDOW_SEC`, `SIGNED_URL_TTL_SEC`

Model runtime knobs:

- SAM2: `SAM2_*`
- SAM3D: `SAM3D_*`
- GroundingDINO: `GROUNDING_DINO_*`

Billing switch:

- `BILLING_ENFORCEMENT_ENABLED`

## 14. Operational Playbook

Local dev quick path:

- `bash scripts/dev-stack.sh start`
- `bash scripts/dev-stack.sh status`
- `bash scripts/dev-stack.sh logs`
- `bash scripts/dev-stack.sh restart`
- `bash scripts/dev-stack.sh stop`

Analytics views:

- `pnpm analytics:views`

Metabase:

- `bash scripts/metabase-start.sh`

## 15. Recommended Documentation Set

Use this file as the main architecture reference, plus:

- `README.md` (setup/run commands)
- `docs/IMPLEMENTATION_RUNBOOK.md` (operational details)
- `docs/OBSERVABILITY_ANALYTICS_GUIDE.md` (telemetry and monitoring)
- `docs/METABASE_ANALYTICS_PLAYBOOK.md` (dashboard setup)

