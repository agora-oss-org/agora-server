import { describe, it, expect, vi, afterEach } from "vitest";
import { relativeTime, shortId } from "./time.js";

describe("relativeTime", () => {
  afterEach(() => vi.useRealTimers());

  const at = (now: string) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
  };

  it("returns an em dash for null/undefined/invalid input", () => {
    expect(relativeTime(null)).toBe("—");
    expect(relativeTime(undefined)).toBe("—");
    expect(relativeTime("not a date")).toBe("—");
  });

  it("says 'just now' within 5 seconds", () => {
    at("2026-01-01T00:00:03Z");
    expect(relativeTime("2026-01-01T00:00:00Z")).toBe("just now");
  });

  it("formats seconds, minutes, hours, and days ago", () => {
    at("2026-01-01T12:00:00Z");
    expect(relativeTime("2026-01-01T11:59:30Z")).toBe("30s ago");
    expect(relativeTime("2026-01-01T11:55:00Z")).toBe("5m ago");
    expect(relativeTime("2026-01-01T09:00:00Z")).toBe("3h ago");
    expect(relativeTime("2025-12-29T12:00:00Z")).toBe("3d ago");
  });

  it("falls back to a locale date for anything a week or older", () => {
    at("2026-01-10T12:00:00Z");
    const out = relativeTime("2026-01-01T12:00:00Z"); // 9 days ago
    expect(out).not.toMatch(/ago|just now|—/);
    expect(out).toBe(new Date("2026-01-01T12:00:00Z").toLocaleDateString());
  });

  it("clamps a future timestamp to 'just now' (never negative)", () => {
    at("2026-01-01T00:00:00Z");
    expect(relativeTime("2026-01-01T00:01:00Z")).toBe("just now");
  });
});

describe("shortId", () => {
  it("takes the first 8 chars", () => {
    expect(shortId("11111111-2222-3333-4444-555555555555")).toBe("11111111");
  });
  it("returns an em dash for empty input", () => {
    expect(shortId(null)).toBe("—");
    expect(shortId(undefined)).toBe("—");
  });
});
