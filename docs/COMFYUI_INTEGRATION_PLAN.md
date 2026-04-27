# ComfyUI Integration: Current Implementation Guide

Last updated: April 13, 2026

This document describes how ComfyUI integration works **currently** in this repository (not just planned architecture).

## 1) What Is Implemented Right Now

ComfyUI is integrated as a backend inference service used by worker executors.

Implemented model paths:
- `input.image` (when `sourceMode=generate`) supports:
  - `Qwen-Distill` (default)
  - `Z-Image-Turbo`
- `model.qwen_image_edit` uses a real ComfyUI executor (requires image input).

Main files:
- Comfy client: `lib/comfy/client.ts`
- Comfy runtime lifecycle: `lib/comfy/runtime.ts`
- Comfy executors: `lib/execution/executors/comfy-image.ts`
- Node routing: `lib/execution/mock-runner.ts`
- Node UI/specs:
  - `lib/graph/node-specs.ts`
  - `components/canvas/workflow-node.tsx`
  - `components/canvas/canvas-editor.tsx`
- Start scripts:
  - `scripts/comfyui-start.sh`
  - `scripts/dev-stack.sh`

## 2) End-to-End Execution Flow

1. You run a workflow/node from canvas.
2. Worker resolves task execution in `lib/execution/mock-runner.ts`.
3. Comfy-backed nodes call one of:
   - `executeComfyZImageNode`
   - `executeComfyQwenImageEditNode`
   - `executeComfyQwenDistillNode`
4. Executor wraps inference with `withComfyRuntime(...)`:
   - Ensures ComfyUI is reachable (starts on-demand if needed).
5. `ComfyClient` sends:
   - `POST /prompt` (queue)
   - `GET /history/{prompt_id}` (poll)
   - `GET /view?...` (download image)
   - `POST /upload/image` (for edit or workflow image inputs)
6. Executor returns output artifact buffer (`image` output).
7. `run-workflow` persists artifact in your storage backend (S3/MinIO or local fallback), and writes artifact metadata to DB.

## 3) Runtime Modes and Process Lifecycle

Controlled by env:
- `COMFYUI_ENABLED`
- `COMFYUI_MODE=on_demand|always_on`
- `COMFYUI_ON_DEMAND_IDLE_MS`
- `COMFYUI_START_TIMEOUT_MS`

### `on_demand` (current default)
- First Comfy job:
  - runtime checks `/system_stats`
  - if unavailable, starts detached `bash scripts/comfyui-start.sh`
  - writes PID to `.run/pids/comfyui-ondemand.pid`
  - logs to `.run/logs/comfyui.log`
- After last active Comfy job:
  - schedules stop after `COMFYUI_ON_DEMAND_IDLE_MS`
  - if idle ms is `0`, stops immediately

### `always_on`
- `bash scripts/dev-stack.sh restart` will start ComfyUI service only when:
  - `COMFYUI_ENABLED=true`
  - `COMFYUI_MODE=always_on`

## 4) Current Model Behavior

## 4.1 `input.image` with `Qwen-Distill` (default)
- Executor: `executeComfyQwenDistillNode`
- Uses built-in default workflow template if `COMFYUI_QWEN_DISTILL_WORKFLOW_PATH` is empty.
- Built-in template is derived from `image_qwen_image_distill` blueprint structure.
- Prompt can come from:
  - node `prompt` param
  - connected text artifact (`value` or `prompt` in JSON payload)
- Supports env overrides for UNET, VAE, CLIP, sampler, scheduler, dimensions, etc.
- Output metadata includes model params and Comfy prompt id.

## 4.2 `input.image` with `Z-Image-Turbo`
- Executor: `executeComfyZImageNode`
- Uses built-in workflow if `COMFYUI_ZIMAGE_WORKFLOW_PATH` is empty.
- Built-in template is derived from `image_z_image_turbo` blueprint structure.
- Supports env overrides for UNET, VAE, CLIP, sampler, scheduler, denoise, and AuraFlow shift.

## 4.3 `model.qwen_image_edit`
- Executor: `executeComfyQwenImageEditNode`
- Requires an input image artifact.
- Supports optional secondary/tertiary reference images (`image2`, `image3`).
- Uses built-in API workflow defaults from the `image_qwen_image_edit_2511` blueprint structure when `COMFYUI_QWEN_EDIT_WORKFLOW_PATH` is empty.
- Supports env-based mapping for model files + sampler settings + turbo LoRA mode.

## 5) Workflow Template Rules

Template loader (`loadWorkflowTemplate`) accepts only Comfy **API JSON** object.

If file looks like UI graph JSON (`nodes` array), executor throws:
- "looks like UI JSON. Export API format from ComfyUI (Workflow -> Export API)."

