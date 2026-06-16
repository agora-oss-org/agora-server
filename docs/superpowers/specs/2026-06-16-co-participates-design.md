# CO_PARTICIPATES Edge — Design Spec

**Date:** 2026-06-16
**Status:** Approved
**Phase:** Social graph Phase 2 completion (PR 9)

---

## Overview

Adds a `CO_PARTICIPATES` graph edge between users who post in the same thread.
This completes the one remaining item in SOCIAL-GRAPH.md §7 Phase 2.

**Scope:** Write edges in the scorer pipeline + expose them in `GET /social/neighborhood`
via an opt-in SDK flag. No new social_config key. No change to Weather.

---

## 1. Edge schema (Neo4j)

**Type:** `CO_PARTICIPATES`
**Direction:** Canonical-directed — always `(lower_id)→(higher_id)` to avoid duplicates.
**Read pattern:** `(me)-[:CO_PARTICIPATES]-(x)` (undirected match; Neo4j ignores direction when no arrow is specified).

| Property | Type | Description |
|---|---|---|
| `sourceA` | string | `min(userA_id, userB_id)` — keying property |
| `sourceB` | string | `max(userA_id, userB_id)` — keying property |
| `projectId` | string | Multi-tenant scope; indexed |
| `weight` | float | Incremented on each co-event, capped at `MAX_WEIGHT` |
| `lastAt` | int (epoch-ms) | Timestamp of most recent co-participation |
| `createdAt` | int (epoch-ms) | Set once on first write |

**Keying:** `MERGE` on `{sourceA, sourceB, projectId}` — idempotent regardless of which commenter triggers the write.

**Sentiment:** None. CO_PARTICIPATES is structurally neutral — it contributes 0 warmth and 0 friction in all read surfaces. Its sole effect is expanding the neighbor set.

---

## 2. Scorer pipeline

### Env vars (scorer)

```
CO_PARTICIPATES_LOOKBACK_DAYS=7     # max age of co-commenters to include
CO_PARTICIPATES_MAX_PARTICIPANTS=50  # max co-participants written per comment event
CO_PARTICIPATES_MAX_WEIGHT=10.0      # weight ceiling; weight never exceeds this
```

### New: `resolve_co_participants()` in `scorer/db.py`

Single SQL query: given a `comment_id`, find all distinct `user_id`s who also commented on the same entity (any depth of thread) within the lookback window, excluding the triggering commenter, ordered by recency, capped at `MAX_PARTICIPANTS`.

```sql
select distinct c.user_id
from comments c
where c.entity_id = $entity_id
  and c.user_id != $actor_id
  and c.created_at >= now() - interval '$lookback_days days'
  and c.removed_at is null
order by max(c.created_at) desc
limit $max_participants
```

Returns `list[str]` (user IDs). Empty list if no co-participants found.

### New: `write_co_participates_edge()` in `worker/neo4j_writer.py`

```cypher
merge (a:User {id: $source_a})
merge (b:User {id: $source_b})
merge (a)-[r:CO_PARTICIPATES {sourceA: $source_a, sourceB: $source_b, projectId: $project_id}]->(b)
  on create set r.createdAt = timestamp(), r.weight = 1.0
  on match  set r.weight = min(r.weight + 1.0, $max_weight)
set r.lastAt = timestamp()
```

Called once per co-participant. `source_a = min(actor_id, participant_id)`, `source_b = max(...)`.

### Wiring in `worker/pipeline.py`

After the existing `write_interaction_edge()` block (triggered on `target_type == "comment"`):

```python
if write_interaction and target_type == "comment" and graph_enabled:
    co_participants = await resolve_co_participants(
        settings, entity_id=ctx.entity_id, actor_id=ctx.actor_id
    )
    for participant_id in co_participants:
        await write_co_participates_edge(
            settings,
            project_id=project_id,
            actor_id=ctx.actor_id,
            participant_id=participant_id,
        )
```

**No new pgmq job, no new trigger, no new Postgres migration.** CO_PARTICIPATES edges live purely in Neo4j.

---

## 3. API — Neighborhood flag

### Query param

`GET /v7/:projectId/social/neighborhood?includeCoParticipates=true`

Default: `false`. Parsed alongside the existing `includeInteractions` param in `routes/social.ts`.

### Cypher change in `lib/social-neighborhood.ts`

