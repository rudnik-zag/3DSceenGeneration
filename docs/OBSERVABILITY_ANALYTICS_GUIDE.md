# Observability and Analytics Guide

This project now records structured run telemetry in Postgres:

- `RunEvent`: lifecycle timeline (`run_queued`, `run_started`, `node_started`, `node_completed`, `run_failed`, etc.)
- `RunStep`: per-node execution records (status, duration, cache hit, input/output summaries)

## 1) Apply DB schema changes

Run these commands in repo root:

```bash
COREPACK_HOME=/tmp/corepack corepack pnpm prisma generate
COREPACK_HOME=/tmp/corepack corepack pnpm prisma db push
```

If you use migrations instead of `db push`:

```bash
COREPACK_HOME=/tmp/corepack corepack pnpm prisma migrate dev -n "run-telemetry"
```

## 2) Use built-in analytics APIs

### Run details (artifacts + steps + events)

```bash
curl -s "http://localhost:3000/api/runs/<RUN_ID>" | jq
```

### Project analytics summary

```bash
curl -s "http://localhost:3000/api/projects/<PROJECT_ID>/analytics" | jq
```

Returns:
- run totals/status split
- top run creators
- node-level step stats (`successRate`, `avgDurationMs`, failures)
- recent structured events

## 3) Metabase (recommended first dashboard tool)

Metabase is the fastest way to visualize your Postgres data.

### Start Metabase

```bash
docker run -d --name metabase -p 3001:3000 metabase/metabase
```

Open `http://localhost:3001`, connect your Postgres (`DATABASE_URL`), then create questions.

### Useful SQL questions

#### A) Which users create most runs?

```sql
select
  r."createdBy" as user_id,
  coalesce(u."name", u."email", 'unknown') as user_label,
  count(*) as runs
from "Run" r
left join "User" u on u."id" = r."createdBy"
group by r."createdBy", user_label
order by runs desc;
```

#### B) Node reliability + speed

```sql
select
  "nodeType",
  count(*) as total_steps,
  sum(case when status = 'success' then 1 else 0 end) as success_steps,
  sum(case when status = 'error' then 1 else 0 end) as error_steps,
  round(avg("durationMs")) as avg_duration_ms
from "RunStep"
group by "nodeType"
order by total_steps desc;
```

#### C) Run success rate over time

```sql
select
  date_trunc('day', "createdAt") as day,
  count(*) as total_runs,
  sum(case when status = 'success' then 1 else 0 end) as successful_runs
from "Run"
group by day
order by day desc;
```

#### D) Recent timeline for one run

```sql
select
  "createdAt",
  "eventType",
  status,
  "nodeId",
  "nodeType",
  message
from "RunEvent"
where "runId" = '<RUN_ID>'
order by "createdAt" asc;
```

## 4) Sentry (errors and stack traces)

Use Sentry for production exceptions in Next.js API/routes and worker processes.

### Install

```bash
COREPACK_HOME=/tmp/corepack corepack pnpm add @sentry/nextjs @sentry/node
```

### Configure env

Set in `.env`:

```bash
SENTRY_DSN=...
SENTRY_ORG=...
SENTRY_PROJECT=...
SENTRY_AUTH_TOKEN=...
```

### Integrate

- Next.js: run Sentry wizard (`npx @sentry/wizard@latest -i nextjs`) or configure manually.
- Worker: initialize `@sentry/node` at worker startup and capture unhandled errors.
- Include tags: `runId`, `projectId`, `graphId`, `nodeId`, `nodeType`.

Result: when a run fails, you get stack trace + telemetry IDs to jump to `RunEvent`/`RunStep`.

## 5) OpenTelemetry + Grafana/Loki (infra-level visibility)

Use this when you need latency, throughput, and log correlation across services.

### What to capture

- Traces: API routes, queue enqueue/dequeue, worker node execution.
- Metrics: run queue depth, run duration, step duration, error rate.
- Logs: structured logs with `runId`, `projectId`, `nodeId`, `eventType`.

### Minimal rollout plan

1. Add OpenTelemetry SDK to app + worker.
2. Export traces/metrics to an OTel collector.
3. Send logs to Loki.
4. Build Grafana dashboards:
   - queue latency
   - run success/error rate
   - p95 step duration by node type
   - top failing nodes

## 6) Suggested weekly operating routine

1. Check Metabase dashboard for success rate and slow nodes.
2. Drill into failing runs via `RunEvent` timeline.
3. Open Sentry for stack traces on top errors.
4. Prioritize fixes by `(failure_count * affected_users)`.
5. Re-check trend lines after deploy.
