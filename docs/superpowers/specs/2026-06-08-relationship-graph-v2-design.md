# Relationship graph v2 — the user→user interaction graph

**Status:** design approved, pre-implementation
**Date:** 2026-06-08
**Subsystem:** `services/scorer` (see `docs/SCORER.md`)
**Roadmap item:** SCORER.md Roadmap #1 — "Relationship graph v2"

---

## 1. Context & goal

The scorer's v1 Neo4j graph captures **`(:User)-[:AUTHORED]->(:Content)`** with a signed sentiment
score on the *content* node — "who wrote what, and how it reads." v2 adds the **user→user**
relationship layer: how warmly user A engages user B, derived by resolving the **recipient** of each
interaction (the author of the parent content) and attaching a sentiment to that directed pair.

This is the headline capability the old `apps/moderator` never had, and the reason Neo4j is in the
stack at all.

## 2. Decisions locked (from brainstorming)

1. **Scope** — comments, replies, **reactions**, and **follows** all feed the graph. (Chat/DMs are out:
   secure chat is end-to-end-encrypted, so the server has no message plaintext to score, and message
   reactions are excluded for the same reason.)
2. **Two distinct edge types, never one blended edge** — combined only at *read* time:
   - `INTERACTED` — *behavioral*, scored, signed, append-log, many per pair, sourced from the content
     pipeline / reactions.
   - `FOLLOWS` — *structural*, unscored, at most one per pair, inherently positive, **retractable**,
     mirrors the `follows` table.
   Rationale: they are genuinely different facts with different lifecycles. Folding a retractable
   structural state into an append-log of scored events creates lifecycle confusion. Keeping them
   separate means each edge label has exactly one meaning, and "overall warmth" is a query-time
   combination where the weighting lives in the *consumer*.
3. **Aggregation = per-interaction append-log (option 1)** — one `INTERACTED` edge **per interaction**,
   `MERGE`-keyed on `sourceId`, so pgmq at-least-once redelivery is idempotent for free (re-`SET`s the
   same edge), exactly like v1's `AUTHORED` `MERGE`. No running-average edge to double-count.

## 3. Architecture

### 3.1 Job kinds — one shared `scorer_jobs` queue

Reuse the existing pgmq queue, consumer loop, and LISTEN/NOTIFY wake-up (smaller dependency surface).
A **`kind`** discriminator on the job payload routes processing; **absent → `"content"`** so any
in-flight v1 job still parses.

| `kind` | payload | path |
|---|---|---|
| `content` (default) | `{targetType, targetId, projectId}` | existing scoring cascade — **plus** now writes the `INTERACTED` edge for comments/replies |
| `reaction` | `{kind:"reaction", op:"add"\|"remove", reactionId, projectId}` | reaction path — no scoring; sentiment from reaction *type* |
| `follow` | `{kind:"follow", op:"add"\|"remove", followerId, followedId, projectId}` | structural projection — no scoring |

Reaction/follow jobs **do not** write `moderation_analyses` rows, so the consumer's redelivery
pre-check (`analysis_exists_for_msg`) applies to `content` jobs only; the graph-only jobs are
idempotent by construction (`MERGE`/`DELETE` keyed on a stable id), so reprocessing on redelivery is a
harmless no-op and needs no dedup pre-check.

### 3.2 Migration `0036_scorer_graph_v2_enqueue.sql`

New triggers that `pgmq.send()` the graph jobs **atomically with the write** (same idempotent pattern
as `0027` — `create or replace`, `drop trigger if exists` before create):

- **`reactions`**:
  - `AFTER INSERT` → `op:"add"`
  - `AFTER DELETE` → `op:"remove"`
  - `AFTER UPDATE` **`when old.reaction_type is distinct from new.reaction_type`** → `op:"add"`
    (a toggle to a *different* reaction type re-scores the edge; the `MERGE` on `sourceId` re-`SET`s the
    new sentiment). Plain `updated_at` bumps do not fire.
- **`follows`**:
  - `AFTER INSERT` → `op:"add"`
  - `AFTER DELETE` → `op:"remove"`

Two enqueue functions (`enqueue_reaction_job()`, `enqueue_follow_job()`), each branching on `TG_OP`
and reading `NEW` (insert/update) or `OLD` (delete).

### 3.3 Recipient resolution (the new logic)

