-- Metabase Query Pack: TribalAI analytics
-- Notes:
-- 1) All table names are quoted because Prisma uses mixed-case identifiers.
-- 2) Replace <PROJECT_ID> and <RUN_ID> where needed.
-- 3) For Metabase variables, use [[ ... {{variable}} ... ]] wrappers.

-- =========================================================
-- Q1) New user signups by day
-- =========================================================
select
  date_trunc('day', u."createdAt") as day,
  count(*) as new_users
from "User" u
group by 1
order by 1 desc;

-- =========================================================
-- Q2) Active users (7d / 30d) based on runs
-- =========================================================
select
  count(distinct case when r."createdAt" >= now() - interval '7 days' then r."createdBy" end) as active_users_7d,
  count(distinct case when r."createdAt" >= now() - interval '30 days' then r."createdBy" end) as active_users_30d
from "Run" r
where r."createdBy" is not null;

-- =========================================================
-- Q3) Projects with owners, members, and run volume
-- =========================================================
with run_counts as (
  select r."projectId", count(*) as run_count
  from "Run" r
  group by r."projectId"
),
member_counts as (
  select pm."projectId", count(*) as member_count
  from "ProjectMember" pm
  group by pm."projectId"
)
select
  p."id" as project_id,
  p."name" as project_name,
  p."createdAt" as project_created_at,
  p."userId" as owner_id,
  coalesce(owner."name", owner."email", 'unknown') as owner_label,
  coalesce(mc.member_count, 0) as members,
  coalesce(rc.run_count, 0) as runs
from "Project" p
left join "User" owner on owner."id" = p."userId"
left join member_counts mc on mc."projectId" = p."id"
left join run_counts rc on rc."projectId" = p."id"
order by runs desc, p."createdAt" desc;

-- =========================================================
-- Q4) Top users by runs created
-- =========================================================
select
  r."createdBy" as user_id,
  coalesce(u."name", u."email", 'unknown') as user_label,
  count(*) as runs_created
from "Run" r
left join "User" u on u."id" = r."createdBy"
where r."createdBy" is not null
group by r."createdBy", user_label
order by runs_created desc;

-- =========================================================
-- Q5) Run status split by project
-- =========================================================
select
  p."id" as project_id,
  p."name" as project_name,
  r.status::text as run_status,
  count(*) as runs
from "Run" r
join "Project" p on p."id" = r."projectId"
group by p."id", p."name", r.status
order by p."name" asc, runs desc;

-- =========================================================
-- Q6) Run success rate trend by day
-- =========================================================
select
  date_trunc('day', r."createdAt") as day,
  count(*) as total_runs,
  sum(case when r.status = 'success' then 1 else 0 end) as success_runs,
  round(
    100.0 * sum(case when r.status = 'success' then 1 else 0 end)::numeric / nullif(count(*), 0),
    2
  ) as success_rate_pct
from "Run" r
group by 1
order by 1 desc;

-- =========================================================
-- Q7) Average run duration by project (completed runs)
-- =========================================================
select
  p."id" as project_id,
  p."name" as project_name,
  round(avg(extract(epoch from (r."finishedAt" - coalesce(r."startedAt", r."createdAt"))) * 1000)) as avg_duration_ms,
  count(*) as completed_runs
from "Run" r
join "Project" p on p."id" = r."projectId"
where r."finishedAt" is not null
group by p."id", p."name"
order by avg_duration_ms desc nulls last;

-- =========================================================
-- Q8) Node reliability and speed
-- =========================================================
select
  rs."nodeType",
  count(*) as total_steps,
  sum(case when rs.status = 'success' then 1 else 0 end) as success_steps,
  sum(case when rs.status = 'error' then 1 else 0 end) as error_steps,
  round(
    100.0 * sum(case when rs.status = 'success' then 1 else 0 end)::numeric / nullif(count(*), 0),
    2
  ) as success_rate_pct,
  round(avg(rs."durationMs")) as avg_duration_ms
from "RunStep" rs
group by rs."nodeType"
order by total_steps desc;

-- =========================================================
-- Q9) Recent failing runs with user + project context
-- =========================================================
select
  r."id" as run_id,
  r."createdAt",
  r.status::text as run_status,
  p."id" as project_id,
  p."name" as project_name,
  coalesce(u."name", u."email", 'unknown') as created_by,
  left(r.logs, 240) as log_preview
from "Run" r
join "Project" p on p."id" = r."projectId"
left join "User" u on u."id" = r."createdBy"
where r.status = 'error'
order by r."createdAt" desc
limit 200;

-- =========================================================
-- Q10) Step error hotspots (node + message)
-- =========================================================
select
  rs."nodeType",
  coalesce(nullif(rs."errorMessage", ''), '(empty)') as error_message,
  count(*) as occurrences
from "RunStep" rs
where rs.status = 'error'
group by rs."nodeType", error_message
order by occurrences desc
limit 200;

-- =========================================================
-- Q11) Token usage by user (last 30 days)
-- =========================================================
select
  ue."userId" as user_id,
  coalesce(u."name", u."email", 'unknown') as user_label,
  count(*) as usage_events,
  coalesce(sum(ue."estimatedTokenCost"), 0) as estimated_tokens,
  coalesce(sum(ue."actualTokenCost"), 0) as actual_tokens
from "UsageEvent" ue
left join "User" u on u."id" = ue."userId"
where ue."createdAt" >= now() - interval '30 days'
group by ue."userId", user_label
order by actual_tokens desc, estimated_tokens desc;

-- =========================================================
-- Q12) Token transaction ledger by source/type (last 30 days)
-- =========================================================
select
  date_trunc('day', tt."createdAt") as day,
  tt.source::text as source,
  tt.type::text as txn_type,
  sum(tt.amount) as net_tokens
from "TokenTransaction" tt
where tt."createdAt" >= now() - interval '30 days'
group by 1, 2, 3
order by 1 desc, 2, 3;

-- =========================================================
-- Q13) Single project deep dive (replace <PROJECT_ID>)
-- =========================================================
select
  r."id" as run_id,
  r.status::text as run_status,
  r."createdAt" as created_at,
  r."startedAt" as started_at,
  r."finishedAt" as finished_at,
  round(extract(epoch from (r."finishedAt" - coalesce(r."startedAt", r."createdAt"))) * 1000) as duration_ms,
  coalesce(u."name", u."email", 'unknown') as created_by
from "Run" r
left join "User" u on u."id" = r."createdBy"
where r."projectId" = '<PROJECT_ID>'
order by r."createdAt" desc;

-- =========================================================
-- Q14) Single run timeline (replace <RUN_ID>)
-- =========================================================
select
  re."createdAt",
  re."eventType",
  re.status::text as status,
  re."nodeId",
  re."nodeType",
  re.message
from "RunEvent" re
where re."runId" = '<RUN_ID>'
order by re."createdAt" asc;