Common placeholders used:
- `__PROMPT__`
- `__NEGATIVE_PROMPT__`
- `__INPUT_IMAGE__`
- `__INPUT_IMAGE2__`, `__INPUT_IMAGE3__`
- `__FILENAME_PREFIX__`
- `__SEED__`
- `__STEPS__`, `__CFG__`, `__SAMPLER__`, `__SCHEDULER__`, `__DENOISE__`
- `__ENABLE_TURBO_MODE__`, `__BASE_STEPS__`, `__TURBO_STEPS__`, `__BASE_CFG__`, `__TURBO_CFG__`
- `__UNET__`, `__VAE__`, `__CLIP__`, `__CLIP_TYPE__`, `__CLIP_DEVICE__`, `__UNET_WEIGHT_DTYPE__`
- `__AURAFLOW_SHIFT__`, `__LORA__`, `__LORA_STRENGTH__`, `__REFERENCE_LATENTS_METHOD__`
- plus model-specific placeholders for distill/z-image

## 6) Current Env Variables (Comfy)

Base runtime:
- `COMFYUI_ENABLED=true`
- `COMFYUI_BASE_URL=http://127.0.0.1:8188`
- `COMFYUI_MODE=on_demand`
- `COMFYUI_ON_DEMAND_IDLE_MS=15000`
- `COMFYUI_START_TIMEOUT_MS=120000`
- `COMFYUI_AUTH_TOKEN=`
- `COMFYUI_TIMEOUT_MS=180000`
- `COMFYUI_ALLOW_MOCK_FALLBACK=true`

Launcher (`scripts/comfyui-start.sh`):
- `COMFYUI_CONDA_COMMAND=conda`
- `COMFYUI_CONDA_ENV=comfyui`
- `COMFYUI_APP_DIR=/absolute/path/to/ComfyUI`
- `COMFYUI_HOST=127.0.0.1`
- `COMFYUI_PORT=8188`
- `COMFYUI_EXTRA_ARGS=`

Qwen Distill:
- `COMFYUI_QWEN_DISTILL_WORKFLOW_PATH=`
- `COMFYUI_QWEN_DISTILL_OUTPUT_NODE_ID=60`
- `COMFYUI_QWEN_DISTILL_TIMEOUT_MS=420000`
- `COMFYUI_QWEN_DISTILL_UNET=qwen_image_distill_full_fp8_e4m3fn.safetensors`
- `COMFYUI_QWEN_DISTILL_VAE=qwen_image_vae.safetensors`
- `COMFYUI_QWEN_DISTILL_CLIP=qwen_2.5_vl_7b_fp8_scaled.safetensors`
- `COMFYUI_QWEN_DISTILL_CLIP_TYPE=qwen_image`
- `COMFYUI_QWEN_DISTILL_CLIP_DEVICE=default`
- `COMFYUI_QWEN_DISTILL_UNET_WEIGHT_DTYPE=default`
- `COMFYUI_QWEN_DISTILL_STEPS=10`
- `COMFYUI_QWEN_DISTILL_CFG=1`
- `COMFYUI_QWEN_DISTILL_SAMPLER=res_multistep`
- `COMFYUI_QWEN_DISTILL_SCHEDULER=simple`
- `COMFYUI_QWEN_DISTILL_DENOISE=1`
- `COMFYUI_QWEN_DISTILL_WIDTH=1328`
- `COMFYUI_QWEN_DISTILL_HEIGHT=1328`
- `COMFYUI_QWEN_DISTILL_AURAFLOW_SHIFT=3`
- `COMFYUI_QWEN_DISTILL_NEGATIVE_PROMPT=`

Qwen Edit:
- `COMFYUI_QWEN_EDIT_WORKFLOW_PATH=`
- `COMFYUI_QWEN_EDIT_OUTPUT_NODE_ID=60`
- `COMFYUI_QWEN_EDIT_TIMEOUT_MS=360000`
- `COMFYUI_QWEN_EDIT_UNET=qwen_image_edit_2511_bf16.safetensors`
- `COMFYUI_QWEN_EDIT_VAE=qwen_image_vae.safetensors`
- `COMFYUI_QWEN_EDIT_CLIP=qwen_2.5_vl_7b_fp8_scaled.safetensors`
- `COMFYUI_QWEN_EDIT_CLIP_TYPE=qwen_image`
- `COMFYUI_QWEN_EDIT_CLIP_DEVICE=default`
- `COMFYUI_QWEN_EDIT_UNET_WEIGHT_DTYPE=default`
- `COMFYUI_QWEN_EDIT_ENABLE_TURBO_MODE=false`
- `COMFYUI_QWEN_EDIT_STEPS=40`
- `COMFYUI_QWEN_EDIT_CFG=4`
- `COMFYUI_QWEN_EDIT_TURBO_STEPS=4`
- `COMFYUI_QWEN_EDIT_TURBO_CFG=1`
- `COMFYUI_QWEN_EDIT_SAMPLER=euler`
- `COMFYUI_QWEN_EDIT_SCHEDULER=simple`
- `COMFYUI_QWEN_EDIT_DENOISE=1`
- `COMFYUI_QWEN_EDIT_AURAFLOW_SHIFT=3.1`
- `COMFYUI_QWEN_EDIT_REFERENCE_LATENTS_METHOD=index_timestep_zero`
- `COMFYUI_QWEN_EDIT_NEGATIVE_PROMPT=`
- `COMFYUI_QWEN_EDIT_LORA=Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors`
- `COMFYUI_QWEN_EDIT_LORA_STRENGTH=1`

