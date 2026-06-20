# Resource Requirements: `services/scorer`

The scorer subsystem runs three containers: two RoBERTa model servers (toxicity + relationship) and one orchestrator (pgmq consumer + admin API). This document specifies CPU, memory, disk, and deployment requirements.

## Overview

| Container | Role | Image Size | Resident RAM | CPUs | Port |
|---|---|---|---|---|---|
| `scorer-toxicity` | RoBERTa toxicity classifier (warm in RAM) | 1.5–2.0 GB | 1–1.5 GB | 1 (pinned) | 8001 |
| `scorer-relationship` | RoBERTa sentiment classifier (warm in RAM) | 1.5–2.0 GB | 1–1.5 GB | 1 (pinned) | 8002 |
| `scorer-worker` | pgmq consumer + cascade + write-back + admin API | 500–700 MB | 200–400 MB | 2 (floating) | 4001 |

**Total resource footprint:** 3–4.5 GB disk × 3 images, 2.4–3.4 GB resident RAM, 4 vCPU (2 pinned + 2 floating).

---

## CPU Requirements

### Pinning (Isolate Models to Prevent Contention)

The two model servers **should run on separate CPU cores** to avoid contention (`asyncio.gather(toxicity:8001, relationship:8002)` in `worker/pipeline.py`). RoBERTa inference is memory-bound, not CPU-bound, so **1 core per model is sufficient** — the benefit of pinning is isolation, not parallelism.

```yaml
scorer-toxicity:
  cpuset: "0"           # exclusive core 0
  environment:
    OMP_NUM_THREADS: "1"

scorer-relationship:
  cpuset: "1"           # exclusive core 1
  environment:
    OMP_NUM_THREADS: "1"
```

**CPU pinning is host-specific.** Adjust `cpuset` values to match your deployment infrastructure:

- **2-core machine** (e.g., `t4g.medium`, `t4g.small`): toxicity on `0`, relationship on `1` ✓ (baseline)
- **4-core machine** (e.g., `c6i.xlarge`): toxicity on `0`, relationship on `1`, worker uses cores 2–3 ✓
- **8-core machine** (e.g., `c7g.2xlarge`): toxicity on `0`, relationship on `1`, worker uses cores 2–7 ✓
- **1-core machine**: remove `cpuset` entirely and accept both models competing for one core (not recommended)

If `cpuset` doesn't match your hardware layout, the container inherits the host's CPU mask silently — pinning becomes ineffective.

#### Why `OMP_NUM_THREADS=1`?

RoBERTa-base inference is **memory-bandwidth-bound**, not CPU-bound. A single forward pass doesn't have enough internal parallelism to benefit from multi-threading. Setting `OMP_NUM_THREADS=1` prevents PyTorch from spawning excess threads that would context-switch on the shared cores. If you set it higher (e.g., `2` on a 4-core machine), you waste CPU spinning on overhead; on a 2-core machine, it's actively harmful (both models fight for the same cores).

### Worker CPU

The worker is **single-process async** and I/O-bound (wait-on pgmq, HTTP to models, Postgres, Neo4j). It doesn't need pinning; let the OS schedule it. Typical actual use is ~0.5–1.5 cores under normal load; it won't spike above 4 unless the Haiku API is slow (blocking on Claude responses).

---

## Memory Requirements

### Per-Container Breakdown

#### Model Servers (`scorer-toxicity` + `scorer-relationship`)

Each model server loads a **RoBERTa-base model** (480 MB on disk) into RAM alongside PyTorch and the transformers library:

| Component | Memory |
|---|---|
| RoBERTa-base model weights | 480 MB |
| PyTorch runtime (CPU build) | 200–300 MB |
| Tokenizer caches + pipeline buffers | 150–250 MB |
| Python interpreter + fastapi + uvicorn | 100–150 MB |
| **Subtotal per model server** | **1.0–1.5 GB** |