When `includeCoParticipates=false` (default), Cypher is unchanged:
```cypher
(me)-[rel:FOLLOWS|CONNECTED|INTERACTED]-(x)
```

When `includeCoParticipates=true`:
```cypher
(me)-[rel:FOLLOWS|CONNECTED|INTERACTED|CO_PARTICIPATES]-(x)
```

CO_PARTICIPATES edges use `lastAt` instead of `at` for the age/decay timestamp.
The warmth/friction accumulation uses:
- `coalesce(rel.sentiment, 0.0)` — neutral edges contribute 0
- `coalesce(rel.at, rel.lastAt)` — handles both edge shapes for the age cutoff

### Response

`SocialNeighborhood` shape is unchanged. The `config` field gains `includeCoParticipates: boolean` echoed back (same PR4.1 pattern as `includeInteractions`).

---

## 4. Contract

File: `packages/contract/src/social.ts`

Add to `SocialNeighborhoodConfig`:
```typescript
includeCoParticipates?: boolean;
```

No other contract changes. No new types.

---

## 5. Testing

### Scorer (Python unit tests, `services/scorer/tests/`)

| Test | Assertions |
|---|---|
| `test_resolve_co_participants_basic` | Returns co-commenters on same entity; excludes actor |
| `test_resolve_co_participants_lookback` | Filters comments older than `LOOKBACK_DAYS` |
| `test_resolve_co_participants_cap` | Truncates at `MAX_PARTICIPANTS` |
| `test_write_co_participates_edge_create` | MERGE fires with canonical pair; weight=1.0 on create |
| `test_write_co_participates_edge_increment` | weight increments on second call |
| `test_write_co_participates_edge_cap` | weight clamps at `MAX_WEIGHT` |
| `test_pipeline_co_participates_fires` | CO_PARTICIPATES writes run after INTERACTED on comment job |
| `test_pipeline_co_participates_skipped_non_comment` | No CO_PARTICIPATES writes for entity jobs |
| `test_pipeline_co_participates_skipped_graph_disabled` | No writes when graph is off |

### API (TypeScript unit tests, `apps/api/src/lib/social-neighborhood.test.ts`)

| Test | Assertions |
|---|---|
| `flag false → unchanged Cypher` | Relationship list does not include CO_PARTICIPATES |
| `flag true → CO_PARTICIPATES added` | Relationship list includes CO_PARTICIPATES |
| `lastAt coalesce` | Edge with `lastAt` (no `at`) parsed correctly for age cutoff |
| `zero sentiment` | CO_PARTICIPATES edge contributes 0 warmth, 0 friction |
| `config echoed` | Response config.includeCoParticipates matches the request flag |

### Integration

Not feasible without live Neo4j + scorer. Same constraint as existing Neighborhood tests.

---

## 6. Files changed

| File | Change |
|---|---|
| `services/scorer/scorer/db.py` | + `resolve_co_participants()` |
| `services/scorer/worker/neo4j_writer.py` | + `write_co_participates_edge()` |
| `services/scorer/worker/pipeline.py` | Wire co-participant loop after INTERACTED write |
| `services/scorer/scorer/settings.py` (or equivalent) | + 3 new env vars |
| `apps/api/src/lib/social-neighborhood.ts` | Cypher conditioned on `includeCoParticipates` |
| `apps/api/src/routes/social.ts` | Parse + pass `includeCoParticipates` query param |
| `packages/contract/src/social.ts` | `SocialNeighborhoodConfig.includeCoParticipates?` |
| `apps/api/src/lib/social-neighborhood.test.ts` | New unit tests (5 cases) |
| `services/scorer/tests/test_co_participates.py` | New Python unit tests (9 cases) |
| `CHANGELOG.md` | Entry under `[Unreleased]` |
| `docs/SOCIAL-GRAPH.md` | §7 Phase 2 marked complete |
| `docs/MANIFEST.md` | `includeCoParticipates` param on Neighborhood endpoint |

---

## 7. Out of scope

- CO_PARTICIPATES in Weather (neutral edge, no warmth contribution there)
- Per-project `social_config` flag (inherits `graphEnabled` gate)
- GDS projection update for Louvain silo detection (CO_PARTICIPATES will be picked up automatically once edges exist, as GDS reads all relationship types included in its projection — confirm the projection definition covers it, or update if needed)
- Per-space CO_PARTICIPATES (deferred alongside per-space Weather)
- `block`/`mute` FRICTION source (separate feature)