Z-Image:
- `COMFYUI_ZIMAGE_WORKFLOW_PATH=`
- `COMFYUI_ZIMAGE_OUTPUT_NODE_ID=60`
- `COMFYUI_ZIMAGE_TIMEOUT_MS=300000`
- `COMFYUI_ZIMAGE_UNET=z_image_turbo_bf16.safetensors`
- `COMFYUI_ZIMAGE_VAE=ae.safetensors`
- `COMFYUI_ZIMAGE_CLIP=qwen_3_4b.safetensors`
- `COMFYUI_ZIMAGE_CLIP_TYPE=lumina2`
- `COMFYUI_ZIMAGE_CLIP_DEVICE=default`
- `COMFYUI_ZIMAGE_UNET_WEIGHT_DTYPE=default`
- `COMFYUI_ZIMAGE_STEPS=4`
- `COMFYUI_ZIMAGE_CFG=1`
- `COMFYUI_ZIMAGE_SAMPLER=res_multistep`
- `COMFYUI_ZIMAGE_SCHEDULER=simple`
- `COMFYUI_ZIMAGE_DENOISE=1`
- `COMFYUI_ZIMAGE_AURAFLOW_SHIFT=3`
- `COMFYUI_ZIMAGE_NEGATIVE_PROMPT=`
- `COMFYUI_ZIMAGE_CHECKPOINT=` (legacy fallback alias)

## 7) Node UX Behavior (Current)

`input.image` defaults:
- `sourceMode=upload`
- `generatorModel=Qwen-Distill` (when switching to generate without explicit model)

Inspector behavior:
- Generate-only fields hidden in upload mode.
- For `Qwen-Distill`, prompt-first UI hides advanced tuning fields in inspector.
- `Qwen-Image-Edit` is exposed as dedicated model node (`model.qwen_image_edit`) and not as `input.image` generator option.

## 8) Output Storage and Where Images Actually Live

Artifacts are persisted by your standard storage layer:
- S3/MinIO primary (from `S3_ENDPOINT`, `S3_BUCKET`)
- local fallback under `.local-storage` if S3 is unavailable

Storage key pattern:
- `projects/{project-slug}/runs/{runLabel}/steps/{stepLabel}/attempt-{nn}/outputs/{outputName}.{ext}`

Important MinIO note:
- In MinIO data directory (`~/minio-data/...`) objects are stored in internal XL layout (`xl.meta`, `part.1` etc.), not plain user-visible PNG files.
- To get image bytes, download through MinIO API/Console or your app storage API.

## 9) Operational Commands

Start Comfy directly:
```bash
pnpm comfy:start
```

Start full stack:
```bash
bash scripts/dev-stack.sh restart
```

Check if Comfy is running:
```bash
pgrep -af "main.py --listen|comfyui-start.sh"
```

Force stop a running Comfy PID:
```bash
kill <pid>
```

## 10) VRAM Behavior and Why It Stays Allocated

If Comfy process is still alive, PyTorch keeps model weights in VRAM.

For quick VRAM release after each job:
- keep `COMFYUI_MODE=on_demand`
- set `COMFYUI_ON_DEMAND_IDLE_MS=0`

Then restart stack:
```bash
bash scripts/dev-stack.sh restart
```

## 11) Security Posture (Current Design)

Security model is backend-only by design:
- Frontend does not call Comfy endpoints directly.
- Worker talks to Comfy server-to-server.
- Recommended deployment: keep Comfy private/internal (localhost or private network only).

## 12) Known Constraints

- `Qwen Image Edit` runs with built-in `image_qwen_image_edit_2511`-aligned API workflow if no custom path is provided.
- Passing Comfy UI-exported graph JSON instead of API JSON will fail intentionally.
- If `COMFYUI_ALLOW_MOCK_FALLBACK=true`, unavailable Comfy returns mock images with warnings instead of hard fail.