| interaction | actor | recipient | `kind` |
|---|---|---|---|
| comment, `parent_id IS NULL` | `comments.user_id` | **entity** author (`entities.user_id` via `entity_id`) | `comment` |
| comment, `parent_id` set (reply) | `comments.user_id` | **parent-comment** author (`comments.user_id` via `parent_id`) | `reply` |
| reaction on entity/comment | `reactions.user_id` | **that content's** author | `reaction` |

- **Entities produce no `INTERACTED` edge** — a post is not directed at a user; it keeps only the v1
  `AUTHORED` edge (and is still toxicity-scored as today).
- **Skipped** (no edge written):
  - **self-interaction** (`actor == recipient`) — no self-loop;
  - reactions whose `target_type = 'message'` — chat is out of scope (E2E);
  - any interaction whose recipient can't be resolved (deleted/anonymous author).

Resolution SQL (in `scorer/db.py`):

```sql
-- comment → (actor, recipient, kind)
select
  c.user_id                                                      as actor_id,
  case when c.parent_id is null then e.user_id else p.user_id end as recipient_id,
  case when c.parent_id is null then 'comment' else 'reply' end   as kind
from comments c
join entities e on e.id = c.entity_id
left join comments p on p.id = c.parent_id
where c.id = $1;

-- reaction → (actor, recipient); kind is always 'reaction'
select
  r.user_id        as actor_id,
  r.target_type    as target_type,
  r.reaction_type  as reaction_type,
  case r.target_type
    when 'entity'  then (select user_id from entities where id = r.target_id)
    when 'comment' then (select user_id from comments where id = r.target_id)
    else null
  end              as recipient_id
from reactions r
where r.id = $1;
```

### 3.4 Reaction → sentiment map

Reactions carry no text, so their warmth is derived from the reaction *type*. Pure, tested module
(`scorer/reaction_sentiment.py`); signed value in `[-1, 1]`:

| `upvote` | `love` | `like` | `funny` | `wow` | `sad` | `angry` | `downvote` |
|---|---|---|---|---|---|---|---|
| +1.0 | +1.0 | +0.8 | +0.5 | +0.3 | 0.0 | −0.8 | −1.0 |

`sad` is left **neutral (0.0)** — it reads as empathy as often as disapproval; we don't claim a sign.
An unknown/future reaction type maps to `0.0` (neutral) rather than erroring.

### 3.5 Retractability / lifecycle

- **Reactions & follows mirror *current* state**: `add → MERGE` the edge, `remove → DELETE` the edge.
  A withdrawn upvote or an unfollow should stop radiating warmth — these are retractable states, not
  historical events.
- **Comments/replies are append events**: a content edit re-`SET`s the edge's sentiment (same
  `sourceId`); a comment *deletion* leaves the edge in place — consistent with v1's `AUTHORED` edge
  (which already survives deletion) and with the content enqueue trigger, which does not fire on
  `DELETE`. (Edge cleanup on content deletion is explicitly out of scope for v2.)

## 4. Neo4j edge schemas

### `INTERACTED` — behavioral, append-log, `MERGE`-keyed on `sourceId`

```cypher
MERGE (a:User {id:$actor})
MERGE (b:User {id:$recipient})
MERGE (a)-[r:INTERACTED {sourceId:$sourceId}]->(b)
  ON CREATE SET r.createdAt = timestamp()
SET r.kind=$kind, r.sentiment=$sentiment, r.projectId=$projectId, r.at=timestamp()
```

- `sourceId` = the comment id (for comment/reply) or the reaction id (for reaction). Functionally
  determines `(actor, recipient)`, so the keyed `MERGE` is stable — redelivery / edit re-`SET`s one
  edge; a new interaction is a new edge.
- **Delete** (reaction removal): `MATCH ()-[r:INTERACTED {sourceId:$sourceId}]->() DELETE r`.

### `FOLLOWS` — structural, mirrors the `follows` table

```cypher
-- add
MERGE (a:User {id:$follower})
MERGE (b:User {id:$followed})
MERGE (a)-[r:FOLLOWS]->(b)
  ON CREATE SET r.createdAt = timestamp()
SET r.at = timestamp()
-- remove
MATCH (a:User {id:$follower})-[r:FOLLOWS]->(b:User {id:$followed}) DELETE r
```

### Query-time "warmth" (consumer, not stored)

