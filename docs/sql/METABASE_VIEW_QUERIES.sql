-- Metabase queries using prebuilt analytics views (analytics.v_*)
-- Make sure views are installed first:
--   pnpm analytics:views

-- QV1) Top users by runs created
select
  user_id,
  user_label,
  runs_created,
  successful_runs,
  failed_runs,
  run_success_rate_pct,
  last_run_at
from analytics.v_user_summary
order by runs_created desc
limit 200;

-- QV2) Project leaderboard
select
  project_id,
  project_name,
  owner_label,
  members,
  graphs,
  artifacts,
  total_runs,
  success_runs,
  error_runs,
  run_success_rate_pct,
  avg_run_duration_ms,
  last_run_at
from analytics.v_project_overview
order by total_runs desc, project_updated_at desc;

-- QV3) Delivery health by day
select
  day,
  sum(total_steps) as total_steps,
  sum(success_steps) as success_steps,
  sum(error_steps) as error_steps,
  round(100.0 * sum(success_steps)::numeric / nullif(sum(total_steps), 0), 2) as success_rate_pct
from analytics.v_node_type_daily
group by day
order by day desc;

-- QV4) Slowest node types (last 30 days)
select
  node_type,
  sum(total_steps) as total_steps,
  round(avg(avg_duration_ms)) as avg_duration_ms
from analytics.v_node_type_daily
where day >= now() - interval '30 days'
group by node_type
having sum(total_steps) >= 5
order by avg_duration_ms desc nulls last;

-- QV5) Error hotspots
select
  project_id,
  node_type,
  error_message,
  error_count,
  last_seen_at
from analytics.v_node_error_hotspots
order by error_count desc, last_seen_at desc
limit 200;

-- QV6) Run funnel by status
select
  run_status,
  count(*) as runs
from analytics.v_run_facts
group by run_status
order by runs desc;

-- QV7) Usage tokens per day (actual)
select
  day,
  sum(actual_tokens) as actual_tokens
from analytics.v_usage_daily
group by day
order by day desc;

-- QV8) Net token flow per source
select
  day,
  source,
  sum(net_tokens) as net_tokens
from analytics.v_token_transactions_daily
group by day, source
order by day desc, source asc;

-- QV9) Step timeline per run (intuitive step code + label)
select
  run_id,
  run_label,
  step_sequence,
  step_code,
  step_label,
  node_type,
  step_status,
  duration_ms,
  cache_hit,
  error_message,
  created_at
from analytics.v_run_step_timeline
where 1 = 1
  [[and project_id = {{project_id}}]]
  [[and run_id = {{run_id}}]]
order by created_at desc, step_sequence asc;
