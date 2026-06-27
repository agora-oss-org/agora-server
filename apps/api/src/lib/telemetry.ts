// Ops-layer OpenTelemetry instruments for @agora/api — custom counters/histograms layered over the
// auto-instrumentation RED baseline (HTTP + DB). These surface product-ops signal the auto-metrics
// can't: embedding latency, automated-moderation decisions, feed-algorithm mix, and the realtime
// (socket.io) path the HTTP instrumentation never sees.
//
// This is the OPS layer. It is deliberately SEPARATE from lib/metrics.ts (`api_usage`), which is the
// per-project PRODUCT metering behind the admin dashboard. Don't conflate them.
//
// No-op-safe: the @opentelemetry/api global is a no-op until the SDK registers a MeterProvider. The SDK
// starts first (src/instrument.ts, imported before any route/lib), so by the time this module loads the
// instruments are live; under disabled telemetry / unit tests they're cheap no-ops. Every call site is
// therefore guard-free — never wrap these in `if (telemetryEnabled)`.
import { metrics } from "@opentelemetry/api";

// Re-exported for manual tracing of non-HTTP/DB work (socket.io handlers). Auto-records span
// status/exceptions and rethrows; see lib usage in realtime/socket.ts.
export { withSpan } from "@jenova-marie/wonder-logger";

// Metric identifiers in one place so the names are greppable and a refactor can't silently rename a
// dashboard's series out from under it (the .test.ts pins these).
export const METRIC_NAMES = {
  embeddingDurationMs: "agora_embedding_duration_ms",
  embeddingsTotal: "agora_embeddings_total",
  moderationDecisionsTotal: "agora_moderation_decisions_total",
  feedRequestsTotal: "agora_feed_requests_total",
  socketActiveConnections: "agora_socket_active_connections",
  socketEventsTotal: "agora_socket_events_total",
} as const;

const meter = metrics.getMeter("agora-api");

// ── Embeddings (Voyage) — every embedText() call, labelled by input_type (query|document) + status ──
export const embeddingDurationMs = meter.createHistogram(METRIC_NAMES.embeddingDurationMs, {
  description: "Voyage embedding call latency",
  unit: "ms",
});
export const embeddingsTotal = meter.createCounter(METRIC_NAMES.embeddingsTotal, {
  description: "Voyage embedding calls by input_type and status",
});

// ── Moderation — automated ('client') decisions written by the scorer via applyClientModeration ──
export const moderationDecisionsTotal = meter.createCounter(METRIC_NAMES.moderationDecisionsTotal, {
  description: "Automated moderation decisions by target type and action",
});

// ── Feed ranking — one increment per feed list request, labelled by the resolved algorithm ──
export const feedRequestsTotal = meter.createCounter(METRIC_NAMES.feedRequestsTotal, {
  description: "Feed list requests by ranking algorithm",
});

// ── Realtime (socket.io) — the path HTTP auto-instrumentation never traces ──
export const socketActiveConnections = meter.createUpDownCounter(METRIC_NAMES.socketActiveConnections, {
  description: "Currently-connected realtime socket.io clients",
});
export const socketEventsTotal = meter.createCounter(METRIC_NAMES.socketEventsTotal, {
  description: "Inbound socket.io events by name",
});
