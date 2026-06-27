// Telemetry-helper contract: stable metric names + no-op safety with no SDK registered (the unit-test
// world — vitest never starts instrument.ts). The real export/aggregation path is exercised by the
// docker observability stack (docs/TELEMETRY.md), not here.
import { describe, it, expect } from "vitest";
import {
  METRIC_NAMES,
  embeddingDurationMs,
  embeddingsTotal,
  moderationDecisionsTotal,
  feedRequestsTotal,
  socketActiveConnections,
  socketEventsTotal,
  withSpan,
} from "./telemetry.js";

describe("telemetry metric names", () => {
  it("are stable and all namespaced under agora_", () => {
    // Pin the wire names — a dashboard/alert references these strings, so a silent rename is a break.
    expect(METRIC_NAMES).toEqual({
      embeddingDurationMs: "agora_embedding_duration_ms",
      embeddingsTotal: "agora_embeddings_total",
      moderationDecisionsTotal: "agora_moderation_decisions_total",
      feedRequestsTotal: "agora_feed_requests_total",
      socketActiveConnections: "agora_socket_active_connections",
      socketEventsTotal: "agora_socket_events_total",
    });
    for (const name of Object.values(METRIC_NAMES)) expect(name).toMatch(/^agora_[a-z_]+$/);
  });
});

describe("instruments are no-op-safe without a registered SDK", () => {
  it("recording never throws (telemetry disabled / tests)", () => {
    expect(() => {
      embeddingsTotal.add(1, { input_type: "query", status: "ok" });
      embeddingDurationMs.record(12.5, { input_type: "document" });
      moderationDecisionsTotal.add(1, { target: "entity", action: "removed", matched: "true" });
      feedRequestsTotal.add(1, { algorithm: "hot" });
      socketActiveConnections.add(1);
      socketActiveConnections.add(-1);
      socketEventsTotal.add(1, { event: "join:conversation" });
    }).not.toThrow();
  });

  it("withSpan runs the wrapped fn and returns its value, exceptions propagate", async () => {
    await expect(withSpan("test-span", async () => 42)).resolves.toBe(42);
    await expect(withSpan("test-span", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  });
});
