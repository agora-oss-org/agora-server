# Demo Read-Only Admin (Settings-Locked Operator) — Design

> **Status:** approved in design review (2026-07-17). Scope: `packages/core` + `apps/api` +
> `apps/admin` (one line) + env templates + docs.
> **Relation:** independent of the auth-wall change; both ship under the same `[Unreleased]`.

## Problem

The public demo of Agora needs to show off the **full admin/operator surface** — the god-view
dashboard, every settings panel, moderation, social analytics — to prospective users who log in with
a shared, publicly-known demo account (`demo-admin@agora-oss.org` / `DemoAdmin123!`). But that account
must not be able to **persist configuration changes**: a visitor mustn't be able to re-rank the feed,
rewrite the moderator thresholds, or repoint the webhook for everyone.

The admin app already renders Settings as view-only when built with `VITE_SETTINGS_READ_ONLY=true`, but
that is a **client-side, deployment-wide** flag — it disables Save buttons in the browser and applies to
*every* logged-in user on that deployment, including the real operator. It is neither enforced on the
server nor scoped to the demo identity. A demo visitor who bypasses the UI (calls the API directly, or
the real operator sharing the deployment) is not covered.

## Decision

Add a **server-enforced, per-identity** read-only cap scoped to the **settings-save surface only**. The
demo account gets full operator authorization (so it can *see* everything) plus a `settingsReadonly`
flag that makes the five config-persisting endpoints return `403` for that identity — and no one else.

**Scope is deliberately narrow (settings saves only).** The demo account can still behave like a normal
operator everywhere else: browse all data, run the two non-destructive *actions* (send a webhook test
ping, force a constellation recompute) so those features can be demonstrated, and — because the wall
governs reads, not this cap — do ordinary member writes (post, comment, react). This cap is about *not
letting a shared demo login rewrite the project's configuration*, nothing more.

## Design

### Mechanism — an allowlist-minted JWT claim (mirrors `isOperator`)

The access token carries no email, so identifying the demo account per-request would cost a DB lookup on
every call. Instead we mirror exactly how the operator flag already works: an env allowlist resolved
once at token-mint time into a boolean claim, read back from the verified token at zero per-request cost.
Fail-closed, and the entire read-only surface is one greppable allowlist.

- **New env var `SETTINGS_READONLY_EMAILS`** — comma-separated, case-insensitive emails; empty/unset ⇒
  feature off (no read-only principals). Added to the core env schema (`packages/core`) as **optional**,
  validated like the other allowlists (empty string treated as unset).
- **`isSettingsReadonly(profile)`** — a small resolver beside `lib/operators.ts` (`apps/api`), parsing
  `SETTINGS_READONLY_EMAILS` the same way `isOperator` parses `OPERATOR_EMAILS`. (Email-only; no user-id
  variant needed — the demo account is addressed by email.)
- **Mint:** `profileAuthBits` computes `settingsReadonly: isSettingsReadonly(p)` and threads it through
  `signAccessToken` / `mintSession` (`apps/api/src/lib/tokens.ts`) as a new claim **`settingsReadonly`**.
  Effective on the principal's next token refresh, exactly like the operator/owner/steward flags.
- **Read back:** core `middleware/auth.ts` reads the claim into **`c.var.auth.settingsReadonly: boolean`**;
  the field is added to core's `AuthContext` type (the single source both packages consume).
- **Guard:** new **`assertSettingsWritable(c)`** (`apps/api`, beside the project-role guards) throws
  **`403 settings/read-only`** when `c.var.auth.settingsReadonly` is true; a no-op otherwise. Called
  **immediately after `requireProjectAdmin(c)`** in each guarded handler, so the identity is always an
  admin/operator first and the read-only cap is the final, narrowest gate.

### The locked settings surface (5 config-persisting saves)

Every one of these handlers today opens with `await requireProjectAdmin(c);`. The guard slots in on the
next line. These are exactly the panels' **Save** actions:

| # | Endpoint | Handler file | Backs |
|---|---|---|---|
| 1 | `PATCH /settings/feed` | `apps/api/src/routes/misc.ts` | Feed ranking panel |
| 2 | `PATCH /settings/moderator` | `apps/api/src/routes/misc.ts` | Moderator panel |
| 3 | `PATCH /settings/steward` | `apps/api/src/routes/misc.ts` | Stewardship panel |
| 4 | `PATCH /settings/social` | `apps/api/src/routes/social.ts` | Social graph panel |
| 5 | `PATCH /webhooks/config` | `apps/api/src/routes/misc.ts` | Webhooks panel |