```
strength(A→B) ≈ w_interaction · avg(INTERACTED.sentiment) · saturate(count)
              + w_follow · exists((A)-[:FOLLOWS]->(B))
```

## 5. Idempotency / redelivery analysis

| event | behavior | redelivery-safe? |
|---|---|---|
| reaction add redelivered | `MERGE` re-`SET`s same edge | ✅ no-op |
| reaction add redelivered *after* it was removed | lookup by id → row gone → skip | ✅ self-healing |
| reaction remove redelivered | `DELETE` by `sourceId` on missing edge | ✅ no-op |
| reaction type changed (toggle) | UPDATE trigger → `add` → re-`SET`s sentiment | ✅ converges |
| comment edit re-score | new pgmq msg, same `sourceId` → re-`SET` | ✅ converges |
| follow add/remove redelivered | `MERGE`/`DELETE` idempotent | ✅ no-op |

No `moderation_analyses` writes occur on the graph-only paths, so the `0028` dedup index is untouched.

## 6. Feature gating & costs

- All edge writes already **no-op when `NEO4J_*` is unset** (the writer guards). With Neo4j off, the
  reaction/follow jobs are enqueued, consumed, and deleted with no side effect.
- **Honest cost:** the reaction/follow triggers enqueue a pgmq job on *every* reaction add/remove/
  retype and *every* follow/unfollow, **even when Neo4j is off**. Reaction volume is real. v2 accepts
  this (the graph is the point); the documented future gate is simply dropping the two triggers (or a
  later project/env flag) — not built now (YAGNI).

## 7. File-by-file change list

**New:**
- `apps/api/drizzle/0036_scorer_graph_v2_enqueue.sql` — reaction + follow enqueue triggers.
- `services/scorer/scorer/reaction_sentiment.py` — pure type→sentiment map.
- `services/scorer/tests/test_reaction_sentiment.py`, `tests/test_dispatch.py` (routing), additions to
  `tests/test_pipeline.py`.

**Modified:**
- `services/scorer/scorer/models.py` — add `ReactionJob`, `FollowJob`; `ScoreJob.kind` default
  `"content"`.
- `services/scorer/scorer/db.py` — `resolve_comment_interaction()`, `resolve_reaction_interaction()`.
- `services/scorer/worker/pipeline.py` — `dispatch_job(message, msg_id)` routing; write the
  `INTERACTED` edge for comment/reply in the content path; `process_reaction_job`, `process_follow_job`.
- `services/scorer/worker/neo4j_writer.py` — `write_interaction_edge`, `delete_interaction_edge`,
  `write_follow_edge`, `delete_follow_edge`.
- `services/scorer/worker/consumer.py` — dispatch by `kind`; gate the analysis pre-check to `content`.
- `docs/SCORER.md` — data-flow + reaction-sentiment additions; roadmap #1 → done.
- `CHANGELOG.md` — Added entry (migration + scorer graph v2).

## 8. Testing plan

- **Unit (pure):** the reaction-sentiment map (every taxonomy value + unknown → 0.0); the dispatch
  router (each `kind` → correct handler, mocked writers); recipient-edge shaping (self skipped, message
  skipped, unresolved recipient skipped).
- **DB-bound resolution SQL** is exercised by the existing end-to-end smoke test (real Postgres +
  Neo4j) — add a reaction + a follow and assert the `INTERACTED` / `FOLLOWS` edges appear, and that an
  unfollow / un-react deletes them.

## 8a. Addendum — the `CONNECTED` structural edge (v2.1)

**Status:** design approved, pre-implementation. **Added:** 2026-06-08 (after the v2 smoke).

The initial v2 modeled `follows` but missed the **`connections`** table — a *second, distinct*
structural relationship. They are different social primitives and get **different edge labels** (one
fact each), consistent with the two-edge-type principle:

| | `FOLLOWS` (done) | `CONNECTED` (this addendum) |
|---|---|---|
| source | `follows` table | `connections` table |
| shape | **asymmetric**, one-way | **mutual** (queried undirected) |
| lifecycle | instant (insert / delete) | **stateful** — `connection_status` `pending → connected → declined` |
| edge exists when | row exists | **only while `status = 'connected'`** |
| sentiment | none (structural) | none (structural) |

