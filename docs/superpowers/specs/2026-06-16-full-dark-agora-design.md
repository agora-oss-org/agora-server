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
- **And the content layer need not stop at chat.** Secure chat encrypts *DMs/group chat*; the **public
  feed** (`entities` + comments) is still plaintext in Postgres even under full-dark. **§8 — operator-blind
  encrypted spaces** — extends the *same* MLS-ratchet primitive to *public posts*, so an opt-in space's
  feed is operator-blind at rest too. It is the content-layer complement for the feed, and it stacks with
  full-dark exactly as secure chat does (see the matrix in §8.9).
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

---

## 8. Complementary program: operator-blind **encrypted spaces** (content-layer E2E for *entities*)

> **Status: vision / program design (exploratory).** A *sibling* program to full-dark, not part of it.
> Full-dark (§1–§7) hardens the **network/custodian** layer; this hardens the **content** layer for the
> public feed. They are orthogonal and stack (§8.9). Like full-dark, this is decomposed into independently
> specifiable sub-projects (§8.10); nothing here is committed to a release. Captured here because it is the
> natural answer to the gap §1 names: *secure chat hides chat content from the operator, but the feed is
> still plaintext.*

### 8.1 Purpose & the gap it fills

Full-dark moves Postgres into the operator's box but **does not hide post content from the operator** —
posts, comments, and plaintext chat sit readable in Postgres (§1, "read this twice"). Secure chat closes
that gap *for chat*. This program closes it *for the public feed*: make a community's **public posts
(`entities`) and comments unreadable by the operator at rest**, by repurposing the **MLS group ratchet**
secure chat already uses — applied to the feed instead of to DMs.

**The concrete threat model is cold database seizure** — a Postgres dump handed over for investigation, a
stolen backup, a seized disk — *decrypts to nothing readable*. This is explicitly **not** a defense against
a tampered *live* server (see the web-delivery caveat, §8.8). It is the at-rest / storage-confidentiality
posture, and it composes with full-dark, which removes the cloud custodian holding that storage in the first
place.

