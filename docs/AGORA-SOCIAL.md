# Agora Social — the design, condensed 🌷🌊

> **What this is:** the entire `../agora-social/docs/` design corpus (16 numbered docs +
> an adversarial REVIEW) condensed into one memory-refresher. Each section names its source
> doc — go there only when you need the full depth. The repo itself is **design-stage only**
> (no code); the implementation plan that consolidates it into `services/scorer` lives in
> [`SOCIAL-GRAPH.md`](SOCIAL-GRAPH.md).

## The thesis (doc 01)

> **Graph as commons, not graph as product.** Every platform mines the social graph *at*
> the user — to target, rank, and sell them. Agora points the same structure *back at the
> community, for the community*, in service of its **health**.

The mission metaphor: **🌊→🌷 "Your ripples tend the garden."** Your behavior propagates
(ripple); the sum of everyone's ripples is the living health of the shared space (garden).
The original spark — "show me who you've been chatting with" trust-score surveillance —
was explicitly **rejected**; what survived is its opposite.

The stakes: Agora's communities skew **trans, queer, sex-worker, recovery**. For them,
graph exposure = doxxing/outing, and **mass-reporting is the primary harassment tactic** —
so any score that counts reports lights up on the *target*, not the harasser ("the
brigading inversion"). Every design rule downstream follows from taking that seriously.

## ⚡ Cheat sheet — the ten ideas to remember

| # | Idea | One-liner |
|---|------|-----------|
| 1 | **Asymmetry principle** | Every possible misreading must land on *kindness*, never a scarlet letter. Friction **dims** a node; it never **reddens** it. |
| 2 | **Two rooms** | Garden (public, aggregate, anonymous — *tend & teach*) vs Steward tier (gated, individual, audited — *protect & judge*). Boundary enforced in the **data layer**, not UI. |
| 3 | **Two layers in Neo4j** | Layer 1 = raw content/event graph (provenance). Layer 2 = projected person→person social graph (what renders). |
| 4 | **Zoom ladder = privacy tiers** | ☀️ Weather (one scalar) → ✨ Constellation (anonymous blobs) → 🏡 Neighborhood (your own ties only). |
| 5 | **One public node signal: warmth** | Loneliness and friction both render as *dim* — indistinguishable on purpose. Both mean "bring care here." |
| 6 | **Dyadic, not global** | Neighborhood brightness is *your tie* `B(u,v)`, never the friend's global score — closes the friction side-channel completely. |
| 7 | **Friction is quarantined** | Aggregate Weather dip + audited steward points-to-context only. Never a per-person verdict, in any tier. |
| 8 | **Time decay, read-time** | Friction half-life (~14d) < warmth (~30d). "A bad week is not a permanent identity." Edges never mutated. |
| 9 | **Visual-only, zero prompts** | The Neighborhood *shows*, never messages. This one rule deletes the grief/loss problem entirely. |
| 10 | **Structure free, valence hard** | Edge existence is objective; edge *meaning* gets a cheap raw guess always + a selective, privacy-locked LLM read. |

## Concepts & vocabulary (doc 02)

- **The Garden 🌷** — what *everyone* sees: aggregate, ambient, anonymous community health.
- **The Ripple 🌊** — how behavior propagates; the *steward-only* tracing tools.
- **Warmth / Structure / Friction** — the three edge valences: 🟢 positive (replies,
  upvotes, mentions), 🟣 neutral (follows, co-participation), 🔴 negative (reports, blocks).
- **Sprout 🌱** — newcomer rendering: low warmth shown as a *hopeful glow*, not lonely grey,
  for a time-limited grace period (new ≠ lonely ≠ deficient; never a permanent mark).
- **Points-to-context** — the steward friction model: "3 people flagged this thread — go
  read it." Never "trust score 0.21."
- **Nudge** — the Garden's only encouragement mode: *visual invitation* (a glow, a dim
  corner), never a text prompt.

## Data model (doc 03)

