# Agora Corp — the corporate deployment profile 🏢✨

> **Status: CONFIG LAYER IMPLEMENTED; ANALYTICS PROPOSED.** The `corporate` privacy tier, its
> per-tier flag defaults, the two-point enforcement (§4), and the mandatory member-transparency
> endpoint (§4.5) shipped in **PR 1** (`packages/contract/src/social.ts`, `GET /social/transparency`).
> The analytics **computation** the tier unlocks (§2/§6 — influence/silo/engagement scores via
> PageRank/Louvain/OpenGDS) is **not yet built**: PR 1 ships the *flags* that gate it, not the graph
> algorithms behind them. The corporate-installation counterpart to
> [`AGORA-SOCIAL.md`](AGORA-SOCIAL.md) (the community design, condensed) and
> [`SOCIAL-GRAPH.md`](SOCIAL-GRAPH.md) (the graph consolidation + `social_config` plan).
> This doc specifies what an **internal corporate social platform** deployment of Agora
> looks like: the market context, the feature set, the `corporate` privacy tier, what it
> unlocks, and — just as deliberately — what it still refuses to do.

## 1. Why this profile exists

**The market opening.** Workplace from Meta — the only genuinely *social-first* enterprise
platform — has been sunset, stranding a proven market. The survivors are comms tools, not
social platforms: Teams/Slack are channel-chat, Viva Engage is bolted into a heavy
Microsoft commitment. None of them offer:

| Capability | Teams | Slack | Viva Engage | **Agora Corp** |
|---|---|---|---|---|
| True social UX (feeds, spaces, follows, reactions) | ❌ | ❌ | partial | ✅ |
| Social-graph analytics (silos, bridges, informal leaders) | ❌ | ❌ | basic¹ | ✅ |
| Community/team health signal | ❌ | ❌ | ❌ | ✅ |
| Self-hosted / data sovereignty | ❌ | ❌ | ❌ | ✅ |
| Open source (auditable privacy claims) | ❌ | ❌ | ❌ | ✅ AGPL |
| Configurable privacy tiers | ❌ | ❌ | ❌ | ✅ |

¹ Viva Insights does organizational network analysis, but from email/calendar metadata,
expensive, and opaque.

**The differentiator is trust.** Agora's social graph was designed first for vulnerable
communities ([`AGORA-SOCIAL.md`](AGORA-SOCIAL.md)) — the privacy architecture is real,
load-bearing, and *readable in the source*. For a corporate buyer this inverts the usual
pitch: most enterprise social tools are surveillance-first with privacy bolted on; Agora is
privacy-first with **disclosed analytics** unlocked by configuration. A hospital, law firm,
or government agency that cannot put employee interaction data on Meta's or Microsoft's
servers can self-host Agora and verify every claim in the code.

## 2. What a corporation gets

### 🧭 Knowledge & expertise discovery
- "Who in this org knows about X?" — expertise surfaces from what people actually post,
  answer, and get thanked for (warmth-weighted, not just keyword search).
- Tribal-knowledge retention: high-warmth answerers in a topic space are visible *before*
  they walk out the door.
- Onboarding: "people you should know" for a new hire — friends-of-friends + same-space
  co-participation (pure Cypher, Phase 2 graph).

### 📊 Collaboration network analytics (the flagship)
Built on the Layer 2 graph + OpenGDS (see §6):
- **Silo detection** — community detection (Louvain) over `INTERACTED`/`CO_PARTICIPATES`,
  cross-referenced with space/team membership: which departments never talk?
- **Informal leaders** — PageRank over sentiment-weighted `INTERACTED`: who actually
  influences, regardless of title?
- **Bridge people** — betweenness centrality: who connects otherwise-isolated clusters
  (and is a single point of failure if they leave)?
- **Trend over time** — is cross-functional interaction growing or shrinking quarter over
  quarter?

**API surface (✅ shipped, PR 6 — operator-only, corporate-tier, NAMED).** Three reports read from
one combined `social_analytics` snapshot table, gated per-report by the corporate-only config flags
(`influence_scores_enabled` / `silo_detection_enabled` / `engagement_scores_enabled`):

