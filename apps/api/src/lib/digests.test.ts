import { describe, expect, it } from "vitest";
import type { spaces } from "../db/schema/index.js";
import { hourInZone, isDue } from "./digests.js";

type SpaceRow = typeof spaces.$inferSelect;

// isDue only reads the digest* fields; build a minimal row and cast (the rest is irrelevant here).
const space = (over: Partial<SpaceRow>): SpaceRow =>
  ({
    digestEnabled: true,
    digestWebhookUrl: "https://example.test/hook",
    digestWebhookSecret: "s3cr3t",
    digestScheduleHour: 9,
    digestTimezone: "UTC",
    ...over,
  }) as SpaceRow;

describe("hourInZone", () => {
  it("returns the UTC hour when tz is null or 'UTC'", () => {
    const t = new Date("2026-01-15T18:30:00Z");
    expect(hourInZone(t, null)).toBe(18);
    expect(hourInZone(t, "UTC")).toBe(18);
  });

  it("shifts into a positive-offset zone (rolling into the next local day)", () => {
    // 18:30Z → 03:30 the next day in Tokyo (UTC+9). We only care about the hour: 3.
    expect(hourInZone(new Date("2026-01-15T18:30:00Z"), "Asia/Tokyo")).toBe(3);
  });

  it("is DST-aware: New York is UTC-5 in January but UTC-4 in July", () => {
    // 18:30Z → 13:30 EST (Jan) vs 14:30 EDT (Jul).
    expect(hourInZone(new Date("2026-01-15T18:30:00Z"), "America/New_York")).toBe(13);
    expect(hourInZone(new Date("2026-07-15T18:30:00Z"), "America/New_York")).toBe(14);
  });

  it("normalizes midnight to 0 (never the '24' some platforms render)", () => {
    expect(hourInZone(new Date("2026-01-15T00:00:00Z"), "UTC")).toBe(0);
  });

  it("falls back to the UTC hour for an unknown/garbage timezone", () => {
    const t = new Date("2026-01-15T18:30:00Z");
    expect(hourInZone(t, "Not/AZone")).toBe(18);
    expect(hourInZone(t, "garbage")).toBe(18);
  });
});

describe("isDue", () => {
  const now = new Date("2026-01-15T09:00:00Z"); // 09:00 UTC

  it("is due when opted in, fully configured, and the local hour matches", () => {
    expect(isDue(space({ digestScheduleHour: 9 }), now)).toBe(true);
  });

  it("is not due when the scheduled hour is not the current local hour", () => {
    expect(isDue(space({ digestScheduleHour: 10 }), now)).toBe(false);
  });

  it("respects the space's timezone when matching the hour", () => {
    // 09:00Z is 04:00 in New York (EST, UTC-5) → due only when scheduled for hour 4 there.
    expect(isDue(space({ digestTimezone: "America/New_York", digestScheduleHour: 4 }), now)).toBe(true);
    expect(isDue(space({ digestTimezone: "America/New_York", digestScheduleHour: 9 }), now)).toBe(false);
  });

  it("is never due when disabled", () => {
    expect(isDue(space({ digestEnabled: false, digestScheduleHour: 9 }), now)).toBe(false);
  });

  it("is never due when the webhook url or secret is missing", () => {
    expect(isDue(space({ digestWebhookUrl: null }), now)).toBe(false);
    expect(isDue(space({ digestWebhookSecret: null }), now)).toBe(false);
  });

  it("is never due when no schedule hour is set", () => {
    expect(isDue(space({ digestScheduleHour: null }), now)).toBe(false);
  });

  it("treats hour 0 (midnight) as a valid schedule, not 'unset'", () => {
    const midnight = new Date("2026-01-15T00:00:00Z");
    expect(isDue(space({ digestScheduleHour: 0 }), midnight)).toBe(true);
  });
});
