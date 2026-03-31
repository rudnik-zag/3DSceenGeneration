# Metabase Analytics Playbook

Use this guide to analyze:
- which users create which projects/runs
- project-level success/error trends
- node reliability and bottlenecks
- token/cost usage

## 1) Start Metabase

### Option A: Docker (recommended)

```bash
bash scripts/metabase-start.sh
```

Opens Metabase on `http://localhost:3001`.

### Option B: Without Docker

```bash
mkdir -p .run/metabase
cd .run/metabase
curl -L -o metabase.jar https://downloads.metabase.com/latest/metabase.jar
java -jar metabase.jar
```

Opens Metabase on `http://localhost:3000` by default.

## 2) Connect your PostgreSQL database

Use these credentials in Metabase:

- Database type: `PostgreSQL`
- Host:
  - `host.docker.internal` if Metabase runs in Docker
  - `localhost` if Metabase runs from JAR on host
- Port: `5432`
- Database name: `tribalai3d`
- Username: `postgres`
- Password: `postgres`

## 3) Load saved SQL queries

Open [docs/sql/METABASE_QUERIES.sql](/home/dusan/Desktop/ML_PROJECTS/git/3DSceenGeneration/docs/sql/METABASE_QUERIES.sql) and create each block as a saved Metabase question.

Start with:
1. `Q3` Projects with owners/members/runs
2. `Q4` Top users by runs
3. `Q6` Run success rate trend
4. `Q8` Node reliability and speed
5. `Q10` Step error hotspots

## 4) Install prebuilt analytics DB views (recommended)

Apply all `analytics.v_*` views:

```bash
pnpm analytics:views
```

Source SQL:
- [scripts/sql/analytics_views.sql](/home/dusan/Desktop/ML_PROJECTS/git/3DSceenGeneration/scripts/sql/analytics_views.sql)

View-based query pack:
- [docs/sql/METABASE_VIEW_QUERIES.sql](/home/dusan/Desktop/ML_PROJECTS/git/3DSceenGeneration/docs/sql/METABASE_VIEW_QUERIES.sql)

## 5) Build 3 dashboards

### A) Product Overview
- Q1 New user signups
- Q2 Active users 7d/30d
- Q3 Projects with owners/members/runs
- Q6 Run success rate trend

### B) Delivery Health
- Q5 Run status split by project
- Q7 Average run duration by project
- Q8 Node reliability and speed
- Q9 Recent failing runs
- Q10 Step error hotspots

### C) Usage and Cost
- Q11 Token usage by user
- Q12 Token transaction ledger

## 6) Project and run deep dives

Use:
- `Q13` by replacing `<PROJECT_ID>`
- `Q14` by replacing `<RUN_ID>`

You can get IDs from:
- app URLs (`/app/p/<PROJECT_ID>/...`)
- API responses (`/api/projects/<PROJECT_ID>/analytics`, `/api/runs/<RUN_ID>`)

## 7) GUI options (if you want alternatives)

1. Metabase: fastest setup, best default choice for this project.
2. Grafana: strong for time-series and infra metrics, more setup for SQL business analytics.
3. Apache Superset: powerful BI, heavier setup and admin overhead.

## 8) Weekly operating routine

1. Check Product Overview for adoption and activity.
2. Check Delivery Health for failures and slow nodes.
3. Open recent failing runs and inspect timelines (Q14).
4. Prioritize fixes by highest failure frequency and longest duration impact.
5. Track trend change after deploy.
