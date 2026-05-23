# 🏛️ Agora

> The open social layer. Own your community.

A self-hosted, **Replyke-API-compatible** community/social backend. Agora exposes an API the
(forked) [Replyke](https://github.com/replyke/monorepo) SDK can consume **1:1** — so you get
Replyke's opinionated social features (entities/posts, threaded comments, reactions & feeds,
follows & connections, nested spaces, real-time chat, notifications, moderation, semantic search)
running on infrastructure **you** control.

## Why

Supabase gives you a chunk for free — auth, storage, realtime, Postgres, pgvector. The rest —
the social schema, the denormalized counts, the opinionated endpoints and business logic in
front of it — is what makes Replyke worth using, and it's exactly what Agora builds.

## Stack

- **API** — [Hono](https://hono.dev) on Node, one router per domain under `/v7/:projectId/*`
- **Data** — **Drizzle ORM** over a direct `postgres.js` connection (Supabase transaction pooler).
  Drizzle owns all DB access; the schema in `server/src/db/schema/*.ts` is the single source of truth.
- **Auth** — Supabase Auth backs password identity + confirmation/reset emails; Agora mints its
  own access (30 m) + refresh (30 d) tokens with **rotation + reuse-detection + 30 s grace**.
  External users authenticate via RS256 JWT (verified against a per-project public key).
- **Realtime** — **socket.io** for chat (REST writes fan out durable events to conversation rooms)
- **Search** — **Voyage AI** (`voyage-3.5`, Anthropic's recommended provider) embeddings + pgvector
- **Storage** — Supabase Storage; images get `sharp`-generated webp variants
- **Supabase JS client** — reserved for Auth + Storage only (everything else is Drizzle)

## Architecture

```
client + forked Replyke SDK
   │  HTTPS  /v7/:projectId/<domain>/...        (+ socket.io for chat realtime)
   ▼
@agora/server  (Hono)   endpoints · business logic · permission checks
   │  Drizzle ORM (postgres.js, Supabase transaction pooler :6543, prepare:false)   ← owner role, bypasses RLS
   ▼
Supabase Postgres   schema · triggers · RPC · pgvector · PostGIS · RLS
        ├── Supabase Auth     (passwords, confirmation/reset emails)
        └── Supabase Storage  (file/image bytes)
        Voyage AI ──▶ embeddings for semantic search
```

**The server is the trust boundary.** It connects as the table-owner role (so RLS never affects
it) and enforces all ownership/role checks in handlers. RLS is enabled as defense-in-depth, with
public-read policies so a client *could* read public content directly via the publishable key —
but in normal operation everything flows through the Agora API.

## Layout

```
agora/
├── docs/
│   ├── MANIFEST.md   # the exact REST + socket.io contract (SDK-confirmed vs inferred)
│   └── MODELS.md     # field-level response shapes (drive both the API and the schema)
├── db/README.md      # database overview (schema now lives in server/src/db/schema)
└── server/           # @agora/server
    ├── drizzle/              # generated + custom SQL migrations (0000–0008)
    ├── scripts/              # seed.sql (validation + dev seed), chat-e2e.mjs
    └── src/
        ├── index.ts          # entrypoint: /v7/:projectId/* + socket.io
        ├── db/               # Drizzle client + schema/*.ts (source of truth)
        ├── lib/              # env, supabase, tokens, embeddings, storage, shape, validation
        ├── http/             # error + pagination envelopes, context types
        ├── middleware/       # project resolution, JWT auth
        ├── routes/           # one router per domain
        └── realtime/         # socket.io server, typed to the SDK's event contract
```

## Features (REST surface — all implemented & validated on live Supabase)

| Domain | Highlights |
|---|---|
| **entities** | feed (hot/new sorts), CRUD, drafts, foreign/short-id lookup, reactions, saved state |
| **comments** | threaded (adjacency list + recursive CTE), reactions, Reddit-style soft delete |
| **users / follows** | profiles, follow graph + counts, suggestions, connections count |
| **spaces** | nested spaces, membership (join/approve/ban/roles), rules, moderation queues, digest config |
| **collections** | nestable saved-entity folders |
| **notifications** | inbox, unread count, mark read |
| **reports** | report queue + resolution (entities, comments, chat messages) |
| **auth** | sign-up/in/out, refresh rotation, change/reset password, email verify, external RS256 |
| **chat** | conversations (direct/group/space), members, messages, reactions — **socket.io realtime** |
| **search** | semantic content search (Voyage + pgvector) + text search for spaces/users |
| **storage** | file uploads + image variants (sharp → webp) |
| **misc** | oauth identities, lean project info, link/OG metadata (SSRF-guarded) |

Denormalized counts (reaction counts, reply counts, member counts, thread counts, reputation)
are maintained atomically by Postgres **triggers** — never recomputed per request.

## Getting started

```bash
cd server
cp .env.example .env     # see "Configuration" below
npm install

npm run db:migrate       # apply migrations to your Supabase DB (idempotent; safe to re-run)
npm run dev              # http://localhost:4000/v7   (GET /health to verify)

# optional: seed dev data + validate triggers/RPC (asserts loudly)
url=$(grep '^DATABASE_URL=' .env | cut -d= -f2-); psql "$url" -v ON_ERROR_STOP=1 -f scripts/seed.sql
```

### Configuration (`.env`)

```
DATABASE_URL=postgresql://postgres.<ref>:<pw>@<region>.pooler.supabase.com:6543/postgres
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sb_secret_...      # admin auth ops
SUPABASE_ANON_KEY=sb_publishable_...         # user auth (signUp/signIn/reset)
ACCESS_TOKEN_SECRET=<random>                 # signs Agora access tokens
VOYAGE_API_KEY=pa-...                        # semantic search (optional)
VOYAGE_MODEL=voyage-3.5
EMBEDDING_DIMENSIONS=1024
```

## 1:1 SDK compatibility — the catch

The published SDK hardcodes `https://api.replyke.com/v7` in ~3 spots, so you must **fork
`@replyke/core`** and repoint those constants (see `docs/MANIFEST.md §0`). The URL shape,
auth token semantics, `{ data, pagination }` / `{ error, code }` envelopes, response object
shapes, and **socket.io event names** must all match exactly — `docs/MANIFEST.md` is the
checklist and `docs/MODELS.md` the response contract.

## Status

- ✅ **Backend feature-complete** — every domain implemented and validated against live cloud
  Supabase; realtime chat, semantic search, auth (incl. token rotation + external RS256), storage,
  and RLS all verified end-to-end.
- ✅ Idempotent Drizzle migrations `0000`–`0008`.
- ⬜ Fork & repoint the Replyke SDK to drive the real client against Agora (the 1:1 proof).
- ⬜ `crypto/sign-testing-jwt` (dev convenience) — only remaining stub.

## License

Apache-2.0 (matching Replyke).
