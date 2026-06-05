import { describe, expect, it } from "vitest";
import { shapeCase, shapeCaseEvent } from "./shape.js";

// shapeCase / shapeCaseEvent are pure row→model shapers for the steward caseload: camelCase passthrough,
// Date→ISO, and party/actor reduction to the lightweight UserSummary. (The routes + DB are exercised by
// the integration suite; these pin the shaping contract on its own.)
const D = new Date("2026-06-01T12:00:00.000Z");
const ISO = D.toISOString();

const user = (id: string) => ({
  id, projectId: "p1", foreignId: null, role: "visitor", name: `N ${id}`, username: id,
  avatar: null, avatarFileId: null, bannerFileId: null, bio: null, birthdate: null,
  location: null, metadata: {}, reputation: 7, createdAt: ISO,
}) as any;

const caseRow = {
  id: "c1", projectId: "p1", reportId: null, complainantId: "u1", respondentId: "u2",
  subjectType: "entity", subjectId: "e1", spaceId: null, summary: "beef", state: "open",
  outcome: null, asymmetry: false, resolutionNote: null, openedById: "u1", assignedToId: null,
  createdAt: D, updatedAt: D, closedAt: null,
} as any;

describe("shapeCase", () => {
  it("shapes a case with ISO dates + party summaries", () => {
    const out = shapeCase(caseRow, { complainant: user("u1"), respondent: user("u2") });
    expect(out.id).toBe("c1");
    expect(out.state).toBe("open");
    expect(out.createdAt).toBe(ISO);
    expect(out.closedAt).toBeNull();
    expect(out.complainant).toEqual({ id: "u1", username: "u1", name: "N u1", reputation: 7 });
    expect(out.respondent?.id).toBe("u2");
    expect(out.assignedTo).toBeNull();
    expect(out.openedBy).toBeNull();
  });

  it("defaults unsupplied parties to null", () => {
    const out = shapeCase(caseRow);
    expect(out.complainant).toBeNull();
    expect(out.respondent).toBeNull();
    expect(out.asymmetry).toBe(false);
  });

  it("serializes closedAt + outcome on a closed case", () => {
    const out = shapeCase({ ...caseRow, state: "closed", outcome: "repaired", closedAt: D, resolutionNote: "made up" });
    expect(out.state).toBe("closed");
    expect(out.outcome).toBe("repaired");
    expect(out.closedAt).toBe(ISO);
    expect(out.resolutionNote).toBe("made up");
  });
});

describe("shapeCaseEvent", () => {
  it("shapes an event with actor summary + meta", () => {
    const ev = { id: "ev1", caseId: "c1", actorId: "u1", kind: "state_change", body: null, meta: { from: "open", to: "in_mediation" }, createdAt: D } as any;
    const out = shapeCaseEvent(ev, user("u1"));
    expect(out.kind).toBe("state_change");
    expect(out.meta).toEqual({ from: "open", to: "in_mediation" });
    expect(out.actor?.username).toBe("u1");
    expect(out.createdAt).toBe(ISO);
  });

  it("null actor + null meta when absent", () => {
    const ev = { id: "ev2", caseId: "c1", actorId: null, kind: "note", body: "hi", meta: null, createdAt: D } as any;
    const out = shapeCaseEvent(ev);
    expect(out.actor).toBeNull();
    expect(out.meta).toBeNull();
    expect(out.body).toBe("hi");
  });
});
