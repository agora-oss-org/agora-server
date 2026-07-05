# Telemetry & Observability

Agora ships **full, production-grade telemetry built in** — all three OpenTelemetry signals
(**traces**, **metrics**, **logs**), wired up out of the box across **every** service, plus a
**one-command Grafana stack** to collect them. There's no plugin to install and no instrumentation to
write: each service starts an OpenTelemetry SDK on boot, auto-instruments HTTP (and, in the scorer, its
database driver), exposes a metrics endpoint, and pushes OTLP to a collector — **or stays completely
dark** (off by default) until you turn it on.

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
| **Traces** | auto-instrumentation (HTTP in/out; the scorer also auto-instruments its `asyncpg` DB driver) + manual `withSpan()` (socket.io) | OTLP/HTTP | Tempo |
| **Metrics** | **custom instruments** (below) — the SDK emits no runtime/HTTP metrics by default | **Prometheus `:9464`** (Node + scorer) + **OTLP push** (traces/logs only) | Mimir |
| **Logs** | `wonder-logger` Pino (Node) / structured JSON (Python), console + OTLP | console + OTLP | Loki |

- **Trace ↔ log correlation is automatic.** Every log line emitted **inside a request/span** carries
  `trace_id` / `span_id` — the Node logger's `traceContext` plugin and the scorer's JSON formatter both
  inject it — so a log in Loki links straight to its trace in Tempo (and back). (Lines logged outside any
  span — e.g. at boot — simply have no trace id.)
