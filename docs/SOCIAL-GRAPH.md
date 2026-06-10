# Social graph — community & corporate deployments 🌱🏢

> **Status: PROPOSED — design doc, nothing implemented.** This is the consolidation plan for the
> social-graph layer: what `../agora-social` designed, what `services/scorer` already built, how the
> two become **one system**, and the per-project configuration that lets each deployment decide what
> it extracts from its own graph. Companion to `docs/SCORER.md` (the live Layer 1 writer) and the
> `../agora-social/docs/` design corpus (the Layer 2 ethics + mechanics spec).

## 1. The decision that frames everything

`../agora-social` was a brainstorming repo — 16 design docs, zero code — that proposed a standalone
projector service reading Agora events and building a person→person graph in Neo4j. Meanwhile,
`services/scorer` independently went live with real Neo4j edge writes (`INTERACTED` / `FOLLOWS` /
`CONNECTED`, validated end-to-end).

**Decision: there will be one graph writer, and it is the scorer.** The agora-social repo stays
design-only. Its Layer 2 projection (decay, capping, warmth derivation, friction quarantine) is
implemented **inside `services/scorer`**, not as a second service consuming the same events. The
scorer already owns the pgmq consumer loop, the Neo4j driver, the sentiment models, and the
idempotency discipline — a separate projector would duplicate all four.

```
                          WRITE SIDE (scorer)                READ SIDE (@agora/api)
 Postgres triggers ──► pgmq 'scorer_jobs' ──► scorer-worker        │
                                               ├─ moderation       │   /v7/.../social/* endpoints
                                               │  (existing)       │   weather · neighborhood ·
                                               └─ graph projection │   analytics — per social_config
                                                  Layer 1 + 2 ──► Neo4j ◄────────────┘
```

- **Scorer writes, API reads.** The warmth/health/analytics queries are read-time aggregations and
  belong in `@agora/api` route handlers (operator/steward/member-gated like everything else), never
  in the scorer.
- The second design input: **Agora is for ANY community** — a recovery network, a queer collective,
  *or a corporation's internal social platform*. Those deployments want nearly **opposite** things
  from the same graph. That tension is resolved by per-project configuration (`§5`), not by picking
  a side.

## 2. The two deployment archetypes

### 🌱 Community (vulnerable-population default)

The `../agora-social` spec was written for trans, queer, sex-worker, and recovery communities, where
graph exposure is a doxxing/outing vector and **mass-reporting is the primary harassment tactic**
(any visible per-person score "lights up on the target, not the harasser"). Its non-negotiable core
is the **asymmetry principle**:

> Every possible misreading must land on **kindness**, never a **scarlet letter**.

Concretely: one public node signal (warmth — friction only *dims*, never renders as its own color);
friction quarantined to aggregates and audited steward views; k-anonymity (k ≥ 5) cluster blobs in
any public graph view; per-person scores never public; no passive tracking; visual-only neighborhood
(reflects, never prompts).

### 🏢 Corporate (internal social platform)

A corporation deploying Agora as its internal network (the post-Workplace-from-Meta gap: social-first
internal platforms with data sovereignty) wants the graph **as an analytics product**:

- **Expertise & knowledge mapping** — "who knows about X", surface tribal knowledge.
- **Collaboration analytics** — silo detection between departments, informal-leader / bridge-person
  identification (PageRank, betweenness), onboarding suggestions.
- **Engagement & team health** — Weather scoped per team, disengagement / churn-risk signals.
- **Read receipts on announcements** — "did employees see the new policy?" is a compliance need,
  not surveillance creep, *in that context*.
- **Friction visibility** — conflict between teams is an HR/management signal they expect to see.

| Signal | 🌱 Community default | 🏢 Corporate want |
|---|---|---|
| Friction edges | Quarantined: aggregate Weather dip + audited steward context only | Steward/operator-visible conflict analytics |
| Per-person warmth | Never public (dyadic brightness only, to the tie-holder) | Engagement scores visible to operators |
| Passive reads | Never tracked as graph data | Read receipts on announcement spaces |
| Influence scores | Aggregate only, k-anonymized | Named informal-leader / bridge reports |
| Silo / cluster detection | Anonymous blobs, layout re-randomized | Named team-level silo analytics |
| Member-facing graph | Constellation (blobs), Neighborhood (own ties only) | Same, plus org-level dashboards |

