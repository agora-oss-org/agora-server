# 🔐🚀 Privacy Roadmap — Beyond the Banner

> **Status:** Forward-looking R&D roadmap. This is the tier *above*
> [`PRIVACY-POSTURE.md`](./PRIVACY-POSTURE.md) §6 — it asks "can we make the square **operator-blind**
> too, not just world-invisible?" Nothing here is committed; it's the honest map of what's possible,
> what it costs, and the one bet worth prototyping first.

[`PRIVACY-POSTURE.md`](./PRIVACY-POSTURE.md) establishes the banner ("Signal w/ community") and two
**true floors** no square escapes: members can leak what they read, and the **operator must read
content to moderate, rank, and search it.** That second floor is what this doc interrogates. "Exotic
crypto" is the only thing that can move it — but the three candidates attack *different* problems, and
exactly one is realistically viable for the square as it exists.

---

## 0. Read this first — the framing that prevents a tar pit

Two cuts matter before any primitive:

1. **Content vs. metadata.** **FHE and TEE** attack *"the operator can read the **content**."*
   **PIR** attacks *"the operator can see **what you access**"* (metadata / access patterns). They are
   not interchangeable.
2. **The square's value IS content being processable.** Ranking, moderation, search, and a shared
   social graph all *require reading content*. Every step you take to blind the operator erodes those
   features and slides the square toward [`SECURE_CHAT.md`](./SECURE_CHAT.md) (which already gave them
   all up — that's its trade). A *fully* operator-blind square that still ranks/moderates/searches is,
   today, either **(a) running in a TEE**, or **(b) a research project.**

**And the prerequisite:** do [`PRIVACY-POSTURE.md`](./PRIVACY-POSTURE.md) §6 *first*. Encryption-at-rest,
retention limits, real deletion, and operator least-privilege buy ~80% of the practical
"minimize the blast radius" benefit at ~1% of the complexity. Exotic crypto is the tier *after* that,
and it mostly matters where **operator ≠ community** — i.e. the **managed-hosting tier**. For self-host
+ Tor, the operator already *is* the community, so the marginal value of the work below is much lower.

---

## 1. TEEs (Trusted Execution Environments) — **the lead bet**

**What it is:** a hardware enclave (Intel SGX, AMD SEV-SNP, AWS Nitro Enclaves, ARM CCA) that runs
**normal code at near-native speed** in encrypted memory the host OS / hypervisor / operator cannot
read, with **remote attestation** so a client can verify *which* code is running before it sends any
plaintext.

**Why it's the realistic one:**
- It runs the square's **existing code largely unchanged** — moderation (RoBERTa + the Haiku call),
  embedding/ranking, `match_content` search — inside the enclave. The operator (host root, hypervisor,
  cloud provider) can't read enclave memory.
- **Direct precedent: this is how Signal does server-side privacy** (contact discovery, secure value
  recovery run in SGX enclaves). "Operator-blind square via TEE" is a trodden path, not a moonshot.
- **It closes the [`PRIVACY-POSTURE.md`](./PRIVACY-POSTURE.md) §4 gap directly** — the "managed
  hosting = third-party operator can read the square" problem. For the managed tier, this is *the* play
  and a genuine, marketable differentiator: *"we, the host, cannot read your community."*

**Honest costs:**
- Trust **shifts**, it doesn't vanish — from "trust the operator" to "trust the hardware vendor +
  attestation chain." Not zero-trust.
- **Side-channel arms race** — SGX has a long graveyard of breaks (Foreshadow, Plundervolt, SGAxe,
  ÆPIC…). SEV-SNP / Nitro have better track records; none are bulletproof.
- **It fights the self-host / Tor ethos.** TEE needs specific CPUs or cloud confidential VMs — there's
  no enclave on a Raspberry Pi behind a `.onion`. So TEE is a **managed/cloud hardening primitive**,
  not a run-it-anywhere one.
- Operational weight: enclave dev, memory limits, attestation infrastructure to operate.

**Verdict:** ✅ The viable path to an operator-blind square that still ranks/moderates/searches. **Scope
it to the managed-hosting tier**, where we control the hardware and the operator≠community gap is real.

---

## 2. Homomorphic Encryption (FHE) — **surgical only**

**What it is:** compute on ciphertext without decrypting it (schemes: BFV/BGV for integers, **CKKS**
for approximate/vector math, TFHE for boolean). Sounds like the whole dream; it isn't a blanket
solution, for two hard reasons.

- **Performance:** 1,000×–1,000,000× slowdown depending on the operation. Transformer inference
  (RoBERTa) under FHE is research-grade — seconds-to-minutes per call, tiny models. Running **Claude**
  under FHE is science fiction. The moderation queue is out.
- **The key-holder problem kills the *blanket* version.** FHE lets the server compute on ciphertext,
  but **someone holds the decryption key.** In a square, content must be readable by *members* — so the
  key lives on every member's device, never the operator's. That's **group key management = MLS again.**
  Once you've built that, you've rebuilt [`SECURE_CHAT.md`](./SECURE_CHAT.md) and **lost** the
  searchable/moderatable square. FHE didn't buy the thing you wanted.

**Where it genuinely shines — bounded, single-purpose private ops:**
- **Private semantic search (CKKS):** client sends an *encrypted* query vector; the server scores it
  against the index **without learning the query**. (Builds on the existing Voyage-embedding +
  `match_content` path.)
- **Private set intersection:** "connections in common" without either side revealing their full list.

**Verdict:** 🔶 Viable for **one** narrow, high-value operation (private search or PSI) — never "encrypt
the whole square." Treat as a fast-follow *feature*, not an architecture.

---

## 3. PIR (Private Information Retrieval) — **metadata, not content**

**What it is:** retrieve item *i* from the server **without the server learning which *i*** you fetched.
Crucially, it hides the *access pattern*, **not** the content of the stored data (the server still holds
the data; PIR hides that you read post #842 or looked up user X).

- **Fit:** metadata privacy — who-read-whose-profile, private user/contact lookup, read receipts.
  (Signal uses PIR-flavored techniques for private contact discovery.)
- **Costs:** single-server PIR (Spiral-class) has improved a lot but inherently **scans the whole DB per
  query** — that linear cost *is* the privacy. Multi-server PIR is faster but needs **non-colluding
  operators**, which is operationally bizarre for a self-hosted community (two independent hosts that
  promise not to collude).
- It does **nothing** for moderation/ranking — those must read content.

**Verdict:** 🔶 Niche metadata hygiene. Complements TEE/FHE, replaces neither. The multi-server variant
fights self-host.

---

## 4. The map

| Primitive | Solves | Square fit | Verdict |
|---|---|---|---|
| **TEE** | operator reading **content** | moderation, ranking, search — *all of it*, existing code | ✅ **Lead bet — managed tier.** Signal precedent. Hardware/cloud dependency; side-channel risk. |
| **FHE** | operator reading **content** | *one* bounded op (private search / PSI) | 🔶 Surgical only. Blanket version infeasible + reinvents MLS. |
| **PIR** | operator seeing **access patterns** | profile/contact lookup, read privacy | 🔶 Metadata only. Multi-server fights self-host. |

---

## 5. Proposed sequence

1. **Earn the banner first.** Land the [`PRIVACY-POSTURE.md`](./PRIVACY-POSTURE.md) §6 checklist
   (at-rest encryption, retention, real deletion of derived data, operator least-privilege). This is the
   prerequisite and the highest value-per-effort work. Nothing below is worth starting until this ships.
2. **Prototype the TEE-backed managed tier** — the one bet worth real engineering. A spike: run the
   moderation + ranking + search path inside an AMD SEV-SNP / AWS Nitro enclave with remote attestation
   surfaced to the client. Success criterion: the hosting operator demonstrably *cannot* read square
   content, attested end-to-end. This becomes the managed tier's headline guarantee.
3. **Fast-follow with ONE surgical FHE feature** — most likely **private semantic search** (encrypted
   CKKS query against the index), reusing the embedding path. Scope it as a feature, time-box the R&D,
   and kill it if latency isn't acceptable.
4. **Consider PIR only for a specific metadata threat** — e.g. private profile/contact lookup — and only
   single-server (Spiral-class) so self-host doesn't need a non-colluding second operator.

> **Guardrail:** most of FHE/PIR is research-grade and can swallow a roadmap. Keep each item time-boxed
> and feature-scoped. The TEE managed tier is the only piece that should get sustained investment — and
> only *after* the §6 baseline is real.

---

## 6. Cost & AWS feasibility (the TEE bet)

The surprise: **on AWS, the TEE itself is free.** There is no "confidential computing" SKU with a
premium price — you pay for the EC2 instance you'd run anyway. The real costs are *architectural*, not
line-item.

> *Pricing below is ~early-2026, `us-east-1`, on-demand — treat the dollars as ballparks and verify
> live. The "no TEE surcharge" structural fact is stable AWS positioning, not a quoted rate.*

### Two AWS paths

- **AWS Nitro Enclaves** — the attested-enclave model (the strong one, closest to Signal's SGX usage).
  A **feature of most current-gen Nitro EC2 instances at no additional charge**: you carve vCPUs + RAM
  out of a parent instance into an isolated enclave with its own attestation. Cost = the EC2 box, sized
  up to donate cores/RAM to the enclave.
- **AMD SEV-SNP** — whole-VM memory encryption (easier to adopt, weaker guarantee). On AMD instances
  (`m6a`/`c6a`/`r6a`/`m7a`…), also **no extra charge** — a launch flag. Trust model is "host/hypervisor
  can't read VM memory" rather than per-enclave attestation; lift-and-shift the whole app instead of
  carving out a sensitive core.

### The dollars (single moderation/ranking box)

Size for enough headroom to run the parent **and** donate to the enclave:

| Instance | vCPU / RAM | On-demand | ~Reserved (1–3 yr) |
|---|---|---|---|
| `m6i.xlarge` | 4 / 16 GB | ~$140/mo | ~$60–90/mo |
| `c6i.2xlarge` | 8 / 16 GB | ~$245/mo | ~$100–150/mo |
| `m6i.2xlarge` | 8 / 32 GB | ~$280/mo | ~$110–170/mo |

**Realistic baseline: ~$250–400/mo on-demand, ~$100–200/mo reserved** for one enclave-capable box. The
enclave is *free*; you're buying a slightly bigger EC2 instance. (Egress/data-transfer is the usual AWS
gotcha, but it's not TEE-specific.)

### The costs that actually bite (engineering, not the bill)

1. **Enclaves have no network and no persistent storage.** A Nitro Enclave reaches the world *only* via
   a `vsock` channel to its parent. You don't run Postgres/Neo4j *in* the enclave — you run the
   **sensitive compute** (decrypt → moderate → rank) in it and the parent proxies encrypted blobs in/out.
   That's a real refactor of the moderation/ranking path.
2. **No GPU/accelerator passthrough into enclaves.** RoBERTa on CPU in-enclave is feasible but
   throughput-limited; you can't accelerate it with a GPU *inside* the enclave. Plan for CPU-bound or
   batched moderation.
3. **🚨 The one that can break the whole story — external LLM calls.** The moderation pipeline ends in a
   **Claude Haiku** adjudication. If the enclave sends plaintext to Anthropic's API, the *operator* is
   blind but **Anthropic now sees the content** — confidentiality leaks out the API call. A genuinely
   operator-blind path must either **(a)** drop the external LLM and rely on the in-enclave RoBERTa
   classifiers only, or **(b)** explicitly name Anthropic as a *trusted processor* in the threat model.
   You can't claim "the operator can't read it" *and* ship it to a third-party LLM without stating that
   trade.

### Takeaway

The blocker on the TEE managed-tier bet was **never the cloud cost** (~$250–400/mo, no TEE premium) — it's
the `vsock` refactor, CPU-only in-enclave ML, and the one honest threat-model decision about the external
Claude call. That makes the bet *more* attractive than "hardware/cloud dependency" first implies.

---

## 7. The honest one-liner

> **The square can become operator-blind — realistically via a TEE (managed tier, Signal's own
> approach), surgically via one FHE feature, with PIR for specific metadata leaks. But the whole square
> encrypted from the operator is not on the table without becoming secure-chat. The baseline hardening
> in [`PRIVACY-POSTURE.md`](./PRIVACY-POSTURE.md) §6 comes first, and for self-host + Tor — where the
> operator already *is* the community — most of this is optional.**

---

## See also

- [`PRIVACY-POSTURE.md`](./PRIVACY-POSTURE.md) — the banner, the two floors, the gradient, the §6 baseline checklist.
- [`SECURE_CHAT.md`](./SECURE_CHAT.md) — what a *fully* operator-blind surface looks like (and what it gives up).
- [`SECURITY.md`](./SECURITY.md) — operator hardening + the server-as-trust-boundary model.
- [`SOCIAL-GRAPH.md`](./SOCIAL-GRAPH.md) — existing privacy work (k-anonymity, dyadic brightness).
