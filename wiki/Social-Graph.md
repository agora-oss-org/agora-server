# Social Graph — "the Garden"

Every platform mines the social graph *at* the user — to target, rank, and sell them. Agora points the
same structure **back at the community, for the community**, in service of its health. It's an
**optional, off-by-default** layer: wire up a Neo4j instance (`NEO4J_URI`) and the Garden comes alive;
leave it unset and nothing in the graph layer runs (every `/social/*` endpoint cleanly 503s and the
admin panels stay hidden).

> Full design, ethics, and threat model:
> [`docs/SOCIAL-GRAPH.md`](https://github.com/agora-oss-org/agora-server/blob/root/docs/SOCIAL-GRAPH.md)
> (the consolidation plan) and
> [`docs/AGORA-SOCIAL.md`](https://github.com/agora-oss-org/agora-server/blob/root/docs/AGORA-SOCIAL.md)
> (the condensed design corpus).

## The asymmetry principle

Agora's communities skew **trans, queer, sex-worker, and recovery** — for them graph exposure is a
doxxing/outing vector, and mass-reporting is the primary harassment tactic. So every rule bends toward
one non-negotiable:

> **Every possible misreading must land on *kindness*, never a scarlet letter.** Friction only ever
> *dims* a node; it never reddens it.

- **One public signal: warmth.** Loneliness and conflict both render as *dim* — indistinguishable on
  purpose, because both mean "bring care here." There is no per-person "bad actor" score, in any view.
- **A zoom ladder that is a privacy ladder.** ☀️ **Community Weather** (one project-wide warmth scalar
  with band + trend) → 🏡 **Neighborhood** (your *own* ties only, each rendered by its **dyadic**
  brightness — never the friend's global score, which closes the friction side-channel). *(✨
  Constellation — anonymous cluster blobs — is designed and next.)*
- **Friction is quarantined and decays.** A user report projects a directed `FRICTION` edge that can
  only *dim* an existing tie and fades at a ~14-day half-life; it never creates a tie, and never becomes
  a per-person verdict.
- **One graph, opposite deployments.** The same structure serves a vulnerable-population community and a
  corporation's internal platform, resolved by a per-project `social_config` **tier** (community ↔
  corporate, admin Settings → Social Graph), not by picking a side.

## How it's wired

The **scorer** owns the write side (it projects `INTERACTED` / `FOLLOWS` / `CONNECTED` / `FRICTION`
edges into Neo4j off the same pgmq queue it scores content on — see [[Governance]]), and `@agora/api`
owns the read side (`/v7/:projectId/social/*`, member/operator-gated, computed live or cached with band
hysteresis).

## Backing store

The graph runs on **DozerDB** (a patched Neo4j Community build that re-enables multi-database) with
OpenGDS. Setup — plugins, memory tuning, TLS, and the `NEO4J_DATABASE` selector — is in
[`docs/DOZERDB.md`](https://github.com/agora-oss-org/agora-server/blob/root/docs/DOZERDB.md). Enable the
subsystem with `--profile scorer` (see [[Deployment]]).

## Corporate profile

The corporate-deployment positioning (privacy tiers, what it refuses to do) is in
[`docs/AGORA-CORP.md`](https://github.com/agora-oss-org/agora-server/blob/root/docs/AGORA-CORP.md).
