begin;

create schema if not exists analytics;

drop view if exists analytics.v_token_transactions_daily;
drop view if exists analytics.v_usage_daily;
drop view if exists analytics.v_node_error_hotspots;
drop view if exists analytics.v_node_type_daily;
drop view if exists analytics.v_run_facts;
drop view if exists analytics.v_project_overview;
drop view if exists analytics.v_user_summary;

create view analytics.v_user_summary as
with owned_projects as (
  select
    p."userId" as user_id,
    count(*)::int as owned_projects
  from "Project" p
  group by p."userId"
),
member_projects as (
  select
    pm."userId" as user_id,
    count(*)::int as member_projects
  from "ProjectMember" pm
  group by pm."userId"
),
run_activity as (
  select
    r."createdBy" as user_id,
    count(*)::int as runs_created,
    sum(case when r.status = 'success' then 1 else 0 end)::int as successful_runs,
    sum(case when r.status = 'error' then 1 else 0 end)::int as failed_runs,
    max(r."createdAt") as last_run_at,
    count(distinct r."projectId")::int as projects_with_runs
  from "Run" r
  where r."createdBy" is not null
  group by r."createdBy"
),
usage_30d as (
  select
    ue."userId" as user_id,
    count(*)::int as usage_events_30d,
    coalesce(sum(ue."estimatedTokenCost"), 0)::bigint as estimated_tokens_30d,
    coalesce(sum(ue."actualTokenCost"), 0)::bigint as actual_tokens_30d
  from "UsageEvent" ue
  where ue."createdAt" >= now() - interval '30 days'
  group by ue."userId"
)
select
  u."id" as user_id,
  coalesce(u."name", u."email", 'unknown') as user_label,
  u."email" as email,
  u."createdAt" as user_created_at,
  coalesce(s.plan::text, 'Free') as subscription_plan,
  coalesce(s.status::text, 'active') as subscription_status,
  coalesce(op.owned_projects, 0) as owned_projects,
  coalesce(mp.member_projects, 0) as member_projects,
  coalesce(ra.projects_with_runs, 0) as projects_with_runs,
  coalesce(ra.runs_created, 0) as runs_created,
  coalesce(ra.successful_runs, 0) as successful_runs,
  coalesce(ra.failed_runs, 0) as failed_runs,
  round(
    100.0 * coalesce(ra.successful_runs, 0)::numeric / nullif(coalesce(ra.runs_created, 0), 0),
    2
  ) as run_success_rate_pct,
  ra.last_run_at as last_run_at,
  coalesce(tw."monthlyTokensRemaining", 0) as monthly_tokens_remaining,
  coalesce(tw."purchasedTokensRemaining", 0) as purchased_tokens_remaining,
  coalesce(tw."totalTokensUsed", 0) as total_tokens_used,
  coalesce(u30.usage_events_30d, 0) as usage_events_30d,
  coalesce(u30.estimated_tokens_30d, 0) as estimated_tokens_30d,
  coalesce(u30.actual_tokens_30d, 0) as actual_tokens_30d
from "User" u
left join "Subscription" s on s."userId" = u."id"
left join "TokenWallet" tw on tw."userId" = u."id"
left join owned_projects op on op.user_id = u."id"
left join member_projects mp on mp.user_id = u."id"
left join run_activity ra on ra.user_id = u."id"
left join usage_30d u30 on u30.user_id = u."id";

create view analytics.v_project_overview as
with member_counts as (
  select
    pm."projectId" as project_id,
    count(*)::int as members
  from "ProjectMember" pm
  group by pm."projectId"
),
graph_counts as (
  select
    g."projectId" as project_id,
    count(*)::int as graphs
  from "Graph" g
  group by g."projectId"
),
artifact_counts as (
  select
    a."projectId" as project_id,
    count(*)::int as artifacts
  from "Artifact" a
  group by a."projectId"
),
run_agg as (
  select
    r."projectId" as project_id,
    count(*)::int as total_runs,
    sum(case when r.status = 'success' then 1 else 0 end)::int as success_runs,
    sum(case when r.status = 'error' then 1 else 0 end)::int as error_runs,
    sum(case when r.status = 'running' then 1 else 0 end)::int as running_runs,
    sum(case when r.status = 'queued' then 1 else 0 end)::int as queued_runs,
    sum(case when r.status = 'canceled' then 1 else 0 end)::int as canceled_runs,
    max(r."createdAt") as last_run_at,
    round(
      avg(extract(epoch from (r."finishedAt" - coalesce(r."startedAt", r."createdAt"))) * 1000)
      filter (where r."finishedAt" is not null)
    ) as avg_run_duration_ms
  from "Run" r
  group by r."projectId"
)
select
  p."id" as project_id,
  p."name" as project_name,
  p."createdAt" as project_created_at,
  p."updatedAt" as project_updated_at,
  p."userId" as owner_id,
  coalesce(owner."name", owner."email", 'unknown') as owner_label,
  coalesce(mc.members, 0) as members,
  coalesce(gc.graphs, 0) as graphs,
  coalesce(ac.artifacts, 0) as artifacts,
  coalesce(ra.total_runs, 0) as total_runs,
  coalesce(ra.success_runs, 0) as success_runs,
  coalesce(ra.error_runs, 0) as error_runs,
  coalesce(ra.running_runs, 0) as running_runs,
  coalesce(ra.queued_runs, 0) as queued_runs,
  coalesce(ra.canceled_runs, 0) as canceled_runs,
  round(
    100.0 * coalesce(ra.success_runs, 0)::numeric / nullif(coalesce(ra.total_runs, 0), 0),
    2
  ) as run_success_rate_pct,
  ra.avg_run_duration_ms as avg_run_duration_ms,
  ra.last_run_at as last_run_at