`connections` columns (`apps/api/src/db/schema/spaces.ts`): `requester_id`, `addressee_id`,
`status` (`pending`/`connected`/`declined`), `unique(project_id, requester_id, addressee_id)`,
`check requester_id <> addressee_id` (no self).

### The lifecycle gate (the one subtlety)

A `pending` request is **not** a relationship — no edge. The edge is created when the row *becomes*
`connected` and removed when it *leaves* `connected` (declined) or is deleted:

| event | edge action |
|---|---|
| INSERT `status='connected'` (direct connect) | **add** (`MERGE`) |
| INSERT `status='pending'` | none |
| UPDATE `pending → connected` (request accepted) | **add** (`MERGE`) |
| UPDATE `connected → declined` (or any non-connected) | **remove** (`DELETE`) |
| UPDATE `pending → declined`, or message-only edit | none |
| DELETE a `connected` row | **remove** (`DELETE`) |
| DELETE a `pending`/`declined` row | none |

`declined` is treated as **"no edge,"** not a negative signal — declining a request reads as "no
relationship," not hostility, and there's no `blocked` status in the enum. (Revisit if one is added.)

### Migration `0037_scorer_connection_enqueue.sql`

A new migration (0036 is already applied — don't edit it). Triggers on `connections`, gated by `WHEN`
so the function only runs on edge-relevant transitions; a single `enqueue_connection_job()` decides
`add` vs `remove`:

- INSERT trigger — `WHEN (new.status = 'connected')` → add
- UPDATE trigger — `WHEN (old.status is distinct from new.status and (new.status = 'connected' or old.status = 'connected'))` → fn: `new.status='connected'` ? add : remove
- DELETE trigger — `WHEN (old.status = 'connected')` → remove

Payload: `{kind:'connection', op:'add'|'remove', requesterId, addresseeId, projectId}`.

### Edge schema (Neo4j) — directed-stored, queried undirected

```cypher
-- add
MERGE (a:User {id:$requester_id})
MERGE (b:User {id:$addressee_id})
MERGE (a)-[r:CONNECTED]->(b)
  ON CREATE SET r.createdAt = timestamp()
SET r.at = timestamp()
-- remove
MATCH (a:User {id:$requester_id})-[r:CONNECTED]->(b:User {id:$addressee_id}) DELETE r
```

Stored directed `requester → addressee` (provenance: who initiated), but **mutual** in meaning — query
with `MATCH (a)-[:CONNECTED]-(b)` (undirected). `unique(requester, addressee)` → one row → one edge;
`MERGE`/`DELETE` are idempotent under pgmq redelivery, exactly like `FOLLOWS`.

### File-by-file (addendum)

- **New:** `apps/api/drizzle/0037_scorer_connection_enqueue.sql` + journal entry.
- **Modified:**
  - `scorer/models.py` — add `ConnectionJob`.
  - `worker/neo4j_writer.py` — `write_connection_edge`, `delete_connection_edge`.
  - `worker/pipeline.py` — `process_connection_job`; `dispatch_job` routes `kind == "connection"`.
  - `tests/test_dispatch.py` — connection add/remove routing.
  - `docs/SCORER.md` (data flow, pgmq triggers, v2 structural layer, smoke step 4b), `CHANGELOG.md`.
- **No change** to `consumer.py` — `connection` is graph-only, already excluded from the content
  dedup pre-check (which gates on `kind == "content"`).

### Testing (addendum)

- **Unit:** `dispatch_job` routes `connection` add → `write_connection_edge`, remove →
  `delete_connection_edge` (mocked).
- **Smoke:** insert a `pending` connection → assert **no** edge; update → `connected` → assert
  `CONNECTED` edge appears (undirected match); update → `declined` (and/or delete) → assert it's gone.

## 9. Future (post-v2 — deferred, YAGNI)

- **`RELATES_TO {strength}`** — if a single materialized number is later wanted, derive it from the two
  edge types. Not v2.
- **Hybrid accumulation** — keep per-interaction edges as source of truth *and* maintain a rolled-up
  summary edge per pair (fast reads + history, at double write work + an extra invariant). Revisit only
  if query-time aggregation over the append-log becomes a measured bottleneck.
- **Edge cleanup on content deletion** — removing `INTERACTED`/`AUTHORED` edges when a comment/entity is
  deleted (would need a DELETE-firing content trigger). Out of scope.