Neither column is "right" — they're different trust contexts. An employer has a legitimate need to
know a policy was read; a recovery community must never be able to reconstruct who read whose 2am
relapse post. **The operator chooses the tier; the platform enforces it server-side.**

## 3. Graph architecture — what exists, what's added

### Layer 1 — raw event log (✅ LIVE in scorer today)

Validated end-to-end (see `SCORER.md`):

```cypher
(:User)-[:AUTHORED]->(:Content {type, projectId, relationshipScore, scoredAt})   // v1, per scored item
(actor:User)-[:INTERACTED {kind, sentiment, sourceId, at}]->(recipient:User)     // comments/replies/reactions
(follower:User)-[:FOLLOWS {at}]->(followee:User)                                 // mirrors follows table
(requester:User)-[:CONNECTED {at}]->(addressee:User)                             // only while status='connected'
```

Append-style, idempotent under pgmq redelivery (keyed on `sourceId`), raw signed sentiment from the
relationship RoBERTa (text) or the reaction→sentiment map. **This is unchanged** — it is the
provenance layer that lets Layer 2 be recomputed at any time.

### Layer 2 — derived social edges (➕ NEW, written by scorer)

Additions to the scorer's graph projection, adapted from `agora-social/docs/03-data-model.md` +
`11-warmth-model.md`:

1. **`FRICTION` edges** — new pgmq job kinds wired by new enqueue triggers (post-`0037` migration),
   mirroring the existing reaction/follow/connection pattern:
   - `report` (user reports content/user) → `(reporter)-[:FRICTION {kind:'report', sourceId, at}]->(subject)`
   - `block` (user blocks user) → `(blocker)-[:FRICTION {kind:'block', sourceId, at}]->(subject)`
   - Downvotes already flow as negative-sentiment `INTERACTED`; whether they *also* project to
     `FRICTION` is an open tuning question (§7).
2. **`CO_PARTICIPATES` edges** — undirected neutral structure: at comment-score time the worker
   already fetched the content; it additionally upserts co-participation with the thread's other
   recent participants (`{weight, lastAt}`, capped lookback).
3. **Warmth derivation** — the dyadic warmth `B(u,v)` and aggregate person score `S_p`
   (cap + floor math, `agora-social/docs/11`) are computed **at read time** from Layer 1/2 edges.
   **Time decay is read-time** (Cypher over `at`/`lastAt` timestamps; friction half-life shorter
   than warmth, ~14d vs ~30d, tunable) — edges are never rewritten as they age, so the write path
   stays append-only and idempotent.

Internal boundary inside the scorer (same worker, same consumer loop, separated concerns):

```
worker/pipeline.py        ├─ assess_and_record()   ← moderation (existing)
                          └─ project_social()      ← graph projection (new)
worker/neo4j_writer.py    ├─ moderation/Layer-1 writers (existing)
                          └─ social/Layer-2 writers: FRICTION, CO_PARTICIPATES (new)
```

### Read side — `@agora/api` (➕ NEW)

Graph reads are normal Hono handlers with normal gates (`requireAuth`, operator/steward checks,
`social_config` checks — §5), querying Neo4j directly. Sketch of the surface:

| Endpoint (sketch) | Audience | Backing query |
|---|---|---|
| `GET /social/weather` ✅ (PR 2) | members | mean S_p over project (or space) — single scalar + trend |
| `GET /social/neighborhood` | the member themself | dyadic B(me, friend) per tie — own ties ONLY |
| `GET /social/constellation` | members | k-anonymized cluster blobs (k ≥ 5), warmth tint only |
| `GET /admin/social/influence` | operator, gated by config | PageRank / betweenness over INTERACTED+FOLLOWS |
| `GET /admin/social/silos` | operator, gated by config | community detection between spaces/teams |
| `GET /admin/social/engagement` | operator, gated by config | per-person S_p, churn-risk trends |
| steward ripple/inspection | steward, audited | N-hop trace along warmth/friction (`agora-social/docs/06`) |

## 4. Reads: affinity vs receipts (two different things)

"Should a click/read be scored?" splits into two features with opposite privacy profiles:

