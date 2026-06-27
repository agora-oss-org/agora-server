# Observability stack (`observability` compose profile)

A self-contained **Grafana Alloy → LGTM** stack for collecting Agora's built-in OpenTelemetry. It rides
on top of any data plane as an optional add-on — a bare `docker compose up` starts none of it.

```
@agora/api ┐
@agora/secure-chat ┤ OTLP (:4318) ─▶ Alloy ─┬─ traces ─▶ Tempo  ┐
services/scorer ───┘                        ├─ metrics ─▶ Mimir  ├─▶ Grafana :3000
                  (+ all container stdout) ──┴─ logs ───▶ Loki   ┘
```

| File | Service | Role |
|---|---|---|
| `config.alloy` | `alloy` | OTLP ingress (:4318/:4317) + container-log tailer → fans out to Tempo/Mimir/Loki |
| `tempo.yaml` | `tempo` | trace store (OTLP in on :4317, query on :3200) |
| `mimir.yaml` | `mimir` | metric store (OTLP in at `/otlp`, PromQL at `/prometheus`, :9009) |
| `loki-config.yaml` | `loki` | log store (push/query on :3100) |
| `grafana/provisioning/datasources/datasources.yaml` | `grafana` | the three datasources + trace↔log correlation |

## Run it

```bash
# data plane + the full stack (telemetry still off until the flag below)
docker compose --profile selfhost --profile observability up --build

# turn the apps' exporters on (single flag — endpoints are already pointed at `alloy`):
echo 'OTEL_SDK_DISABLED=false' >> .env     # then restart the app services
```

Open **Grafana at http://localhost:3000** (anonymous admin). You should see three services in Tempo
(`agora-api`, `agora-secure-chat`, the scorer trio), RED + custom metrics in Mimir, and logs in Loki
whose `trace_id` links straight to the trace.

> **Local-convenience defaults.** Grafana runs with anonymous admin and every backend writes to local
> disk with short retention — fine for a single host or demo. For a shared/production deploy: enable
> Grafana auth, point Tempo/Mimir/Loki at object storage, and front them with real retention/limits.
> The Prometheus endpoints (`:9464`) and these backends are reachable only on the compose network, never
> through the public Caddy front door.

Full walkthrough, env vars, and per-service signal table: [`docs/TELEMETRY.md`](../../docs/TELEMETRY.md).
