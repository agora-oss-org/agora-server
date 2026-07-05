# `agora` — the on-box operator CLI & terminal dashboard

> **Status:** design / not yet built. This document is the agreed design for the `agora` CLI —
> a single Go binary that makes operating a self-hosted Agora deployment *feel good*.
> Scope, architecture, and v1 surface below are settled; implementation follows in `cli/`.

## What this is

`agora` is a **single Go binary, run on the deployment host**, that turns operating a self-hosted
Agora into a delightful terminal experience: a live dashboard plus command control over the Docker
Compose deployment, host diagnostics, database backups, and a thin slice of API-backed admin.

It is **glitter and sparkle, not load-bearing.** Everything it does, you could also do by hand —
through the web admin app, `docker compose`, `psql`, or the existing `apps/api/scripts/*.mjs`. If the
binary vanished, the deployment runs unchanged. The CLI is *additive*: it never becomes something a
running Agora depends on.

**Division of labor — deliberate:**

- **Remote / serious admin → the web admin app** (`@agora/admin`). Multi-tenant ops, moderation
  queues, role management at scale, dashboards. That's the real ops surface, reachable from anywhere.
- **On-box console → this CLI.** You're SSH'd into (or sitting at) the box running the deployment and
  you want diagnostics, container control, backups, logs, and a pretty live dashboard — without
  remembering which `.mjs` script and which env var.

The **SDK developer CLI is a separate project** (lives in the SDK repo) and is explicitly out of
scope here. This document is the *operator* CLI only.

## Why Go (and not TypeScript)

The repo is otherwise TypeScript + Python, so Go is a third general-purpose language and a new CI
lane. We're accepting that cost deliberately, because the tool's identity is an **on-box live
dashboard + host/docker console**, and for that identity Go wins on the things that matter:

- **Single static binary.** A Docker Compose host does not have Node installed — Agora's own deploy
  doesn't require it. A TS CLI would mean shipping Node + `node_modules` onto the production box just
  to run the dashboard. The Go binary is `curl -L … > /usr/local/bin/agora` and nothing else.
- **Bubbletea + Lipgloss** are the gold standard for a dense, live, multi-panel TUI (streaming
  `docker stats`, tailing logs, sparklines). Ink (React-in-terminal) flickers under high-refresh
  dense layouts where Bubbletea's targeted redraws don't.
- **Goroutines** fan out cleanly across docker-stats + log-tails + host probes.

**The cost we accept, and how it's bounded:**

- **No shared kernel.** The CLI cannot import `@agora-server/contract` or `@agora/core`. It does not
  need the whole contract — only the **operator subset** it actually renders (~10 response structs:
  projects, roles, health). These are **hand-modeled** in v1. Drift detection therefore moves from
  compile-time (a TS CLI would break the build) to **runtime** (a Go decode error) — mitigated by an
  `agora doctor contract` smoke check. Codegen (zod → OpenAPI → Go structs) is a *later* nicety, not
  v1.
- **No script reuse… except we shell out.** The dangerous DB tier (`migrate`, `seed`, `genesis`) is
  *not* reimplemented in Go — the CLI **shells out to the existing, tested `apps/api/scripts/*.mjs`**.
  Go orchestrates; Node still does the DB work. Go only *owns* the TUI, host probes, the container
  driver, the backup logic, and the ~10-struct API client.

## Targeting model — on-box only (v1)

The binary assumes it runs **on the same host** as the Compose deployment. It reads:

- the local **`docker.sock`** (container driver),
- this machine's **mem / disk / cpu** (host probe),
- the repo's **`docker-compose.yml`** + **`.env`** (resolved from the working directory / repo root),
- the API at **`localhost:<port>`** with an operator token.

**No remote, no SSH, no `--context` in v1.** Remote administration is the web app's job. (If a remote
target is ever wanted, it slots behind the same provider interfaces — see Architecture — but it is
explicitly not a v1 goal and we are not building the seam speculatively.)

## Architecture — one spine, two front-ends

The dashboard and the commands are fed by the **same providers**, so they can never drift. A
capability module contributes *both* a command tree and a dashboard panel.

```
                     ┌─────────────────────────────────────────────┐
   front-ends        │   Cobra dispatcher        Bubbletea TUI       │
                     │   `agora <topic> <cmd>`   `agora` / dashboard │
                     └───────────────┬───────────────┬──────────────┘
                                     │   (same modules, same data)   │
                     ┌───────────────┴───────────────────────────────┐
   capability        │  doctor   dashboard   host   db   ops   …more  │
   modules           │  each registers: command tree + dashboard panel│
                     └───────────────┬───────────────────────────────┘
                                     │   (only modules touch providers)
                     ┌───────────────┴───────────────────────────────┐
   providers         │ containerDriver   hostProbe   apiClient   pg   │
   (touch the world) │  (Compose now,                                 │
                     │   Swarm later)                                 │
                     └────────────────────────────────────────────────┘
```

