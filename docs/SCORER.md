# `services/scorer` — content scoring & moderation 🧪💞

> **Status: LIVE — validated end-to-end.** The RoBERTa model servers, asyncpg db layer, pgmq consumer
> (+ LISTEN/NOTIFY), Claude Haiku adjudication + API write-back, the operator-complete admin surface, and
> the Neo4j relationship graph all run against real infra: a toxic comment was scored `block`, auto-removed
> through the API, and recorded; a benign one `allow`ed; both wrote signed sentiment edges to Neo4j. The
> old `apps/moderator` is retired. The user→user interaction graph (**v2** — `INTERACTED` behavioral edges
> + `FOLLOWS`/`CONNECTED` structural edges from comments, replies, reactions, follows, and connections) is
> **LIVE — validated end-to-end**: a comment, a reply, a reaction, a follow, and a connection each wrote
> the correctly-directed edge (positive *and* negative sentiment, upvote → +1.0; the `CONNECTED` edge
> appears only on `status='connected'`); a reaction-removal, an unfollow, and a disconnect deleted their
> edge; a self-interaction and a chat-message-target reaction were skipped.

`services/scorer` is Agora's content scoring + moderation subsystem. It **replaces `apps/moderator`**
(the Node/Hono LLM-over-webhooks service) with an **async, post-publish** Python pipeline: content
publishes instantly, then — a beat later, off a queue — it is scored by two RoBERTa classifiers,
borderline cases are adjudicated by Claude Haiku, removals are written back through the API, and a
relationship signal is recorded in a graph.

## What this is (and why)

The old moderator blocked on a synchronous webhook → single-LLM call per item. The scorer instead:

- **decouples** scoring from posting via **Supabase pgmq** (a Postgres-native queue) so posting is
  instant and resilient — if the scorer is down, jobs wait safely in the DB and drain when it's back;
- adds a **cheap RoBERTa pre-filter** so the (paid, slower) LLM only sees the *borderline* items;
- adds a **relationship-quality** signal feeding a **Neo4j** graph — a capability the moderator never had;
- **reuses** the moderator's proven brain — the exact policy prompt + `allow/block/review` verdict
  schema, the auto-action thresholds, the `moderation_analyses` audit table, the API write-back, and the
  admin AI-flag queue — so the cutover is behaviour-compatible for operators.

## The three containers

| Container | Role | Port | CPUs | Image |
|---|---|---|---|---|
| `scorer-toxicity` | RoBERTa **toxicity** classifier, model warm in RAM | 8001 | pinned `0,1` | `Dockerfile.model-server` |
| `scorer-relationship` | RoBERTa **relationship-quality** (sentiment) classifier | 8002 | pinned `2,3` | `Dockerfile.model-server` |
| `scorer-worker` | pgmq consumer + cascade + write-back + Neo4j + admin API | 4001 | `4` | `Dockerfile.worker` |

The two model servers are the **same image**, differentiated only by `SCORER_MODEL` / `SCORER_MODEL_KIND`
/ `SCORER_PORT`. They're pinned to **disjoint CPU cores** (compose `cpuset` + `OMP_NUM_THREADS`) so the
worker's parallel calls actually run side-by-side rather than contending. (cpuset values are
host-specific — set them to your box's layout, e.g. a 4-vCPU `c6i.xlarge`.) The worker is a single
process that runs both the admin HTTP server **and** the queue-consumer loop (an asyncio background task).

All three run under `docker-compose.yml` with the rest of Agora; the worker reaches the model servers by
compose DNS (`http://scorer-toxicity:8001`).

## Data flow

