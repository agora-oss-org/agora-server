import { describe, expect, it } from "vitest";
import { canOpenJoint } from "./mediation.js";

// The pure gate behind a JOINT mediation room (steward + both parties together). The DB create/invite
// path is exercised live; this pins the safety rule: a joint room requires hybrid mode, no targeting,
// and both parties — caucus channels (steward ↔ one party) never need this gate.
describe("canOpenJoint", () => {
  it("allows only in hybrid mode with both parties and no targeting", () => {
    expect(canOpenJoint("hybrid", false, true)).toBe(true);
  });

  it("never allows in caucus mode", () => {
    expect(canOpenJoint("caucus", false, true)).toBe(false);
  });

  it("never allows a targeting (asymmetry) case — even in hybrid with both parties", () => {
    expect(canOpenJoint("hybrid", true, true)).toBe(false);
    expect(canOpenJoint("caucus", true, true)).toBe(false);
  });

  it("requires both parties present", () => {
    expect(canOpenJoint("hybrid", false, false)).toBe(false);
  });
});
