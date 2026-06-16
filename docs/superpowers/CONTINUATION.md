# agora-server — Continuation (managed-hosting work)

> **Resume point after compaction, server side.** This tracks the `agora-server` code
> for the managed-hosting initiative. Initiative-level context (tiers, seam principle,
> the A–G decomposition) lives in `../agora-hosting/docs/STATUS.md`. Last updated
> 2026-06-16 (end of sub-project A).

## One-line context

Agora is going SaaS. Rule: **authorization/mechanism lives here in the open AGPL server;
the profit engine (billing/control-plane) lives in the closed `../agora-hosting` repo.**
All executable work so far is in THIS repo, on branch `root` (solo dev, no feature
branches — commit in place).

## Sub-project A — DONE ✅ (auth-provider abstraction + native auth)

Spec: `docs/superpowers/specs/2026-06-16-auth-provider-abstraction-design.md`.
Why: the shared hosting tier needs per-tenant identity, which Supabase Auth can't give
on one shared instance (unique email per SB project). So auth went behind a provider
interface: `supabase` (default, unchanged) vs `native` (Agora-owned credential store).

### Code map (all under `apps/api/src/lib/auth/`)
- `provider.ts` — `AuthProvider` interface + `SignUpResult`. The credential boundary;
  route still owns profile/session work (`ensureProfile`, `mintSession` — unchanged).
- `supabase-provider.ts` — wraps the old Supabase Auth calls verbatim. **Default.**
- `native-provider.ts` — argon2id (`@node-rs/argon2`); `auth_credentials` /
  `auth_email_tokens`; `unique(project_id, email)` with `normalizeEmail` (lowercase, no
  citext); hashed single-use expiring tokens consumed via atomic `UPDATE … WHERE
  consumed_at IS NULL RETURNING`; tenant isolation by join on `project_id`; anti-enum
  (existing-email signup runs a throwaway hash to equalize timing); token hygiene
  (delete prior unconsumed on reissue); sets `updated_at` on credential mutations.
- `password.ts` / `email-token.ts` — argon2id wrappers / random+sha256 tokens.
- `email/sender.ts` — `EmailSender` + `ConsoleEmailSender` (dev) + `setEmailSender()`
  test seam + `confirmLink`/`resetLink` (`AUTH_EMAIL_LINK_BASE`).
- `index.ts` — `getAuthProvider(projectId)` (30s cache, fail-safe `supabase`) +
  `invalidateAuthProvider()`.

### Touch points outside lib/auth
- `routes/auth.ts` — credential handlers call the provider; **new `POST /auth/reset-password`**
  (`{token,newPassword}`). `/sign-out`, `/request-new-access-token`, `/verify-external-user`
  untouched. Supabase import removed.
- `db/schema/auth.ts` — `authCredentials`, `authEmailTokens`. `db/schema/projects.ts` —
  `projects.auth_provider` enum. `db/schema/_shared.ts` — `authProvider`/`authEmailTokenKind` enums.
- Migrations **0041** (tables), **0042** (`updated_at`), **0043** (RLS deny-all).
- `packages/contract/src/schemas.ts` — `resetPasswordSchema`, `email().max(254)`.

### Status: green
`pnpm -r typecheck` ✓ · 255 unit tests ✓ · `test/integration/native-auth.test.ts` 8/8 ✓
(real Postgres, incl. cross-tenant isolation). Default `supabase` ⇒ no regression.

### Verify / run
```bash
pnpm -r typecheck
pnpm --filter @agora/api test
# native-auth integration (note TMPDIR avoids macOS /tmp ENOSPC):
TMPDIR="$HOME/.cache/agora-tmp" pnpm --filter @agora/api exec \
  vitest run -c vitest.integration.config.ts native-auth.test
# manual: UPDATE projects SET auth_provider='native' WHERE id=…; sign-up; read confirm
# link from logs at LOG_LEVEL=debug (ConsoleEmailSender); verify-email; sign-in.
```