**The semantic the design targets** (operator's own words): *new members can't see past posts, but see all
new posts immediately; the brief "empty space" for a new joiner is acceptable and short-lived in a healthy
community.* As §8.3 shows, **this semantic falls out of MLS forward secrecy for free** — it is not a feature
we bolt on, it is what the ratchet already does.

### 8.2 The locked design decisions

Each was a deliberate fork, chosen knowingly:

| Axis | Decision | Consequence |
|---|---|---|
| **Threat model** | Cold DB seizure / at-rest confidentiality | A seized DB is opaque; a *tampered live server* is explicitly **out of scope** |
| **Key custody** | True E2E — keys on member **devices**; server is a blind delivery service holding **zero** group secrets | Operator cannot read either; MLS is the right (and necessary) tool |
| **Scope** | **Opt-in** per space/community (a flag at creation); everything else stays cleartext | Bounded blast radius; Agora keeps its current self — two confidentiality tiers on one platform |
| **Metadata** | Author + timing + reply-structure + reaction counts stay **cleartext**; only **bodies** (and embedded media) are ciphertext | Ownership/edit/delete/rate-limit/threading/notification-routing all keep working; the *participation graph* is exposed on seizure (accepted) |
| **Recovery** | **Passphrase-wrapped** key backup; server holds only an Argon2id-locked opaque blob | Device loss ≠ data loss; forgotten passphrase = lost access; a seized DB still can't open the blob |
| **Safety** | **Reporting only, no AI** in E2E spaces; report performs *selective disclosure* to a steward | No proactive scanning (impossible — server can't read bodies); steward caseload survives via surgical per-post disclosure |

### 8.3 The cryptographic core — repurposing the MLS ratchet for a *re-readable feed*

**One MLS group per E2E space.** Space members = group members; each member **device = a leaf** in the
ratchet tree. The server is the **Delivery Service (DS)**: it stores and *orders* the ciphertext handshake
stream (KeyPackages, Welcomes, Commits) and the encrypted posts, but holds no group secrets — the identical
"blind DS" posture as secure chat, just a different payload. **The server never links an MLS library.**

**The key move — decouple group key-agreement from content encryption.** Raw MLS *application messages* are
forward-secret *per message*: the secret-tree ratchet erases keys as it advances, so you cannot re-read.
That is correct for a chat transcript and **exactly wrong for a feed**, which needs random-access re-reads of
history. So posts are **not** sent as MLS application messages. Instead:

1. **Per-epoch content key.** Each MLS **epoch** yields a content key via MLS's standard exporter interface:
   `K_epoch = MLS-Exporter("agora/espace-content", epoch_id)`. Every member *of that epoch* can derive it
   deterministically; the server and non-members cannot.
2. **Per-post DEK, wrapped to the epoch.** Each post gets a fresh random **DEK** (XChaCha20-Poly1305). The
   body is encrypted under the DEK; the DEK is wrapped under `K_epoch`. The stored envelope is:

   ```
   espace_post envelope (body field):
     { v, epoch_id, wrapped_dek, nonce, ciphertext, author_sig }
                │        │           │      │           └─ author signs {plaintext, post_id, epoch_id}
                │        │           │      └─ AEAD nonce for the body
                │        │           └─ AEAD(K_epoch, DEK)         ← only an epoch member can unwrap
                │        └─ which epoch's key wraps the DEK        ← tells a reader which K_epoch to derive
                └─ envelope/format version (crypto agility)
   ```

   *(Why a per-post DEK rather than encrypting the body directly under `K_epoch`? Nonce hygiene across many
   posts under one epoch key, and it lets the DEK be **re-wrapped** to a different recipient — e.g. a steward
   on report, §8.7 — without re-encrypting the body.)*
3. **Reading** a post = derive `K_epoch` for `epoch_id` → unwrap DEK → decrypt body → verify `author_sig`.

**The history semantic the operator wanted — for free:**

- A **new member** joins via the MLS **Welcome**, which hands them the **current** epoch secret *only*. They
  can derive `K_epoch` for the current and future epochs, and are **cryptographically unable** to derive any
  *past* epoch exporter (MLS forward secrecy). → They read everything from their join epoch forward, and
  **nothing** before it. The brief "empty space" **is** the epoch boundary at their join. This is precisely
  the requested behavior, achieved by the primitive, not by an access-control rule we have to trust the
  server to enforce.
- Members **persist the epoch exporters they have lived through** in their encrypted local store, so they can
  re-read *any* post made since they joined — random access, not destroy-on-read. **This is the one
  deliberate softening of the ratchet:** MLS would let a device forget; we retain exporters for the member's
  *membership window* so the feed stays re-readable.

**Membership changes drive epochs — and that *is* the access control:**

| Event | MLS mechanism | Effect on keys | Result |
|---|---|---|---|
| **Join** | Committer adds the leaf + sends Welcome | New epoch; joiner gets current `K_epoch` forward | Reads from join-epoch onward; can't derive earlier epochs |
| **Leave / ban** | Committer removes the leaf (Commit) | New epoch `K_epoch'` the removed leaf can't derive | Cut off from **all future** posts (keeps epochs its device already held — inherent, §8.8) |
| **Key rotation / heal** | Member sends an Update/Commit | New epoch, fresh tree secrets | Post-compromise security: a leaked device's future reads are healed after rotation |

- **Who may commit** maps onto Agora's **existing space roles**: space **owners/admins** are the committers
  (their clients perform adds/removes), mirroring `requireSpaceRole` (owner ⇒ admin). Member-initiated joins
  for open spaces resolve through an admin's client — *or*, to avoid joins blocking on an admin being online,
  via MLS **external commits / published `GroupInfo`** (a joiner self-admits against the public group state
  the DS stores). The external-join path is strongly preferred for availability.

### 8.4 What the server stores — all opaque or public

New `espace_*` tables, mirroring the `secure_*` convention (and, like `secure_*`, defined in
`packages/core`'s schema and served by a blind DS — co-locating with `apps/secure-chat` is the natural home,
since it is already the blind-DS process):

| Table | Holds | Readable by operator? |
|---|---|---|
| `espace_groups` | Per-space group state: `group_id`, `current_epoch_id`, public `GroupInfo`/ratchet-tree ciphertext for external joins | Public handshake data only |
| `espace_key_packages` | Members' published **KeyPackages** (public keys; consumed on join) | Public keys only |
| `espace_commits` | The **ordered Commit transcript** — the DS's ordering of these *is* the epoch sequence | MLS handshake ciphertext |
| `espace_welcomes` | Welcome messages addressed to specific joining devices | Encrypted to the joiner |
| `espace_key_backups` | Passphrase-wrapped recovery blobs (Argon2id + AEAD) | **Opaque** — passphrase not in DB |
| **encrypted posts** | Stored as **`entities`/`comments` rows** (§8.5) with the §8.3 envelope in the body field, `encrypted=true`, plus `epoch_id`/`wrapped_dek` sidecar | **Bodies opaque**; author/time/thread cleartext |

**What a full seizure of all of the above yields:** the membership roster per space, who-posted-when, the
reply graph, reaction tallies, a pile of MLS handshake ciphertext, and Argon2-locked backup blobs — **and no
post bodies.** That is exactly the §8.2 threat-model line, and **no more** (the metadata exposure is the
accepted §8.2 cost).

### 8.5 SDK / contract impact

Encrypted posts remain ordinary **`entities` / `comments` rows** so the forked SDK's feed, pagination,
reactions, and threading hooks work **1:1** — the contract (`@agora-server/contract`) is preserved. The only
delta:

- The row's `body`/`title`/`content` carry the **ciphertext envelope** instead of plaintext, with
  `encrypted = true` and the `epoch_id` / `wrapped_dek` sidecar.
- The forked SDK gains an **encrypted-space code path**: in an `encrypted` space the feed hook runs a
  **decrypt pass** (derive `K_epoch` → unwrap → decrypt → verify signature) before render, and the composer
  runs an **encrypt pass** (fresh DEK → wrap to current `K_epoch` → sign) before upload. This is the
  "encrypted space code path" flagged when scope was chosen — it lives in the **SDK repos**, not this server
  repo.
- This is the same shape as secure chat's `SecureChatCrypto` seam: an **`EncryptedSpaceCrypto`** client
  interface over an MLS implementation (OpenMLS-wasm / `mls-rs` / whatever secure chat already links).

### 8.6 Server-side feature degradation (the accepted cost)

For `encrypted = true` rows, every server-side body reader becomes a **no-op, not a failure** — the server
simply can't read the body, so it skips. Metadata-only features keep working:

| Feature | On a cleartext space | On an E2E space |
|---|---|---|
| Semantic search / Voyage embeddings | ✅ indexes body | ⛔ skipped — no body to embed (in-space client-side search only) |
| Scorer AI moderation (RoBERTa + Haiku) | ✅ scans body | ⛔ skipped — reporting-only (§8.7) |
| OG / link-preview (`/utils/get-metadata`) | ✅ | ⛔ skipped for encrypted bodies |
| Content-based feed ranking | ✅ | ⚠️ recency/metadata ranking only |
| Notifications **with body preview** | ✅ | ⚠️ metadata-only ("new post in X") |
| Reactions, counts, threading, ownership, rate-limit | ✅ | ✅ (metadata is cleartext) |
| Realtime fan-out (`emitToConversation`-style) | ✅ | ✅ payload body is ciphertext; client decrypts on receipt |

### 8.7 Safety, recovery, realtime

- **Report → selective disclosure (preserves the steward caseload).** E2E spaces have **no automated
  moderation** — the server can't read bodies. When a member reports a post, their client **re-wraps that one
  post's DEK to the steward's public key** and attaches it to the report. The steward can decrypt **exactly
  the reported item** — nothing else — adjudicate, and remove it through Agora's normal moderation path
  (`moderationStatus='removed'`, the ciphertext additionally tombstoned). The operator **never** obtains the
  space's `K_epoch`; disclosure is surgical and member-initiated. Block/leave behave normally. The space's
  "no proactive moderation" posture is surfaced to the **owner at creation** and to **members on join** (it
  has real ToS/compliance weight — §8.8).
- **Recovery (passphrase-wrapped).** On first E2E join, the member sets a recovery passphrase; the client
  **Argon2id**-derives a wrap key and encrypts `{ MLS signature/identity key + the set of epoch exporters the
  member currently holds }` into an opaque blob stored in `espace_key_backups`. A new device: passphrase →
  unwrap → restore identity → **re-join at the current epoch**, and restore the persisted exporters so
  history-since-original-join is readable again. A seized DB holds the blob but cannot open it (the passphrase
  is never in the DB).
- **Realtime.** New posts fan out over the existing socket.io path (the "see all new posts immediately"
  experience) with the body as ciphertext; clients decrypt on receipt. Reaction/presence events are unchanged
  cleartext metadata.

### 8.8 Honest costs & caveats — **read this twice** (mirrors §1's discipline)

- **Web-delivery trust — the load-bearing caveat.** True E2E *in a browser* still trusts the operator to
  serve **honest client JavaScript**; a compelled or malicious **live** operator could ship backdoored JS
  that exfiltrates keys from members' browsers. **This program's threat model (cold DB seizure) is fully
  covered; a tampered live server is NOT.** Native SDK targets (React-Native / Expo) harden this materially
  (signed app binaries, no per-load code delivery); the web admin/SPA path is best-effort. This must be
  stated plainly in the README, the admin, and the space's join notice. *It is the content-layer analogue of
  full-dark's own repeated "dark ≠ E2E" honesty.*
- **Metadata is exposed on seizure (accepted, §8.2).** Roster, who-posted-when, reply graph, and reaction
  tallies remain cleartext. For some investigations the participation graph is as revealing as content. A
  stronger "author hidden from server (anonymous credential)" variant was considered and **deliberately not
  chosen** — it would force edit/delete/ownership/abuse to be redesigned around crypto rather than
  `author_id`. Revisit only if the social graph itself becomes part of the threat model.
- **Removed-member residual.** A removed/banned member is cut off from all *future* posts (new epoch), but
  **keeps whatever epoch exporters their device already held** — they can still re-read history up to their
  removal. You cannot claw back keys a device already saw. Inherent to the model.
- **Scale & churn.** MLS is `O(log n)` per change (TreeKEM), fine for a sensitive community; a very large,
  high-churn E2E space means frequent Commits/epochs and heavier KeyPackage management. The **opt-in scope**
  (§8.2) keeps this bounded — this is for *a* sensitive community, not the 100k-member firehose.
- **Committer availability.** Joins/removes require a committer; lean on **external commits** (§8.3) so joins
  don't block on an admin being online.
- **Key loss is real.** Forgotten passphrase **and** all devices lost = access gone; the operator cannot
  recover it (that's the whole point). The passphrase backup is the humane default, not a safety net the
  server can override.
- **Legal / ToS.** Operator-blind + no AI moderation has genuine compliance implications (illegal-content
  liability, jurisdiction-specific takedown duties). The space **owner acknowledges** this at creation. This
  is the same posture debate as Signal/Matrix E2E, scoped to opt-in spaces.
- **No discovery / SEO inside E2E spaces** (accepted) — there is nothing public to crawl; new visitors see
  the space's content only after joining, forward from their join epoch.

### 8.9 How it stacks with full-dark (the two-axis matrix)

Encrypted spaces and full-dark are **orthogonal** and compose — the same way secure chat composes with
full-dark. The two axes answer two different adversaries:

```
                          │  Encrypted spaces OFF          │  Encrypted spaces ON (this program)
──────────────────────────┼────────────────────────────────┼────────────────────────────────────────
  Full-dark OFF (cloud)    │  cloud custodian holds          │  cloud custodian holds CIPHERTEXT
                          │  plaintext; operator reads      │  bodies; neither cloud nor operator
                          │  (today's default)              │  reads bodies; seized cloud DB opaque
──────────────────────────┼────────────────────────────────┼────────────────────────────────────────
  Full-dark ON (.onion)    │  no cloud, no network observer; │  STRONGEST: location hidden, no clearnet
                          │  but operator/box still reads   │  egress, AND post bodies operator-blind
                          │  plaintext on the box           │  at rest — network + content both hardened
```

- **Full-dark** defeats the **network/custodian** adversary (where is the server, who holds the data, who
  sees the traffic).
- **Encrypted spaces** defeat the **at-rest content** adversary (a seized/subpoenaed/stolen database).
- **Neither subsumes the other**, and **both** is the maximal posture: a hidden service whose sensitive
  communities are also operator-blind at rest. This mirrors §1's "the strongest posture is *both*" exactly,
  now extended from chat to the feed.

### 8.10 Decomposition, build order & open questions

Like full-dark, this is a multi-part program; each part gets its own spec → plan → implementation cycle.

| # | Sub-project | Lives in | Difficulty |
|---|---|---|---|
| **E1** | **`espace_*` blind-DS endpoints** — KeyPackage publish, Welcome/Commit ordering, encrypted-post store/fetch | `apps/secure-chat` (already the blind-DS process) + `packages/core` schema | Medium — mirrors secure-chat DS |
| **E2** | **`EncryptedSpaceCrypto` client seam + SDK encrypted-space path** — encrypt/decrypt feed passes over an MLS impl | **SDK repos** (`agora-sdk`), not this repo | Hard — the crypto heart |
| **E3** | **Space flag + entity envelope plumbing** — `encrypted` space flag, envelope sidecar columns, body-reader no-op guards | `apps/api` + `packages/core` | Medium — must wire every body-reader to skip |
| **E4** | **Passphrase recovery** — Argon2id wrap, `espace_key_backups`, new-device restore | SDK + `espace_*` DS | Medium |
| **E5** | **Report → steward selective disclosure** — client re-wrap to steward key, steward decrypt-one path | SDK + `apps/api` steward routes | Medium |

**Build order:** E3 (the flag + no-op guards make the surface *safe to exist* — a body-reader that doesn't
skip an encrypted row is a leak) → E1 (the DS) → E2 (the client crypto, the hard part) → E4/E5 (recovery and
safety, before any real community uses it). **Rule, mirroring §5:** don't expose an E2E space to members
before E5 — a space members can't safely report in is a safety hole, exactly as "Tor around a chat with no
working encryption buys little."

**Open questions to resolve in the per-sub-project specs:**

- **MLS library choice & crypto-agility** — reuse exactly what secure chat links (OpenMLS-wasm / `mls-rs`);
  pin ciphersuite; the envelope `v` field is the agility seam.
- **Epoch-exporter persistence budget** — how many epochs a long-lived member's device must retain; bound it
  (e.g. snapshot-and-compact) so the local store doesn't grow unbounded in a high-churn space.
- **Open-join vs. admin-approved** for E2E spaces, and whether external-commit self-admit is allowed without
  an admin in the loop (availability vs. control).
- **Edit/delete semantics** under encryption — edits re-encrypt under the *current* epoch (so a since-joined
  member sees edits even of pre-join posts? or edits stay in the original epoch?); deletes tombstone the
  ciphertext.
- **Whether the whole-project (not just per-space) "encrypted community" toggle** is worth supporting, or
  per-space is sufficient (start per-space; YAGNI on whole-project).
- **Combining with full-dark backups** (§6) — `espace_key_backups` blobs and the operator's `pg_dump` story
  must account for these opaque blobs (they're safe to back up; they're useless without member passphrases).
