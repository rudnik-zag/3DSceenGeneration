# Billing + Subscription + Token Enforcement Implementation

## Scope
This document describes the production-oriented implementation for:

1. Public website with protected application routes
2. Authenticated billing surface
3. Subscription plans + entitlements
4. Token wallet + append-only token ledger
5. Server-side token enforcement for workflow runs
6. Stripe checkout + webhook sync (idempotent)

The implementation keeps the existing stack and integrates with current Next.js/Prisma/BullMQ architecture.

## Prompt Improvements Included
The implementation includes these practical improvements beyond the base prompt:

1. Hard switch for rollout safety: `BILLING_ENFORCEMENT_ENABLED`
   - `true`: entitlement/token checks block protected actions
   - `false`: app stays usable while billing code remains active for gradual rollout
2. Token usage lifecycle split into reservation + finalization
   - reserve on run creation
   - finalize/refund on run finish/cancel/error
3. Idempotent Stripe webhook processing with persistent event table
   - duplicate events return success without double credit/debit
4. Stripe integration without SDK lock-in
   - REST-based helper with signature verification using Node crypto
5. Concurrency-safe wallet updates using DB row locks (`SELECT ... FOR UPDATE`)
6. Queue priority mapping from plan entitlements (higher plans run earlier)

## Route Access Model

### Public
- `/`
- `/pricing`
- `/login`
- `/register`

### Protected
- `/app/**`
- `/billing`
- `/settings`
- private project/run/storage APIs

Middleware redirects unauthenticated users to:
- `/login?next=<original-path>`

## Data Model
Prisma models added for billing:

- `Subscription`
- `TokenWallet`
- `TokenTransaction`
- `UsageEvent`
- `StripeWebhookEvent`

Key principles:

- `TokenTransaction` is append-only (ledger source of truth)
- wallet counters are operational convenience, not audit history
- project remains the primary boundary for private resources

## Server Services

### `lib/billing/plans.ts`
- plan definitions: Free / Creator / Pro / Studio
- entitlement table
- token pack definitions
- Stripe price-id mapping from env

### `lib/billing/entitlements.ts`
- resolves effective billing state for a user
- lazy bootstrap of subscription/wallet
- monthly rollover logic
- entitlement assertions for:
  - project creation
  - upload/storage limits

### `lib/billing/pricing.ts`
- reusable run token estimation from graph execution plan
- per-node pricing base + multipliers
- returns estimate breakdown + policy version

### `lib/billing/usage.ts`
- `estimateRunForUser`
- `createRunWithTokenReservation`
- `finalizeRunUsage`
- `creditTokenPack`
- `syncSubscriptionFromBilling`

### `lib/billing/stripe.ts`
- Stripe REST checkout + billing portal session creation
- webhook signature verification (`Stripe-Signature`)
- no direct `stripe` SDK dependency

## API Endpoints Added

### Billing read
- `GET /api/billing/summary`

Returns:
- current plan/status
- wallet balances
- recent token transactions
- recent usage events
- plan + token-pack catalog

### Run estimate
- `POST /api/billing/estimate`

Validates payload and project access, then returns:
- estimated token cost
- affordability
- enforcement flag
- effective entitlements

### Checkout
- `POST /api/billing/checkout/subscription`
- `POST /api/billing/checkout/token-pack`
- `POST /api/billing/portal`

### Webhook
- `POST /api/billing/webhook`

Handled event families:
- `checkout.session.completed`
- `customer.subscription.created|updated|deleted`
- `invoice.paid`

## Existing APIs Updated

- `POST /api/projects`
  - entitlement check for project creation (when enforcement enabled)
- `POST /api/uploads`
  - upload/storage entitlement check (when enforcement enabled)
- `POST /api/projects/[projectId]/runs`
- `POST /api/projects/[projectId]/nodes/[nodeId]/run`
  - token reservation before queueing
  - response includes billing reservation metadata
- `PATCH /api/runs/[runId]`
  - cancel now finalizes token usage as canceled and attempts queued-job removal

## Worker Finalization
`lib/execution/run-workflow.ts` now finalizes usage:

- success => finalize as success
- error => finalize as error
- canceled => finalize as canceled
- pre-canceled queued job exits early and refunds reservation

## UI Added/Updated

### New pages
- `/billing`
  - current plan
  - wallet balances
  - recent token transactions
  - recent usage events
  - checkout actions (plan + token packs + portal)
- `/settings` (protected placeholder page)

### Canvas run UX
Before queueing a run:
1. save graph
2. estimate token cost
3. block execution if insufficient tokens (when enforcement enabled)
4. queue run with reservation metadata

### Landing UX
Public CTAs now prioritize:
- register
- login
- pricing

## Environment Variables

Required for billing flow:

- `BILLING_ENFORCEMENT_ENABLED`
- `BILLING_CHECKOUT_LIMIT`
- `BILLING_CHECKOUT_WINDOW_SEC`
- `BILLING_WEBHOOK_LIMIT`
- `BILLING_WEBHOOK_WINDOW_SEC`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_FREE_MONTHLY`
- `STRIPE_PRICE_CREATOR_MONTHLY`
- `STRIPE_PRICE_PRO_MONTHLY`
- `STRIPE_PRICE_STUDIO_MONTHLY`
- `STRIPE_PRICE_TOKEN_PACK_STARTER`
- `STRIPE_PRICE_TOKEN_PACK_GROWTH`
- `STRIPE_PRICE_TOKEN_PACK_SCALE`

## Local Migration + Run

```bash
COREPACK_HOME=/tmp/corepack corepack pnpm db:generate
COREPACK_HOME=/tmp/corepack corepack pnpm db:migrate
COREPACK_HOME=/tmp/corepack corepack pnpm db:seed
COREPACK_HOME=/tmp/corepack corepack pnpm dev
COREPACK_HOME=/tmp/corepack corepack pnpm worker
```

If pnpm store mismatch appears, use the same store directory as existing install.

## Validation Checklist

- [ ] public pages load without auth
- [ ] `/app`, `/billing`, `/settings` redirect to login when logged out
- [ ] login/register/logout still work
- [ ] project creation respects plan limits
- [ ] upload respects plan limits
- [ ] run start reserves tokens
- [ ] run success/error/cancel finalizes usage and refunds appropriately
- [ ] token estimate shown before run
- [ ] webhook does not double-process duplicate Stripe events
- [ ] billing page shows balances/ledger history

## Known Local Constraint
In this environment, Prisma client types can remain stale even after `prisma generate` due local package-store/tooling mismatch. Runtime behavior can still be validated via route testing and migrations, but typecheck may report outdated model fields until client generation is fully refreshed.