## ⚠️ Migration-journal gotcha (READ before adding any migration)

`scripts/migrate.mjs` (= `db:migrate:run`, also the integration `global-setup`) is
drizzle-orm `migrate()`: it gates each journal entry on a single `max(created_at)`
**watermark** and does NOT dedupe by hash. The journal is **non-monotonic** — `0039`'s
`when` is ~17h *after* `0040`, so `0040` (`social_constellation`) gets **silently
skipped** on DBs already at `0039`. Consequence: `0040` is applied on the **dev DB** but
**absent on the cloud test DB** → `test/integration/social-constellation.test.ts` fails
(500). **This is pre-existing and unrelated to auth work — do NOT try to fix it by
bumping 0040's timestamp** (0040 is already applied on dev → destructive re-apply). It
needs the constellation owner to make 0040 idempotent or hand-fix `__drizzle_migrations`.

**Rule:** any NEW migration's journal `when` must be **greater than the current max
`when`** (not just the prior idx), or it skips on migrated DBs. Auth 0041–0043 were
bumped to ...937/938/939 above the 0039 watermark (commit `9c7afb4`). Full detail in
memory `drizzle-journal-timestamp-skip`.

## Carry-over follow-ups (minor)
1. Unit tests for `getAuthProvider` factory + `ConsoleEmailSender` redaction.
2. `SupabaseAuthProvider.signUp` surfaces GoTrue `error.message` (pre-existing partial
   enumeration on the Supabase path; native is clean).
3. `signInSchema.email` could also get `.max(254)`.
4. Production `EmailSender` transport (Resend/SES/Postmark) — interface ready.
5. Open spec Q: distinguish native vs Supabase password in `profiles.auth_methods`?

## ⏭️ NEXT — Sub-project B: per-project role system (server-side, AGPL)

Goal: replace the deployment-wide env `isOperator` with proper per-project roles.

- **New `project_roles` table**, generalizing the existing `project_stewards` grant:
  `project_id, profile_id, role enum('owner','admin','steward'), granted_by, granted_at,
  unique(project_id, profile_id, role)`. Patterns to mirror: `lib/stewards.ts` +
  `project_stewards` (the steward grant), `lib/social-config.ts` (cache).
- **JWT claims**: stamp `isProjectOwner`/`isProjectAdmin` at mint/refresh in
  `lib/tokens.ts` (next to existing `isSteward`/`operator`); read in `middleware/auth.ts`
  → `c.var.auth.*`. Effective on next token refresh.
- **The crux = the `isOperator` audit**: grep every `isOperator` use and classify
  cross-tenant (stays *platform-operator*) vs within-project (becomes
  `isProjectOwner`/`isProjectAdmin`). Security-critical; assert negatives.
- **Grant endpoints** (route-scoped): owner grants admin/steward + transfers owner;
  platform-operator anything; admin/steward grant nothing.
- Migrate `steward` from `project_stewards` → `project_roles` (or keep as a view — decide
  in B's spec). New migration `when` must exceed the journal max (gotcha above).
- When an admin endpoint can flip `projects.auth_provider`, call
  `invalidateAuthProvider(projectId)` on write.

**Approach:** `superpowers:brainstorming` → spec in `docs/superpowers/specs/` →
`superpowers:writing-plans` → `superpowers:subagent-driven-development` (same as A).

## Pointers
- A spec: `docs/superpowers/specs/2026-06-16-auth-provider-abstraction-design.md`
- Plan: `~/.claude/plans/effervescent-floating-pearl.md`
- Initiative umbrella: `../agora-hosting/docs/STATUS.md`
- Memory: `managed-hosting-initiative`, `drizzle-journal-timestamp-skip`
- Reference patterns: `routes/entities.ts`, `lib/stewards.ts`, `lib/tokens.ts`,
  `middleware/auth.ts`, `test/integration/helpers.ts`.
