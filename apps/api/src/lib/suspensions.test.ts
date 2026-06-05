import { describe, expect, it } from "vitest";
import { isActiveSuspension } from "./suspensions.js";

// isActiveSuspension is the one place the suspension semantics live: active when it has started and not
// yet ended (null endDate = indefinite). The DB helpers + enforcement are covered by the integration suite.
const NOW = new Date("2026-06-05T12:00:00.000Z");
const at = (iso: string) => new Date(iso);

describe("isActiveSuspension", () => {
  it("is active when started and indefinite (null endDate)", () => {
    expect(isActiveSuspension(NOW, { startDate: at("2026-06-01T00:00:00Z"), endDate: null })).toBe(true);
  });

  it("is active when started and endDate is in the future", () => {
    expect(isActiveSuspension(NOW, { startDate: at("2026-06-04T00:00:00Z"), endDate: at("2026-06-06T00:00:00Z") })).toBe(true);
  });

  it("is inactive before it starts", () => {
    expect(isActiveSuspension(NOW, { startDate: at("2026-06-10T00:00:00Z"), endDate: null })).toBe(false);
  });

  it("is inactive once endDate has passed", () => {
    expect(isActiveSuspension(NOW, { startDate: at("2026-06-01T00:00:00Z"), endDate: at("2026-06-04T00:00:00Z") })).toBe(false);
  });

  it("treats endDate == now as already ended (exclusive upper bound)", () => {
    expect(isActiveSuspension(NOW, { startDate: at("2026-06-01T00:00:00Z"), endDate: NOW })).toBe(false);
  });

  it("treats startDate == now as started (inclusive lower bound)", () => {
    expect(isActiveSuspension(NOW, { startDate: NOW, endDate: null })).toBe(true);
  });
});
