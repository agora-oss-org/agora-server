# Telemetry & Observability

Agora ships **full, production-grade telemetry built in** — all three OpenTelemetry signals
(**traces**, **metrics**, **logs**), wired up out of the box across **every** service, plus a
**one-command Grafana stack** to collect them. There's no plugin to install and no instrumentation to
write: each service starts an OpenTelemetry SDK on boot, auto-instruments HTTP + the database, exposes
metrics, and pushes OTLP to a collector — **or stays completely dark** (off by default) until you turn
it on.

The whole layer is built on **[`@jenova-marie/wonder-logger`](https://www.npmjs.com/package/@jenova-marie/wonder-logger)**
(the Node services) and the **OpenTelemetry Python SDK** (the scorer). A single
[`wonder-logger.yaml`](#the-config-wonder-loggeryaml) declares the logger transports and the OTel
tracing/metrics/log exporters for the Node side; the Python side reads the standard `OTEL_*` env.

This doc covers **what's emitted, how to turn it on, and how the bundled Grafana Alloy → LGTM stack
collects it**.

---

## What's built in

| Signal | Source | Exporters | Backend |
|---|---|---|---|
| **Traces** | OTel SDK + auto-instrumentation (HTTP, DB) + manual `withSpan()` (socket.io) | OTLP/HTTP | Tempo |
| **Metrics** | OTel SDK (process/runtime RED) + **custom instruments** (below) | **Prometheus `:9464`** (Node) + **OTLP push** | Mimir |
| **Logs** | `wonder-logger` Pino (Node) / structured JSON (Python), console + OTLP | console + OTLP | Loki |

- **Trace ↔ log correlation is automatic.** Every log line carries `trace_id` / `span_id` — the Node
  logger's `traceContext` plugin and the scorer's JSON formatter both inject it — so a log in Loki links
  straight to its trace in Tempo (and back).
- **Secrets are redacted at the boundary.** `password`, `token`, `authorization`, `cookie`,
  `refreshToken`, `accessToken`, `secret`, `webhookSecret` are stripped from every Node log record
  (per the project's *Log with intent* posture; raw error objects only ever ride a `debug` line).

### Which services emit what

| Service | Traces | Metrics | Logs | Prometheus `:9464` | Service name |
|---|---|---|---|---|---|
| **`@agora/api`** | ✅ | ✅ (+ custom) | ✅ | ✅ | `agora-api` |
| **`@agora/secure-chat`** | ✅ | ✅ | ✅ | ✅ | `agora-secure-chat` |
| **`services/scorer`** (worker + 2 model servers) | ✅ | ✅ | ✅ (trace-correlated) | — (OTLP push) | `agora-scorer-*` |
| **`@agora/admin`** (browser SPA) | — | — | — | — | — (no RUM by design) |

The Node SDK is bootstrapped in each app's `src/instrument.ts`, imported **first** in `index.ts` (right
after `dotenv`) so auto-instrumentation patches `http`/`postgres`/`socket.io` before they load. Both
Node apps share one [`wonder-logger.yaml`](../packages/core/wonder-logger.yaml) via `@agora/core`; only
the `SERVICE_NAME` differs. The scorer bootstraps in `scorer/telemetry.py` (auto-instruments
FastAPI + asyncpg + httpx).

### Custom metrics (the API)

Beyond the auto-generated RED metrics, the API emits product-ops instruments
([`apps/api/src/lib/telemetry.ts`](../apps/api/src/lib/telemetry.ts)):

| Metric | Type | Labels | What |
|---|---|---|---|
| `agora_embedding_duration_ms` | histogram | `input_type` | Voyage embedding latency |
| `agora_embeddings_total` | counter | `input_type`, `status` | Voyage calls (search + indexing) |
| `agora_moderation_decisions_total` | counter | `target`, `action`, `matched` | automated (scorer) moderation decisions |
| `agora_feed_requests_total` | counter | `algorithm` | feed-algorithm mix |
| `agora_socket_active_connections` | up/down counter | — | live realtime connections |
| `agora_socket_events_total` | counter | `event` | inbound socket.io events |

The socket.io handlers are also wrapped in `withSpan` — the realtime path is otherwise invisible to HTTP
auto-instrumentation.

### Two metrics worlds — keep them straight

Agora has **two independent metrics systems**; they don't overlap:

| | **OTel metrics** (this doc) | **`api_usage` product metering** |
|---|---|---|
| Layer | **Ops** — RED, runtime, the custom instruments above | **Product** — per-project API calls / egress / latency |
| Where | Prometheus `:9464` + OTLP push | Postgres `api_usage` ([`lib/metrics.ts`](../apps/api/src/lib/metrics.ts)) |
| Labels | service-scoped, **no `project_id`** | keyed by `project_id` + month |
| Consumer | Grafana | the admin **Community** dashboard |

This doc is about the **ops** layer. The product-metering accumulator needs no collector.

---

## Collection: the bundled Grafana stack

The repo ships a complete **[Grafana Alloy](https://grafana.com/docs/alloy/latest/) → LGTM** stack
behind the `observability` compose profile — config in [`deploy/observability/`](../deploy/observability/).
Alloy is the collector; it fans the three signals out to Tempo / Mimir / Loki, and Grafana reads all
three:

```
@agora/api ────────┐
@agora/secure-chat ─┤ OTLP :4318 ─▶ Alloy ─┬─ traces ─▶ Tempo  ┐
services/scorer ────┘                      ├─ metrics ─▶ Mimir  ├─▶ Grafana :3000
        (+ every container's stdout) ──────┴─ logs ───▶ Loki   ┘
```

Metrics use **one path on purpose**: OTLP push (the apps already export OTLP metrics). The Node
`:9464/metrics` endpoints stay exposed for ad-hoc `curl`/scrape but aren't *also* scraped by the
collector, so series are never double-counted.

> **Internal by design.** The `:9464` endpoints and the LGTM backends are reachable only on the compose
> network, **never** through the public Caddy front door (a Prometheus endpoint must not be public).

---

## Quick start: turn it on

### 1. Bring up the stack alongside your data plane

```bash
docker compose --profile selfhost --profile observability up --build
# (or --profile supabase, --profile full, … — observability composes on top of any data plane)
```

This starts Alloy + Tempo + Mimir + Loki + Grafana (`:3000`). Telemetry is still **off** at this point —
the apps stay dark until you flip the flag.

### 2. Flip the single toggle

The OTLP endpoints are already pointed at `alloy` in compose, so enabling telemetry is one env var:

```bash
echo 'OTEL_SDK_DISABLED=false' >> .env     # then restart the app services
docker compose --profile selfhost --profile observability up -d
```

That's it. Traces, metrics, and logs now flow to the stack for `@agora/api`, `@agora/secure-chat`, and
the scorer.

### 3. Verify in Grafana

Open **http://localhost:3000** (anonymous admin, local convenience):

- **Explore → Tempo** — search by service; you should see `agora-api`, `agora-secure-chat`, and the
  `agora-scorer-*` trio. A socket `join` and a Voyage embed produce spans.
- **Explore → Mimir** — `agora_embeddings_total`, `agora_socket_active_connections`, `http_server_*`,
  `process_*` …
- **Explore → Loki** — `{service_name="agora-api"}`; each line carries `trace_id` → click **View trace**
  to jump to Tempo. Scorer log lines carry `trace_id` too.

```bash
# the Node Prometheus endpoints are live whenever the SDK is on (handy for a quick sanity check):
docker compose exec agora       curl -s localhost:9464/metrics | head
docker compose exec secure-chat curl -s localhost:9464/metrics | head
```

### Bare deploys stay dark

Without `--profile observability` and with the default `OTEL_SDK_DISABLED=true`, no SDK starts, nothing
is exported, `:9464` doesn't bind, and there are no OTLP-export warnings. Telemetry is strictly opt-in.

---

## The config: `wonder-logger.yaml`

The Node telemetry is declared in YAML, not code — both apps load
[`packages/core/wonder-logger.yaml`](../packages/core/wonder-logger.yaml) (the API also has an identical
[`apps/api/wonder-logger.yaml`](../apps/api/wonder-logger.yaml) for its SDK bootstrap). The shape:

```yaml
service:
  name: ${SERVICE_NAME:-agora-api}        # secure-chat overrides this to agora-secure-chat
  version: ${SERVICE_VERSION:-0.3.0}
  environment: ${NODE_ENV:-development}

logger:
  enabled: true
  level: ${LOG_LEVEL:-debug}
  redact: [password, token, authorization, cookie, refreshToken, accessToken, secret, webhookSecret]
  transports:
    - type: console
      variant: ${LOG_CONSOLE:-aligned}     # LOG_CONSOLE=json in prod
    - type: otel
      endpoint: ${OTEL_LOGS_ENDPOINT:-http://localhost:4318/v1/logs}
  plugins:
    traceContext: true                      # inject trace_id/span_id into every line

otel:
  enabled: true
  tracing:
    enabled: true
    exporter: ${OTEL_TRACE_EXPORTER:-otlp}
    endpoint: ${OTEL_TRACES_ENDPOINT:-http://localhost:4318/v1/traces}
    sampleRate: 1.0                         # 100% — lower in high-volume production
  metrics:
    enabled: true
    exporters:
      - type: prometheus
        port: 9464                          # GET :9464/metrics
      - type: otlp
        endpoint: ${OTEL_METRICS_ENDPOINT:-http://localhost:4318/v1/metrics}
        exportIntervalMillis: 60000
  instrumentation:
    auto: true
    http: true
```

> ⚠️ **Env interpolation is string-only.** `${VAR:-default}` works for **strings** (service name, log
> level, endpoints, the trace exporter enum). **Booleans and numbers must be literals** —
> `enabled: true`, `port: 9464`, `sampleRate: 1.0`. Writing `enabled: ${OTEL_ENABLED:-true}` makes the
> Zod schema reject the string `"true"`.

The `OTEL_SDK_DISABLED` env var (honored by the OTel SDK natively, Node **and** Python) is the master
off switch — it short-circuits the whole SDK regardless of `otel.enabled` in the YAML.

---

## Environment variables

All optional. In compose these default to off-and-pre-wired-to-`alloy`; standalone they default to a
local collector at `localhost:4318`.

| Var | Default | Purpose |
|---|---|---|
| `OTEL_SDK_DISABLED` | `true` (compose) | The master switch. `false` turns telemetry on. Logging is unaffected. |
| `SERVICE_NAME` | `agora-api` | `service.name` (Node). secure-chat overrides via `SECURE_CHAT_SERVICE_NAME`. |
| `SERVICE_VERSION` | `0.3.0` | `service.version`. |
| `NODE_ENV` | `development` | `deployment.environment`. |
| `LOG_LEVEL` | `debug` | `trace`\|`debug`\|`info`\|`warn`\|`error`\|`fatal`\|`silent`. Use `info` in prod. |
| `LOG_CONSOLE` | `aligned` | `aligned` (dev) or `json` (prod). |
| `OTEL_TRACE_EXPORTER` | `otlp` | `otlp`\|`jaeger`\|`console`\|`none`. |
| `OTEL_TRACES_ENDPOINT` / `OTEL_METRICS_ENDPOINT` / `OTEL_LOGS_ENDPOINT` | `http://alloy:4318/v1/*` | Node OTLP/HTTP endpoints. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://alloy:4318` | scorer (Python) OTLP base — appends `/v1/{traces,metrics}`. |
| `OTEL_SERVICE_NAME` | per service | scorer service name (`agora-scorer-worker`, …; set per container in compose). |
| `GRAFANA_PORT` / `ALLOY_PORT` | `3000` / `12345` | host ports for the observability UIs. |

---

## Standalone / external collector

Don't want the bundled stack (you already run Tempo/Mimir/Loki, or a hosted Grafana Cloud)? Skip
`--profile observability`, point the endpoints at your own collector, and flip the switch:

```bash
OTEL_SDK_DISABLED=false
OTEL_TRACES_ENDPOINT=https://otlp.example.com/v1/traces
OTEL_METRICS_ENDPOINT=https://otlp.example.com/v1/metrics
OTEL_LOGS_ENDPOINT=https://otlp.example.com/v1/logs
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.example.com      # scorer
```

The bundled [`deploy/observability/config.alloy`](../deploy/observability/config.alloy) is also a fine
starting point for an Alloy config you run yourself.

---

## Custom spans & metrics

The SDK is global, so any handler can add instrumentation without re-wiring. Add to the API's
[`lib/telemetry.ts`](../apps/api/src/lib/telemetry.ts) registry, then record at the call site:

```ts
import { withSpan } from "../lib/telemetry.js";
import { trace } from "@opentelemetry/api";

await withSpan("rank-feed", async () => {
  trace.getActiveSpan()?.setAttribute("feed.algorithm", "hot");
  // … work …
});
```

The `@opentelemetry/api` global is a **no-op until the SDK registers** (telemetry disabled / unit
tests), so call sites are guard-free. Scorer-side, use `opentelemetry.trace.get_tracer(__name__)`.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Periodic `OTLP export failed` warnings | SDK is on but no collector at the endpoint. Bring up `--profile observability`, fix `OTEL_*_ENDPOINT`, or set `OTEL_SDK_DISABLED=true`. |
| `Invalid input: expected boolean, received string` on boot | A `${VAR}` used for a boolean/number in `wonder-logger.yaml`. Booleans/numbers **must be literals**. |
| `:9464/metrics` refused | SDK disabled (`OTEL_SDK_DISABLED=true`). The endpoint only binds when the OTel SDK starts. |
| Logs in Loki have empty `trace_id` | Line logged outside an active span (e.g. at boot), or `traceContext`/scorer injection unavailable. |
| secure-chat shows up as `agora-api` | `SECURE_CHAT_SERVICE_NAME` / `SERVICE_NAME` not reaching the container — check the compose `environment` block. |
| scorer emits no traces | Python OTel deps not installed in the image, or `OTEL_SDK_DISABLED=true`. `setup_telemetry` logs a skip line. |

---

## See also

- [`deploy/observability/`](../deploy/observability/) — the Alloy + LGTM stack (`README.md`, `config.alloy`, backend configs, Grafana datasources).
- [`apps/api/src/instrument.ts`](../apps/api/src/instrument.ts) · [`apps/secure-chat/src/instrument.ts`](../apps/secure-chat/src/instrument.ts) — the Node SDK bootstraps.
- [`apps/api/src/lib/telemetry.ts`](../apps/api/src/lib/telemetry.ts) · [`services/scorer/scorer/telemetry.py`](../services/scorer/scorer/telemetry.py) — custom instruments + the scorer bootstrap.
- [`@jenova-marie/wonder-logger`](https://www.npmjs.com/package/@jenova-marie/wonder-logger) — the Node telemetry framework, with its own `content/{CONFIGURATION,TRACING,METRICS}.md`.
- The **CLAUDE.md → Observability (OTel)** note for the in-repo design rationale (ops vs product metrics).