| Endpoint | Report | Backing |
|---|---|---|
| `GET /admin/social/influence` | informal leaders + bridge people | GDS PageRank + betweenness, one shared projection |
| `GET /admin/social/silos` | named clusters → dominant spaces | GDS Louvain (no k-anon — operator view) |
| `GET /admin/social/engagement` | per-person S_p + churn-risk band | Weather math (`fetchWarmthPairs`/`personScoresFromPairs`) over the trailing weekly series |
| `POST /admin/social/recompute` | operator-forced **synchronous** recompute | runs the rollup with `force:true`, returns the fresh report(s) |

Materialized weekly (`/internal/cron/social-analytics`, Sun 05:00; in-lib per-report epoch gate
self-heals a missed run). Snapshots store **raw ids + scores only** — names and space labels are
hydrated fresh at read, so a renamed/departed person is never stale. Each surface fails closed: under
the community tier the flag is forced off → `400 social/<report>-disabled`; a non-operator → `403
admin/operator-required`. Unlike the member-facing Constellation, these reports name real people —
temporal anonymity does **not** apply, because the operator is the accountable employer (§4).

### 🌡️ Engagement & team health
- **Team Weather** — the community-health scalar (`S_p` mean) scoped per space/team:
  "Engineering has been warm lately; Sales is having a stormy month."
- **Engagement scores** — per-person aggregate warmth visible to operators
  (`engagement_scores_enabled`): disengagement and churn-risk trends.
- **Onboarding health** — are new hires' first interactions welcomed or chilled? (The 🌱
  newcomer signal, repurposed: same graph, corporate reading.)

### 📣 Announcements with read receipts ✅ (PR 8)
- An operator marks an individual space as `read_receipts_enabled` via `PATCH
  /admin/social/read-receipts/spaces/:spaceId`. Members' reads of posts in that space are recorded
  as `POST /entities/:id/read` (idempotent `(entity, member)` rows). Operators query live coverage
  via `GET /admin/social/read-receipts` — per-space list of announcement posts with `readerCount /
  memberCount` and a `readReceiptCoverage` ratio: "87% of Engineering has seen the new policy."
- Per-space and **disclosed** — `shapeSpace` surfaces `readReceiptsEnabled` so clients can render
  the receipt badge on opted-in spaces. Watercooler/casual spaces are never tracked. Corporate tier
  only (`readReceiptsAllowed` flag); the admin Spaces section shows the toggle + coverage panel.
  See [`SOCIAL-GRAPH.md` §4](SOCIAL-GRAPH.md).

### 🏆 Recognition
- Kudos/peer-appreciation surfaces from the warmth graph itself — "who is quietly doing
  great work" is literally a query (high inbound warmth, low self-promotion volume).
- Leaderboards stay **opt-in and positive-only** (warmth received), consistent with the
  no-scarlet-letter rule for member-facing surfaces (§4).

### 🔒 Governance
- Moderation: the full scorer pipeline (RoBERTa gates + LLM adjudication) enforcing *HR
  content policy* rather than community guidelines — same machinery, different policy
  prompt (`projects.moderator_config` already supports per-project prompts/thresholds).
- Steward tier → **HR / people-ops case work**: audited, logged, in-context conflict
  resolution (the `project_stewards` machinery as designed).
- Operator audit trail, AGPL-auditable data handling, and self-hosted data residency.

## 3. Concept mapping — community ↔ corporate

The engine is identical; the nouns change:

| Engine concept | Community reading | Corporate reading |
|---|---|---|
| Project | the community | the company |
| Space | interest group / support room | team, department, project, announcement channel |
| Weather | community climate | org/team health gauge |
| Constellation | anonymous community shape | org-shape view (clusters, bridges) |
| Neighborhood | your personal warm ties | your personal work network (still self-view-only) |
| Steward | trusted conflict-resolution member | HR / people-ops / community manager |
| Operator | deployment admin | IT admin + leadership analytics consumers |
| Sprout 🌱 | newcomer grace period | new-hire onboarding signal |
| FRICTION edges | quarantined harassment signal | conflict analytics (visible to operators) |

## 4. The corporate tier — what unlocks, what NEVER unlocks

