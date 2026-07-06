// Hourly community-activity rollup for the operator-only "Community" dashboard. For each project it
// (re)computes a trailing window of per-hour buckets and upserts them into community_stats_hourly —
// so a missed cron run self-heals on the next pass (idempotent like lib/recompute.ts). Each bucket
// carries: flow counts (events within the hour), cumulative all-time totals as of the hour (base
// count + running sum, exact and cheap — no correlated per-hour counts), and — for the latest hour
// only — the leaderboard / top-post ranking over a rolling window. Snapshots store ids + counts only;
// the read endpoint hydrates display fields fresh. Invoked by POST /internal/cron/community-stats and
// the standalone scripts/rollup-community-stats.mjs.
import { sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { projects } from "../db/schema/index.js";

// Hours of trailing buckets to recompute each run. 25 → the current hour + the prior 24, so a single
// missed hourly run is fully backfilled on the next one.
const BACKFILL_HOURS = 25;
// Rolling window (days) the leaderboard + top-post snapshot ranks over — "who's driving the pulse now".
const LEADERBOARD_WINDOW_DAYS = 7;

export async function rollupCommunityStats(projectId?: string | null): Promise<{ projects: number; hours: number }> {
  const ids = projectId
    ? [projectId]
    : (await getDb().select({ id: projects.id }).from(projects)).map((r) => r.id);

  let hours = 0;
  for (const id of ids) {
    hours += await rollupProject(id);
  }
  return { projects: ids.length, hours };
}

async function rollupProject(id: string): Promise<number> {
  // 1) Flow + cumulative totals for the trailing window. generate_series gives a row per hour even
  //    when nothing happened (so cumulative totals stay continuous); LEFT JOINs attach per-source
  //    counts. Cumulative = all-time base before the window + a running sum over the buckets. The
  //    upsert deliberately omits the top_* snapshot columns so historical snapshots are preserved.
  const upserted = await getDb().execute(sql`
    with hours as (
      select generate_series(
        date_trunc('hour', now() - make_interval(hours => ${BACKFILL_HOURS - 1})),
        date_trunc('hour', now()),
        interval '1 hour'
      ) as hour
    ),
    win as (select min(hour) as start from hours),
    u as (
      select date_trunc('hour', created_at) as hour, count(*) as n
      from profiles where project_id = ${id}::uuid and created_at >= (select start from win)
      group by 1
    ),
    p as (
      select date_trunc('hour', created_at) as hour, count(*) as n, count(distinct user_id) as actors
      from entities where project_id = ${id}::uuid and deleted_at is null and created_at >= (select start from win)
      group by 1
    ),
    cm as (
      select date_trunc('hour', created_at) as hour, count(*) as n, count(distinct user_id) as actors
      from comments where project_id = ${id}::uuid and deleted_at is null and created_at >= (select start from win)
      group by 1
    ),
    rx as (
      select date_trunc('hour', created_at) as hour, count(*) as n, count(distinct user_id) as actors
      from reactions where project_id = ${id}::uuid and created_at >= (select start from win)
      group by 1
    ),
    ro as (
      select date_trunc('hour', created_at) as hour, count(*) as n
      from reports where project_id = ${id}::uuid and created_at >= (select start from win)
      group by 1
    ),
    rr as (
      select date_trunc('hour', resolved_at) as hour, count(*) as n
      from reports where project_id = ${id}::uuid and resolved_at is not null and resolved_at >= (select start from win)
      group by 1
    ),
    base as (
      select
        (select count(*) from profiles  where project_id = ${id}::uuid and created_at < (select start from win)) as users,
        (select count(*) from entities  where project_id = ${id}::uuid and deleted_at is null and created_at < (select start from win)) as posts,
        (select count(*) from comments  where project_id = ${id}::uuid and deleted_at is null and created_at < (select start from win)) as comments,
        (select count(*) from reactions where project_id = ${id}::uuid and created_at < (select start from win)) as reactions
    ),
    flow as (
      select
        h.hour,
        coalesce(u.n, 0)::int       as new_users,
        coalesce(p.n, 0)::int       as new_posts,
        coalesce(cm.n, 0)::int      as new_comments,
        coalesce(rx.n, 0)::int      as new_reactions,
        coalesce(p.actors, 0)::int  as active_posters,
        coalesce(cm.actors, 0)::int as active_commenters,
        coalesce(rx.actors, 0)::int as active_reactors,
        coalesce(ro.n, 0)::int      as reports_opened,
        coalesce(rr.n, 0)::int      as reports_resolved
      from hours h
      left join u  on u.hour  = h.hour
      left join p  on p.hour  = h.hour
      left join cm on cm.hour = h.hour
      left join rx on rx.hour = h.hour
      left join ro on ro.hour = h.hour
      left join rr on rr.hour = h.hour
    ),
    rolled as (
      select
        flow.*,
        ((select users     from base) + sum(new_users)     over w)::int as total_users,
        ((select posts     from base) + sum(new_posts)     over w)::int as total_posts,
        ((select comments  from base) + sum(new_comments)  over w)::int as total_comments,
        ((select reactions from base) + sum(new_reactions) over w)::int as total_reactions
      from flow
      window w as (order by hour rows between unbounded preceding and current row)
    )
    insert into community_stats_hourly (
      project_id, hour, new_users, new_posts, new_comments, new_reactions,
      active_posters, active_commenters, active_reactors, reports_opened, reports_resolved,
      total_users, total_posts, total_comments, total_reactions, updated_at
    )
    select ${id}::uuid, hour, new_users, new_posts, new_comments, new_reactions,
      active_posters, active_commenters, active_reactors, reports_opened, reports_resolved,
      total_users, total_posts, total_comments, total_reactions, now()
    from rolled
    on conflict (project_id, hour) do update set
      new_users         = excluded.new_users,
      new_posts         = excluded.new_posts,
      new_comments      = excluded.new_comments,
      new_reactions     = excluded.new_reactions,
      active_posters    = excluded.active_posters,
      active_commenters = excluded.active_commenters,
      active_reactors   = excluded.active_reactors,
      reports_opened    = excluded.reports_opened,
      reports_resolved  = excluded.reports_resolved,
      total_users       = excluded.total_users,
      total_posts       = excluded.total_posts,
      total_comments    = excluded.total_comments,
      total_reactions   = excluded.total_reactions,
      updated_at        = now()
    returning hour
  `);

  // 2) Leaderboard + top-post snapshot for the CURRENT hour, ranked by activity volume over the
  //    rolling window. Stored as id+count arrays (rank order preserved via jsonb_agg ... order by).
  //    The current-hour row was just inserted by step 1, so this UPDATE always lands.
  await getDb().execute(sql`
    with posters as (
      select user_id, count(*)::int as n
      from entities
      where project_id = ${id}::uuid and deleted_at is null and user_id is not null
        and created_at >= now() - make_interval(days => ${LEADERBOARD_WINDOW_DAYS})
      group by user_id order by n desc limit 10
    ),
    commenters as (
      select user_id, count(*)::int as n
      from comments
      where project_id = ${id}::uuid and deleted_at is null and user_id is not null
        and created_at >= now() - make_interval(days => ${LEADERBOARD_WINDOW_DAYS})
      group by user_id order by n desc limit 10
    ),
    reactors as (
      select user_id, count(*)::int as n
      from reactions
      where project_id = ${id}::uuid
        and created_at >= now() - make_interval(days => ${LEADERBOARD_WINDOW_DAYS})
      group by user_id order by n desc limit 10
    ),
    posts as (
      select e.id, r.reactions::int as reactions, e.replies_count::int as replies, e.score,
        (r.reactions + e.replies_count) as eng
      from entities e
      cross join lateral (
        select coalesce(sum(value::int), 0) as reactions from jsonb_each_text(e.reaction_counts)
      ) r
      where e.project_id = ${id}::uuid and e.deleted_at is null
        and e.moderation_status is distinct from 'removed'
        and e.created_at >= now() - make_interval(days => ${LEADERBOARD_WINDOW_DAYS})
      order by eng desc, e.created_at desc limit 20
    )
    update community_stats_hourly s set
      top_posters    = coalesce((select jsonb_agg(jsonb_build_object('userId', user_id, 'count', n) order by n desc) from posters), '[]'::jsonb),
      top_commenters = coalesce((select jsonb_agg(jsonb_build_object('userId', user_id, 'count', n) order by n desc) from commenters), '[]'::jsonb),
      top_reactors   = coalesce((select jsonb_agg(jsonb_build_object('userId', user_id, 'count', n) order by n desc) from reactors), '[]'::jsonb),
      top_posts      = coalesce((select jsonb_agg(jsonb_build_object('entityId', id, 'reactions', reactions, 'replies', replies, 'score', score) order by eng desc) from posts), '[]'::jsonb),
      updated_at     = now()
    where s.project_id = ${id}::uuid and s.hour = date_trunc('hour', now())
  `);

  return (upserted as unknown as unknown[]).length;
}