**Worst case (concurrent high-load inference):**
- Batch of 4 requests × 512 tokens each → intermediate tensors → +300 MB overhead
- **Per-model ceiling: ~1.8–2.0 GB**

**Recommendation:** Set `mem_limit: "2g"` per model server in `docker-compose.yml` (or Kubernetes `resources.limits.memory: 2Gi`).

```yaml
scorer-toxicity:
  mem_limit: "2g"
scorer-relationship:
  mem_limit: "2g"
```

#### Worker (`scorer-worker`)

The worker is lightweight — no models loaded locally, mostly async I/O:

| Component | Memory |
|---|---|
| Python interpreter + FastAPI + uvicorn | 100–150 MB |
| asyncpg connection pool (8 conn × ~10 MB) | 50–100 MB |
| Neo4j driver | 50–100 MB |
| Job buffer (pgmq messages in flight) | 10–50 MB |
| Claude Haiku response streaming buffer | 20–50 MB |
| **Subtotal** | **230–450 MB** |

**Recommendation:** Set `mem_limit: "512m"` for the worker (conservative).

```yaml
scorer-worker:
  mem_limit: "512m"
```

### Total Resident Memory (All Three)

- **Minimum (no concurrent load):** 2.4 GB
  - toxicity: 1 GB
  - relationship: 1 GB
  - worker: 250 MB

- **Comfortable (normal load):** 2.8–3.2 GB
  - toxicity: 1.2 GB
  - relationship: 1.2 GB
  - worker: 400 MB

- **Peak (concurrent model requests + Haiku backlog):** 3.4–4.0 GB
  - toxicity: 1.5 GB
  - relationship: 1.5 GB
  - worker: 400–500 MB

**Do not deploy on machines with <3.5 GB available.** If you must run on smaller hardware, disable the Neo4j relationship-edge writes (`unset NEO4J_*` in `.env`); that saves ~150 MB in the worker.

---

## Disk Requirements

### Image Size (Build Artifacts)

```
agora-scorer-model-server:
  - Compressed (docker push to registry): ~600–800 MB
  - Uncompressed (docker run): ~1.5–2.0 GB per container
  - 2 containers × 1.75 GB average = ~3.5 GB on disk

agora-scorer-worker:
  - Compressed: ~200–300 MB
  - Uncompressed: ~500–700 MB

Total (downloaded + running): ~4–5 GB
```

The model server is large because PyTorch bundles BLAS/LAPACK libs (CBLAS, Intel MKL stubs). The Dockerfile slims it:
- `find /opt/venv -type d -name __pycache__ -exec rm -rf {}`
- `find /opt/venv -type d -path '*/torch/*' -name tests -exec rm -rf {}`
- `rm -rf /root/.cache`

Further trimming is possible (e.g., stripping debug symbols from PyTorch wheels) but low-ROI for the complexity.

### HuggingFace Model Cache

Models are downloaded at container startup and cached in a named volume (`scorer-hf-cache` in `docker-compose.yml`):

```yaml
volumes:
  scorer-hf-cache:  # default: /var/lib/docker/volumes/scorer-hf-cache/_data
```

**Disk footprint (both models):**
- `s-nlp/roberta_toxicity_classifier`: ~480 MB
- `cardiffnlp/twitter-roberta-base-sentiment-latest`: ~480 MB
- **Total: ~1 GB**

Mount this volume so models persist across container restarts. Without it, each `docker compose up` re-downloads (~1–2 min latency on first start). In Kubernetes, use a `PersistentVolumeClaim`:

```yaml
volumes:
  - name: hf-cache
    persistentVolumeClaim:
      claimName: scorer-hf-cache
```

---

## CPU Scaling

The architecture does **not** scale CPU within a single machine (the two model servers are pinned to fixed cores). Scale horizontally (multiple machines) when needed:

- **Single machine:** 1× toxicity, 1× relationship, 1× worker (bottleneck: the pinned cores)
- **Multiple machines:** N× toxicity + N× relationship (horizontally scaled, stateless), 1× worker (single consumer on the pgmq queue)