Set `social_config.privacy_tier = "corporate"`
([`SOCIAL-GRAPH.md` §5](SOCIAL-GRAPH.md) — the full schema and defaults table). Unlocked:
`influence_scores_enabled`, `silo_detection_enabled`, `engagement_scores_enabled`,
`friction_analytics_enabled`, `read_receipts_allowed`.

**The invariants that hold in EVERY tier — including corporate — are not negotiable:**

1. **k-anonymity on member-facing graph renderings** — the Constellation's cluster floor is
   **adaptive (2–5 by community size, hard floor 2)**, never below 2. (Operator analytics may
   name individuals; what *members* see of each other never does.)
2. **Feed read-affinity never becomes graph data** — private, per-viewer, Postgres-only.
   Read receipts exist *only* in disclosed announcement spaces.
3. **Steward/HR access is in-context and audited** — logged inspections, revocable grants,
   no exportable per-person distrust dossier. Conflict analytics aggregate; case work is
   per-incident and logged.
4. **No member-facing scarlet letter** — what employees see of *each other* obeys the
   asymmetry principle: warmth-only, friction dims, no red badges, no public per-person
   scores. (Management analytics are operator-facing and disclosed — see invariant 5.)
5. **Transparency is mandatory, not optional.** The active tier and every enabled analytic
   are **readable by every member** via `GET /social/transparency` (PR 1 — returns the tier,
   the enabled analytics, the Garden surfaces, and the decay half-lives). Employees always
   know the instance runs corporate analytics and which ones. *(Surfacing the **audience** —
   which roles can see each analytic — is a planned addition; the endpoint exposes which
   analytics are active today, not per-analytic viewer roles.)*

**The line, in one sentence:** *Agora Corp does disclosed organizational analytics; it does
not do covert individual surveillance.* Concretely refused, in any configuration:

- ❌ Covert monitoring — any analytic invisible to the people it measures.
- ❌ Per-person browsing/reading dossiers ("show me everything Alice read").
- ❌ Exportable ranked "problem employee" lists (the distrust-list rule survives —
  friction analytics aggregate to teams/spaces; individual friction is case-work, audited).
- ❌ Vulnerability rosters ("who's lonely/struggling" as a clickable list) — disengagement
  trends aggregate to team level; individual outreach goes through a human (HR steward),
  in context, logged.
- ❌ Selling, sharing, or exfiltrating graph data. It's the company's own instance; the
  data never leaves it.

Why hold the line in a corporate product? Three reasons: (a) it's the *brand* — the
auditable-ethics platform is the differentiator, and one covert feature destroys it;
(b) works councils and GDPR make covert employee monitoring legally radioactive in major
markets (§7); (c) the analytics are *better* when disclosed — a measured-in-secret org
games the metric anyway, and a disclosed health signal becomes a shared goal (the
pedagogical core of the Garden, which is the product's actual magic, survives translation:
**your ripples tend the org**).

## 5. Identity & access (enterprise table stakes)

- **SSO** — corporate identity via SAML/OIDC. Supabase Auth (GoTrue) supports OIDC/SAML
  enterprise connections; Agora's token mint (`lib/tokens.ts`) sits on top unchanged.
  Requirement: map IdP groups → space memberships (department spaces auto-provisioned from
  the directory; SCIM is the eventual answer, manual sync the Phase-1 reality).
- **Lifecycle** — offboarding: deactivation must drop tokens (existing refresh-token purge),
  remove from spaces, and *retain* their content per the company's retention policy
  (authored content persists; the person stops being an active node — their edges decay
  naturally via the half-life machinery).
- **Roles** — operators (IT/leadership) via the existing env allowlist; stewards (HR) via
  the existing DB grant. A future `analyst` read-only role (analytics dashboards without
  moderation powers) is an open question (§8).

## 6. Deployment notes

Everything in `SCORER.md` / `SCORER-REQUIREMENTS.md` applies, plus:

- **Graph stack:** DozerDB (Neo4j Community + enterprise features, GPL) with the **OpenGDS
  plugin** — required for the §2 analytics tier (PageRank, Louvain, betweenness). Pure
  Cypher covers everything member-facing; feature-detect GDS at startup and 503 the
  analytics endpoints with a clear "OpenGDS not installed" when absent
  ([`SOCIAL-GRAPH.md` §6](SOCIAL-GRAPH.md)).