from "Project" p
left join "User" owner on owner."id" = p."userId"
left join member_counts mc on mc.project_id = p."id"
left join graph_counts gc on gc.project_id = p."id"
left join artifact_counts ac on ac.project_id = p."id"
left join run_agg ra on ra.project_id = p."id";

create view analytics.v_run_facts as
select
  r."id" as run_id,
  r."projectId" as project_id,
  p."name" as project_name,
  r."graphId" as graph_id,
  r."createdBy" as created_by_user_id,
  coalesce(u."name", u."email", 'unknown') as created_by_user_label,
  r.status::text as run_status,
  r."progress" as progress,
  r."createdAt" as created_at,
  r."startedAt" as started_at,
  r."finishedAt" as finished_at,
  case
    when r."finishedAt" is not null
      then round(extract(epoch from (r."finishedAt" - coalesce(r."startedAt", r."createdAt"))) * 1000)
    else null
  end as duration_ms
from "Run" r
join "Project" p on p."id" = r."projectId"
left join "User" u on u."id" = r."createdBy";

create view analytics.v_node_type_daily as
select
  date_trunc('day', rs."createdAt") as day,
  rs."projectId" as project_id,
  rs."nodeType" as node_type,
  count(*)::int as total_steps,
  sum(case when rs.status = 'success' then 1 else 0 end)::int as success_steps,
  sum(case when rs.status = 'error' then 1 else 0 end)::int as error_steps,
  sum(case when rs.status = 'running' then 1 else 0 end)::int as running_steps,
  sum(case when rs.status = 'queued' then 1 else 0 end)::int as queued_steps,
  sum(case when rs.status = 'canceled' then 1 else 0 end)::int as canceled_steps,
  round(
    100.0 * sum(case when rs.status = 'success' then 1 else 0 end)::numeric / nullif(count(*), 0),
    2
  ) as success_rate_pct,
  round(avg(rs."durationMs")) as avg_duration_ms
from "RunStep" rs
group by date_trunc('day', rs."createdAt"), rs."projectId", rs."nodeType";

create view analytics.v_node_error_hotspots as
select
  rs."projectId" as project_id,
  rs."nodeType" as node_type,
  coalesce(nullif(rs."errorMessage", ''), '(empty)') as error_message,
  count(*)::int as error_count,
  max(rs."createdAt") as last_seen_at
from "RunStep" rs
where rs.status = 'error'
group by rs."projectId", rs."nodeType", coalesce(nullif(rs."errorMessage", ''), '(empty)');

create view analytics.v_usage_daily as
select
  date_trunc('day', ue."createdAt") as day,
  ue."userId" as user_id,
  ue."projectId" as project_id,
  count(*)::int as usage_events,
  coalesce(sum(ue."estimatedTokenCost"), 0)::bigint as estimated_tokens,
  coalesce(sum(ue."actualTokenCost"), 0)::bigint as actual_tokens
from "UsageEvent" ue
group by date_trunc('day', ue."createdAt"), ue."userId", ue."projectId";

create view analytics.v_token_transactions_daily as
select
  date_trunc('day', tt."createdAt") as day,
  tt."userId" as user_id,
  tt."projectId" as project_id,
  tt.source::text as source,
  tt.type::text as txn_type,
  sum(tt.amount)::bigint as net_tokens
from "TokenTransaction" tt
group by
  date_trunc('day', tt."createdAt"),
  tt."userId",
  tt."projectId",
  tt.source,
  tt.type;

commit;
