# Security Upgrade Implementation (Auth + AuthZ + Storage + Audit)

## Scope
This document describes the production security upgrade implemented for the workflow platform:

1. Authentication (Auth.js + credentials + Argon2id)
2. Session management (signed JWT sessions + secure cookies)
3. Project-based authorization (owner/editor/viewer)
4. Private storage access (server-authorized signed URLs / protected object route)
5. Input validation (Zod)
6. Redis rate limiting on sensitive routes
7. Audit logging for sensitive actions
8. Billing/token security enforcement for paid compute actions

The implementation keeps the existing stack and integrates into current routes/components instead of replacing architecture.

Detailed billing/subscription/token architecture is documented in:
- `docs/BILLING_SUBSCRIPTION_IMPLEMENTATION.md`

## Prompt Improvements Applied
The implementation follows the original prompt, with these practical refinements applied:

1. Security controls are centralized in reusable helpers to avoid route-by-route drift.
2. Authorization checks are enforced before storage URL generation or object streaming.
3. Audit logging is write-fail-safe (never breaks user flow if audit insert fails).
4. Storage key authorization requires exact project-scoped artifact/upload database references; path shape alone never grants access.
5. Migration is incremental and backward-compatible where possible (`ownerId` mapped to existing `Project.userId` column).

## Architecture Summary

### Authentication
- Auth.js with Prisma adapter and credentials provider.
- Registration endpoint hashes passwords with Argon2id.
- Login uses credentials provider + rate limiting.
- Session strategy: signed JWT.
- Auth pages:
  - `/login`
  - `/register`
  - `/forbidden`

### Authorization Boundary
- Project is the primary security boundary.
- Role model:
  - `owner`
  - `editor`
  - `viewer`
- Access helpers:
  - `requireAuthUser()`
  - `requireProjectAccess(projectId, minimumRole)`
  - `requireArtifactAccess(artifactId, minimumRole)`
  - `requireRunAccess(runId, minimumRole)`
  - `requireStorageObjectAccess(storageKey, minimumRole)`

### Private Storage
- Object route (`/api/storage/object`) is now protected:
  - validates key
  - authorizes access to project ownership/membership
  - logs secure access attempts
- Signed URLs are short-lived (TTL clamped by env).
- Frontend never needs raw private bucket URLs.
- Uploads are proxied through the protected object route and require an exact initialized byte count, allowed image MIME type, and matching file signature.

## Key Code Changes

### New security/auth modules
- `lib/auth/options.ts`
- `lib/auth/password.ts`
- `lib/auth/session.ts`
- `lib/auth/access.ts`
- `lib/security/errors.ts`
- `lib/security/request.ts`
- `lib/security/rate-limit.ts`
- `lib/security/audit.ts`
- `lib/validation/schemas.ts`
- `types/next-auth.d.ts`

### Auth/API routes
- `app/api/auth/[...nextauth]/route.ts`
- `app/api/auth/register/route.ts`

### Protected UI routes/pages
- `middleware.ts`
- `app/login/page.tsx`
- `app/register/page.tsx`
- `app/forbidden/page.tsx`
- `app/app/layout.tsx`
- `app/app/page.tsx`
- `app/app/p/[projectId]/*` (layout/graph-editor/runs/viewer)

### Hardened API routes
- `app/api/projects/route.ts`
- `app/api/projects/[projectId]/route.ts`
- `app/api/projects/[projectId]/graph/route.ts`
- `app/api/projects/[projectId]/runs/route.ts`
- `app/api/projects/[projectId]/nodes/[nodeId]/run/route.ts`
- `app/api/runs/[runId]/route.ts`
- `app/api/artifacts/[artifactId]/route.ts`
- `app/api/uploads/route.ts`
- `app/api/storage/object/route.ts`
- `app/api/world/manifest/route.ts`
- `app/api/world/transforms/route.ts`
- `app/api/splats/tileset/route.ts`
- `app/api/splats/buildTileset/route.ts`
- `app/api/demo/open/route.ts`

### Storage / env / UX updates
- `lib/storage/s3.ts` (signed URL TTL clamping)
- `lib/env.ts`
- `.env.example`
- `components/layout/app-shell.tsx` (session-aware sign-out)

### Prisma schema + migration
- `prisma/schema.prisma`
- `prisma/migrations/20260329100000_auth_security_upgrade/migration.sql`
- `prisma/seed.ts`

## Prisma/Data Model Notes
Added/extended:
- `User` (password hash, profile, updatedAt)
- Auth.js models: `Account`, `Session`, `VerificationToken`, `Authenticator`
- `ProjectRole` enum
- `ProjectMember`
- `Project.slug`
- `Graph.createdBy`
- `Run.createdBy`
- `Artifact.ownerId`
- `AuditLog`

Compatibility approach:
- `Project.ownerId` maps to existing DB column `userId` via `@map("userId")` to reduce migration risk.

## Validation + Rate Limit Coverage

### Zod validation added for
- register/login payloads
- project creation
- graph save
- run create / node run
- upload init
- artifact/world/storage queries
- run action (`cancel`)
- tileset build payload

### Rate limits
- auth login/register
- run creation
- node-run enqueue
- upload initialization
- signed-url heavy routes
- protected storage reads/writes
- Production requests fail closed with `503` if Redis cannot enforce a limit.

### Browser request integrity
- Unsafe `/api/*` browser requests reject cross-site `Origin`/`Sec-Fetch-Site` metadata.
- Stripe webhooks are exempt from origin checks and authenticated with the Stripe signature.
- Forwarded client-IP headers are ignored unless `TRUST_PROXY_HEADERS=true`; the trusted reverse proxy must overwrite them.

## Audit Logging Coverage
Implemented events include:
- `register`
- `login_success`
- `login_failure`
- `logout`
- `project_create`
- `project_delete`
- `workflow_save`
- `run_start`
- `run_cancel`
- `artifact_download`
- `artifact_delete`
- `viewer_manifest_access`
- `viewer_transforms_read`
- `viewer_transforms_update`
- `storage_object_read`
- `storage_object_write`
- `secure_file_access_attempt`
- `upload_init`

## Migration and Local Runbook

1. Ensure Postgres, Redis, and storage service are running.
2. Update env values in `.env` (see `.env.example`).
3. Run:

```bash
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm check
pnpm dev
```

For production, use `pnpm db:deploy` instead of the development migration command.

## Security Validation Checklist

- [ ] Registration creates user with Argon2id hash (no plain password)
- [ ] Login works and writes audit events
- [ ] `/app/*` requires authentication
- [ ] Project APIs reject unauthorized users (403/401)
- [ ] Artifact/download routes are project-authorized server-side
- [ ] `/api/storage/object` denies unauthorized key access
- [ ] Upload init and run creation are rate-limited
- [ ] Audit log rows are created for sensitive actions
- [ ] Signed URL access remains short-lived

## Dependency Audit Requirement
Run the audit after every dependency update and before deployment:

```bash
pnpm audit --prod --audit-level high
```

Do not deploy a Next.js version below the minimum patched version reported by the audit. As of this documentation update, upgrade from `15.5.16` to at least `15.5.18` once registry access is available, then regenerate `pnpm-lock.yaml` with `pnpm install`.