- **Secrets are redacted at the boundary.** `password`, `token`, `authorization`, `cookie`,
  `refreshToken`, `accessToken`, `secret`, `webhookSecret` are stripped from every Node log record
  (per the project's *Log with intent* posture; raw error objects only ever ride a `debug` line).

### Which services emit what

| Service | Traces | Metrics | Logs | Prometheus `:9464` | Service name |
|---|---|---|---|---|---|
| **`@agora/api`** | ✅ | ✅ custom | ✅ | ✅ | `agora-api` |
| **`@agora/secure-chat`** | ✅ | ◐ endpoint only | ✅ | ✅ | `agora-secure-chat` |
| **`services/scorer`** (worker + 2 model servers) | ✅ | ◐ endpoint only | ✅ (trace-correlated) | ✅ | `agora-scorer-*` |
| **`@agora/admin`** (browser SPA) | — | — | — | — | — (no RUM by design) |

> **Metrics today are the API's custom instruments.** They're registered only in `@agora/api`
> ([next section](#custom-metrics-the-api)). `@agora/secure-chat` and the scorer both expose a `:9464`
> endpoint (scraped by Alloy, see [Collection](#collection-the-bundled-grafana-stack)) but register no
> app-level series yet — just whatever auto-instrumentation RED metrics their instrumented libraries
> emit (asyncpg/httpx/FastAPI for the scorer). Traces + logs flow from all three.

The Node SDK is bootstrapped in each app's `src/instrument.ts`, imported **first** in `index.ts` (right
after `dotenv`) so the HTTP auto-instrumentation patches `http` (incoming + outbound `fetch`) before it
loads. Note: Drizzle's `postgres.js` driver has **no** OTel auto-instrumentation (the Node bundle targets
`pg`), so DB calls aren't auto-traced; the socket.io realtime path is traced **manually** via `withSpan`.
Both Node apps share one [`wonder-logger.yaml`](../packages/core/wonder-logger.yaml) via `@agora/core`;
only the `SERVICE_NAME` differs. The scorer bootstraps in `scorer/telemetry.py` (auto-instruments
FastAPI + asyncpg + httpx — so its DB *is* traced). Unlike the Node side, the scorer's metrics **only**
go out via the `:9464` scrape endpoint (`PrometheusMetricReader`) — no OTLP metric exporter is wired at
all, since Alloy would just 404 it (see [Collection](#collection-the-bundled-grafana-stack)).

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
@agora/api ────────┐                         ┌─ traces  (OTLP) ─▶ Tempo  ┐
@agora/secure-chat ─┤ OTLP :4318 ─▶ Alloy ────┼─ logs    (OTLP) ─▶ Loki   ├─▶ Grafana :3000
services/scorer ────┘   scrape :9464 ─────────┴─ metrics (scrape→remote-write) ─▶ Mimir ┘
```

**Traces and logs** are pushed via OTLP. **Metrics** are *scraped* from Prometheus endpoints (`:9464`) —
the two Node apps (`prometheus.scrape "agora_nodes"`) plus the scorer's worker + 2 model servers
(`prometheus.scrape "agora_scorer"`) — and remote-written to Mimir — deliberately, because the scraped
names are **deterministic** (exactly the instrument names: `agora_embeddings_total`,
`agora_embedding_duration_ms_bucket`, `agora_socket_active_connections`, …), which is what the bundled
dashboards query. The Node apps still emit OTLP metrics too, but Alloy drops those (its OTLP `metrics`
output is empty) so series are never double-counted; the scorer skips the OTLP metric exporter entirely
(scrape-only from the start — see the note above) to avoid the same 404s. The scorer has no *custom*
metrics yet, so its scraped series are auto-instrumentation RED metrics only.

> **Internal by design.** The `:9464` scrape endpoints and Tempo / Mimir / Loki are reachable only on
> the compose network, **never** through the public Caddy front door (a Prometheus endpoint must not be
> public). **Grafana** is the one exception — the front door routes `/grafana/*` to it (`GRAFANA_UPSTREAM`
> + `GF_SERVER_SERVE_FROM_SUB_PATH`), and in prod its direct `:3000` host port is dropped so it's reached
> **only** via `/grafana/` (behind a login). The `:9464`/Tempo/Mimir/Loki internal rule is unchanged.

### Bundled dashboards

Two dashboards auto-load into Grafana's **Agora** folder
([`deploy/observability/grafana/dashboards/`](../deploy/observability/grafana/dashboards/)):

- **Agora — Overview** — active realtime connections, socket events/sec, embedding throughput + latency
  (p50/p95/p99), automated-moderation decisions, feed-algorithm mix, and a recent-logs panel.
- **Agora — Logs** — per-service log volume + a live, filterable log stream (service + free-text vars).

They're editable in the UI (changes aren't written back to the JSON). Metric panels use the verified
instrument names; log panels key on the `service_name` label Alloy derives from each OTLP log's
`service.name`.

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

Open Grafana at **`/grafana/`** behind the Caddy front door (e.g. `https://localhost/grafana/`); in dev
the container also publishes the direct port **http://localhost:3000** (anonymous admin, local
convenience) — in prod that host port is dropped, so `/grafana/` is the only way in. The **Agora**
dashboard folder is pre-loaded — open **Agora — Overview** and **Agora — Logs** for the curated views.
To poke around raw:

- **Explore → Tempo** — search by service; you should see `agora-api`, `agora-secure-chat`, and the
  `agora-scorer-*` trio. A socket `join` and a Voyage embed produce spans.
- **Explore → Mimir** — `agora_embeddings_total`, `agora_socket_active_connections`,
  `agora_feed_requests_total` … (the custom instruments; scraped from `:9464`).
- **Explore → Loki** — `{service_name="agora-api"}`; each line carries `trace_id` → click **View trace**
  to jump to Tempo. Scorer log lines carry `trace_id` too.

```bash
# the Prometheus endpoints are live whenever the SDK is on (handy for a quick sanity check):
docker compose exec agora              curl -s localhost:9464/metrics | head
docker compose exec secure-chat        curl -s localhost:9464/metrics | head
docker compose exec scorer-worker      curl -s localhost:9464/metrics | head
```

### Bare deploys stay dark

Without `--profile observability` and with the default `OTEL_SDK_DISABLED=true`, the SDK **collects and
exports nothing** — no traces, no metric data, no OTLP pushes, no export warnings. (The Node Prometheus
server still binds `:9464` and serves a near-empty response — that's the exporter's own startup, not the
SDK — but compose never publishes `:9464` to the host, so nothing is reachable from outside the network.
The scorer's `:9464` doesn't even bind when disabled — `setup_telemetry` returns early before calling
`start_http_server`, so there's no caveat on the Python side.) Telemetry is strictly opt-in.

---

## The config: `wonder-logger.yaml`

The Node telemetry is declared in YAML, not code — both apps load
[`packages/core/wonder-logger.yaml`](../packages/core/wonder-logger.yaml) (the API also has an identical
[`apps/api/wonder-logger.yaml`](../apps/api/wonder-logger.yaml) for its SDK bootstrap). The shape:

```yaml
service:
  name: ${SERVICE_NAME:-agora-api}        # secure-chat overrides this to agora-secure-chat
  # version is NOT set here — it's injected programmatically at runtime from @agora/core's
  # package.json (lib/version.ts → createTelemetryFromConfig `overrides.serviceVersion`), so a
  # YAML placeholder can't go stale (SERVICE_VERSION/npm_package_version aren't set under `node dist`).
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

The `OTEL_SDK_DISABLED` env var is the master off switch (Node **and** Python) — it stops the SDK from
collecting or exporting anything, regardless of `otel.enabled` in the YAML. (One caveat on Node: the
Prometheus exporter binds `:9464` in its constructor, so the endpoint still *responds* when disabled — it
just serves no app series. It's internal-only in compose.)

---

## Environment variables

All optional. In compose these default to off-and-pre-wired-to-`alloy`; standalone they default to a
local collector at `localhost:4318`.

| Var | Default | Purpose |
|---|---|---|
| `OTEL_SDK_DISABLED` | `true` (compose) | The master switch. `false` turns telemetry on. Logging is unaffected. |
| `SERVICE_NAME` | `agora-api` | `service.name` (Node). secure-chat overrides via `SECURE_CHAT_SERVICE_NAME`. |
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
| `:9464/metrics` responds but has no `agora_*` series | Node: `OTEL_SDK_DISABLED=true` — the Prometheus server binds, but the SDK records nothing until enabled (set `false` + restart). |
| Logs in Loki have empty `trace_id` | Line logged outside an active span (e.g. at boot), or `traceContext`/scorer injection unavailable. |
| secure-chat shows up as `agora-api` | `SECURE_CHAT_SERVICE_NAME` / `SERVICE_NAME` not reaching the container — check the compose `environment` block. |
| scorer emits no traces, or `:9464` connection refused | Python OTel deps not installed in the image, or `OTEL_SDK_DISABLED=true` (the scorer's `:9464` doesn't bind at all when disabled — see [Bare deploys stay dark](#bare-deploys-stay-dark)). `setup_telemetry` logs a skip line. |
| Docker logs spam `Failed to export metrics batch code: 404` for a scorer container | Stale image predating the scrape-only metrics change — rebuild (`docker compose build scorer-worker scorer-toxicity scorer-relationship`). A current image never pushes OTLP metrics, so it can't hit this. |

---

## See also

- [`deploy/observability/`](../deploy/observability/) — the Alloy + LGTM stack (`README.md`, `config.alloy`, backend configs, Grafana datasources).
- [`apps/api/src/instrument.ts`](../apps/api/src/instrument.ts) · [`apps/secure-chat/src/instrument.ts`](../apps/secure-chat/src/instrument.ts) — the Node SDK bootstraps.
- [`apps/api/src/lib/telemetry.ts`](../apps/api/src/lib/telemetry.ts) · [`services/scorer/scorer/telemetry.py`](../services/scorer/scorer/telemetry.py) — custom instruments + the scorer bootstrap.
- [`@jenova-marie/wonder-logger`](https://www.npmjs.com/package/@jenova-marie/wonder-logger) — the Node telemetry framework, with its own `content/{CONFIGURATION,TRACING,METRICS}.md`.
- The **CLAUDE.md → Observability (OTel)** note for the in-repo design rationale (ops vs product metrics).
