# Governance

Most community backends ship content primitives and leave *governance* to you. Agora makes it **core
surface area** — endpoints, schema, and admin UI in the box, enforced at the server trust boundary.
There are two distinct layers: **moderation judges content; stewardship tends people and relationships.**

## Moderation

- **Report queues** for entities, comments, and chat messages, with resolution.
- **Server-enforced removed-content hiding** — a removed row is omitted from every list, 404'd on single
  reads, and filtered inside the semantic-search RPC; operators bypass to review. See [[Security]].
- **Roles** — space-scoped moderator roles plus a project-wide operator god-view, and DB-backed
  per-project owner/admin grants.
- **AI Agent Moderator** — the Python `services/scorer` subsystem assesses all new content: two RoBERTa
  classifiers gate a Claude Haiku adjudication, and content is either **auto-hidden** or **flagged for
  human review** depending on the score (configurable categories, confidence thresholds, and
  auto-actions, tuned per-project in admin Settings). A `moderation_analyses` audit trail and an
  operator-gated AI-flag queue back the admin AI tab.

The scorer architecture (pipeline, write-back, resource sizing) is documented in
[`docs/SCORER.md`](https://github.com/agora-oss-org/agora-server/blob/root/docs/SCORER.md) and
[`docs/SCORER-REQUIREMENTS.md`](https://github.com/agora-oss-org/agora-server/blob/root/docs/SCORER-REQUIREMENTS.md).

## Stewardship

A distinct **conflict-resolution** layer — restorative, not punitive — powering the admin **Steward** tab.

- A DB-granted **steward** role between member and operator (route-scoped to the caseload; stewards do
  *not* inherit the operator's global read bypass).
- A **caseload** that moves a dispute (complainant ↔ respondent over some content) through
  `open → in_mediation → closed` with **transformative-ordered outcomes** (repair → separation →
  protection → escalation).
- An **asymmetry / "targeting"** flag for power-aware, anti-false-balance handling.
- **Private mediation channels** built on the existing chat — a 1:1 *caucus* with each party, or a
  consensual *joint room* (never for a targeting case).
- **Configurable participant notifications** (power-aware / symmetric / resolution-only) that keep
  parties informed **without ever leaking who raised a case**.
- An append-only case timeline, and **escalate-to-removal** that takes the subject content down through
  the normal moderation path.

Full design:
[`docs/STEWARDSHIP.md`](https://github.com/agora-oss-org/agora-server/blob/root/docs/STEWARDSHIP.md).

Both layers live behind the same `/v7/:projectId/...` contract and in the Postgres schema, so they're
available to every client from day one.