### Providers — the only things that touch the outside world

| Provider | Responsibility | v1 impl | Future |
|---|---|---|---|
| `containerDriver` | list/inspect/health/stats/logs/lifecycle of services | **Compose** (via `docker compose` + `docker.sock`) | **Swarm** behind the same interface |
| `hostProbe` | mem / disk / cpu / uptime of this machine | `/proc`, `gopsutil` | — |
| `apiClient` | operator-token client over `localhost/v7`; ~10 hand-modeled operator-subset structs | hand-modeled structs | codegen from contract (zod→OpenAPI→Go) |
| `pg` | localhost Postgres: `pg_dump` for backups; connection for the shelled `.mjs` | `pg_dump`/`psql` + `DATABASE_URL` | — |

The `containerDriver` interface is the key to **Compose-now / Swarm-later** — nothing above it knows
which substrate is underneath. This mirrors the server's own provider seams (storage, auth).

### Capability modules

Each module is self-contained and registers two things: a **Cobra command tree** and a **Bubbletea
dashboard panel**. Adding a capability = drop in a module; it lights up in both front-ends. This is
the "expands to whatever we dream up" property — alerts, a `secure-chat` panel, scorer/Neo4j health,
etc. are all just future modules, no architectural change required.

## v1 capability scope

Because the **web app owns real ops**, v1 is weighted toward *diagnostics + host control + the
dashboard + backups*, with `ops` kept intentionally thin.

