# ComfyUI Integration Plan for TribalAI Workflow Studio

## Goal
Integrate ComfyUI into the current app so users can run production models (including Qwen Image Edit) from your existing canvas/workflow system, without exposing ComfyUI directly to end users.

This plan follows your current architecture:
- Node specs and params in `lib/graph/node-specs.ts`
- Node execution in `lib/execution/run-workflow.ts`
- Executor routing in `lib/execution/mock-runner.ts`
- Worker queue in `worker/index.ts`

## Recommended Architecture (Best Option)
Use **ComfyUI as an internal inference service** and call it only from backend executors.

### Key rules
- Browser never calls ComfyUI.
- Next.js API routes never proxy raw ComfyUI endpoints to clients.
- BullMQ worker executors call ComfyUI server-to-server.
- Final outputs are stored in your own artifact system (DB + S3/local storage), same as SAM2/SAM3D.

### Why this is the best fit
- Matches your existing executor pattern (GroundingDINO, SAM2, SAM3D).
- Keeps clear boundaries: orchestration in your app, heavy inference in ComfyUI.
- Easier scaling: app nodes and GPU nodes scale independently.
- Better reliability: ComfyUI crashes do not take down app/web.
- Safer upgrades: pin ComfyUI version per environment.

## Security Model (Backend-only)
Treat ComfyUI as private infrastructure.

### Mandatory controls
- Bind ComfyUI to `127.0.0.1` (single host) or private VPC subnet (multi-host).
- No public ingress to ComfyUI port.
- Firewall/security group allowlist only worker hosts.
- Add service auth between worker and ComfyUI if cross-host (token or mTLS).
- Validate and sanitize all user params before building Comfy prompts.
- Never accept raw Comfy workflow JSON directly from browser users.

### Data protection controls
- Keep your current authz model as gatekeeper for run creation.
- Log run/node execution metadata in your DB as source of truth.
- Persist only selected output assets from ComfyUI to your storage.

## Deployment Strategy
Package ComfyUI as a pinned, versioned artifact (prefer Docker image).

### Environment approach
- Test: fast iteration, pinned ref.
- Staging: production candidate ref.
- Production: approved stable ref only.

Suggested env vars:
- `COMFYUI_BASE_URL`
- `COMFYUI_AUTH_TOKEN` (if used)
- `COMFYUI_TIMEOUT_MS`
- `COMFYUI_VERSION_REF`
- `COMFYUI_ENABLED`

## Integration Design in Current Codebase

### 1) Add Comfy client layer
Create a small typed client (example path: `lib/comfy/client.ts`) for:
- Submit workflow: `POST /prompt`
- Poll job status/history: `GET /history/{prompt_id}` (or websocket `/ws`)
- Download generated file: `GET /view?...`

### 2) Add Comfy-backed executors
Add executor files (example):
- `lib/execution/executors/qwen-image-edit.ts`
- `lib/execution/executors/qwen-vl.ts` (optional if used via Comfy)

Each executor should:
- Build a predefined Comfy API workflow template.
- Inject validated params (prompt, seed, model, strength, etc.).
- Submit job to ComfyUI.
- Wait for completion with timeout/retry.
- Fetch output images.
- Return `ExecutorOutputArtifact[]` in your existing format.

### 3) Route node types to real executors
In `lib/execution/mock-runner.ts`:
- Replace mock branches for `model.qwen_image_edit` and `model.qwen_vl` with real executor calls.
- Keep mock fallback behind env flag for local/dev resilience.

### 4) Keep node spec UX stable
Use existing node types so canvas and saved graphs remain compatible:
- `model.qwen_image_edit`
- `model.qwen_vl`

Only extend params in `lib/graph/node-specs.ts` if needed:
- `modelName`
- `seed`
- `steps`
- `guidance`
- `strength`

## Qwen Image Edit Exposure Plan
Expose Qwen Image Edit as a standard model node (`model.qwen_image_edit`) with:
- Required input: `image`
- Optional input: `text` (prompt node)
- Output: edited `image`

Implementation behavior:
- Executor builds a pinned Qwen-edit Comfy workflow template.
- Template references model names available in Comfy deployment.
- Generated image is downloaded and stored as your artifact.
- Viewer/canvas consume output exactly like current image outputs.

## Data Contract and Artifact Policy
For each Comfy run, include metadata in output artifacts:
- `provider: "comfyui"`
- `model: "qwen-image-edit"` (or specific model id)
- `prompt`, `seed`, `steps`
- `comfyPromptId`
- `comfyWorkflowTemplateVersion`
- `sourceImageArtifactId`
- `timingsMs`

This keeps analytics, debugging, and reproducibility aligned with your existing run tracking.

## Reliability and Failure Handling
Required runtime behavior:
- Hard timeout for each Comfy job.
- Retry on transient network errors.
- Clear user-facing warning when Comfy is unavailable.
- Optional fallback to mock mode in non-production.

Do not block worker forever waiting on Comfy history.

## Rollout Plan
1. Add Comfy client + health check endpoint (internal use).
2. Implement `model.qwen_image_edit` real executor first.
3. Keep `model.qwen_vl` mock until image edit is stable.
4. Add staging load tests (concurrency, timeout, retries).
5. Promote same pinned Comfy build to production.

## What Not To Do
- Do not expose ComfyUI HTTP endpoints directly to frontend.
- Do not allow arbitrary user-provided Comfy graphs in production path.
- Do not couple app deploy and Comfy deploy into one release unit.
- Do not use floating `latest` Comfy versions in production.

## Final Recommendation
Use ComfyUI as a private, pinned, backend-only inference service called by your existing worker executors.  
This is the strongest fit for your current software architecture, security requirements, and multi-environment deployment model.
