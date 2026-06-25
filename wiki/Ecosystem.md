# Ecosystem

Agora is **three separate repos** — kept separate on purpose, *not* one monorepo.

| Repo | What it is |
|---|---|
| **`agora-server`** (this repo) | The backend + admin. The contract's server side. |
| **[`agora-sdk`](https://github.com/jenova-marie/agora-sdk)** | The forked, repointed Replyke SDK, published as `@agora-sdk/*` (`core` / `react-js` / `react-native` / `expo`). The base URL flows in via the provider prop; no `api.replyke.com` left. Its own release cycle. |
| **`agora-sdk-plus`** | Additive, Agora-only SDK features built on `@agora-sdk/*` (kept out of the Replyke fork so that stays a tiny, documented divergence). Home of the **client** end-to-end-encrypted chat packages — the `SecureChatCrypto` seam + mock, transport, provider, hooks. See [[Secure Chat]]. |
| **[`agora-demo`](https://github.com/jenova-marie/agora-demo)** | A standalone Vite + React app: the **1:1 compatibility harness** (and what powers the live demo). Eight tabs, each exercising one SDK surface against a running server. |

## Why a fork?

The published Replyke SDK hardcodes `https://api.replyke.com/v7`; `agora-sdk` repoints that base URL.
Because it does, the URL shape, auth token semantics, `{ data, pagination }` / `{ error, code }`
envelopes, response object shapes, and socket.io event names all line up 1:1 — that's the entire point.
See [[API & Contract|API-Contract]].

## Why the demo stays separate

A compatibility harness must be an *arms-length* consumer: `agora-demo` installs the **published**
`@agora-sdk/*` (not a workspace link), so it catches server↔SDK contract drift exactly as a third party
would. Folding it in would test local source you control, not the published contract — defeating the
point.

## Running all three locally

Start the server, seed a confirmed demo user, then run the demo pointed at the server via
`VITE_API_BASE_URL`. The step-by-step is in [[Getting Started]] and the
[repo CLAUDE.md](https://github.com/agora-oss-org/agora-server/blob/root/CLAUDE.md).