| Module | v1 commands | Notes |
|---|---|---|
| **`doctor`** ⭐ | `agora doctor` | The flagship preflight. Checks: docker/compose present + versions; which Compose profiles are up; per-container health; API `/health` reachable; DB reachable; host mem/disk/cpu headroom; **unapplied DB migrations** (drizzle journal vs what's applied — see below). Optional `agora doctor contract` smokes the API response shapes against the hand-modeled structs (drift guard). Pretty pass/fail report. |
| **`dashboard`** ⭐ | bare `agora`, or `agora dashboard` | The centerpiece. Live Bubbletea TUI: container health & `stats`, host resources (sparklines), API health, a tail of recent logs. |
| **`host`** | `host ps`, `host stats`, `host logs <svc>`, `host up/down/restart [--profile]` | Thin, pretty wrapper over the `containerDriver` (Compose). Lifecycle commands respect the two-axis profile model. |
| **`db`** (fenced) | `db backup`, `db migrate`, `db seed`, `db genesis` | **Fenced & confirm-gated** — this tier bypasses the server. `backup` = `pg_dump` (+ optional storage/MinIO bucket) to a local destination. `migrate`/`seed`/`genesis` **shell out to the existing `apps/api/scripts/*.mjs`**. |
| **`ops`** (thin) | `projects ls`, `roles ls/grant/revoke` | Just enough to be handy on-box; the web admin remains the real ops surface. Uses the `apiClient` + operator token. |

### Backups (v1)

`agora db backup` is in v1 (self-host need). It runs `pg_dump` against the local `DATABASE_URL` and,
optionally, snapshots the storage bucket (MinIO/S3) when `STORAGE_PROVIDER=s3`. Destination is a local
path in v1; remote/scheduled backups are a future enhancement (not v1).

### Migrations are a *manual* step (why `doctor` checks for drift)

Migrations do **not** run on API startup. The `agora` service's container command is just
`node dist/index.js` (`apps/api/Dockerfile`) — there is no migrate-on-boot in `src/index.ts`. Applying
migrations is an explicit, separate step, documented only as a comment in the compose files:

```bash
docker compose run --rm agora node scripts/migrate.mjs   # migrations (self-host / every deploy)
```

The consequence: a code deploy can **outrun the schema**. If you pull a new image but forget to run
`migrate.mjs`, new code that reads a not-yet-added column will `500` (e.g. a `select *` row missing a
column the shaper reads → `KeyError` → bare `Internal Server Error`), and **restarting the API does not
fix it** — restart re-runs the same unmigrated schema. This is precisely why `agora doctor` flags
pending migrations (drizzle journal vs applied) and why `agora db migrate` exists as a first-class,
one-command wrapper: catch the drift in preflight, apply it without hunting for the buried compose
comment.

### Fencing the `db` tier

Mirrors the server's own posture (deployment powers vs within-project powers). The `db` commands are
visibly dangerous: they require `DATABASE_URL`, print exactly what they will do, and confirm before
acting (`--yes` to skip in scripts). `migrate`/`seed`/`genesis` never reimplement logic — they invoke
the corresponding `.mjs` so there is a single source of truth for those operations.

## Layout & distribution

- **Lives in `cli/`** as its own Go module (`cli/go.mod`) inside this repo, with its own CI lane. It
  is tightly coupled to *this* repo's `docker-compose.yml`, `.env`, and `apps/api/scripts/*.mjs` — it
  is **not** an arms-length consumer like the SDK/demo, so in-repo is correct (it is not subject to the
  "three separate repos on purpose" rule, which exists to keep the SDK harness arms-length).
- **Stack:** Go + [Cobra](https://github.com/spf13/cobra) (commands) + [Bubbletea](https://github.com/charmbracelet/bubbletea) + [Lipgloss](https://github.com/charmbracelet/lipgloss) (TUI) + `gopsutil` (host probe).
- **Build:** `go build ./cli` → one static binary. A `Makefile` target and `goreleaser` (cross-compiled
  release binaries) come later.
- **Config:** near-zero in v1. The CLI resolves `docker-compose.yml` + `.env` from the working
  directory / repo root and reads `DATABASE_URL` + the API port + an operator token from the
  environment (or `.env`). No `~/.agora/config` needed for the on-box single-deployment case.

## Security posture

- **On-box trust model.** The CLI inherits the host's trust boundary — whoever can run it already has
  shell on the deployment box (and thus `docker`, `psql`, the `.env`). It grants no privilege a shell
  user doesn't already have.
- **Operator token, never minted blindly.** The `ops` tier uses an operator JWT read from the
  environment; the CLI does not hand-roll auth or mint tokens from secrets it shouldn't hold.
- **No secret leakage.** Following the repo's logging posture: never print `.env` secrets — report a
  variable's presence/length, not its value. `doctor` output names *what* is misconfigured, not the
  secret itself.
- **The `db` tier is fenced** (confirm-gated, `DATABASE_URL`-required) precisely because it bypasses
  the server trust boundary. Destructive operations confirm before acting.

## Testing

- **Pure logic** (doctor check evaluation, report formatting, profile parsing, struct decoding) gets
  Go unit tests (`*_test.go`), mirroring the server's "test what deserves testing" principle.
- **Provider boundaries** are interfaces, so modules are tested against fakes (a fake `containerDriver`
  / `hostProbe` / `apiClient`) with no Docker or DB required.
- **The contract smoke** (`agora doctor contract`) is the runtime drift guard against the hand-modeled
  operator structs.

## Future / "dream up" list (explicitly not v1)

Each is just a future capability module or provider — no architectural change required:

- **Guided setup — "Option C" (generator / task-runner).** A `make setup` (or `node
  scripts/env-init.mjs`, or an `agora setup` capability module) that asks/takes `--mode`, generates a
  correct `.env` with secrets auto-filled (`openssl rand`), and a `make dev|selfhost|prod` that runs
  the right compose + profile command for you. The matrix knowledge lives in one generator.
  - *Pros:* best adoption UX — "run `make setup`, answer one question, you have a valid env + the right
    up command." Eliminates hostname/placeholder mistakes entirely and wraps the destructive-op guard.
  - *Context:* this is the deferred alternative from the env-config cleanup design
    ([`docs/superpowers/specs/2026-07-01-env-config-design.md`](superpowers/specs/2026-07-01-env-config-design.md)),
    which shipped **Option A** first (three complete per-mode `.env.*.example` templates + a `cp`
    workflow + an `AGORA_ENV` marker and destructive-script guard). Option A was designed so this
    generator can layer on top later **without rework** — it reads the same templates/marker rather
    than replacing them.
- **Swarm** container driver (behind the existing `containerDriver` interface).
- **Codegen** of the operator structs (zod → OpenAPI → Go) to restore compile-time-ish drift safety.
- **Alerts / thresholds** (disk low, container unhealthy, cert expiring).
- **Service-specific panels:** `secure-chat` delivery health, `scorer`/Neo4j status, Redis, Caddy.
- **Scheduled / remote backups** (off-box destinations, rotation).
- **Remote targeting** (`--context`, SSH/TCP docker endpoints) — *only if ever wanted*; the provider
  interfaces already make it a drop-in rather than a reshape.
