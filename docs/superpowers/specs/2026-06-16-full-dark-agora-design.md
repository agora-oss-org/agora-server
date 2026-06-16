# Full-Dark Agora — running the whole instance with zero clearnet egress

> **Status: vision / program design (exploratory).** This is the umbrella spec for a multi-part
> program, not a single buildable plan. It captures the threat model, the architecture, the
> decomposition into independent sub-projects, the build order, and the honest costs. Each
> sub-project gets its own spec → plan → implementation cycle when it's picked up. Nothing here is
> committed to a release.
>
> Supersedes and expands the "Future exploration — network-layer privacy (Tor / onion routing)"
> section of [`CHAT_TODO.md`](../../../CHAT_TODO.md) and §16.4 of
> [`docs/SECURE_CHAT.md`](../../SECURE_CHAT.md).

---

## 1. Purpose & the honest boundary

**The goal:** let an operator run a *complete* Agora instance — API, admin, realtime, database,
auth, storage, moderation, search — as a Tor **v3 hidden service** with **no dependency on any
clearnet service**. Data never leaves the box; the server's location is unknowable; clients are
reachable without ever revealing an IP. "Total privacy" in the network/custodian sense.

### What full-dark removes

- **Cloud custodians.** No Supabase/AWS holding your data at rest; no Anthropic or Voyage seeing
  your content; no external Umami collecting your usage metadata. Every tier runs in-box.
- **Network observers.** No real client IP reaches the server (there's no exit node — traffic stays
  inside Tor end-to-end); the server has no public IP to log, block, subpoena, or seize; an on-path
  ISP sees only "this host talks to the Tor network."
- **Censorship & seizure resistance.** A `.onion` has no DNS record and no hostable IP to take down.

### What full-dark is **NOT** — read this twice

**Full-dark is not end-to-end encryption.** It is a *network and custodian* hardening, orthogonal to
*content* encryption. Concretely:

- **The operator can still read plaintext content.** Posts, comments, and the Replyke-compatible
  *plaintext* chat are stored readable in Postgres. Full-dark moves that Postgres from AWS into the
  operator's box — it does **not** hide it from the operator or from anyone with DB access inside the
  box. A malicious or compelled operator, or a breach of the host itself, still exposes plaintext.
- **The complement is [secure chat (MLS)](../../SECURE_CHAT.md).** That's the layer that hides
  *content* even from the operator. Full-dark and MLS stack: **dark hardens the network/custodian
  layer; MLS hardens the content layer.** Neither substitutes for the other. The strongest posture is
  *both* — a hidden service whose private conversations are also E2E-encrypted.
- **Tor is not magic.** It does not defeat a **global passive adversary** capable of traffic-shape
  correlation across the whole network, and **availability is not a cryptographic guarantee** — a
  hidden service can still be DoS'd or simply go offline. Client-side ciphertext **size-bucket
  padding** (a secure-chat Phase 2 item) blunts traffic-shape fingerprinting but doesn't eliminate it.

> **One-line honesty statement for the README/admin:** *Full-dark hides where the server is and who
> is talking to it, and keeps your data off third-party clouds. It does not, by itself, hide your
> community's content from you, the operator — for that, use secure chat.*

---

## 2. Architecture — the additive `--profile dark`

Full-dark is an **additive deployment profile**, not a replacement. The existing cloud deployment is
untouched and remains the easy-onboarding default; `docker compose --profile dark` brings up a
self-contained stack instead. This keeps faith with Agora's core pitch — *self-hosting is yours to
choose* — and has a decisive engineering benefit:

**Every external dependency swaps to a local backend behind a seam that already exists.** The wire
contract (`@agora-server/contract`), the REST/socket surface, and the app's business logic **do not
change**. Full-dark is overwhelmingly *compose + env + backend wiring*, with exactly two places that
touch app *behavior* (the AI policy in §4.A2 and the anti-abuse limiter key in §4.B2).

### The trust boundary

```
              ┌──────────────────────  the box / the onion  ──────────────────────┐
              │                                                                     │
  Tor client ─┼─▶ tor sidecar (v3 .onion) ─▶ admin nginx ─▶ @agora/api ─▶ Postgres │
   (no IP)    │        (B1)                   (existing)      (existing)    (local) │
              │                                   │              │           (A1)   │
              │                                   └─▶ socket.io ◀┘                   │
              │                                                                     │
              │   GoTrue auth (A1)   Storage (A1)   scorer + local-ai (A2)          │
              │   self-host Umami or off (A3)       Neo4j/DozerDB (already local)   │
              │                                                                     │
              └──────────────────  clearnet egress: NONE  ─────────────────────────┘
```

