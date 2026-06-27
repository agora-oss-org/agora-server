# Observability stack (`observability` compose profile)

A self-contained **Grafana Alloy → LGTM** stack for collecting Agora's built-in OpenTelemetry. It rides
on top of any data plane as an optional add-on — a bare `docker compose up` starts none of it.

```
@agora/api ┐                            ┌─ traces (OTLP) ─▶ Tempo  ┐
@agora/secure-chat ┤ OTLP (:4318) ─▶ Alloy ┼─ logs   (OTLP) ─▶ Loki   ├─▶ Grafana :3000
services/scorer ───┘                       └─ metrics (scrape :9464 → remote-write) ─▶ Mimir ┘
```

**Traces + logs** are pushed via OTLP. **Metrics** are *scraped* from the Node apps' Prometheus
endpoints (`:9464`) and remote-written to Mimir — so the metric names are deterministic (exactly the
instrument names the dashboards query), and never double-counted against the apps' OTLP metrics.

| File | Service | Role |
|---|---|---|
| `config.alloy` | `alloy` | OTLP ingress (traces+logs) + Prometheus scrape (metrics) → fans out to Tempo/Mimir/Loki |
| `tempo.yaml` | `tempo` | trace store (OTLP in on :4317, query on :3200) |
| `mimir.yaml` | `mimir` | metric store (remote-write at `/api/v1/push`, PromQL at `/prometheus`, :9009) |
| `loki-config.yaml` | `loki` | log store (push/query on :3100) |
| `grafana/provisioning/datasources/datasources.yaml` | `grafana` | the three datasources + trace↔log correlation |
| `grafana/provisioning/dashboards/dashboards.yaml` + `grafana/dashboards/*.json` | `grafana` | **auto-loaded dashboards** (Agora folder): **Overview** + **Logs** |

## Run it

```bash
# data plane + the full stack (telemetry still off until the flag below)
docker compose --profile selfhost --profile observability up --build

# turn the apps' exporters on (single flag — endpoints are already pointed at `alloy`):
echo 'OTEL_SDK_DISABLED=false' >> .env     # then restart the app services
```

Open **Grafana at http://localhost:3000** (anonymous admin). Two dashboards auto-load under the
**Agora** folder:

- **Agora — Overview** — live realtime connections, socket events, embedding throughput + latency
  (p50/p95/p99), automated-moderation decisions, feed-algorithm mix, and a recent-logs panel.
- **Agora — Logs** — per-service log volume + a live, filterable log stream (service + free-text vars).

You'll also see three services in Tempo (`agora-api`, `agora-secure-chat`, the scorer trio) and logs in
Loki whose `trace_id` links straight to the trace.

> The metric panels query the verified instrument names (`agora_embeddings_total`,
> `agora_socket_active_connections`, …). The log panels key on the `service_name` label Alloy derives
> from each OTLP log's `service.name`; if your collector maps it differently, adjust the panel queries.

> **Local-convenience defaults.** Grafana runs with anonymous admin and every backend writes to local
> disk with short retention — fine for a single host or demo. For a shared/production deploy: enable
> Grafana auth, point Tempo/Mimir/Loki at object storage, and front them with real retention/limits.
> The Prometheus endpoints (`:9464`) and these backends are reachable only on the compose network, never
> through the public Caddy front door.

Full walkthrough, env vars, and per-service signal table: [`docs/TELEMETRY.md`](../../docs/TELEMETRY.md).
