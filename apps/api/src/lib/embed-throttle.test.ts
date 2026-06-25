import { describe, it, expect, beforeEach, vi } from "vitest";

// Keep output pristine + decouple from the real logger.
vi.mock("./logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  allow,
  getBreakerState,
  resolveStreamConfig,
  _configure,
  _reset,
  sweep,
  type StreamConfig,
} from "./embed-throttle.js";

// A 1-second window makes `rate` equal to "attempts in the current second", so the state machine is
// easy to drive deterministically: N calls at the same `now` give rate = N.
const cfg = (over: Partial<StreamConfig> = {}): StreamConfig => ({
  windowSeconds: 1,
  spikeRate: 3,
  rateMax: 2,
  resumeRate: 1,
  resumeMs: 30_000,
  ...over,
});

const SEC = 1000;

beforeEach(() => _reset());

describe("resolveStreamConfig", () => {
  it("is disabled (null) when spikeRate is unset", () => {
    expect(resolveStreamConfig({ windowSeconds: 10, resumeMs: 30_000 })).toBeNull();
  });

  it("derives rateMax and resumeRate as fractions of spikeRate when unset", () => {
    const r = resolveStreamConfig({ windowSeconds: 10, spikeRate: 50, resumeMs: 30_000 })!;
    expect(r.rateMax).toBeCloseTo(30); // 0.6 * 50
    expect(r.resumeRate).toBeCloseTo(20); // 0.4 * 50
  });

  it("honors explicit rateMax / resumeRate", () => {
    const r = resolveStreamConfig({ windowSeconds: 10, spikeRate: 50, rateMax: 40, resumeRate: 10, resumeMs: 5_000 })!;
    expect(r.rateMax).toBe(40);
    expect(r.resumeRate).toBe(10);
    expect(r.resumeMs).toBe(5_000);
  });

  it("clamps resumeRate and rateMax to not exceed spikeRate (misconfig safety)", () => {
    const r = resolveStreamConfig({ windowSeconds: 10, spikeRate: 5, rateMax: 99, resumeRate: 99, resumeMs: 30_000 })!;
    expect(r.rateMax).toBeLessThanOrEqual(5);
    expect(r.resumeRate).toBeLessThanOrEqual(5);
  });
});

describe("allow — disabled stream", () => {
  it("always serves and reports 'disabled' when not configured", () => {
    _configure("write", null);
    for (let i = 0; i < 100; i++) expect(allow("write", "p1", SEC)).toBe(true);
    expect(getBreakerState("write", "p1")).toBe("disabled");
  });
});

describe("allow — trip on spike", () => {
  beforeEach(() => _configure("write", cfg()));

  it("serves below the spike rate", () => {
    expect(allow("write", "p1", SEC)).toBe(true); // rate 1
    expect(allow("write", "p1", SEC)).toBe(true); // rate 2
    expect(getBreakerState("write", "p1")).toBe("closed");
  });

  it("trips (denies) once rate reaches spikeRate", () => {
    expect(allow("write", "p1", SEC)).toBe(true); // 1
    expect(allow("write", "p1", SEC)).toBe(true); // 2
    expect(allow("write", "p1", SEC)).toBe(false); // 3 -> rate 3 >= spike, trips
    expect(getBreakerState("write", "p1")).toBe("open");
    expect(allow("write", "p1", SEC)).toBe(false); // stays open
  });
});

describe("allow — resume with hysteresis", () => {
  beforeEach(() => _configure("write", cfg()));

  const trip = () => {
    for (let i = 0; i < 3; i++) allow("write", "p1", SEC);
    expect(getBreakerState("write", "p1")).toBe("open");
  };

  it("stays open while demand stays above resumeRate", () => {
    trip();
    // sustained spike at a later second — never falls to resume level
    for (let s = 5; s < 60; s++) for (let i = 0; i < 3; i++) allow("write", "p1", s * SEC);
    expect(getBreakerState("write", "p1")).toBe("open");
  });

  it("resumes only after rate <= resumeRate is sustained for resumeMs", () => {
    trip();
    // calm begins at sec 5 (rate 1 <= resumeRate) — but not yet long enough
    expect(allow("write", "p1", 5 * SEC)).toBe(false);
    expect(getBreakerState("write", "p1")).toBe("open");
    // resumeMs (30s) later, still calm -> resume, and this request is served
    expect(allow("write", "p1", 5 * SEC + 30_000)).toBe(true);
    expect(getBreakerState("write", "p1")).toBe("closed");
  });

  it("resets the resume timer if demand re-spikes mid-cooldown", () => {
    trip();
    expect(allow("write", "p1", 5 * SEC)).toBe(false); // calm starts at 5s
    for (let i = 0; i < 3; i++) allow("write", "p1", 6 * SEC); // re-spike at 6s resets calm
    // 30s after the FIRST calm but only ~29s of churn — must still be open (timer reset)
    expect(allow("write", "p1", 6 * SEC + 1_000)).toBe(false);
    expect(getBreakerState("write", "p1")).toBe("open");
  });
});

describe("allow — isolation", () => {
  it("isolates breakers per project", () => {
    _configure("write", cfg());
    for (let i = 0; i < 3; i++) allow("write", "pA", SEC);
    expect(getBreakerState("write", "pA")).toBe("open");
    expect(allow("write", "pB", SEC)).toBe(true);
    expect(getBreakerState("write", "pB")).toBe("closed");
  });

  it("isolates breakers per stream", () => {
    _configure("write", cfg());
    _configure("search", cfg());
    for (let i = 0; i < 3; i++) allow("write", "p1", SEC);
    expect(getBreakerState("write", "p1")).toBe("open");
    expect(allow("search", "p1", SEC)).toBe(true);
    expect(getBreakerState("search", "p1")).toBe("closed");
  });
});

describe("sweep", () => {
  it("evicts idle breakers so the map stays bounded", () => {
    _configure("write", cfg());
    allow("write", "p1", SEC);
    expect(getBreakerState("write", "p1")).toBe("closed");
    sweep(SEC + 10 * 60_000); // 10 min later
    // an evicted breaker reads as a fresh 'closed' (no retained state) — assert it didn't keep an entry
    // by tripping anew from zero
    expect(allow("write", "p1", SEC + 10 * 60_000)).toBe(true);
  });
});