In full-dark, the "clearnet" column is **empty** — the only thing leaving the box is Tor protocol
traffic to the Tor network itself.

---

## 3. The decomposition — five sub-projects

Each is independently specifiable and (mostly) independently shippable. Difficulty and the seam each
one swaps:

| # | Sub-project | Severs (clearnet tether) | Existing seam it swaps behind | Difficulty |
|---|---|---|---|---|
| **A1** | **Local data plane** — self-hosted Supabase | DB + Auth + Storage (cloud data-at-rest) | `DATABASE_URL`, `getSupabase()`, `lib/storage.ts`, `profiles.auth_user_id` | Medium — the spine; mostly ops |
| **A2** | **AI policy + local-AI** | Anthropic Haiku + Voyage (the only *content* egress) | `moderator_config`, URL-configurable Anthropic/Voyage clients, scorer model-server pattern | Hard / real design — but high standalone value |
| **A3** | **Analytics egress** | Umami (usage metadata) | `lib/umami.ts` (`trackEvent`, already fire-and-forget) | Easy |
| **B1** | **Tor transport** | client IP + server location | the admin nginx front door (already proxies API + socket.io) | Medium — the capstone |
| **B2** | **Anti-abuse without IP** | the IP-keyed rate-limit gotcha | `lib/rate-limit.ts` pluggable store, `requireAuth` | Medium |

> Client-side opt-in Tor routing (running the SDK/socket transport over Tor regardless of whether the
> server is a hidden service) lives in the **SDK repos** (`agora-sdk` / `agora-sdk-plus`), not here.
> Cross-referenced for completeness; out of scope for this server repo.

### A1 · Local data plane (the spine)

Stand up the **open-source Supabase stack** in-box — Postgres (with `pgvector`, `postgis`, `pgmq`,
`pgcrypto`), **GoTrue** (auth), and the **Storage API** — as containers, and repoint `DATABASE_URL` /
`SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` at localhost. Because the app
already speaks these exact APIs through `getSupabase()` and `lib/storage.ts`, and `auth.users` is
deliberately *not* modeled in Drizzle (only `profiles.auth_user_id` links to it), the app code barely
moves.