```
entity/comment INSERT/UPDATE · reaction INS/DEL/retype · follow INS/DEL · connection status→/from connected
   │  Postgres triggers → pgmq.send('scorer_jobs', {kind, …})   (atomic with the write)
   │    • content    (0027): {targetType,targetId,projectId}             → scored
   │    • reaction   (0036): {kind:'reaction',op,reactionId,…}           → graph-only
   │    • follow     (0036): {kind:'follow',op,followerId,followedId}    → graph-only
   │    • connection (0037): {kind:'connection',op,requesterId,addresseeId} → graph-only
   ▼
pgmq queue 'scorer_jobs'   (Supabase pgmq; at-least-once, visibility-timeout redelivery)
   ▼
scorer-worker ── poll pgmq.read() ──► dispatch_job(message) by `kind`:
   │
   ├─ content → fetch content text by id
   │     asyncio.gather( toxicity:8001/score , relationship:8002/score )   ← parallel
   │     cascade (toxicity score):
   │         < grayzone_low   → allow
   │         ≥ grayzone_high  → block (high confidence)
   │         in between       → escalate to Claude Haiku (salvaged policy prompt + verdict schema)
   │     decide_auto_action(verdict, confidence, thresholds)   ← salvaged pure fn
   │     if removable + triggered → POST {API}/internal/moderation/apply (x-moderation-secret)
   │     record moderation_analyses  (append; dedup on pgmq msg_id)  ← admin AI-flag queue source
   │     MERGE Content/AUTHORED + (comment/reply) INTERACTED edge into Neo4j   ← "The relationship graph"
   │
   ├─ reaction   → resolve recipient (parent-content author); MERGE INTERACTED {sentiment=f(type)}
   │               (op=remove → DELETE the edge by reactionId; idempotent)
   ├─ follow     → MERGE / DELETE the structural FOLLOWS edge
   ├─ connection → MERGE / DELETE the structural CONNECTED edge (mutual; only while status=connected)
   │
   │   pgmq.delete(msg_id)
   └── ALSO serves /v1/:projectId/moderation/* (operator JWT) — identical shapes to the old moderator
```

## The pgmq queue + Trigger A

- **Atomic enqueue.** Migration `apps/api/drizzle/0027_scorer_pgmq_enqueue.sql` enables `pgmq`, creates
  the `scorer_jobs` queue, and attaches triggers that `pgmq.send()` a job in the **same transaction** as
  the content write. No lossy webhook hop — the job is committed iff the content is.
