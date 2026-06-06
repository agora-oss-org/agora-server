import { describe, expect, it } from "vitest";
import { stewardCaseRecipients, type StewardCaseKind } from "./notifications.js";

// The pure policy matrix behind steward-case notifications. The DB insert + webhook bridge are exercised
// elsewhere; this pins WHO gets notified, WITH WHAT, and WHEN — including the privacy guarantee that a
// respondent notification never carries the complainant's identity.
const CTX = { caseId: "case-1", complainantId: "C", respondentId: "R", subjectType: "comment" } as const;
const to = (notes: ReturnType<typeof stewardCaseRecipients>, id: string) => notes.filter((n) => n.recipientId === id);

describe("stewardCaseRecipients — power-aware", () => {
  const p = "power-aware" as const;
  it("notifies the complainant at every stage, the respondent at none (non-removal)", () => {
    for (const kind of ["opened", "in_mediation"] as StewardCaseKind[]) {
      const notes = stewardCaseRecipients(p, kind, null, CTX);
      expect(to(notes, "C")).toHaveLength(1);
      expect(to(notes, "R")).toHaveLength(0);
    }
    const dismissed = stewardCaseRecipients(p, "closed", "dismissed", CTX);
    expect(to(dismissed, "C")).toHaveLength(1);
    expect(to(dismissed, "R")).toHaveLength(0);
  });

  it("notifies the respondent (content-framed) only when content is removed/protected", () => {
    for (const outcome of ["escalated", "protective_action"]) {
      const notes = stewardCaseRecipients(p, "closed", outcome, CTX);
      const r = to(notes, "R");
      expect(r).toHaveLength(1);
      expect(r[0]!.type).toBe("steward-content-removed");
      expect(to(notes, "C")).toHaveLength(1); // complainant still told too
    }
  });
});

describe("stewardCaseRecipients — symmetric", () => {
  const p = "symmetric" as const;
  it("notifies both parties at every stage, case-framed", () => {
    for (const kind of ["opened", "in_mediation"] as StewardCaseKind[]) {
      const notes = stewardCaseRecipients(p, kind, null, CTX);
      expect(to(notes, "C")).toHaveLength(1);
      expect(to(notes, "R")).toHaveLength(1);
      expect(to(notes, "R")[0]!.type).toBe(notes.find((n) => n.recipientId === "C")!.type); // same case-framed type
    }
    const closed = stewardCaseRecipients(p, "closed", "escalated", CTX);
    expect(to(closed, "R")[0]!.type).toBe("steward-case-resolved"); // case-framed, not content-removed
  });
});

describe("stewardCaseRecipients — resolution-only", () => {
  const p = "resolution-only" as const;
  it("stays silent until close", () => {
    expect(stewardCaseRecipients(p, "opened", null, CTX)).toHaveLength(0);
    expect(stewardCaseRecipients(p, "in_mediation", null, CTX)).toHaveLength(0);
  });
  it("notifies complainant on close; respondent only on removal", () => {
    const dismissed = stewardCaseRecipients(p, "closed", "dismissed", CTX);
    expect(to(dismissed, "C")).toHaveLength(1);
    expect(to(dismissed, "R")).toHaveLength(0);
    const escalated = stewardCaseRecipients(p, "closed", "escalated", CTX);
    expect(to(escalated, "C")).toHaveLength(1);
    expect(to(escalated, "R")).toHaveLength(1);
  });
});

describe("stewardCaseRecipients — privacy + nulls", () => {
  it("never puts the complainant's identity in a respondent notification (any policy)", () => {
    for (const p of ["power-aware", "symmetric", "resolution-only"] as const) {
      for (const outcome of [null, "escalated", "dismissed", "protective_action"]) {
        for (const kind of ["opened", "in_mediation", "closed"] as StewardCaseKind[]) {
          for (const n of to(stewardCaseRecipients(p, kind, outcome, CTX), "R")) {
            expect(JSON.stringify(n.metadata)).not.toContain(CTX.complainantId);
          }
        }
      }
    }
  });

  it("skips a missing party", () => {
    const noResp = stewardCaseRecipients("symmetric", "opened", null, { caseId: "x", complainantId: "C" });
    expect(to(noResp, "C")).toHaveLength(1);
    expect(noResp.every((n) => n.recipientId === "C")).toBe(true);
    const noComplainant = stewardCaseRecipients("power-aware", "closed", "escalated", { caseId: "x", respondentId: "R" });
    expect(noComplainant.every((n) => n.recipientId === "R")).toBe(true);
  });
});