The worker is a single consumer group and can only be scaled to multiple replicas once pgmq consumer groups are wired (future; requires schema change). For now, worker stays 1:1 per deployment.

---

## Memory Scaling

### If You're Memory-Constrained

**Option 1: Disable Neo4j relationship writes**
- Unset `NEO4J_*` in `.env`
- Saves ~150 MB in the worker (driver won't load)
- Trade-off: relationship graph not populated (v1 data loss, but v2 is deferred anyway)

**Option 2: Use smaller models**
- Swap `SCORER_TOXICITY_MODEL` / `SCORER_RELATIONSHIP_MODEL` to distilled variants:
  - `distilbert-base-uncased-finetuned-sst-2-english` (distilBERT): ~200 MB, ~20% faster, ~2% accuracy loss
  - `roberta-tiny`: ~80 MB, ~50% accuracy loss (not recommended for production)
- Rebuild the model server image with the new model env var

**Option 3: Run worker on a different machine**
- Model servers on one beefy machine (4 GB RAM)
- Worker on a tiny machine (512 MB RAM), reaches models via the network
- Adds latency (HTTP call overhead ~5ms per model per request)

### If You Have Excess Memory

No benefit to over-provisioning (models are already warm; PyTorch doesn't use cache hierarchies for inference-only workloads). Allocate extra to Postgres and Neo4j instead.

---

## Recommended Deployments

### Local Development

```bash
docker compose up agora scorer-toxicity scorer-relationship scorer-worker neo4j
```

**Minimum spec:** 4 vCPU, 4 GB RAM (will swap on load)  
**Recommended spec:** 4 vCPU, 8 GB RAM

### AWS Baseline (Absolute Minimum Load)

**Hardware:** `t4g.medium` (2 vCPU, 4 GB) + `t4g.small` (2 vCPU, 2 GB) — **$15.91/mo RI** ($36.79 on-demand)

**t4g.medium (models + system):**
```yaml
scorer-toxicity:
  cpuset: "0"
  mem_limit: "1.5g"      # tight: 1.5 GB model + 0.5 GB overhead
  environment:
    OMP_NUM_THREADS: "1"

scorer-relationship:
  cpuset: "1"
  mem_limit: "1.5g"      # tight: 1.5 GB model + 0.5 GB overhead
  environment:
    OMP_NUM_THREADS: "1"
```

**t4g.small (worker + system):**
```yaml
scorer-worker:
  mem_limit: "512m"      # comfortable: 400 MB worker + 112 MB system
```

**Trade-offs:**
- ⚠️ **Memory is tight** — models have 1.5 GB hard limits, 0.5 GB system overhead. Any memory spike (concurrent requests, Haiku buffering) hits swap or OOM.
- ⚠️ **Burstable CPU** — baseline 0.5 vCPU per instance, burst to 2 vCPU. Model inference is sustained, so you'll burn through CPU credits fast. Performance becomes less predictable under sustained load.
- ✓ **Cheap** — realistic for development/staging or low-traffic production.

**When this works:** <10 entities/comments per minute, low concurrent traffic, you can tolerate occasional OOM restarts.

**When you should upgrade:** >50/min traffic, sustained load >30s, or if you see Haiku escalations >20% (memory-hungry LLM calls backing up).

---

### Production (Balanced, Recommended)

**Hardware:** `c7g.large` (2 vCPU, 8 GB) + `t4g.small` (2 vCPU, 2 GB) — **$40.47/mo RI** ($74.31 on-demand)

**c7g.large (models + system):**
```yaml
scorer-toxicity:
  cpuset: "0"
  mem_limit: "2g"        # comfortable: 1.5 GB model + 0.5 GB overhead
  environment:
    OMP_NUM_THREADS: "1"

scorer-relationship:
  cpuset: "1"
  mem_limit: "2g"        # comfortable: 1.5 GB model + 0.5 GB overhead
  environment:
    OMP_NUM_THREADS: "1"
```

**t4g.small (worker + system):**
```yaml
scorer-worker:
  mem_limit: "512m"      # comfortable: 400 MB worker + 112 MB system
```

**Advantages:**
- ✓ **Dedicated CPU** — predictable performance (no burstable surprises).
- ✓ **Memory breathing room** — 8 GB lets models spike to 2 GB with headroom.
- ✓ **Scaling headroom** — can handle 100+/min traffic spikes.
- ✓ Only **+$24.56/mo** more than baseline, totally worth the stability.

---

### Single-Box (Simplest Ops)

**Hardware:** `c7g.xlarge` (4 vCPU, 8 GB) — **$53.74/mo RI** ($124.10 on-demand)

```yaml
scorer-toxicity:
  cpuset: "0"
  mem_limit: "2g"
  environment:
    OMP_NUM_THREADS: "1"

scorer-relationship:
  cpuset: "1"
  mem_limit: "2g"
  environment:
    OMP_NUM_THREADS: "1"

scorer-worker:
  # No cpuset — floats on cores 2–3 and OS scheduling
  mem_limit: "512m"
```

**Advantages:**
- ✓ No split networking or ops complexity.
- ✓ Dedicated CPU + memory comfortable.
- ✓ Worker gets dedicated cores 2–3 for true parallelism.
- ✗ **Only +$13.27/mo** more than balanced split — negligible savings for the simplicity gain.

### Kubernetes (Horizontal Scale)

```yaml
# scorer-toxicity-deployment.yaml (horizontal scale only)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: scorer-toxicity
spec:
  replicas: 3  # or auto-scale via HPA
  template:
    spec:
      containers:
      - name: scorer-toxicity
        image: ghcr.io/jenova-marie/agora-scorer-model-server:v0.1.0
        resources:
          requests:
            memory: "1Gi"
            cpu: "1"
          limits:
            memory: "2Gi"
            cpu: "1"
        env:
        - name: SCORER_MODEL
          value: "s-nlp/roberta_toxicity_classifier"
        - name: SCORER_MODEL_KIND
          value: "toxicity"
        - name: OMP_NUM_THREADS
          value: "1"
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchExpressions:
                - key: app
                  operator: In
                  values: ["scorer-toxicity"]
              topologyKey: kubernetes.io/hostname
```

Apply the same pattern for `scorer-relationship` (different `SCORER_MODEL` and label).

**Worker deployment:** stays 1× replica (pgmq is the single consumer queue; multiple replicas would just contend). Add more workers only when pgmq consumer groups are implemented (future).

```yaml
# scorer-worker-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: scorer-worker
spec:
  replicas: 1  # single queue consumer
  template:
    spec:
      containers:
      - name: scorer-worker
        image: ghcr.io/jenova-marie/agora-scorer-worker:v0.1.0
        resources:
          requests:
            memory: "256Mi"
            cpu: "500m"
          limits:
            memory: "512Mi"
            cpu: "1"
```

---

## Environment Configuration

All container resource and memory limits are set in `docker-compose.yml` or Kubernetes manifests. The `.env` file configures **feature gates**, not resources:

| Env Var | Default | Impact |
|---|---|---|
| `SCORER_TOXICITY_MODEL` | `s-nlp/roberta_toxicity_classifier` | Model weights size (480 MB for base) |
| `SCORER_RELATIONSHIP_MODEL` | `cardiffnlp/twitter-roberta-base-sentiment-latest` | Model weights size (480 MB for base) |
| `OMP_NUM_THREADS` | Set per container in compose | PyTorch threading (should equal `cpuset` cores) |
| `LOG_LEVEL` | `info` | Disk I/O; no memory impact |
| `ANTHROPIC_API_KEY` | unset → review-queue | Enables Haiku escalation; adds ~50 MB buffer per job |
| `NEO4J_*` | unset → no-op | Disables relationship writes; saves ~150 MB worker RAM |

---

## Monitoring & Alerts

### Metrics to Track

1. **Memory usage per container:**
   ```bash
   docker stats scorer-toxicity scorer-relationship scorer-worker
   ```

2. **Model inference latency:**
   - Check `scorer-worker` logs for `"assessed"` lines
   - Toxicity + relationship parallel call should be ~100–300ms (depending on hardware)
   - If >1s, models are thrashing (likely memory pressure or CPU contention)

3. **pgmq queue depth:**
   ```sql
   select count(*) from pgmq.q_scorer_jobs;
   ```
   - Should drain to ~0 within a few seconds
   - If backing up, worker is memory-starved or the model servers are slow

4. **Haiku (Claude) escalation rate:**
   ```sql
   select count(*) from moderation_analyses where model like '%claude%';
   ```
   - Should be 5–15% of total jobs (the grayzone band)
   - If >30%, `SCORER_GRAYZONE_LOW`/`HIGH` thresholds are too tight

### Alerting

- **Model server memory >90% of limit:** likely OOM incoming; add capacity or reduce batch size
- **Worker memory >80% of limit:** likely Neo4j driver or connection pool bloat; check pool exhaustion logs
- **pgmq queue depth >1000:** worker is falling behind; check model server latency and Haiku API throttle
- **Haiku API errors:** Anthropic quota exceeded or API downtime; fallback to `review` verdict

---

## Verification

After deploying, run the smoke test in `docs/SCORER.md` to confirm resource usage under realistic load:

```bash
docker compose build agora scorer-toxicity scorer-relationship scorer-worker neo4j
docker compose --profile full up -d
docker compose run --rm agora node scripts/migrate.mjs

# Create content (fires enqueue trigger)
psql "$DATABASE_URL" -c "insert into entities (id, project_id, user_id, title, content)
  values (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', '<user-uuid>',
          'smoke', 'you are an idiot and everyone hates you') returning id;"

# Observe
docker stats scorer-toxicity scorer-relationship scorer-worker
docker compose logs -f scorer-worker  # should see "assessed" within ~1s
```

Peak memory should stabilize within the `mem_limit` boundaries. If not, adjust limits and re-test.

---

## Frequently Asked Questions

**Q: Can I run both model servers on the same 2-core machine?**

A: Yes, that's the baseline! Pin toxicity to core 0, relationship to core 1, and let the worker float. The models are memory-bound, not CPU-bound, so 1 core per model is enough. The worker is I/O-bound, so it doesn't need dedicated cores. Memory is tight (1.5 GB limit per model), so monitor and be prepared to scale up on spikes.

**Q: What if I don't need the relationship graph (v2 is future)?**

A: Set `unset NEO4J_*` in `.env`. The relationship edge writes become a no-op (logged), saving ~150 MB in the worker. The Neo4j container can stay off entirely.

**Q: Can I run scorer on ARM (Apple Silicon, Graviton)?**

A: Yes. The Dockerfile detects `TARGETARCH` and installs the ARM64 PyTorch wheel from PyPI (the `whl/cpu` index has no aarch64 wheels, so arm64 falls back to PyPI). CI builds both amd64 + arm64 natively (`.github/workflows/docker-publish.yml`). Memory requirements are the same; CPU pinning syntax is unchanged.

**Q: What happens if models OOM?**

A: Likely a hard crash (PyTorch allocation fails, Python process exits). Docker will restart the container (unless configured otherwise). To gracefully degrade, set a tighter `mem_limit` (e.g., `"1.5g"`); inference will queue and slow, but won't crash. Or implement request queuing in the model server (not yet done; would require a refactor).

**Q: How much latency does horizontal scaling add?**

A: For N replicas of the model servers, each call crosses the network (docker-compose DNS → HTTP overhead ~5–10ms). For local docker-compose, this is negligible. For Kubernetes across AZs, expect 10–50ms per RPC. Throughput improves (parallelism), but p99 latency slightly increases. The worker batches requests (asyncio.gather), so it's worth it unless you're latency-critical (<100ms SLA per job).

---

**Last updated:** 2026-06-08