- **Scale shape:** corporate instances are *smaller and denser* than public communities
  (500–50,000 members, high interaction rates inside teams, 9-to-5 traffic shape). The
  scorer's two RoBERTa containers handle bursts via pgmq backpressure by design; size the
  worker per `SCORER-REQUIREMENTS.md`.
- **LLM adjudication boundary:** the community design's agent-privacy posture
  ([`AGORA-SOCIAL.md`](AGORA-SOCIAL.md) — on-boundary by default) maps directly to corp
  procurement reality: many corps will demand **no employee content leaves the boundary** →
  run the scorer's LLM step against an internal endpoint or disable it (gray-zone gate
  already degrades gracefully); others will accept a zero-retention DPA (e.g. Claude via
  enterprise agreement). Both are existing config, not new code.
- **Compliance posture:** self-hosted = data residency solved by deployment choice. SOC2 /
  ISO-27001 are *hosting-provider* concerns in the SaaS offering, not Agora-the-software
  concerns; document the shared-responsibility split when the managed offering exists.

## 7. Legal reality check (do this homework before selling Phase 4)

- **GDPR:** employee interaction data is personal data; engagement scores are profiling.
  Lawful basis is *legitimate interest* (not consent — consent is invalid under employer
  power imbalance), which requires a **DPIA** for the analytics tier, data-minimization
  defaults (aggregate-first, named-individual analytics only where justified), retention
  limits (the decay half-lives are genuinely helpful here — the graph *forgets by design*),
  and DSAR support (export/erase a member's edges; erasure must cascade Layer 1 → Layer 2).
- **EU works councils** (Germany/Austria/France/Nordics): introducing employee-monitoring
  software typically requires **works-council co-determination**. The transparency
  invariant (§4.5) and disclosed-analytics posture are exactly what makes approval
  plausible — keep them load-bearing in the sales story, not just the code.
- **US:** lighter federally, but state laws (CCPA for employee data, Illinois BIPA-style
  statutes) are moving; the disclosed posture future-proofs.
- Net: **the ethics architecture is also the compliance architecture.** This is a selling
  point, not a constraint — competitors retrofit it; Agora ships it.

## 8. Phasing & open questions

Corporate features ride the existing build order ([`SOCIAL-GRAPH.md` §7](SOCIAL-GRAPH.md)):
the `corporate` tier config ships with **Phase 1** (it's just the jsonb + clamps), team
Weather with Phase 1–2, read receipts + the OpenGDS analytics suite are **Phase 4**. ✅ The
**analytics API** (influence / silos / engagement reports + operator forced-recompute) shipped
in **PR 6** — see §2 flagship — and the operator React dashboards (a tabbed, operator-only **Social**
page in `apps/admin`) shipped in **PR 7**; per-space read receipts remain.

Open questions:

1. **`analyst` role** — read-only analytics access without operator powers? (Leadership
   wants dashboards, not god-mode.)
2. **SCIM / directory sync** — auto-provision department spaces from the IdP? Build vs
   document-the-manual-path for v1.
3. **Recognition surface** — does positive-only opt-in leaderboard conflict with the
   no-comparison rule the community Neighborhood holds? (Leaning: it's a *space-level*
   opt-in feature, distinct from the Neighborhood, and corporate-tier only.)
4. **Retention policy engine** — corps need configurable content retention (legal hold,
   N-year deletion). Today Agora has no retention machinery at all; scope it.
5. **DSAR tooling** — graph-aware export/erasure (Layer 1 + Layer 2 + analyses) as an
   operator endpoint. Needed for GDPR regardless of tier — community instances benefit too.
6. **Pricing posture** — is the analytics suite (Phase 4) the paid differentiator in the
   hosted offering, with the social core free in all tiers? (Consistent with
   AGPL-forever + hosting-only revenue.)

---

*Companions: [`AGORA-SOCIAL.md`](AGORA-SOCIAL.md) (the community design this profile
adapts), [`SOCIAL-GRAPH.md`](SOCIAL-GRAPH.md) (graph consolidation + `social_config`
schema), `SCORER.md` / `SCORER-REQUIREMENTS.md` (the engine + deployment). Written
2026-06-09.*
