# Social graph — community & corporate deployments 🌱🏢

> **Status: PARTIALLY IMPLEMENTED.** The `social_config` foundation (§5) shipped in **PR 1**,
> Community Weather (§3 `GET /social/weather`, §7 Phase 1) shipped in **PR 2**, the Layer-2
> **`FRICTION`** edge (user reports → Weather's friction term, §7 Phase 2) shipped in **PR 3**, and the
> **Neighborhood** read surface (§3 `GET /social/neighborhood` — dyadic self-view) shipped in **PR 4**, and
> the **Constellation** (§3 `GET /social/constellation` — GDS-Louvain k-anonymized blobs, seasonally
> cron-materialized) shipped in **PR 5**, completing the member-facing **Garden** — see the ✅ markers on
> those sections. The **`CO_PARTICIPATES`** edge (§7 Phase 2) shipped in **PR 9** — see the ✅ marker there. The rest of Layer 2 (the `block`/`mute` friction source — which
> has no feature/table yet), the **admin analytics** endpoints, and the corporate OpenGDS algorithm tier
> (§6 — OpenGDS is now installed; PageRank/silo reports remain) stay **proposed**. This is the consolidation plan for the social-graph layer: what `../agora-social`
> designed, what `services/scorer` already built, how the two become **one system**, and the
> per-project configuration that lets each deployment decide what it extracts from its own graph.
> Companion to `docs/SCORER.md` (the live Layer 1 writer) and the `../agora-social/docs/` design
> corpus (the Layer 2 ethics + mechanics spec).

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
(actor:User)-[:INTERACTED {kind, sentiment, sourceId, projectId, at}]->(recipient:User)  // comments/replies/reactions (projectId scopes the read query)
(follower:User)-[:FOLLOWS {at}]->(followee:User)                                 // mirrors follows table
(requester:User)-[:CONNECTED {at}]->(addressee:User)                             // only while status='connected'
```

Append-style, idempotent under pgmq redelivery (keyed on `sourceId`), raw signed sentiment from the
relationship RoBERTa (text) or the reaction→sentiment map. **This is unchanged** — it is the
provenance layer that lets Layer 2 be recomputed at any time.

### Layer 2 — derived social edges (➕ written by scorer)

Additions to the scorer's graph projection, adapted from `agora-social/docs/03-data-model.md` +
`11-warmth-model.md`:

1. **`FRICTION` edges** — ✅ **LIVE for reports (PR 3)**. New pgmq job kind (`friction`) wired by an
   enqueue trigger (migration `0039`), mirroring the reaction/follow/connection pattern:
   - `report` (user reports content) → `(reporter)-[:FRICTION {kind:'report', sourceId, weight, projectId, at}]->(subject)`,
     where the subject is the **author of the reported content**. ✅ shipped. Append + decay only: a
     resolved/dismissed report is a no-op in the graph (friction fades at the friction half-life; it
     isn't adjudicated here — that's the steward tier). Weather folds it into `F` **additively**
     alongside negative-`INTERACTED` (§7 Phase 1 note).
   - `block` (user blocks user) → `(blocker)-[:FRICTION {kind:'block'}]->(subject)` — **deferred**: no
     block/mute feature or table exists yet.
   - Downvotes flow as negative-sentiment `INTERACTED` and **stay `INTERACTED`-only** (resolved §7 open
     question — same brigading vector as mass-reporting); they do not *also* project to `FRICTION`.
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
                          └─ social/Layer-2 writers: FRICTION ✅ (PR 3), CO_PARTICIPATES (new)
```

### Read side — `@agora/api` (➕ NEW)

Graph reads are normal Hono handlers with normal gates (`requireAuth`, operator/steward checks,
`social_config` checks — §5), querying Neo4j directly. Sketch of the surface:

| Endpoint (sketch) | Audience | Backing query |
|---|---|---|
| `GET /social/weather` ✅ (PR 2) | members | mean S_p over project — single scalar + trend (per-space deferred — see §7 Phase 1) |
| `GET /social/neighborhood` ✅ (PR 4) | the member themself | dyadic B(me, friend) per tie — own ties ONLY. Default = follows ∪ connections; interactions opt-in via `neighborhoodIncludeInteractions` (project default) or `?includeInteractions=` (per-member override). Friction dims, never creates a tie. |
| `GET /social/constellation` ✅ (PR 5) | members | k-anonymized cluster blobs (k ≥ 5), warmth tint only — GDS Louvain (by-space fallback), seasonally cron-materialized (§12), suppress sub-k-floor |
| `GET /admin/social/influence` ✅ (PR 6) | operator, corporate-tier | named informal leaders (GDS PageRank) + bridge people (GDS betweenness), one shared projection; weekly cron-materialized, operator force-recompute |
| `GET /admin/social/silos` ✅ (PR 6) | operator, corporate-tier | named GDS Louvain clusters mapped to their dominant spaces — the receipts form of the Constellation (NO k-anon; the operator is the accountable employer) |
| `GET /admin/social/engagement` ✅ (PR 6) | operator, corporate-tier | per-person warmth-received S_p (reuses the Weather math) + a churn-risk band from the trailing weekly S_p series |
| `POST /admin/social/recompute` ✅ (PR 6) | operator, corporate-tier | operator-forced synchronous recompute (bypasses the weekly epoch gate), returns the fresh report(s) |
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
  "neighborhood_include_interactions": false,  // default tie set is follows+connections; opt in to add interaction-only ties (per-member ?includeInteractions= overrides)

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

The compose file runs **DozerDB** (`graphstack/dozerdb:5.26.3.0` — GPL; Neo4j Community + enterprise
features: multi-db, full constraints — no Neo4j affiliation), with **OpenGDS 2.12.0** installed as a
plugin (jar mounted at `/plugins`; APOC via `NEO4J_PLUGINS`) — see `docs/DOZERDB.md`. ✅ **The
Constellation (PR 5) uses `gds.louvain.stream`** for community detection, with a by-space heuristic
fallback when GDS is absent (feature-detected at run time). Remaining GDS tiers:

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

   > **Status: ✅ implemented (PR 2), extended (PR 3).** Live Cypher over Layer-1 `INTERACTED` edges
   > (zero-sentiment neutral edges excluded), dual-window trend (now vs. −7d), 1h per-project cache,
   > band hysteresis (±0.02). **PR 3** made the friction term `F` **additive**: negative-`INTERACTED`
   > sentiment **plus** dedicated `FRICTION` edges (user reports, migration `0039`), summed per directed
   > pair and merged before brightness (`mergePairRows`). PR 3 also added the **age cutoff** (~6 warmth
   > half-lives) — the design debt below is **resolved**: long-dead edges leave the scan, so a fully
   > dormant community now reads "quiet" instead of asymptoting to floor-dark "stormy", and the scan
   > shrinks. Per-space Weather is still deferred — `spaceId` is not yet written to the graph (scorer
   > change, later PR).

   > **Cadence & materialization (decision 2026-06).** §12 temporal-anonymity does **not** apply to
   > Weather (re-scoped to the Constellation) — so the refresh cadence is a **product/cost choice, not
   > privacy**. The 30d/14d decay half-lives mean the number can't meaningfully move faster than ~daily
   > (one hour ages it ~0.1% — noise), so the **target default is daily**, but kept **tunable** (a
   > `social_config` TTL field) for deployments that want an hourly "pulse" that makes the community
   > feel alive. *Shipped today:* a 1h per-replica in-process cache, lazy-computed on request — fine as
   > an interim. *Evolution* when stored history (sparklines) or the Weather-oracle narrative
   > (AGORA-SOCIAL.md, Garden) lands: a **scheduled cron-materialization** — snapshot Weather (+ its
   > agent sentence) to a table on the chosen clock; the endpoint then reads the table. Mirror the
   > existing hourly **`community-stats` rollup → `community_stats_hourly`** cron — it's the exact
   > pattern, right down to writing one row per project per period.

2. **Phase 2 — Layer 2 writes + Garden reads.** *(Partially shipped, PR 3–5; CO_PARTICIPATES shipped PR 9.)* ✅ `FRICTION` job kind
   (report trigger `0039` + scorer handler + read-time decay) folded into Weather (PR 3); ✅ the
   **Neighborhood** read endpoint — dyadic `B(me, friend)` over the caller's own ties, friction-folded,
   age-cut, self-view only (PR 4); ✅ the **Constellation** — k-anonymized cluster blobs from GDS Louvain
   (by-space fallback), seasonally cron-materialized into `social_constellation`, sub-k-floor suppressed
   (PR 5). **The Garden lenses are now complete.** ✅ **`CO_PARTICIPATES`** — undirected structurally-neutral
   co-commenter edge (scorer, PR 9); `GET /social/neighborhood?includeCoParticipates=true` opts in
   (default off; floor brightness, 0 warmth/friction; canonical `(min,max)` key, windowed + capped +
   weight-clamped). **Remaining in Phase 2:** the `block`/`mute` friction source (needs a feature/table
   first), and feed affinity (`view` endpoint + `user_affinities`).
3. **Phase 3 — Steward tier.** Ripple tracing + audited in-context inspection (rides the existing
   `project_stewards` grant + audit machinery).
4. **Phase 4 — Corporate analytics.** *(API shipped, PR 6; operator dashboards shipped, PR 7.)* ✅ Three operator-only, **NAMED**
   corporate-tier reports read from one combined `social_analytics` snapshot table: **influence**
   (GDS PageRank leaders + betweenness bridges, one shared projection), **silos** (GDS Louvain
   clusters mapped to dominant spaces — the receipts counterpart to the k-anonymized Constellation,
   no k-anon because the operator is the accountable employer), and **engagement** (per-person S_p
   from the Weather math + a churn-risk band over the trailing weekly series). Weekly cron-materialized
   (`/internal/cron/social-analytics`, Sun 05:00, in-lib per-report epoch gate self-heals a missed
   run) with an operator-forced **synchronous** recompute (`POST /admin/social/recompute`). Snapshots
   store raw ids + scores only; names + space labels are hydrated fresh at read so they never go stale.
   See `docs/AGORA-CORP.md`. The **operator React dashboards** (PR 7) render the three reports as a
   tabbed, operator-only **Social** page in `apps/admin` (ranked influence lists, silo cards, an
   engagement table with trend sparklines + churn badges), each tab carrying a per-report Recompute
   button. **Per-space read receipts shipped in PR 8** — `POST /entities/:id/read` records member
   reads; `GET /admin/social/read-receipts` returns live per-space coverage (readerCount/memberCount
   per announcement post); `PATCH /admin/social/read-receipts/spaces/:spaceId` toggles per-space
   opt-in; admin **Spaces** page exposes the toggle + per-post coverage panel. **Phase 4 is complete.**

Open questions (carried from `agora-social/docs/08` + new ones from this consolidation):

- ~~Do downvotes project into `FRICTION`, or stay negative-`INTERACTED` only?~~ **Resolved (PR 3):
  `INTERACTED`-only.** Mass-downvoting is the same brigading vector as mass-reporting; downvotes keep
  feeding `F` as negative-sentiment `INTERACTED` and do not *also* create `FRICTION` edges.
- Exact warmth formula weights / cap + floor constants (`agora-social/docs/11` leaves them TBD).
- Half-life defaults (14d friction / 30d warmth) need validation against real activity volumes.
- ~~`CO_PARTICIPATES` lookback window + weight cap (thread-size blowup guard).~~ **Resolved (PR 9):** `SCORER_CO_PARTICIPATES_LOOKBACK_DAYS`=7, `_MAX_PARTICIPANTS`=50, `_MAX_WEIGHT`=10.
- LLM valence enrichment (`agora-social/docs/04`, the five-trigger agent) — deferred entirely;
  raw RoBERTa sentiment is the valence source until there's evidence it isn't enough.
- Corporate tier legal surface: read receipts + engagement scores likely interact with works-council
  / GDPR-employee-data rules in EU deployments — needs research before Phase 4 ships.

---

*Design inputs: `../agora-social/docs/01–16` (ethics + mechanics spec, esp. 03 data model, 07
privacy, 11 warmth math), `docs/SCORER.md` (live graph writer), conversation review 2026-06-09
(corp/community split, single-writer consolidation, read-affinity vs read-receipts distinction).*
