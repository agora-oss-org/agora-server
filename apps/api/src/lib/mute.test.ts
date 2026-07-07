import { describe, it, expect } from "vitest";
import { muteDurationToState, isConversationMuted } from "./mute.js";

const NOW = new Date("2026-07-07T12:00:00.000Z");

describe("muteDurationToState", () => {
  it("8h/24h/1w set a future muted_until, forever=false", () => {
    expect(muteDurationToState("8h", NOW)).toEqual({ mutedUntil: new Date("2026-07-07T20:00:00.000Z"), mutedForever: false });
    expect(muteDurationToState("24h", NOW)).toEqual({ mutedUntil: new Date("2026-07-08T12:00:00.000Z"), mutedForever: false });
    expect(muteDurationToState("1w", NOW)).toEqual({ mutedUntil: new Date("2026-07-14T12:00:00.000Z"), mutedForever: false });
  });
  it("forever → mutedUntil null, forever true", () => {
    expect(muteDurationToState("forever", NOW)).toEqual({ mutedUntil: null, mutedForever: true });
  });
  it("null clears both", () => {
    expect(muteDurationToState(null, NOW)).toEqual({ mutedUntil: null, mutedForever: false });
  });
});

describe("isConversationMuted", () => {
  it("forever is always muted", () => {
    expect(isConversationMuted({ mutedUntil: null, mutedForever: true }, NOW)).toBe(true);
  });
  it("timed mute active until its instant", () => {
    expect(isConversationMuted({ mutedUntil: new Date("2026-07-07T13:00:00.000Z"), mutedForever: false }, NOW)).toBe(true);
    expect(isConversationMuted({ mutedUntil: new Date("2026-07-07T11:00:00.000Z"), mutedForever: false }, NOW)).toBe(false);
  });
  it("not muted when both empty", () => {
    expect(isConversationMuted({ mutedUntil: null, mutedForever: false }, NOW)).toBe(false);
  });
});
