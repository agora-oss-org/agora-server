# 🗺️ Agora Roadmap

The living index of where Agora is headed — what's designed and ready to build, what's committed
but not yet designed, and what's on the research horizon. Each item links to its real document;
this file holds **no content of its own**, only pointers + status, so it can't drift far.

> **How work flows here:** an idea is brainstormed into a **spec**
> (`docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`), the spec becomes an executable **plan**
> (`docs/superpowers/plans/YYYY-MM-DD-<topic>.md`), and the plan is executed task-by-task (TDD,
> per-task commits when authorized). When something ships it moves to `CHANGELOG.md` and drops off
> this page. Update this file whenever a spec/plan lands or ships.

_Last updated: 2026-07-18_

## 🔨 Ready to execute (spec + plan approved)

| Item | Spec | Plan |
|---|---|---|
| **Space-scoped stewards** — steward grants bound to a space: scoped caseload, scoped case-opened notifications, space-admin-managed benches, admin SPA scoping. Foundation for per-space self-governance. | [spec](docs/superpowers/specs/2026-07-17-space-scoped-stewards-design.md) | [plan](docs/superpowers/plans/2026-07-17-space-scoped-stewards.md) |
| **Store Phase 1** — per-project opt-in store: coin economy + digital cosmetics, append-only ledger, atomic purchases, equip/render contract. | [spec](docs/superpowers/specs/2026-07-17-store-marketplace-design.md) | [plan](docs/superpowers/plans/2026-07-18-store-phase1.md) |

## 🧭 Committed follow-ons (design owed, seams already reserved)

- **Space self-governance, phases 2–3** — the per-space opt-in flag gating bench management, then
  **elections** (members electing their stewards/moderators; terms, quorums). Both build on the
  space-scoped-stewards foundation's `grantProjectRole` seam — see that spec's §9 for the reserved
  seams. A possible phase 4 generalizes the `StewardScope` pattern to space-scoped views of the
  other admin tabs (dashboard/moderation/settings).
- **Store Phase 2** — the real-money rail: coin top-ups + fulfilled physical merch. Same spec as
  Phase 1 ([design §Phase 2](docs/superpowers/specs/2026-07-17-store-marketplace-design.md)).
- **Store follow-ons** — the admin SPA **Store tab** (spec §3.7; plans separately once the Phase 1
  API lands), SDK `useStore*` hooks + demo Store tab (sibling-repo cycles), and the reserved
  `item-back-in-stock` / `stipend-available` notification kinds (deferred in the
  [Phase 1 plan](docs/superpowers/plans/2026-07-18-store-phase1.md) → "Deliberately NOT in this plan").
- **Stewardship "Watch"** — proactive harm-pattern spotting, the 🔜-marked tier of
  [STEWARDSHIP.md](docs/STEWARDSHIP.md) (the caseload + mediation channels are live).
- **Secure-chat diag harness** — shared `traceparent` correlation id + `chat-diag` emitting the
  normalized event schema natively: [SECURE-CHAT-DIAG-HARNESS.md](docs/SECURE-CHAT-DIAG-HARNESS.md).

## 📚 Design backlog (proposals, not yet committed)

- **[PROPOSED.md](docs/PROPOSED.md)** — server changes surfaced by the `agora-demo` compatibility
  harness, tagged by contract impact (🟢 compat / 🟡 additive / 🔴 hard divergence). Several sections
  have since shipped (see its in-file status banners); the rest remain the contract-facing backlog.

## 🔬 Research horizon

- **[PRIVACY-ROADMAP.md](docs/PRIVACY-ROADMAP.md)** — the tier above
  [PRIVACY-POSTURE.md](docs/PRIVACY-POSTURE.md): can the square be made **operator-blind**, not just
  world-invisible? Nothing committed; maps the exotic-crypto candidates and the one bet worth
  prototyping.

## 🕳️ Known gaps (accepted or minor, tracked in CLAUDE.md → Status)

- `@mention` link-resolution/validation endpoint unimplemented (tokens stored + fan-out fires).
- RLS **write** policies unset — accepted: the server is the trust boundary
  ([SECURITY.md](docs/SECURITY.md)).
- Live-credential E2E tests (Supabase auth/Storage/Voyage/Anthropic) are opt-in, skipped in CI.

## 🏘️ Ecosystem (tracked elsewhere)

- **Managed hosting** — per-tenant runtime routing builds in the private `../agora-hosting` repo on
  the server's hosting-enablement seam (`setDbResolver`/`AGORA_BOOT_MODULE` — see
  [the seam design](docs/superpowers/specs/2026-07-06-hosting-enablement-seam-design.md)). This repo
  stays single-tenant.
- **SDK** (`../agora-sdk`) and **demo harness** (`../agora-demo`) have their own cycles; server-side
  obligations from SDK syncs arrive as `docs/SDK-V*-SERVER-SPEC.md` files.
