# @agora/moderator

> LLM-backed content moderation for Agora — a standalone webhook receiver + admin review aids.

A separate Hono service (default **:4001**) that moderates content with an LLM **without coupling
that logic into the API**. It listens for the API's signed broadcast webhooks, assesses each piece
of content against a generic LLM provider, auto-acts above a confidence threshold by writing the
removal back to the API, and serves the operator-gated review aids the admin app's AI queue consumes.

For the project overview, see the [root README](../../README.md).

## Why a separate service

Content moderation is opinionated, latency-sensitive, and benefits from being swappable — so it
lives outside the API. The moderator plugs into the seams the API already exposes:

- It shares the API's Postgres (reads `projects.webhook_secret`, reads/writes its own
  `moderation_analyses` table) and `ACCESS_TOKEN_SECRET` (to verify the operator JWT the admin
  already holds).
- It **never mutates content directly** — every removal goes back through the API over HTTP, so the
  **API stays the single trust boundary**. DDL for shared tables is owned by the API's Drizzle
  migrations.

## How it works

```
@agora/api  ──(signed *.complete webhook)──▶  POST /webhooks/agora   (verify HMAC, ACK, assess async)
                                                      │
                                              LLM provider (OpenAI-compatible | Anthropic)
                                                      │  verdict: allow | block | review
                                                      ▼
                                  confidence ≥ threshold?  ──yes──▶  POST {API}/internal/moderation/apply
                                                      │                (MODERATION_SERVICE_SECRET-gated,
                                                      │                 moderatedByType="client")
                                                      └──no──▶  wait in the human AI-flag queue

@agora/admin ──(operator JWT)──▶  GET /v1/:projectId/moderation/*    (review aids: queue + re-analyze)
```

- **Real-time monitoring** — point a project's webhook at `POST /webhooks/agora` and subscribe the
  content `*.complete` broadcast events (in the admin's Webhook settings). The moderator verifies the
  HMAC signature against the project's `webhookSecret`, ACKs immediately, then assesses asynchronously
  (no creation latency).
- **Generic LLM provider** (`lib/llm-provider.ts`) — `MODERATOR_LLM_PROVIDER=openai` speaks the
  OpenAI-compatible `/chat/completions` shape (OpenAI, Groq, Together, OpenRouter, Ollama, vLLM,
  LM Studio — pick the host with `MODERATOR_LLM_BASE_URL`); `anthropic` speaks `/v1/messages`. Each
  call returns a strict JSON verdict: `allow` | `block` | `review` + categories + confidence + reason.
- **Auto-action** — a `block` at/above `MODERATION_AUTO_ACTION_THRESHOLD` is written back to the API
  (`POST /internal/moderation/apply`) as `moderatedByType="client"`, removing it from reads
  immediately via the moderation-visibility layer. Below the threshold, items wait in the human
  queue. Set the threshold to `0` for advisory-only.
- **Aids for human moderators** — the admin's Moderation page gains an **AI-flag** queue
  (`GET /v1/:projectId/moderation/queue`) with per-item Remove/Dismiss, and the report ReviewDialog
  shows an **AI assessment** panel with a Re-analyze action. Every verdict is persisted in
  `moderation_analyses` (audit trail). These endpoints are operator-gated (shared `ACCESS_TOKEN_SECRET`).

## Layout

```
apps/moderator/src/
├── index.ts                 # entrypoint: serves the app
├── app.ts                   # createApp() — side-effect-free Hono app (drives in-process tests)
├── routes/
│   ├── webhooks.ts          # POST /webhooks/agora — inbound signed broadcast receiver
│   └── moderation.ts        # /v1/:projectId/moderation/* — operator-gated review aids
├── lib/
│   ├── llm-provider.ts      # generic OpenAI-compatible | Anthropic client + verdict parsing
│   ├── assess-and-record.ts # orchestrates assess → persist → maybe write-back
│   ├── policy.ts            # the moderation prompt/policy
│   ├── api-client.ts        # write-back to the API's /internal/moderation/apply
│   ├── webhook-verify.ts    # HMAC verification against projects.webhook_secret
│   └── env.ts               # validated environment access
├── db/                      # Drizzle client + schema (moderation_analyses; reads projects)
├── http/ · middleware/      # error envelopes, operator-JWT auth, request logging
```

## Getting started

From the **repo root** (depends on the built `@agora-server/contract` package):

```bash
corepack enable
pnpm install
pnpm -r build              # build contract first
```

Then, from `apps/moderator` (it reads the same root `.env` as the API):

```bash
pnpm dev                   # tsx watch -> http://localhost:4001 (GET /health to verify)
```

Finally, in the admin's **Webhook settings**, point the project webhook at
`http://localhost:4001/webhooks/agora` and subscribe the content `*.complete` events.

## Commands

Run from `apps/moderator`, or `pnpm --filter @agora/moderator <script>` from the repo root:

```bash
pnpm dev          # tsx watch -> http://localhost:4001
pnpm build        # tsc -> dist/
pnpm start        # node dist/index.js
pnpm typecheck    # tsc --noEmit — run before considering work done
pnpm test         # vitest unit suite (llm-provider verdict parsing, …)
```

## Configuration (`.env`)

Reads the repo's root `.env` (shared with the API). `DATABASE_URL` + `ACCESS_TOKEN_SECRET` are
required; everything else is optional, and empty strings are treated as unset (so a half-configured
provider never silently activates).

```ini
MODERATOR_PORT=4001                            # the moderator listens here (api's PORT stays 4000)
DATABASE_URL=postgresql://...                  # same Supabase pooler as the API (required)
ACCESS_TOKEN_SECRET=<random>                   # shared with the API — verifies the operator JWT (required)
CORS_ORIGIN=*

# Write-back to the API
API_BASE_URL=http://localhost:4000             # api ORIGIN (no /v7) — write-back target
MODERATION_SERVICE_SECRET=<random>             # must match the API's; unset = auto-action disabled
MODERATION_AUTO_ACTION_THRESHOLD=0.85          # auto-remove `block` at/above this (0 = advisory only)

# Generic LLM provider
MODERATOR_LLM_PROVIDER=openai                  # openai (OpenAI-compatible /chat/completions) | anthropic
MODERATOR_LLM_BASE_URL=                        # override the provider host (Groq/Together/Ollama/vLLM/…)
MODERATOR_LLM_API_KEY=sk-...                   # the moderation model's key (separate from ANTHROPIC_API_KEY)
MODERATOR_LLM_MODEL=gpt-4o-mini
MODERATOR_LLM_MAX_TOKENS=512
```

When `MODERATOR_LLM_API_KEY` is unset the service still runs (and `/health` reports `llm: null`),
but no assessment happens — useful for wiring up the webhook plumbing before adding a provider.

## Docker

Ships a multi-stage `Dockerfile` (`node:22-slim`, built from the repo root since it depends on the
`@agora-server/contract` workspace package).

```bash
# build context = repo root
docker build -f apps/moderator/Dockerfile -t agora-moderator .
docker run  --rm --init --env-file .env -e API_BASE_URL=http://<api-host>:4000 -p 4001:4001 agora-moderator
```

See the [root README](../../README.md#docker) for the full `docker compose` stack (api + admin +
moderator).

## License

[Apache-2.0](../../LICENSE) — matching Replyke.