- **Minimal subset, not the whole Supabase platform.** For an onion we want least attack surface and
  least weight: Postgres + GoTrue + Storage-api (+ a local S3-compatible blob store like MinIO, or
  Storage's filesystem backend). Skip Studio, Realtime, Kong, the dashboard — Agora doesn't use them.
- **Migrations already work against any Postgres** (`pnpm db:migrate:run`); the custom SQL migrations
  are extension-guarded (`create extension if not exists …`), so a vanilla Postgres + extensions is
  enough. The integration suite already proves Agora runs against a non-cloud Postgres.
- **Relates to** [`2026-06-16-auth-provider-abstraction-design.md`](./2026-06-16-auth-provider-abstraction-design.md)
  — if auth is being abstracted behind a provider seam, the dark profile is just another provider
  (self-hosted GoTrue, or a native provider). Coordinate so A1 reuses that abstraction rather than
  forking it.
- **Backups become the operator's job** — see §6.

### A2 · AI policy + the composable local-AI profile

The one piece with genuinely new design, and the one with **standalone value to every operator**
(cloud included) because `local` mode is a *cost saver*, not only a privacy tool. Fully specified in
§4. Ships independently of the rest of the program.

### A3 · Analytics egress

`lib/umami.ts` is already fire-and-forget and no-ops unless `AGORA_UMAMI_*` is set. Two valid
dark-mode answers: **(a)** leave it unset → analytics off; or **(b)** run a **self-hosted Umami**
container in-box and point `AGORA_UMAMI_URL` at it (Agora already supports self-hosted Umami via the
username/password reporting path). Either keeps metadata in the box. Trivial.

### B1 · Tor hidden-service transport (the capstone)

A `tor` sidecar that publishes a **v3 `.onion`** whose hidden-service port maps to the **existing
admin nginx**, which already reverse-proxies `/v7` + `/socket.io` to the API over the internal network
(same pattern as the bundled Caddy `edge` profile — one front door, no CORS, no build-time API URL).
So B1 adds *one* container and a volume for the onion keys; it does not restructure routing.

- **socket.io over Tor** is the thing to validate: long-lived realtime connections under Tor's added
  latency and circuit churn. Confirm reconnection/backoff, handshake timeouts, and that the existing
  socket auth is unaffected. This is the main *unknown* in the whole program.
- **Onion key material** is persisted in a volume (the `.onion` address is derived from it) — back it
  up; losing it changes your address.
- **Public vs. private onion** is an operator choice (§4.B1 / §6): a plain public hidden service, or a
  **client-authorized** onion (v3 client auth) where only holders of an issued key can connect at all
  — a network-level allowlist *beneath* application auth, ideal for a private community.

### B2 · Anti-abuse without IP

Behind a single `.onion`, every request arrives from the local Tor daemon, so the IP-keyed limiter
(`lib/rate-limit.ts`, keyed via `RATE_LIMIT_TRUSTED_HOPS` / `X-Forwarded-For`) collapses — one abuser
looks like everyone. The fix is to **swap the key, not drop the control**:

- **Authenticated routes → key on the account/token (`sub`), not the IP.** Every mutation is
  `requireAuth`, so the abuse-sensitive write surface keys cleanly on identity — *strictly better*
  than IP (you can't escape it by switching networks). The limiter store is already pluggable.
- **Unauthenticated surface is the hard part** — `/auth/*` (login brute-force, signup spam) and
  anonymous reads. Mitigations, standard for Tor/VPN-facing services: a **PoW or CAPTCHA challenge**
  on signup/login; **account/email-keyed** limits + email-confirmation gating; **global/endpoint
  caps** on the onion ingress as a blast-radius backstop; or simply **keep signup/login on clearnet**
  and use the `.onion` for the authenticated app only.
- **Two ingresses, two policies.** Don't apply one limiter to both doors: clearnet keeps the IP-keyed
  limiter as-is; the `.onion` gets an account-keyed + challenge policy. Additive "onion mode," not a
  rearchitecture.
- **Honest trade:** you swap IP heuristics for account-level controls + challenges. A determined
  abuser who farms many accounts is harder to stop than one you could IP-ban — but that's inherent to
  offering anonymity (the same trade every privacy service makes). The account-level **stewardship**
  layer is already the right lever for it.

---

## 4. `AI_PROVIDER_MODE` — the one knob (profile-independent)

The content-reading AI calls — Anthropic **Haiku** (moderation gray-zone escalation) and **Voyage**
(search embeddings) — are the *only* place plaintext content can leave the box. Full-dark needs them
configurable, but the right design is **a single deployment-level master switch that works in any
profile**, sitting *above* the existing per-project `projects.moderator_config` overrides.

Crucially, this axis is **orthogonal to the dark/cloud profile**. `local` mode is equally a **cost
saver** for a plain clearnet operator (drop the Anthropic/Voyage bill) and a **privacy guarantee** for
a dark operator. Same knob, two motivations.

### The modes

| `AI_PROVIDER_MODE` | Moderation escalation | Search / embeddings | Content egress | Typical use |
|---|---|---|---|---|
| `external` | Haiku, direct | Voyage, direct | clearnet | **cloud-profile default** (today's behavior) |
| `tor` | Haiku via Tor SOCKS | Voyage via Tor | reaches providers, but not over clearnet IP | pragmatic; **admin surfaces a "content leaves the onion" warning** |
| `local` | local LLM (Ollama) | local embedder | **none** | full parity, zero egress — **cost saver OR privacy** |
| `classifiers-only` | local RoBERTa only; borderline → human AI-flag queue | off → search degrades to ILIKE | **none** | **dark-profile default** — light, no LLM needed |
| `none` | manual / keyword only | off | none | minimal — pure relay |

### The composable `--profile local-ai`

The local model servers are **their own compose profile**, stackable onto *either* base:

- `docker compose up` *(cloud)* + `--profile local-ai` + `AI_PROVIDER_MODE=local` → **cost-optimized
  clearnet** (no AI bills).
- `docker compose --profile dark` + `--profile local-ai` + `AI_PROVIDER_MODE=local` → **zero-egress
  full parity**.
- `docker compose --profile dark` alone + `AI_PROVIDER_MODE=classifiers-only` → **light dark default**
  (no LLM container at all).

### Why it falls out of the existing architecture

- **Mirrors the scorer model-server pattern.** `scorer-toxicity` and `scorer-relationship` are already
  CPU-pinned container model servers; an **`scorer-llm` (Ollama)** and a local **embedder** are the
  same shape — new entries in `--profile local-ai`.
- **Reuses `moderator_config` + URL-configurable clients.** `projects.moderator_config` already
  carries LLM-provider overrides, and the Anthropic/Voyage clients are URL-configurable; `local` mode
  just points them at the in-box endpoint (Ollama exposes OpenAI-compatible APIs).
- **Haiku is overkill anyway.** The LLM only adjudicates the RoBERTa **gray-zone**
  (`SCORER_GRAYZONE_LOW..HIGH`), so the local model can be **small** — an 8B-class Llama, escalation-
  only, no GPU strictly required. The heavy lifting already happens in the local classifiers.
- **`tor` mode** = put a SOCKS5 proxy agent (pointing at the tor sidecar) on the outbound fetch path
  (the SSRF-guarded fetch already centralizes egress). Small, honest change.

> **Open sub-decision (defer to the A2 spec):** one combined knob vs. splitting moderation-egress and
> embedding-egress into two vars. Start combined (YAGNI); split only if a real deployment wants
> `local` moderation but `external` search, or vice-versa.

---

## 5. Build order & dependencies

```
A2 (AI policy + local-ai)  ── independently shippable; a cost win for ANY operator ──┐
                                                                                      │
A1 (local data plane / self-hosted Supabase)  ── the dark spine ──────────┐          │
                                                                          ▼          ▼
A3 (analytics egress)  ── independent, trivial ──────────────▶  full-dark stack runnable
                                                                          │
B1 (tor transport)  ── needs A1 (no point onion-fronting a cloud-dependent server) ──┘
                                                                          │
B2 (anti-abuse without IP)  ── pairs with B1 ─────────────────────────────┘
```

**Recommended sequence:**

1. **A2 first** — it's the highest-leverage *standalone* win (cuts AI cost for cloud operators today)
   and delivers the AI half of full-dark for free. Not gated behind anything.
2. **A1** — the spine; everything dark hangs on it. Coordinate with the auth-provider abstraction
   spec.
3. **A3** — trivial; can slot in any time.
4. **B1** — the capstone, once A1 means the box is actually self-contained.
5. **B2** — alongside/just after B1, before exposing the onion to the public.

**Rule (mirrors the secure-chat reasoning):** don't ship B1 before A1. A `.onion` in front of a server
that still phones home to cloud Supabase and Anthropic is privacy theater — exactly as "Tor around a
chat with no working encryption buys little."

---

## 6. Honest costs & open questions

- **socket.io over Tor** — the primary unknown. Validate long-lived realtime under Tor latency/circuit
  churn (reconnection, backoff, handshake timeouts) before promising realtime in dark mode.
- **Private vs. public onion** — v3 **client-authorized** onion (network-level allowlist beneath app
  auth, great for a closed community and it makes B2's anti-abuse problem nearly moot) vs. a public
  hidden service (anyone can reach it; B2 matters a lot). Operator choice; document both.
- **Backups are now wholly the operator's responsibility.** No Supabase point-in-time recovery, no
  managed off-box snapshots. The dark profile must ship a documented backup story (pg_dump + blob
  store + the **onion key material** + secure-chat key backups) — losing the onion key changes your
  address; losing Postgres loses everything.
- **The abuse trade** (§4.B2) — account-farming is harder to stop than IP-banning; leans on
  stewardship + challenges. Inherent to anonymity.
- **Local-model hardware cost** (`local` mode) — an 8B LLM + an embedder add real RAM/CPU (and ideally
  a GPU) to the box. `classifiers-only` is the no-extra-hardware dark default for a reason.
- **`.onion` address distribution** — how members discover and trust the address (out-of-band sharing,
  pinning) is a real UX problem with no in-band answer; document it.
- **Performance** — Tor adds latency to every request; the admin SPA and feed reads will feel it.
  Acceptable for the threat model, but set expectations.
- **The operator-trust caveat, repeated** (§1) — full-dark ≠ E2E. Keep this front-and-center in the
  README and admin so no one over-trusts the `.onion` for *content* privacy it doesn't provide.

---

## 7. What this program does **not** change

- No change to `@agora-server/contract` (REST paths, envelopes, socket events, response shapes) — the
  1:1 SDK compatibility is preserved; the SDK can't tell cloud from dark.
- No change to the database schema or migrations — the same schema runs on cloud or local Postgres.
- No change to the secure-chat MLS design — full-dark is the network/custodian layer beneath it.
- No new always-on trusted component that can read content (the secure-chat "no management bot" rule
  generalizes: nothing added here gains content access the cloud deploy didn't already have).
