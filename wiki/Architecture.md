# Architecture

```
client + forked Replyke SDK
   │  HTTPS  /v7/:projectId/<domain>/...        (+ socket.io for chat realtime)
   ▼
@agora/api  (Hono)   endpoints · business logic · permission checks
   │  Drizzle ORM (postgres.js, transaction pooler :6543, prepare:false)   ← owner role, bypasses RLS
   ▼
Postgres   schema · triggers · RPC · pgvector · PostGIS · RLS
        ├── Auth     (passwords, confirmation/reset emails, OAuth)
        └── Storage  (file/image bytes)
        Voyage AI ──▶ embeddings        Anthropic ──▶ /search/ask answers
        pgmq ──▶ services/scorer ──▶ AI moderation · social-graph edges ──▶ Neo4j   (optional)
                                                  @agora/api reads Neo4j back for /social/*
```

## Core ideas

- **The server is the trust boundary.** The API connects to Postgres as the table-owner role (so RLS
  never constrains it) and enforces *every* ownership / role / visibility check in the handlers. RLS is
  enabled underneath as defense-in-depth, never the primary gate. See [[Security]].
- **Drizzle owns all DB access** via a direct `postgres.js` connection; the schema in
  `apps/api/src/db/schema/*.ts` is the single source of truth for tables. The Supabase JS client is used
  *only* for Auth/Storage and is lazily constructed.
- **Multi-tenant by `project_id`** — every table has it; the SDK addresses `/v7/:projectId/...`. A
  single-project deployment just has one `projects` row.
- **Supabase is the default, not a hard dependency.** Auth and Storage sit behind provider seams, so the
  same server runs fully self-contained on native auth + S3 storage + local Postgres (see [[Deployment]]).
- **Denormalized counts are trigger-maintained** (reaction/reply/member/thread counts, reputation) —
  never recomputed per request.

## The monorepo

Agora is a **pnpm monorepo** — apps plus shared packages, with a Python sibling for scoring:

| Package | What it is |
|---|---|
| **`@agora/api`** | The backend — Hono + socket.io. Every endpoint, permission check, and bit of business logic. The reference package. |
| **`@agora/secure-chat`** | The independently-deployable end-to-end-encrypted chat service (own Hono + socket.io process). See [[Secure Chat]]. |
| **`@agora/admin`** | The admin dashboard — Vite + React (moderation, stewardship caseload, feed tuning, dashboards). |
| **`@agora/core`** | The shared kernel both servers consume: env schema, logger, the Drizzle db client + full schema, http error/context, auth + project middleware, validation, suspensions, the Redis client. |
| **`@agora-server/contract`** | Shared API types + zod request schemas (no hono/drizzle). Built first; the permissive (Apache-2.0) wire surface the SDK builds on. See [[API & Contract|API-Contract]]. |
| **`services/scorer`** | The Python moderation + social-graph subsystem (off one pgmq consumer loop). See [[Governance]] and [[Social Graph]]. |

## Handler conventions

URL shape is fixed (`/v7/:projectId/<domain>/...`); lists return `{ data, pagination }` envelopes;
errors throw typed `Errors.*`; every row is shaped to camelCase via `lib/shape.ts`. The full set of
conventions (and the reference router) lives in
[`apps/api/README.md`](https://github.com/agora-oss-org/agora-server/blob/root/apps/api/README.md#architecture)
and the
[repo CLAUDE.md](https://github.com/agora-oss-org/agora-server/blob/root/CLAUDE.md).

The wire contract itself — every REST path, envelope, and socket event — is specified in
[`docs/MANIFEST.md`](https://github.com/agora-oss-org/agora-server/blob/root/docs/MANIFEST.md) and
[`docs/MODELS.md`](https://github.com/agora-oss-org/agora-server/blob/root/docs/MODELS.md). See
[[API & Contract|API-Contract]].
