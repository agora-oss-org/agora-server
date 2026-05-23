# Agora — Database

> **The schema now lives in code.** Drizzle ORM is the single source of truth:
> TypeScript schema in [`server/src/db/schema/`](../server/src/db/schema) →
> generated + custom SQL in [`server/drizzle/`](../server/drizzle). The old hand-written
> `db/migrations/*.sql` have been removed (fully ported into the Drizzle flow).

Designed for **Supabase** (uses `auth.users`, `vector`, `postgis`).

## Migrations (Drizzle)

Applied in journal order by `drizzle-kit migrate`, which is **idempotent** — already-applied
migrations are skipped, and the custom SQL is itself re-runnable
(`create extension if not exists`, `create or replace`, `drop trigger if exists`).

| Migration | Contents |
|---|---|
| `0000_init` | extensions (pgcrypto/vector/postgis), all enums + ~23 tables + btree indexes |
| `0001_postgis` | `geography(Point,4326)` location columns + GIN/GiST/IVFFlat indexes |
| `0002_triggers` | denormalized counts (reactions, replies, members, threads, collection) + reputation |
| `0003_functions` | `toggle_reaction`, `hot_score`/`refresh_entity_score`, `fetch_comment_thread`, `match_entities` |
| `0004_rls` | enable RLS on all tables (deny-all to non-privileged callers) |

```bash
cd server
cp .env.example .env          # set DATABASE_URL (+ Supabase URL/keys)
npm run db:generate           # regenerate after editing src/db/schema/*.ts
npm run db:migrate            # apply (safe to re-run)
```

To change the schema: edit `server/src/db/schema/*.ts`, run `db:generate`, then `db:migrate`.
Triggers / functions / RLS / PostGIS bits are hand-written custom migrations in
`server/drizzle/` (Drizzle can't express them) — edit those SQL files directly.

## Key design decisions

- **Drizzle owns DB access** via a direct `postgres.js` connection; `@supabase/supabase-js`
  is reserved for Auth + Storage. Connection uses Supabase's transaction pooler (6543) with
  `{ prepare: false }`.
- **Multi-tenant by `project_id`** — every table carries it because the SDK addresses
  `/v7/:projectId/...`. A single-project deployment just uses one row in `projects`.
- **Denormalized counts** (`reaction_counts`, `replies_count`, `members_count`,
  `thread_reply_count`, `entity_count`) are maintained by triggers — never recomputed per request.
- **v6 + v7 reactions coexist**: `entities`/`comments` keep legacy `upvotes[]`/`downvotes[]`
  arrays *and* the v7 `reaction_counts` jsonb, because the SDK types expose both.
- **Reactions are normalized** in `reactions`; the jsonb counts are derived (trigger `0002`).
- **`auth.users` is NOT modeled in Drizzle** — `profiles.auth_user_id` is a plain uuid the app
  links, so Drizzle never tries to own the Supabase-managed auth schema.
- **Comments** use adjacency list (`parent_id`) + recursive CTE (`fetch_comment_thread`).
- **Embedding dim = 1536** (OpenAI `text-embedding-3-small`). Change `vector(N)` + the ivfflat index for another model.
- **Scores**: call `refresh_entity_score(id)` after vote changes, or batch via cron for the hot feed.

## Not yet covered (intentional gaps)

- Refresh-token family/rotation tables (lives in the auth service — see server scaffold).
- RLS *policies* (only enablement is done — deny-all backstop).
- Digest webhook delivery log; partitioning for high-volume `chat_messages` / `app_notifications`.