Two graphs in Neo4j:

```
Layer 1 (substrate)            Layer 2 (projected, what renders)
(:Person)-[:AUTHORED]->(:Content)     (:Person)-[:INTERACTED {valence, valenceSource,
(:Content)-[:CHILD_OF]->(:Content)                weight, lastInteractionAt, agentScoredAt}]->(:Person)
                                      (:Person)-[:CO_PARTICIPATES {weight, lastAt}]-(:Person)   // undirected
                                      (:Person)-[:FOLLOWS]->(:Person)
                                      (:Person)-[:FRICTION {weight, lastAt, decayHalfLifeDays}]->(:Person)
```

Projection rules: reply/upvote/mention → `INTERACTED` (warmth); same-thread posting →
`CO_PARTICIPATES`; report/block/downvote → `FRICTION`. Idempotent, incremental upserts.

**Warmth is derived at two granularities — never confuse them:**
1. **Dyadic `B(u,v)`** — your tie to a friend. What the Neighborhood renders.
2. **Aggregate `S_p`** (`warmthScore`) — a person's total. Feeds Weather mean + blob tint
   **only**; *never* rendered as an individual node anywhere public.

## The public Garden (doc 05) — three lenses, one engine

- **☀️ Weather** — "warmth 78%, sunny / 61%, stormy week." One scalar, zero
  re-identification surface. Ships first. The *only* place friction shows publicly — as a
  dip in collective climate.
- **✨ Constellation** — the anonymous *shape*: cluster blobs (size = members, brightness =
  warmth), **never individual nodes**. Guardrails: k-anonymity (an **adaptive floor of 2–5 by
  community size**, hard floor **2** — sub-floor clusters suppressed), layout re-randomized per load,
  warmth-only (friction never renders as structure).

> **As shipped (PR 5):** `GET /social/constellation` returns cluster **blobs** — a bucketed size
> (`5–9`, `10–19`, …) + a warmth band, **no ids, names, or member lists**. Clustering is **GDS Louvain**
> (`gds.louvain.stream`) over the warmth/structure graph (`INTERACTED ∪ FOLLOWS ∪ CONNECTED`; **`FRICTION`
> excluded** — friction is never structure), scoped by the project's user set, with a **by-space fallback**
> when OpenGDS is absent. Clusters smaller than the effective `constellationKFloor` are **suppressed**;
> each blob is tinted by its members' mean `S_p`. **The k-floor is adaptive (2026-06):**
> `constellationKFloor` defaults to `null` → resolved at materialization by `adaptiveConstellationFloor`
> (2 for `<50` members, 3 `<100`, 4 `<500`, 5 `≥500`) so a small community sees an accurate, non-empty
> constellation instead of a permanently-empty one; an admin may pin a fixed override (raised to ≥2,
> capped 1000). The **hard anonymity floor is 2** in both paths — a blob can never *be* one identifiable
> person. A project-admin can force an on-demand re-materialization via `POST
> /admin/social/constellation/recompute` (the config-companion to `PATCH /settings/social`). Per §12 it's
> otherwise **materialized seasonally**
> (a `social_constellation` snapshot refreshed by a weekly cron with a ~6-week per-project epoch gate —
> never per-load), and blobs carry **no persistent identity** (re-clustered fresh each epoch). The
> coarse buckets + slow cadence are the temporal-anonymity protection.
- **🏡 Neighborhood** — zoom to *yourself*: your named friends and ties, warm and alive.
  Self-view only; nobody else can see it.

