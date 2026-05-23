# 🏛️ Agora

> The open social layer. Own your community.

A self-hosted, **Replyke-API-compatible** community/social backend built on **Supabase**.
The goal: expose an API the (forked) Replyke SDK can consume **1:1** — so you get Replyke's
opinionated social features (entities, threaded comments, reactions, feeds, follows,
connections, spaces, chat, notifications, moderation, semantic search) on infrastructure
you control.

## Why

Supabase gives you ~40% for free (auth, storage, realtime, Postgres, pgvector). The other
~60% — the social schema + the opinionated endpoints and business logic in front of it — is
what Replyke's value actually is, and what Agora builds.

## Layout

```
agora/
├── docs/
│   ├── MANIFEST.md   # the exact REST + socket.io contract to match (with SDK-confirmed flags)
│   └── MODELS.md     # field-level response shapes (drive both the API and the schema)
├── db/
│   ├── migrations/   # 0001–0008: schema, triggers, RPC, RLS (apply in order)
│   └── README.md
└── server/           # @agora/server — Hono + Supabase + JWT + socket.io
    └── src/
        ├── index.ts         # entrypoint: /v7/:projectId/* + realtime
        ├── lib/             # env, supabase service client
        ├── http/            # error + pagination envelopes, context types
        ├── middleware/      # project resolution, JWT auth
        ├── routes/          # one router per Replyke domain (all paths wired; handlers stubbed)
        └── realtime/        # socket.io server, typed to the SDK's event contract
```

## Architecture (Pattern 2: custom server in front of Supabase)

```
[ client + forked Replyke SDK ]
        │  HTTPS  /v7/:projectId/...
        ▼
[ @agora/server ]  ← endpoints + business logic + permission checks  (+ socket.io)
        │  service-role key
        ▼
[ Supabase ]  Postgres (schema + triggers + RPC + pgvector) · Auth · Storage · Realtime
```

## 1:1 SDK compatibility — the catch

The published SDK hardcodes `https://api.replyke.com/v7` in ~3 spots, so you must **fork
`@replyke/core`** and repoint those constants (see `docs/MANIFEST.md §0`). The base URL,
auth token rotation, pagination/error envelopes, response shapes, and the **socket.io**
event names must all match exactly. The manifest is the build checklist.

## Getting started

```bash
# 1. Database (Supabase project or local)
for f in db/migrations/0*.sql; do psql "$DATABASE_URL" -f "$f"; done

# 2. Server
cd server
cp .env.example .env        # fill in SUPABASE_URL + SERVICE_ROLE_KEY + secrets
npm install
npm run dev                 # http://localhost:4000/v7  (GET /health to verify)
```

## Status

- ✅ Build manifest (REST endpoints + socket.io events) — `docs/MANIFEST.md`
- ✅ Postgres schema + triggers + RPC — `db/migrations/`
- ✅ Server scaffold (routes wired, handlers stubbed, typechecks & boots) — `server/`
- ⬜ Implement handlers (start with entities/comments/auth; chat realtime last)
- ⬜ Fork & repoint the SDK

## License

Apache-2.0 (matching Replyke).