- **Loop-safe.** Triggers fire on `entities` and `comments`, on **INSERT** and on **content-changing
  UPDATE**. (Chat messages are **not** scored — Agora uses end-to-end-encrypted secure chat, so the
  server never sees message plaintext; there's nothing to classify.) INSERT and UPDATE are *separate*
  triggers, and the UPDATE trigger is **gated** (`when old.content is distinct from new.content`, plus
  `title` for entities) so the moderation write-back itself (which only touches `moderation_status`) and
  trigger-maintained count/reaction bumps do **not** re-enqueue. This is what prevents a write-back →
  re-score loop.
- **Graph-job triggers (v2).** Migration `0036_scorer_graph_v2_enqueue.sql` adds triggers on `reactions`
  (INSERT/DELETE, plus UPDATE **gated on `reaction_type` changing**) and `follows` (INSERT/DELETE);
  `0037_scorer_connection_enqueue.sql` adds triggers on `connections` (INSERT/UPDATE/DELETE, **gated** so
  they only fire on transitions **into or out of `status='connected'`** — a `pending`/`declined` row
  produces no edge). All enqueue onto the **same** queue with a **`kind` discriminator**
  (`reaction`/`follow`/`connection`); the worker's `dispatch_job` routes by `kind`. These feed only the
  Neo4j graph (no scoring, no `moderation_analyses` row) — see "The relationship graph" → v2. They enqueue
  regardless of whether `NEO4J_*` is set (the worker no-ops the job when Neo4j is off); the documented
  "off" gate is dropping those triggers.
- **At-least-once → idempotency contract.** pgmq redelivers a message if the worker dies before
  `pgmq.delete` (visibility-timeout). So every downstream write is idempotent: the `moderation_analyses`
  insert is stamped with the pgmq **`source_msg_id`** and uses `ON CONFLICT (source_msg_id) DO NOTHING`
  (partial unique index, migration `0028_scorer_analysis_dedup`) — a redelivery (same msg_id) is a no-op,
  a genuine re-score (content edit → a *new* pgmq message → new msg_id) inserts a new row, and an
  on-demand `/analyze` row carries `source_msg_id = NULL` (unconstrained). The write-back (set
  `moderation_status`) and the Neo4j `MERGE` are idempotent too. The consumer also pre-checks
  `source_msg_id` on a redelivery to skip a redundant Haiku call; a poison message is archived after N
  reads. This keeps the **append-log** semantics (cumulative `/stats` + token metering) rather than
  collapsing history.
- **id-only payload.** Jobs carry only `{targetType, targetId, projectId}`; the worker fetches the text
  (and space/author) by id. Keeps messages small and avoids stale/duplicated content in the queue.

## Why pgmq, not Redis (even though Redis is now in the stack)

Redis was added to Agora for **rate limiting** (shared atomic counters across API replicas — the
in-process limiter in `lib/rate-limit.ts` doesn't hold across processes). That removed the original
"no new infra" argument for pgmq — but the queue **stays on pgmq**, because the two jobs want different
tools:

- **The decisive reason is atomic enqueue.** "Trigger A" calls `pgmq.send()` *inside the same Postgres
  transaction* as the content write, so a job exists iff the row committed. Redis isn't in that
  transaction, so a Redis queue forces one of: app-level `XADD` after the insert (lossy dual-write — the
  exact failure mode pgmq kills), a `pg_net` trigger → Redis (non-transactional, lossy, +extension), or a
  transactional outbox (which is just pgmq rebuilt). None is better than what we have.
- **Durability.** Moderation jobs shouldn't silently vanish; pgmq is ACID-durable by default. Redis
  Streams needs AOF tuning and is still weaker.
- **Latency doesn't matter here.** The pipeline is async/post-publish, so Redis's throughput/latency edge
  (its real strength, and why it's perfect for rate limiting) buys nothing for the queue.
- **Smaller dependency surface.** The worker already needs a Postgres connection (for
  `moderation_analyses`); pgmq adds none. A Redis queue would make it need both.

**So: Redis for rate limiting, pgmq for the scorer queue — right tool per job, not redundancy.** Revisit
only if you decide one queue technology is worth giving up the atomic-enqueue guarantee.

## The cascade

The toxicity RoBERTa runs on **everything** and its score drives a gray-zone gate:

- below `SCORER_GRAYZONE_LOW` → `allow` (record the score, no LLM);
- above `SCORER_GRAYZONE_HIGH` → `block` at high confidence;
- in the band → **escalate to Claude Haiku**, which returns the full `{verdict, categories, confidence,
  reason}` using the **salvaged** `policy.build_system_prompt` + the tolerant `verdict.parse_verdict`.

The verdict then flows through the **salvaged** `auto_action.decide_auto_action` against the project's
two confidence floors (block/review), and — for `entity`/`comment` (the only scored types) — a
triggered removal is applied via the API write-back. Every assessment records one `moderation_analyses`
row (the admin queue) — stamped with both **raw classifier signals** (`toxicity_score` = P(toxic),
`relationship_score` = the signed sentiment quality), on every verdict **including `allow`**, so a
human reviewer sees what the models measured and future threshold ideas can be validated against
real traffic instead of guesses. The **relationship** RoBERTa score is written to the Neo4j graph in parallel.

### Future addition (documented, NOT implemented): disagreement routing

When `P(toxic) ≥ grayzone_high` **but** the relationship score is strongly positive, the two models
disagree — a pattern typical of sarcasm, quoted lyrics, or in-group banter. A future gate could route
that combination to `review` (the human queue) instead of auto-blocking. What makes it acceptable to
consider: it only ever moves content **toward** humans (fail-closed — it can never cause a removal),
and the "strongly positive" threshold must be validated against the accumulated analysis rows (which
now record both signals on every verdict, `allow` included) — not guessed. The relationship score is
deliberately NOT a moderation gate today: sentiment ≠ toxicity (grief/venting read negative but are
fine; polite harassment reads positive but isn't). See `services/scorer/README.md` → "The cascade".

## The relationship graph

The relationship-quality classifier (a 3-way sentiment model) produces a signed quality in **[-1, 1]**
(`P(positive) − P(negative)`), which the worker writes to Neo4j. **v1 schema** (idempotent, all `MERGE`):

```cypher
MERGE (u:User {id: $author})
MERGE (c:Content {id: $target})
  ON CREATE SET c.type = $targetType, c.projectId = $projectId
SET c.relationshipScore = $quality, c.scoredAt = timestamp()
MERGE (u)-[:AUTHORED]->(c)
```

- Uniqueness constraints on `User.id` + `Content.id` (created once on worker startup via
  `ensure_constraints`) back the MERGE and create the supporting indexes.
- All-`MERGE` → a redelivered job just re-`SET`s the latest score (idempotent).
- No-op (logged) when `NEO4J_*` is unset or the content has no resolvable author.

⚠️ **v1 captures "who authored what, and how positive/negative it reads."** The richer **user→user
interaction graph** is **v2** — see below.

### v2 — the user→user interaction graph

> **LIVE — validated end-to-end** (migrations `0036`/`0037`, worker `dispatch_job` + the
> reaction/follow/connection handlers, `neo4j_writer` edge writers). The smoke (step 4b below) confirmed
> correctly-directed edges for comment/reply/reaction/follow/connection, type-mapped reaction sentiment,
> the `CONNECTED` status-gate (no edge while `pending`), edge deletion on reaction-removal/unfollow/
> disconnect, and the self-interaction + message-target skips. Design spec (incl. §8a CONNECTED):
> `docs/superpowers/specs/2026-06-08-relationship-graph-v2-design.md`.

**Distinct edge types**, kept separate on purpose (one fact each) and combined only at *read* time —
never blended into one overloaded edge:

```cypher
// behavioral — scored. ONE edge per interaction (append-log), MERGE-keyed on sourceId so pgmq
// redelivery is idempotent and a content edit updates that one edge in place.
(actor:User)-[:INTERACTED {kind:'comment'|'reply'|'reaction', sentiment, sourceId, at}]->(recipient:User)

// structural — UNscored, asymmetric. Mirrors the follows table: MERGE on follow, DELETE on unfollow.
(follower:User)-[:FOLLOWS {at}]->(followee:User)

// structural — UNscored, MUTUAL (stored directed requester→addressee, queried undirected). Mirrors the
// connections table, but exists ONLY while status='connected' (MERGE on accept, DELETE on disconnect).
(requester:User)-[:CONNECTED {at}]->(addressee:User)

// Layer-2 friction — UNscored, directed. Mirrors the reports table (PR 3, migration 0039): a user report
// MERGEs one edge per report (keyed on the report id), the subject being the reported content's author.
// Append + decay only (no delete) — Community Weather folds it into the friction term at read time.
(reporter:User)-[:FRICTION {kind:'report', sourceId, weight, projectId, at}]->(subject:User)
```

- **Recipient resolution** (the new bit): the *actor* is the comment/reply/reaction author; the
  *recipient* is the **parent-content author** — comment→entity author, reply→parent-comment author,
  reaction→content author. **Self-interactions** (acting on your own content) are skipped (no self-loop).
- **Sentiment source.** Text interactions carry the relationship-RoBERTa score already computed in the
  cascade. **Reactions have no text** — their sentiment is derived from the reaction *type*
  (`scorer/reaction_sentiment.py`, signed `[-1, 1]`):

  | `upvote` | `love` | `like` | `funny` | `wow` | `sad` | `angry` | `downvote` |
  |---|---|---|---|---|---|---|---|
  | +1.0 | +1.0 | +0.8 | +0.5 | +0.3 | 0.0 | −0.8 | −1.0 |

  `sad` is left **neutral** (empathy as often as disapproval); an unknown/future type → `0.0`.
  Reaction *removal* / unfollow **deletes** the edge (these are retractable states); a comment edit
  re-`SET`s the edge, a comment deletion leaves it (it happened) — consistent with the v1 `AUTHORED` edge.
- **Why distinct edge types (not one).** They're genuinely different facts: `INTERACTED` is a *behavioral
  event* — append-only, idempotent, can be **negative**, many per pair, sourced from the content
  pipeline; `FOLLOWS`/`CONNECTED` are *structural state* — at most one per pair, **retractable**, never
  through the scorer's brain (no text). Folding a retractable structural state into an append-log of
  scored events creates lifecycle confusion. So: separate labels, each with one clear meaning.
- **`FOLLOWS` vs `CONNECTED` — two different structural ties.** They are decoupled in the app and
  modeled separately: **`follows`** is *asymmetric/one-way/instant* and is the relationship that
  **drives the feed** (`followedOnly` → `select followed_id from follows`); **`connections`** is
  *mutual* with a lifecycle (`pending → connected → declined`) and does **not** touch the feed. A
  `CONNECTED` edge exists **only while `status='connected'`** (created on accept/direct-connect, deleted
  on disconnect — which is a row DELETE, not a status flip). `declined` = no edge (not a negative
  signal; the enum has no `blocked`). Being connected does **not** imply following, and vice-versa.
- **`FRICTION` — the Layer-2 friction edge (PR 3).** A user **report** projects a directed
  `(reporter)-[:FRICTION {kind:'report', weight}]->(subject)` edge (subject = the reported content's
  author), enqueued by an `AFTER INSERT on reports` trigger (migration `0039`, job kind `friction`) and
  MERGE-keyed on the report id (idempotent under redelivery). **Append + decay only** — there is *no*
  delete counterpart: a resolved/dismissed report simply lets the edge decay at the friction half-life
  (friction *fades*; it is not adjudicated in the graph — that's the steward tier). Skipped for
  chat-message reports (out of scope), anonymous reporters, and self-reports. Community Weather reads it
  into the friction term `F` **additively** alongside negative-`INTERACTED` (`block`/`mute` deferred —
  no such table; downvotes stay `INTERACTED`-only).
- **"How warmly does A relate to B?"** is a **query-time** combination (e.g.
  `avg(INTERACTED.sentiment) · saturate(count)` plus `FOLLOWS`/`CONNECTED` bonuses) — the weighting
  lives in the *consumer*, not baked into an ambiguous edge.

(Chat/DMs can't feed this graph: secure chat is end-to-end-encrypted, so the server has no message
plaintext to score.) The v1 schema is a deliberate, easily-revised starting point.

**Future (post-v2 — deferred, YAGNI):**
- If you later want a single number, you materialize a derived `RELATES_TO {strength}` edge from these
  two — but that's a YAGNI deferral, not v2.
- A **hybrid** accumulation — keep the per-interaction edges as the source of truth *and* maintain a
  rolled-up summary edge alongside on every write (fast reads + full history, at double the write work
  and an extra re-derivable invariant) — is premature for v2. Revisit only if query-time aggregation
  over the append-log becomes a measured bottleneck.

## Preserved contracts (so the admin keeps working)

- **`moderation_analyses`** table + the **`ModerationAnalysis`** envelope — unchanged from the moderator.
- **`/v1/:projectId/moderation/*`** operator endpoints (config/stats/queue/analysis + analyze/resolve/
  remove) — the `scorer-worker` serves identical shapes; the Caddy front door's moderator upstream is just
  repointed (`MODERATOR_UPSTREAM → http://scorer-worker:4001`).
- **`POST {API}/internal/moderation/apply`** write-back (`x-moderation-secret`, `moderatedByType=client`)
  — reused verbatim; **no API change needed**.
- **Operator JWT** (HS256 over `ACCESS_TOKEN_SECRET`, `operator` claim) — verified the same way (PyJWT).

## Salvaged from `apps/moderator`

| moderator source | scorer module | kind |
|---|---|---|
| `lib/policy.ts` | `scorer/policy.py` | verbatim (prompts + verdict schema) |
| `lib/auto-action.ts` | `scorer/auto_action.py` | verbatim (pure fn) |
| `lib/llm-provider.ts` `parseVerdict` | `scorer/verdict.py` | port (tolerant parse) |
| `lib/reason.ts` | `scorer/reason.py` | port |
| `lib/project-config.ts` + `lib/env.ts` | `scorer/config.py` | port (jsonb merge over env, 30s cache) |
| `lib/api-client.ts` | `worker/writeback.py` | verbatim contract |
| `middleware/auth.ts` | `scorer/jwt_auth.py` | port (jose → PyJWT) |
| `routes/moderation.ts` | `worker/admin_api.py` | port (Hono → FastAPI, identical shapes) |
| `lib/shape.ts` `shapeAnalysis` | `worker/analyses.py` + `scorer/models.py` | port |
| `lib/assess-and-record.ts` | `worker/pipeline.py` | shape port (now cascade-shaped) |

## Config & feature gates

All via the root `.env` (see the per-mode templates `.env.dev/selfhost/prod.example`). Reused: `DATABASE_URL`, `ACCESS_TOKEN_SECRET`,
`API_BASE_URL`, `MODERATION_SERVICE_SECRET`, `MODERATION_BLOCK/REVIEW_AUTO_ACTION_THRESHOLD`. New:
`SCORER_*` (models, URLs, gray-zone, Haiku, queue/poll) and `NEO4J_*`. Feature gates:

- no `ANTHROPIC_API_KEY` → cascade records the RoBERTa score but never escalates: the gray-zone item
  becomes `review`, routing to the human queue **only while `MODERATION_REVIEW_AUTO_ACTION_THRESHOLD=0`
  (the default)**. A nonzero review floor instead auto-removes any gray-zone item whose P(toxic) meets it
  — with Haiku off that's a removal on the toxicity score alone. See `services/scorer/README.md` → "The cascade";
- no `NEO4J_*` → the relationship-edge write is a logged no-op;
- no `MODERATION_SERVICE_SECRET`/`API_BASE_URL` → write-back disabled; verdicts still persist + queue.

> **Postgres pooler note:** `DATABASE_URL` is the Supabase transaction pooler (`:6543`, `prepare:false`),
> which doesn't support prepared statements — the Python client uses asyncpg with `statement_cache_size=0`.

## Operations

```bash
# Build the three images (from repo root — build context is the root):
docker compose build scorer-toxicity scorer-relationship scorer-worker
docker compose up scorer-toxicity scorer-relationship scorer-worker neo4j

# Apply the enqueue migration (idempotent):
docker compose run --rm agora node scripts/migrate.mjs

# Local pure-fn tests:
cd services/scorer && pip install -r requirements-dev.txt && pytest
```

- **Scaling:** the model servers are stateless — scale horizontally; the worker is a single consumer
  group (add replicas to share the queue once wired).
- **CPU pinning:** set `cpuset` per the deploy host; the parallel model calls only benefit if the two
  servers own disjoint cores.
- **Verify pgmq first:** confirm `create extension if not exists pgmq;` succeeds on your Supabase plan —
  it's the entire transport.
- **Image size:** the model server bundles the CPU `torch` wheel (large). The Dockerfile installs the
  right CPU wheel per arch (`TARGETARCH`: amd64 → pytorch `/whl/cpu` index; arm64 → PyPI default) and
  trims bytecode caches + torch's bundled tests. Further slimming is possible but low-priority.
- **Multi-arch images:** `docker-publish.yml` builds **amd64 + arm64** on native runners (no QEMU) and
  merges per-arch digests into one manifest per tag — so the torch-heavy model server builds fast on
  both. Published as `{ghcr.io/jenova-marie,docker.io/agoraserver}/agora-scorer-{worker,model-server}`.
- **HF cache:** mount the `scorer-hf-cache` volume (wired in `docker-compose.yml`, `HF_HOME` set in the
  image) so the model download survives a container recreate.

## Smoke test (manual)

The unit suite covers the pure logic + HTTP paths via mocks; this proves the pipeline **end-to-end against
real infra** — the cheapest way to catch the bugs mocks can't (model label names, pgmq/asyncpg quirks,
Neo4j, NOTIFY). Run it once after any infra change.

**1. Bring up** (from repo root):
```bash
docker compose build agora scorer-toxicity scorer-relationship scorer-worker neo4j
docker compose up -d agora scorer-toxicity scorer-relationship scorer-worker neo4j
```
`.env` needs `DATABASE_URL` (pooler :6543) + `ACCESS_TOKEN_SECRET` + `MODERATION_SERVICE_SECRET`; optional
`SCORER_LISTEN_DATABASE_URL` (:5432, for the NOTIFY wake-up), `ANTHROPIC_API_KEY` (else gray-zone → review),
`NEO4J_*`.

**2. Migrate** (idempotent; applies `0027`/`0028`/`0033` + the v2 graph triggers `0036`/`0037`):
```bash
docker compose run --rm agora node scripts/migrate.mjs
```

**3. Create content** (fires the enqueue trigger). Direct SQL is simplest:
```bash
psql "$DATABASE_URL" -c "insert into entities (id, project_id, user_id, title, content)
  values (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', '<user-uuid>',
          'smoke', 'you are an idiot and everyone hates you') returning id;"
```
…or via the API (`node apps/api/scripts/seeds/00-seed-auth-admin.mjs` → sign in → `POST /v7/<projectId>/entities`).

**4. Observe** (should land within ~1s, or instantly with the NOTIFY listener):
```bash
docker compose logs -f scorer-worker            # "job processed" verdict=…
psql "$DATABASE_URL" -c "select target_type, verdict, confidence, model, source_msg_id
  from moderation_analyses order by created_at desc limit 5;"
psql "$DATABASE_URL" -c "select count(*) from pgmq.q_scorer_jobs;"   # drains to ~0
# admin queue (operator JWT — see CLAUDE.md mint snippet, claim {operator:true}):
curl -s localhost:4001/v1/11111111-1111-1111-1111-111111111111/moderation/queue \
  -H "Authorization: Bearer $TOK" | jq
# Neo4j (if NEO4J_* set): http://localhost:7474 →
#   MATCH (u:User)-[:AUTHORED]->(c:Content) RETURN u.id, c.id, c.relationshipScore LIMIT 10;
```

**4b. v2 graph smoke** (reactions + follows → user→user edges; needs `NEO4J_*`). Post a comment on
someone else's entity, react to it, then follow them — each fires a `0036` trigger:
```bash
# react to a comment (entity/comment target — NOT a chat message):
psql "$DATABASE_URL" -c "insert into reactions (project_id, target_type, target_id, user_id, reaction_type)
  values ('11111111-1111-1111-1111-111111111111','comment','<comment-id>','<reactor-uuid>','upvote');"
# follow:
psql "$DATABASE_URL" -c "insert into follows (project_id, follower_id, followed_id)
  values ('11111111-1111-1111-1111-111111111111','<a-uuid>','<b-uuid>');"
# connection (CONNECTED edge appears ONLY when status='connected'): insert pending → no edge;
# then accept (→ connected) → edge appears; then disconnect (DELETE the row) → edge gone.
psql "$DATABASE_URL" -c "insert into connections (project_id, requester_id, addressee_id, status)
  values ('11111111-1111-1111-1111-111111111111','<a-uuid>','<b-uuid>','pending');"   # no edge yet
psql "$DATABASE_URL" -c "update connections set status='connected', responded_at=now()
  where requester_id='<a-uuid>' and addressee_id='<b-uuid>';"                          # → edge
# Neo4j → the user→user edges (http://localhost:7474):
#   MATCH (a:User)-[r:INTERACTED]->(b:User) RETURN a.id, r.kind, r.sentiment, r.sourceId, b.id LIMIT 20;
#   MATCH (a:User)-[r:FOLLOWS]->(b:User) RETURN a.id, b.id LIMIT 20;
#   MATCH (a:User)-[r:CONNECTED]-(b:User) RETURN a.id, b.id LIMIT 20;   -- undirected (mutual)
# then DELETE the reaction / follow / connected row and confirm the matching edge disappears (retractable).
```

**5. ⚠️ Watch for the real-infra bugs** (fix before trusting it):
- **Model label names** — confirm the toxicity model emits `toxic`/`neutral` and the sentiment model
  `negative`/`neutral`/`positive`. If they're `LABEL_0`/`LABEL_1`, the P(toxic) gate + signed-quality
  mapping silently misfire → fix the label keys (or map id2label) in `model_server`/`pipeline.py`.
- **pgmq function signatures** match your Supabase pgmq version (`read`/`delete`/`archive` arg order).
- **asyncpg jsonb** returns `dict` vs `str` (db.py coerces `str` — confirm).
- **NOTIFY** only fires on the **`:5432`** listen connection (not the `:6543` pooler).
- **Neo4j** auth + that `ensure_constraints` ran (worker startup log).
- **v2 recipient resolution** — confirm a reaction `add` resolves the target author (the `CASE` on
  `target_type` matches the `reaction_target` enum text `'entity'`/`'comment'`), a `message`-target
  reaction writes **no** edge, a self-interaction is skipped, and a reaction *remove* / unfollow
  **deletes** its edge.

## Roadmap

**Done**: ✅ RoBERTa `/score` · ✅ asyncpg db layer · ✅ pgmq read/delete/archive · ✅ LISTEN/NOTIFY
wake-up · ✅ Haiku adjudication + API write-back · ✅ Neo4j v1 graph (author→content + sentiment) ·
✅ full admin surface (queue w/ **author enrichment**, stats, analysis, **`/analyze`**, resolve,
**`/{id}/remove`**, config — contract-aligned) · ✅ **live end-to-end smoke validated** · ✅ **`apps/moderator`
source retired**.

**Remaining:** none — the REST surface and the scoring/graph pipeline are feature-complete and the v2
graph is smoke-validated end-to-end.

**Recently done:** ✅ **Relationship graph v2** — the user→user interaction graph. Edge types: the
scored, append-log `INTERACTED` edge (comments/replies via the content pipeline + reactions with
type-derived sentiment, recipient = parent-content author) and two structural edges — `FOLLOWS`
(asymmetric, mirrors `follows`) and `CONNECTED` (mutual, mirrors `connections`, exists only while
`status='connected'`; migration `0037`). New enqueue triggers (migrations `0036`/`0037`) feed the same
pgmq queue with a `kind` discriminator; the worker's `dispatch_job` routes content vs. graph-only jobs.
Unit-tested **and smoke-validated end-to-end** (correctly-directed edges for
comment/reply/reaction/follow/connection, type-mapped reaction sentiment, the `CONNECTED` status-gate,
edge deletion on reaction-removal/unfollow/disconnect, self + message-target skips). See "The
relationship graph" → v2 and the design spec. · ✅ **ops polish** — a Python
CI job (ruff + mypy + pytest) in `.github/workflows/ci.yml`;
the scorer images (`agora-scorer-worker` + `agora-scorer-model-server`) added to `docker-publish.yml` as
**native-runner multi-arch** (amd64 + arm64, no QEMU — fast even for the torch-heavy model server);
arch-aware CPU-torch install (`TARGETARCH`) + image slim + an `HF_HOME` cache volume; and the test-suite
debt cleared (conftest force-empties `ANTHROPIC_API_KEY` for hermeticity, `respx` added to dev deps,
suite is mypy-clean across all source dirs). · ✅ **dead moderation-notifier path removed** — `lib/webhooks.ts` `MODERATION_EVENTS`
+ the internal notifier, the `projects.moderation_webhook_url/secret` columns (dropped by migration
`0035`), the `/settings/moderator/test` endpoint, and the admin Settings → Moderator webhook card are
all gone. The scorer drives moderation entirely off pgmq; admin Settings → Moderator now tunes only the
auto-action thresholds + LLM config + categories (`projects.moderator_config`).