1. **Feed affinity (all tiers, private).** Reads are real signal — in recovery communities people
   lurk for months before interacting, and their feed should still learn. But
   `(reader)-[:READ]->(author)` as a graph edge is surveillance ("Alice read Bob's relapse post at
   2am"). So: a debounced `POST /v7/:projectId/entities/:id/view` increments `view_count`
   (trending input) and optionally upserts a **Postgres** `user_affinities` row
   `(viewer_id, author_id, view_count, last_viewed_at)` used **only** to boost that author in *that
   viewer's own feed*. **Never written to Neo4j, never visible to stewards/operators, never part of
   the social graph.**
2. **Read receipts (corporate tier, per-space opt-in).** A space the operator marks as
   `announcement` (with `read_receipts: true`) records proper `READ` rows the operator can query
   ("87% of Engineering has seen the new policy"). Members see the badge on the space — receipts
   are **disclosed, scoped, and off everywhere else**. Community tier cannot enable them.

## 5. `social_config` — per-project settings

> **Status: §5 implemented (PR 1, 2026-06-09).** Keys are camelCase in the implementation
> (`privacyTier`, `readReceiptsAllowed`, …), not the snake_case shown below. Contract:
> `packages/contract/src/social.ts`; resolver: `apps/api/src/lib/social-config.ts`; routes in
> `apps/api/src/routes/misc.ts`; admin panel: Settings → Social Graph.

Follows the `projects.moderator_config` precedent exactly: a `projects.social_config` jsonb column
(new migration + zod schema in `@agora-server/contract`), edited in admin **Settings → Social
Graph**, defaulted by tier, **enforced in the data-access layer, not the UI** (load-bearing —
`agora-social/docs/07`; consistent with this repo's "the server is the trust boundary" rule).

```jsonc
// projects.social_config (zod-validated; all fields optional, defaulted by privacy_tier)
{
  "privacy_tier": "community",        // 'community' | 'corporate' — selects the DEFAULTS row below
  "graph_enabled": true,              // master switch (Neo4j feature-gate stays the env vars)

  // member-facing garden
  "weather_enabled": true,
  "constellation_enabled": true,
  "constellation_k_floor": 5,         // k-anonymity floor; clamp: can be raised, never lowered below 5
  "neighborhood_enabled": true,

  // operator analytics
  "influence_scores_enabled": false,  // named PageRank/bridge reports
  "silo_detection_enabled": false,    // named team/space-level cluster analytics
  "engagement_scores_enabled": false, // per-person S_p visible to operators
  "friction_visible_to_stewards": true,   // in-context, audited (community keeps this)
  "friction_analytics_enabled": false,    // aggregate named conflict analytics (corporate)

  // reads
  "read_affinity_enabled": true,      // private per-viewer feed boost (Postgres, never graph)
  "read_receipts_allowed": false,     // master gate; actual opt-in is PER SPACE (announcement spaces)

  // decay & warmth tuning (read-time; safe to retune anytime)
  "warmth_half_life_days": 30,
  "friction_half_life_days": 14
}
```

### Tier defaults

| Setting | 🌱 `community` | 🏢 `corporate` |
|---|---|---|
| weather / constellation / neighborhood | ✅ / ✅ / ✅ | ✅ / ✅ / ✅ |
| `constellation_k_floor` | 5 (hard floor) | 5 (hard floor — k-anonymity is not tier-relaxable) |
| `influence_scores_enabled` | ❌ | ✅ |
| `silo_detection_enabled` | ❌ | ✅ |
| `engagement_scores_enabled` | ❌ | ✅ |
| `friction_visible_to_stewards` | ✅ (audited, in-context) | ✅ |
| `friction_analytics_enabled` | ❌ | ✅ |
| `read_affinity_enabled` | ✅ (private) | ✅ (private) |
| `read_receipts_allowed` | ❌ (cannot be enabled) | ✅ (per-space opt-in) |

### Invariants that hold in EVERY tier

These are platform guarantees, not settings — no tier, flag, or operator can switch them off:

1. **k-anonymity floor of 5** in any member-facing graph rendering (configurable upward only).
2. **Read affinity never becomes graph data** — it lives in Postgres, scoped to the viewer's own
   feed ranking; there is no code path from `user_affinities` to Neo4j or to any operator view.
3. **Steward friction access is in-context and audited** (logged inspections, revocable grants —
   the `project_stewards` machinery), never a bare ranked list of people.
4. **No member-facing scarlet letter** — per-person scores surfaced to *members* are warmth-only;
   friction dims, it never renders as its own public signal. (Corporate tier exposes per-person
   analytics to **operators**, who in that context are the accountable employer — but member-facing
   views obey the asymmetry principle everywhere.)
5. **Transparency**: the active tier + enabled analytics are readable by members (e.g. surfaced in
   project metadata / an about screen), so people always know which instrument their instance is.

The tier selects defaults; individual flags can then be tuned — but validation clamps every flag to
what the tier allows (e.g. `read_receipts_allowed: true` is rejected under `community`). Fail closed.

## 6. GDS: DozerDB + OpenGDS

The compose file currently runs stock `neo4j:5-community`. The deployment target is **DozerDB**
(GPL; Neo4j Community + enterprise features: multi-db, full constraints — no Neo4j affiliation),
with **OpenGDS** as a separately-installed plugin for the algorithm tier:

- **Pure Cypher (no plugin needed):** weather, neighborhood, affinity feed boosts,
  people-you-may-know (friends-of-friends), co-participation queries. Phase 1–2 needs nothing else.
- **OpenGDS required:** PageRank (influence), Louvain/label-propagation (silo & community
  detection), betweenness (bridge people). Corporate analytics tier — and the constellation's
  clustering can upgrade from heuristic to Louvain when present.
- Treat GDS availability like every other optional integration: **feature-detect at startup, degrade
  gracefully** (analytics endpoints 503 with a clear "OpenGDS not installed" error rather than
  failing mid-query).

## 7. Build order & open questions

Phasing (adapted from `agora-social/docs/08`, re-grounded in the scorer-owns-the-graph decision):

1. **Phase 1 — Weather.** Read-time S_p aggregation over existing Layer 1 edges + the
   `social_config` column + admin settings UI. Lowest risk, zero re-identification surface, proves
   the read side. *(No new writes needed — the live INTERACTED graph already feeds it.)*

   > **Status: ✅ implemented (PR 2).** Live Cypher over Layer-1 `INTERACTED` edges (zero-sentiment
   > neutral edges excluded), dual-window trend (now vs. −7d), 1h per-project cache, band hysteresis
   > (±0.02). Negative Layer-1 sentiment feeds the friction term until PR 3's dedicated FRICTION
   > edges land. Per-space Weather deferred — `spaceId` is not yet written to the graph (scorer
   > change, later PR). Design debt noted for PR 3+: a fully dormant community asymptotes to
   > "stormy" rather than "quiet" (decayed pairs never leave the S_p denominator) — an age cutoff
   > on edges (~6 warmth half-lives) would fix it and shrink the scan.

2. **Phase 2 — Layer 2 writes.** FRICTION + CO_PARTICIPATES job kinds (triggers + scorer handlers),
   read-time decay, dyadic warmth → Neighborhood + Constellation endpoints. Feed affinity
   (`view` endpoint + `user_affinities`).
3. **Phase 3 — Steward tier.** Ripple tracing + audited in-context inspection (rides the existing
   `project_stewards` grant + audit machinery).
4. **Phase 4 — Corporate analytics.** OpenGDS algorithms (influence, silos, engagement), per-space
   read receipts, org dashboards in admin.

Open questions (carried from `agora-social/docs/08` + new ones from this consolidation):

- Do downvotes project into `FRICTION`, or stay negative-`INTERACTED` only? (Mass-downvoting is the
  same brigading vector as mass-reporting — leaning: INTERACTED-only, like today.)
- Exact warmth formula weights / cap + floor constants (`agora-social/docs/11` leaves them TBD).
- Half-life defaults (14d friction / 30d warmth) need validation against real activity volumes.
- `CO_PARTICIPATES` lookback window + weight cap (thread-size blowup guard).
- LLM valence enrichment (`agora-social/docs/04`, the five-trigger agent) — deferred entirely;
  raw RoBERTa sentiment is the valence source until there's evidence it isn't enough.
- Corporate tier legal surface: read receipts + engagement scores likely interact with works-council
  / GDPR-employee-data rules in EU deployments — needs research before Phase 4 ships.

---

*Design inputs: `../agora-social/docs/01–16` (ethics + mechanics spec, esp. 03 data model, 07
privacy, 11 warmth math), `docs/SCORER.md` (live graph writer), conversation review 2026-06-09
(corp/community split, single-writer consolidation, read-affinity vs read-receipts distinction).*