**Explicitly NOT locked** (non-destructive actions, allowed so the demo can exercise them):
`POST /webhooks/test` (pings the already-saved URL; the URL itself can't be changed) and
`POST /admin/social/constellation/recompute` (re-materializes a snapshot from existing data).

### Frontend alignment (one line)

The UI must match the new backend contract — the two allowed actions stay clickable in read-only mode:

- `apps/admin/src/routes/settings/SocialGraphPanel.tsx` — the **Recompute constellation** button is
  currently `disabled={recompute.isPending || SETTINGS_READ_ONLY}`. Remove `SETTINGS_READ_ONLY` so the
  action stays available under view-only.
- The **Send test ping** button (`WebhooksPanel.tsx`) is already `disabled={!enabled || test.isPending
  || save.isPending}` (never gated by `SETTINGS_READ_ONLY`) — no change.
- The five Save buttons remain disabled under `SETTINGS_READ_ONLY` — unchanged.

The client `VITE_SETTINGS_READ_ONLY` flag stays a separate, deployment-wide concern; this design does
not couple to it. The server cap is per-identity and is the real enforcement.

### Demo-admin becomes a full operator (config only)

Operator status is env-granted (`OPERATOR_EMAILS` / `OPERATOR_USER_IDS`), not seedable. So the demo
account is made an operator purely by configuration — add `demo-admin@agora-oss.org` to **both**:

- `OPERATOR_EMAILS` — grants the operator god-view (all spaces, deployment cards, analytics).
- `SETTINGS_READONLY_EMAILS` — applies the settings-save lock on top.

in the env templates (`.env.dev.example`, `.env.selfhost.example`). The account's existing `seed.json`
`roles:["owner"]` grant stays (redundant but harmless under operator; leaving it avoids churn and keeps
the account meaningful if operator status is ever removed).

### Rename `agora-admin@agora-oss.org` → `agora-admin@agora-oss.org`

The default seeded-admin email moves onto the project's own domain. **Live surfaces only:**

- `.env.dev.example`, `.env.selfhost.example` (`OPERATOR_EMAILS`, `AGORA_DEMO_EMAIL`).
- The seed scripts: `apps/api/scripts/seeds/00-seed-auth-admin.mjs` (`DEMO_EMAIL`), the ~15
  `seed-*-post.mjs` / `04-seed-homepage-comments.mjs` `DEMO_EMAIL` defaults, and
  `helpers/seed-supabase-auth-admin.mjs`.
- Docs describing the *current* default: `CLAUDE.md`, `docs/SELF-HOSTING.md`, `docs/DEVELOPMENT.md`,
  `apps/admin/README.md`, `apps/api/README.md`.

**Excluded (do not rewrite):**
- Shipped `CHANGELOG.md` history and `docs/superpowers/plans/2026-07-01-env-config-cleanup.md` — these
  are historical records; they described the default accurately as of their date.
- **`docs/PENTEST.md` — repo owner's file; never touched by this work.** Its line 346 will continue to
  reference the old email; updating it is the owner's call.

The rename does not affect existing deployments (their real `.env` is already set); only the template
default and fresh seeds change. Non-breaking.

## Testing

Security-relevant ⇒ negative cases are the priority (per CLAUDE.md → "Test what deserves testing").

**Unit** (`packages/core` and/or `apps/api`, no DB):
- `isSettingsReadonly` allowlist parse: matches (case-insensitive, whitespace-trimmed), non-matches,
  empty/unset ⇒ everyone writable. Mirror the existing operators test.
- `assertSettingsWritable`: throws `403 settings/read-only` when the flag is set; no-op when unset.

**Integration** (`test/integration/**`, real Postgres):
- For **each** of the 5 locked endpoints: a token minted with `settingsReadonly` → `403 settings/read-only`;
  an operator token without the flag → success. Assert per-route.
- **Scope proof (negative-of-the-negative):** the same `settingsReadonly` principal succeeds on
  `POST /webhooks/test`, `POST /admin/social/constellation/recompute`, and at least one ordinary
  member write (e.g. create an entity) — proving the cap is settings-saves-only, not global.
- The integration `signToken` helper gains an optional `settingsReadonly` flag so tests can mint the
  principal (mirrors the existing operator/pid plumbing).

## Docs & propagation

- Core env schema + both `.env.*.example` templates gain `SETTINGS_READONLY_EMAILS` (documented inline,
  defaulting to the demo account). Run `pnpm check:propagation --diff <ref>` / `/propagate` to fan the
  new env var + the email rename across all mirrors (`docs/PROPAGATION.yaml`, wiki, compose if tracked).
- **MANIFEST**: note that the five settings-save endpoints return `403 settings/read-only` for a
  read-only principal (one line in the settings/admin section).
- **SECURITY.md**: a short bullet — the settings-readonly principal as defense-in-depth for shared demo
  logins (server-enforced, per-identity, additive; no regression).
- **CHANGELOG `[Unreleased]`**: `Added` — `SETTINGS_READONLY_EMAILS` + the settings-locked demo operator;
  `Changed` — default seeded-admin email renamed to `agora-admin@agora-oss.org`.

## Out of scope

- Global (all-endpoints) read-only — not wanted; the cap is settings-saves only by decision.
- Coupling the server cap to the client `VITE_SETTINGS_READ_ONLY` flag — they stay independent.
- A user-id allowlist variant (`SETTINGS_READONLY_USER_IDS`) — email-only suffices for the demo account;
  add later if a deployment needs it.
- Updating `docs/PENTEST.md` — owner's file.