> **As shipped (PR 4, refined PR 4.1):** `GET /social/neighborhood` returns the caller's own ties, each
> with its **dyadic** brightness `B(me, them)` — *your tie's* warmth, **never** the friend's global `S_p`
> (the asymmetry rule, cheat-sheet #6). **By default a tie is a deliberate one — a follow or a
> connection.** Interaction-only ties are **opt-in**: the project default is `social_config.
> neighborhoodIncludeInteractions` (default off, admin-editable), and a member can override it for their
> own view with `?includeInteractions=true|false` (the response echoes the effective `includesInteractions`).
> The toggle governs only *who appears* — a structural tie still glows from your interactions either way.
> `FRICTION` only *dims* an existing tie (FLOOR-bounded → unreadable) and never *creates* one — a
> report-only pair never appears. Reuses the PR 3 warmth math (additive friction, read-time decay, age
> cutoff) per dyad. No k-anonymity here (named self-view of people you already know — the adaptive
> k-floor governs the Constellation's view of *others*). Computed live, no cache (bounded by your own degree).

**The abuser edge case, named:** a genuine abuser also reads "needs care" publicly. That's
accepted — *the Garden is not where abuse is adjudicated*; the steward tier is.

> **Future idea — the Weather oracle (Jenova, 2026-06):** when a member asks "why did it dip this
> week?", an LLM agent generates a one-line **narrative** for the current Weather ("a couple of tense
> threads in the commons, but your core circles held steady"), regenerated in sync with each Weather
> refresh. *Users ask, Agora answers.* **Hard guardrail:** it must be the **stateless number-only
> oracle** (doc 13 / "agent privacy") — it sees only the aggregate numbers (value, trend, per-space
> bands where k ≥ 5), **never names, edges, or individual events** — or it would narrate the very
> per-person leak the whole design exists to prevent. Pairs naturally with cron-materialized Weather
> (store the number + its sentence together); cheap at a daily cadence, pricey/noisy hourly, so the
> narrative likely runs on a slower clock than the number even if the number ticks faster.

## The steward tier (doc 06)

The other room. `isSteward` role gates the system's one genuinely dangerous capability:
looking hard at a named individual.

- **Ripple tracing** — follow propagation N hops along warmth/friction edges.
- **In-context inspection** — open one person's activity. Honesty: *inspection IS
  identification*; safety comes from who can do it, what it shows (context, not verdicts),
  and that it's **logged**.
- Friction is **points-to-context** even here — a number gets screenshotted and weaponized;
  "reported a lot" tracks the brigaded. The steward reads the thread and discerns.
- Accountability: audit log, explicit revocable grants, **no export of any distrust list**,
  decay applies to the default view.

## Privacy & ethics (doc 07 — the load-bearing doc)

- **"No names" is not privacy.** Graphs de-anonymize via structural fingerprints
  (Narayanan–Shmatikov): your pattern of connections is nearly unique, and an attacker
  self-anchors and peels outward. Anonymity must be *engineered*: blobs, k-anonymity,
  unstable layout.
- **Three leak tiers:** position (😌 low), **association** (⚠️ the outing vector — the edges
  are the secret), **verdict** (🚨 radioactive — never built as a per-person artifact, period).
- **The drama side-channel:** friction is *loud* — anyone who read the forum can re-identify
  "that red edge" from Tuesday's blowup with no math. Hence friction never renders as public
  structure at all.
- **Brigading at the post level:** a dogpiled member produces an "unhealthy" thread; a naïve
  toxic-badge re-victimizes them. Framing rule: ✅ "this conversation could use warmth"
  (summons allies) — ❌ "toxic post" (summons a pile-on).
- **Grief:** the visual-only rule deletes the problem — no prompt exists to cheerfully
  suggest messaging a dead friend. No death-detector needed; every ending just fades.
- The doc ends in a long **enforced guardrail checklist** (k-anon, no red, blobs, dyadic
  houses, gated sensitive-space joins, billing firewall, agent rules…) — the implementation
  acceptance criteria.

## Valence engine (doc 04) + agent privacy (doc 13)

**Hybrid model:** ① structure (free, always) + ② raw valence guess (cheap, always:
upvote→mild+, report/block→negative — blind to words) + ③ selective **LLM agent
enrichment** that refines the *number on an existing edge*. The agent never creates
structure and never scores people.

**Five triggers (all in scope):** 🚩 reported/contested · 📣 high-reach · 🎲 random
calibration sampling · 👁️ steward on-demand · 🌱 newcomer's first interactions.
Cost controls required: budget-capped queue, priority (🚩🌱 first), dedup, idempotency.

**The agent is a stateless valence oracle — "ephemeral · amnesic · on-boundary ·
number-only":**
- Output is a **typed `{valence, confidence}`** enforced at decoding — no free-text channel
  exists, which kills rationale-retention, prose verdict-laundering, and prompt-injection
  text-exfil in one move (injection's blast radius = one wrong number).
- **Amnesia covers input too** — interaction text never lands in logs, traces, DLQs, or
  crash dumps (the commonly-missed vector).
- **Local/on-prem model by default** (hard self-hosting line); hosted APIs only with
  zero-retention DPA + per-community consent; consumer-terms APIs forbidden.
- Low confidence → fall back to raw valence. Communities may run **agent-off** entirely.
- Honest caveats: the agent actually *protects* the brigaded (it reads context where raw
  report-counts punish them) — but it's off-by-default and falls back on exactly the messy
  contested threads where victims need it most. Conditional upside; say so.

## The warmth math (doc 11) — what makes the ethics *mechanical*

Per-dyad accumulators with read-time exponential decay:
`W(u,v)`, `F(u,v)`; defaults `H_w = 30d`, `H_f = 14d`.

Brightness: `S_w = W/(W+k_w)`; `φ = F/(F+W+k_w)`; `B = B_floor + (1−B_floor)·S_w·(1−c_f·φ)`
with defaults `k_w=10, c_f=0.5, B_floor=0.15`. Two structural guarantees:

- **CAP** — friction can remove at most 50% of warmth; a dogpile can't crash a bright tie.
- **FLOOR** — `B ≥ 0.15` always; friction can never dim *below* the lonely band, so
  "extra-dark = friction" is **unreadable by construction**.

> **As shipped (PR 3):** Weather computes `W`/`F` live at read time. `W` comes from positive-`sentiment`
> Layer-1 `INTERACTED` edges (warmth half-life); zero-sentiment edges (deliberately-neutral reactions
> like "sad" = empathy) are **excluded** so they can't read as floor-dark. `F` is now **additive** —
> **negative `sentiment` `INTERACTED`** (angry/downvote reactions) **plus** dedicated Layer-2
> **`FRICTION`** edges (user **reports**, migration 0039), both decayed at the friction half-life and
> summed per directed pair. The brightness formula is unchanged. Scope notes: **`block`/`mute` friction
> is deferred** — no such feature/table exists yet; and **downvotes stay `INTERACTED`-only** (they do not
> *also* project to `FRICTION` — same brigading vector as mass-reporting, §-open-questions). A read-time
> **age cutoff** (~6 warmth half-lives) drops long-dead edges so a dormant community reads "quiet", not
> floor-dark "stormy".

**The magnitude-regime theorem:** friction identifiable enough to target one person can't
move an aggregate; friction big enough to move the Weather involves too many people to
single anyone out. The regimes are disjoint → aggregate Weather can be *sharp and honest*
while individuals stay unreadable.

**Dogpile simulation (illustrative — a worked example with assumed per-dyad inputs, not output
reproducible from the shipped constants; "blob tint" refers to the not-yet-built Constellation. The
PR 2 tests assert only the *direction and bound* — a dogpile moves the aggregate by < 0.05 and
downward):** 8 brigaders hit well-loved T in a community of 200 → her real friend's porch:
**0.72 → 0.72 (unchanged)**; blob tint −0.005; Weather −0.0001. An honest storm (80 of 200 in
friction) moves Weather −11%. T's support network is never poisoned, and the only people who see her
at the floor already attacked her.

## Temporal anonymity (doc 12) — a **Constellation-only** concern

> **Scope (settled 2026-06): this governs the Constellation, NOT Weather.** The time-series leak
> below needs either *structure you can track* (blobs, small clusters) or a population that changes by
> ~one between readings — both real for the Constellation, neither real for a project-wide Weather
> scalar. Weather is protected by the **magnitude-regime theorem (§11) + the k≥5 floor**, which don't
> care how often it updates. So **Weather's refresh cadence is a product/cost choice, not a privacy
> one** (see SOCIAL-GRAPH.md §7). Everything below applies to the Constellation only.

> **Implemented (PR 5):** the Constellation is materialized on a **weekly cron with a ~6-week per-project
> epoch gate** (`CONSTELLATION_EPOCH_DAYS`), never per-load; blobs are **re-clustered fresh** with no
> persistent identity, and **coarse size buckets + warmth bands** quantize away small shifts. (Per-blob
> band *hysteresis* is moot without blob identity — the buckets + slow cadence do that work instead.
> "Sticky noise" is deferred.)

k-anon + unstable layout protect *one* snapshot; an always-on view leaks via the time
series (differential privacy under continual observation). Master principle: **minimize how
often the published value changes.**

- **Seasonal cadence (locked)** — recompute ~every 6 weeks, smoothed trailing window. Never per-load.
- **Re-cluster fresh (locked)** — no persistent blob identity (honest caveat: stable
  clustering is still re-matchable by shape; cadence + coarsening do the real work).
- **Buckets + hysteresis** — size in buckets (5–9, 10–19…), tint in ~4 bands; a band moves
  only on a margin-crossing, persistent change. This is what makes doc 11's 0.005 blob
  shift invisible over *any* number of frames.
- **Sticky noise** — fresh per-load noise is averaged away by an observer; draw once per
  epoch if at all.
- Honest cost: the Constellation is deliberately **low-fidelity and slow** — a seasonal
  impression, defensible rather than "safe," and fundamentally riskier than Weather.

## Units of health (doc 09)

Warmth rolls up a ladder: **edge → post/thread → space → community**, all in the same
weather language. Space health = Weather scoped to a room (k ≥ 5 guard — tiny spaces show
nothing). Post health is the dangerous one (a post has *one named author*), resolved by:
**🪞 author-mirror** (private self-reflection for the OP) + **🌤️ soft public cue** ("this
conversation could use warmth") — never a score, badge, or derank. Never punish a brigaded
person's post.

## The Neighborhood & relationship lifecycle (doc 10)

Your living local map: you, your friends, post-interaction circles — named, warm, alive.

- **Visual-only, zero prompts — the load-bearing rule.** A picture you open, never a voice
  that interrupts. No "say hi to X," no numbers, no comparison, ever.
- Circles are built from **public co-participation + your own ties** — never other people's
  private friend-graphs (the association guard).
- Lifecycle: 🟢 warm (bright) → 🟡 cooling (dims silently) → 🔵 faded, optionally becomes a
  **follow** (persists, lighter). Rekindling re-brightens. **No loss state, no
  death-detector** — every ending fades the same gentle way.

## The experience layer (docs 14–15 — vision tier)

- **🌷 The Bloom:** all warmth rendering becomes *flora*. A member's flower is **self-chosen
  and decodes to nothing** (never gender/orientation/status — preference, never inference).
  Individual flowers only in named views; the Constellation blooms in **beds, never stems**.
- **🌍 The World:** spaces **are** neighborhoods — joining = moving in, building a little
  house, planting your flower. The zoom ladder gets a body: Earth/season = Weather, region
  = Constellation, neighborhood = named houses. **Zoom = anonymity**: you can't see into a
  town you don't live in; sensitive spaces gate the join; a fresh joiner gets a *lobby*,
  never an instant named roster (enforced in the data layer).
- A **house's bloom is dyadic-or-aggregate only** — your tie or the room's shared health,
  never a resident's global `S_p` (the cottage carries the exact guarantee the dot did).
- **🌅 The Sunrise:** good-mornings broadcast to the *whole* neighborhood — never
  system-targeted at "who needs it" (a vulnerability roster is a predator's list). The
  lonely are warmed by membership, not by being singled out.
- **Co-op, hard line:** no scores/levels/streaks, no plant death, no guilt pings, no
  who's-wilting dashboard. Anti-reference: FarmVille. Spirit: a cozy wordless community
  garden.
- **Geography is chosen vibe, never coordinate** — pretend places (Marigold Hollow), no
  GPS, no auto-assign, no ZIP precision; real-local only as a coarse, opt-in, k-anon-gated
  flag. Physical location is the thing that gets these members hurt.

## Sustainability (doc 16)

**The member is the customer, never the product.** Three streams: a free tier that is the
*whole garden* (belonging/safety/warmth never paywalled — the community skews low-income),
patron subscriptions (cosmetics/convenience only — **never purchasable warmth**, or the
honesty model collapses), and cosmetic self-expression (no loot boxes/gacha/FOMO — gambling
mechanics are an addiction trigger and a duty-of-care red line for recovery members).

**The payment firewall 🧱:** billing identity is architecturally separated from graph
identity — no shared join key, no billing PII in the graph; the processor never learns
*which member* paid. **Instance-level funding (one bill for the whole community, à la
Mastodon) is the privacy-preferred default.** Money never becomes a name. No targeted ads,
no data sale, no profiling, ever.

## REVIEW.md — the adversarial pass

A deliberately problems-only critique (21 items, two passes). The three hardest hits each
got a dedicated answering doc:

- **Item 1** ("the warmth formula carries the whole ethical guarantee and is hand-waved")
  → **doc 11** (dyadic basis + cap/floor math + magnitude-regime theorem).
- **Item 2** ("k-anonymity is single-snapshot; you render a time series") → **doc 12**
  (seasonal cadence, buckets + hysteresis, sticky noise).
- **Item 3** ("the agent reads the most sensitive text and doc 07 never covers it") →
  **doc 13** (the stateless number-only oracle).
- **Item 9** (loss-prompt cruelty) → resolved *by deletion* via the visual-only rule.

Still open / handed off: the **steward numeric-dossier firewall** (item 4 — typed output
killed prose verdicts, but per-edge numbers on a named person still aggregate), the
People-You-May-Know outing risk (item 12), and the experience-layer red-team items.

## Phasing & open questions (doc 08)

**Build order:** Phase 0 plumbing (Neo4j + projector) → Phase 1 structural graph + raw
valence + **☀️ Weather ships first** → Phase 2 full Garden (Constellation w/ temporal
guardrails, Neighborhood, space/post health) → Phase 3 steward tier → Phase 4 agent
enrichment (off-by-default, 🚩+🌱 triggers first).
*(`SOCIAL-GRAPH.md` re-grounds this: the projector is `services/scorer`, not a new service.)*

**Open questions:** ingestion path *(answered: scorer/pgmq)*; k value per community size;
decay half-lives; agent model + budget; steward scope (global vs per-space); warmth formula
weights; tiny-community failure mode (Weather only, Constellation off); and **Q8, the one
values fork** — where may a piled-on person's "needs care" signal appear? **Selected: (A)
aggregate + stewards only** (a human reaching out beats an algorithm dimming a dot), with
(B) anonymous-area cue and (C) public individual cue kept as reversible options.

**Locked decisions (do not silently reverse):** the two tiers; two layers; hybrid valence;
one public node signal; **dyadic Neighborhood brightness**; friction quarantine; visual-only
Neighborhood; gentle lifecycle with no death-detector; temporal-anonymity stack; the
stateless agent oracle; the asymmetry principle itself.

---

*Sources: `../agora-social/docs/01–16` + `REVIEW.md`, condensed 2026-06-09. The
implementation consolidation (scorer-owns-the-graph, corp/community config tiers) is
[`SOCIAL-GRAPH.md`](SOCIAL-GRAPH.md).*
