import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { stewardCases, stewardCaseEvents, projectStewards } from "../../src/db/schema/index.js";
import { api, signToken, createProject, createUser, deleteProject, base } from "./helpers.js";

describe("Stewardship: Cases & Conflict Resolution", () => {
  let projectId: string;
  let steward: { id: string; token: string };
  let operator: { id: string; token: string };
  let complainant: { id: string; token: string };
  let respondent: { id: string; token: string };
  let member: { id: string; token: string };

  beforeAll(async () => {
    projectId = await createProject();
    steward = await createUser(projectId);
    operator = await createUser(projectId);
    complainant = await createUser(projectId);
    respondent = await createUser(projectId);
    member = await createUser(projectId);

    // Grant steward role to steward user
    await db.insert(projectStewards).values({
      projectId,
      profileId: steward.id,
      grantedById: operator.id,
    });

    // Re-mint tokens with steward/operator flags
    steward.token = await signToken(steward.id, "visitor", false, true);
    operator.token = await signToken(operator.id, "visitor", true, false);
  });

  afterAll(async () => {
    await deleteProject(projectId);
  });

  describe("Case Lifecycle — Happy Path", () => {
    it("opens a case cold (no report)", async () => {
      const res = await api("POST", `${base(projectId)}/steward/cases`, {
        token: steward.token,
        body: {
          complainantId: complainant.id,
          respondentId: respondent.id,
          summary: "Conflict between members",
        },
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        state: "open",
        outcome: null,
        closedAt: null,
        complainant: { id: complainant.id },
        respondent: { id: respondent.id },
      });
    });

    it("opens a case from a report (seeds target + reporter)", async () => {
      // Create an entity and a report against it
      const entityRes = await api("POST", `${base(projectId)}/entities`, {
        token: member.token,
        body: { content: "Test entity" },
      });
      const entityId = entityRes.body.id;

      const reportRes = await api("POST", `${base(projectId)}/reports`, {
        token: complainant.token,
        body: {
          targetType: "entity",
          targetId: entityId,
          reason: "Inappropriate content",
        },
      });
      const reportId = reportRes.body.id;

      // Open case from report
      const caseRes = await api("POST", `${base(projectId)}/steward/cases`, {
        token: steward.token,
        body: { reportId },
      });
      expect(caseRes.status).toBe(201);
      expect(caseRes.body).toMatchObject({
        state: "open",
        subjectType: "entity",
        subjectId: entityId,
        complainant: { id: complainant.id }, // seeded from report
      });
    });

    it("transitions case: open → in_mediation", async () => {
      const openRes = await api("POST", `${base(projectId)}/steward/cases`, {
        token: steward.token,
        body: { complainantId: complainant.id, respondentId: respondent.id, summary: "Test" },
      });
      const caseId = openRes.body.id;

      const updateRes = await api("PATCH", `${base(projectId)}/steward/cases/${caseId}`, {
        token: steward.token,
        body: { state: "in_mediation" },
      });
      expect(updateRes.status).toBe(200);
      expect(updateRes.body).toMatchObject({
        state: "in_mediation",
        outcome: null,
        closedAt: null,
      });
    });

    it("transitions case: in_mediation → closed with outcome", async () => {
      const openRes = await api("POST", `${base(projectId)}/steward/cases`, {
        token: steward.token,
        body: { complainantId: complainant.id, respondentId: respondent.id, summary: "Test" },
      });
      const caseId = openRes.body.id;

      // Move to mediation
      await api("PATCH", `${base(projectId)}/steward/cases/${caseId}`, {
        token: steward.token,
        body: { state: "in_mediation" },
      });

      // Close with outcome
      const closeRes = await api("PATCH", `${base(projectId)}/steward/cases/${caseId}`, {
        token: steward.token,
        body: { outcome: "repaired", resolutionNote: "Parties agreed to reconcile" },
      });
      expect(closeRes.status).toBe(200);
      expect(closeRes.body).toMatchObject({
        state: "closed",
        outcome: "repaired",
        closedAt: expect.any(String), // ISO date
      });
    });

    it("escalates case: removes entity + closes with escalated outcome", async () => {
      // Create entity to remove
      const entityRes = await api("POST", `${base(projectId)}/entities`, {
        token: member.token,
        body: { content: "Entity to remove" },
      });
      const entityId = entityRes.body.id;

      // Open case with entity as subject
      const caseRes = await api("POST", `${base(projectId)}/steward/cases`, {
        token: steward.token,
        body: {
          complainantId: complainant.id,
          respondentId: respondent.id,
          subjectType: "entity",
          subjectId: entityId,
          summary: "Inappropriate content",
        },
      });
      const caseId = caseRes.body.id;

      // Escalate: remove entity + close case
      const escalateRes = await api("POST", `${base(projectId)}/steward/cases/${caseId}/escalate`, {
        token: steward.token,
        body: { reason: "Violates community guidelines" },
      });
      expect(escalateRes.status).toBe(200);
      expect(escalateRes.body).toMatchObject({
        state: "closed",
        outcome: "escalated",
        closedAt: expect.any(String),
      });

      // Verify entity is removed (operator can see, non-operator 404)
      const readRes = await api("GET", `${base(projectId)}/entities/${entityId}`, {
        token: member.token,
      });
      expect(readRes.status).toBe(404);
    });

    it("escalates case: removes comment + closes with escalated outcome", async () => {
      // Create entity + comment
      const entityRes = await api("POST", `${base(projectId)}/entities`, {
        token: member.token,
        body: { content: "Parent entity" },
      });
      const entityId = entityRes.body.id;

      const commentRes = await api("POST", `${base(projectId)}/comments`, {
        token: member.token,
        body: { entityId, content: "Comment to remove" },
      });
      const commentId = commentRes.body.id;

      // Open case with comment as subject
      const caseRes = await api("POST", `${base(projectId)}/steward/cases`, {
        token: steward.token,
        body: {
          complainantId: complainant.id,
          respondentId: respondent.id,
          subjectType: "comment",
          subjectId: commentId,
          summary: "Inappropriate comment",
        },
      });
      const caseId = caseRes.body.id;

      // Escalate
      const escalateRes = await api("POST", `${base(projectId)}/steward/cases/${caseId}/escalate`, {
        token: steward.token,
        body: { reason: "Harassing comment" },
      });
      expect(escalateRes.status).toBe(200);
      expect(escalateRes.body.outcome).toBe("escalated");

      // Verify comment is removed (hidden from non-privileged on single read)
      const readRes = await api("GET", `${base(projectId)}/comments/${commentId}`, {
        token: member.token,
      });
      expect(readRes.status).toBe(404);
    });
  });

  describe("Case Assignment & State Transitions", () => {
    it("assigns case to different steward (creates assignment event)", async () => {
      const openRes = await api("POST", `${base(projectId)}/steward/cases`, {
        token: steward.token,
        body: { complainantId: complainant.id, respondentId: respondent.id, summary: "Test" },
      });
      const caseId = openRes.body.id;

      const assignRes = await api("PATCH", `${base(projectId)}/steward/cases/${caseId}`, {
        token: steward.token,
        body: { assignedToId: respondent.id }, // Reassign to another steward
      });
      expect(assignRes.status).toBe(200);
      expect(assignRes.body.assignedTo?.id).toBe(respondent.id);

      // Verify assignment event created
      const caseRow = await db.select().from(stewardCases).where(eq(stewardCases.id, caseId));
      const events = await db.select().from(stewardCaseEvents).where(eq(stewardCaseEvents.caseId, caseId));
      const assignmentEvent = events.find((e) => e.kind === "assignment");
      expect(assignmentEvent).toBeDefined();
      expect(assignmentEvent?.meta).toEqual({ from: null, to: respondent.id });
    });

    it("reassigns from userId → null (unassign for triage)", async () => {
      const openRes = await api("POST", `${base(projectId)}/steward/cases`, {
        token: steward.token,
        body: { complainantId: complainant.id, respondentId: respondent.id, summary: "Test" },
      });
      const caseId = openRes.body.id;

      // Assign (open doesn't take an assignee — it's a separate PATCH).
      await api("PATCH", `${base(projectId)}/steward/cases/${caseId}`, {
        token: steward.token,
        body: { assignedToId: steward.id },
      });

      const unassignRes = await api("PATCH", `${base(projectId)}/steward/cases/${caseId}`, {
        token: steward.token,
        body: { assignedToId: null },
      });
      expect(unassignRes.status).toBe(200);
      expect(unassignRes.body.assignedTo).toBeNull();
    });

    it("toggles asymmetry flag (power-aware marking)", async () => {
      const openRes = await api("POST", `${base(projectId)}/steward/cases`, {
        token: steward.token,
        body: { complainantId: complainant.id, respondentId: respondent.id, summary: "Test" },
      });
      const caseId = openRes.body.id;

      const toggleRes = await api("PATCH", `${base(projectId)}/steward/cases/${caseId}`, {
        token: steward.token,
        body: { asymmetry: true },
      });
      expect(toggleRes.status).toBe(200);
      expect(toggleRes.body.asymmetry).toBe(true);

      // Verify asymmetry event
      const events = await db.select().from(stewardCaseEvents).where(eq(stewardCaseEvents.caseId, caseId));
      const asymmetryEvent = events.find((e) => e.kind === "asymmetry");
      expect(asymmetryEvent?.meta).toEqual({ asymmetry: true });
    });
  });

  describe("Case Queries & Filtering", () => {
    it("lists open cases (default scope)", async () => {
      // Create multiple cases in different states
      const openRes = await api("POST", `${base(projectId)}/steward/cases`, {
        token: steward.token,
        body: { complainantId: complainant.id, respondentId: respondent.id, summary: "Open case" },
      });
      const openCaseId = openRes.body.id;

      const closedRes = await api("POST", `${base(projectId)}/steward/cases`, {
        token: steward.token,
        body: { complainantId: complainant.id, respondentId: respondent.id, summary: "To close" },
      });
      const closedCaseId = closedRes.body.id;
      await api("PATCH", `${base(projectId)}/steward/cases/${closedCaseId}`, {
        token: steward.token,
        body: { outcome: "dismissed" },
      });

      // List defaults to non-closed
      const listRes = await api("GET", `${base(projectId)}/steward/cases`, {
        token: steward.token,
      });
      expect(listRes.status).toBe(200);
      const ids = listRes.body.data.map((c: any) => c.id);
      expect(ids).toContain(openCaseId);
      expect(ids).not.toContain(closedCaseId);
    });

    it("filters by state (open, in_mediation, closed, all)", async () => {
      // Create cases in each state
      const openRes = await api("POST", `${base(projectId)}/steward/cases`, {
        token: steward.token,
        body: { complainantId: complainant.id, respondentId: respondent.id, summary: "Open" },
      });

      const mediationRes = await api("POST", `${base(projectId)}/steward/cases`, {
        token: steward.token,
        body: { complainantId: complainant.id, respondentId: respondent.id, summary: "Mediation" },
      });
      await api("PATCH", `${base(projectId)}/steward/cases/${mediationRes.body.id}`, {
        token: steward.token,
        body: { state: "in_mediation" },
      });

      // List with state filter
      const closedListRes = await api("GET", `${base(projectId)}/steward/cases?state=closed`, {
        token: steward.token,
      });
      expect(closedListRes.body.data.every((c: any) => c.state === "closed")).toBe(true);

      const allListRes = await api("GET", `${base(projectId)}/steward/cases?state=all`, {
        token: steward.token,
      });
      expect(allListRes.body.data.length).toBeGreaterThan(0);
    });

    it("filters by assignment (assigned to me, to specific user)", async () => {
      const openRes = await api("POST", `${base(projectId)}/steward/cases`, {
        token: steward.token,
        body: { complainantId: complainant.id, respondentId: respondent.id, summary: "Assigned to steward" },
      });
      const caseId = openRes.body.id;

      // Assign to the steward (open doesn't accept an assignee).
      await api("PATCH", `${base(projectId)}/steward/cases/${caseId}`, {
        token: steward.token,
        body: { assignedToId: steward.id },
      });

      // Filter by "me"
      const meRes = await api("GET", `${base(projectId)}/steward/cases?assigned=me`, {
        token: steward.token,
      });
      expect(meRes.status).toBe(200);
      const ids = meRes.body.data.map((c: any) => c.id);
      expect(ids).toContain(caseId);
    });

    it("paginates cases (offset envelope: page/pageSize/totalItems/hasMore)", async () => {
      // Create multiple cases
      for (let i = 0; i < 5; i++) {
        await api("POST", `${base(projectId)}/steward/cases`, {
          token: steward.token,
          body: { complainantId: complainant.id, respondentId: respondent.id, summary: `Case ${i}` },
        });
      }

      // First page — the list uses the standard offset envelope, not a cursor.
      const page1Res = await api("GET", `${base(projectId)}/steward/cases?limit=2`, {
        token: steward.token,
      });
      expect(page1Res.status).toBe(200);
      expect(page1Res.body.data.length).toBe(2);
      expect(page1Res.body.pagination).toMatchObject({
        page: 1,
        pageSize: 2,
        hasMore: true,
      });
      expect(page1Res.body.pagination.totalItems).toBeGreaterThanOrEqual(5);
    });
  });

  describe("Timeline & Events", () => {
    it("appends correct event type for each mutation (state_change, assignment, outcome, escalation)", async () => {
      const openRes = await api("POST", `${base(projectId)}/steward/cases`, {
        token: steward.token,
        body: { complainantId: complainant.id, respondentId: respondent.id, summary: "Test" },
      });
      const caseId = openRes.body.id;

      // Verify "opened" event
      let events = await db.select().from(stewardCaseEvents).where(eq(stewardCaseEvents.caseId, caseId));
      expect(events.some((e) => e.kind === "opened")).toBe(true);

      // Mutate state
      await api("PATCH", `${base(projectId)}/steward/cases/${caseId}`, {
        token: steward.token,
        body: { state: "in_mediation" },
      });
      events = await db.select().from(stewardCaseEvents).where(eq(stewardCaseEvents.caseId, caseId));
      expect(events.some((e) => e.kind === "state_change")).toBe(true);

      // Mutate assignment
      await api("PATCH", `${base(projectId)}/steward/cases/${caseId}`, {
        token: steward.token,
        body: { assignedToId: respondent.id },
      });
      events = await db.select().from(stewardCaseEvents).where(eq(stewardCaseEvents.caseId, caseId));
      expect(events.some((e) => e.kind === "assignment")).toBe(true);
    });

    it("orders timeline by createdAt ASC (oldest to newest)", async () => {
      const openRes = await api("POST", `${base(projectId)}/steward/cases`, {
        token: steward.token,
        body: { complainantId: complainant.id, respondentId: respondent.id, summary: "Test" },
      });
      const caseId = openRes.body.id;

      // Make multiple mutations
      await api("PATCH", `${base(projectId)}/steward/cases/${caseId}`, {
        token: steward.token,
        body: { state: "in_mediation" },
      });
      await api("PATCH", `${base(projectId)}/steward/cases/${caseId}`, {
        token: steward.token,
        body: { assignedToId: respondent.id },
      });

      // Fetch case detail + timeline
      const detailRes = await api("GET", `${base(projectId)}/steward/cases/${caseId}`, {
        token: steward.token,
      });
      const timeline = detailRes.body.events;
      for (let i = 1; i < timeline.length; i++) {
        expect(new Date(timeline[i].createdAt).getTime()).toBeGreaterThanOrEqual(
          new Date(timeline[i - 1].createdAt).getTime(),
        );
      }
    });

    it("hydrates event actors (steward names, IDs)", async () => {
      const openRes = await api("POST", `${base(projectId)}/steward/cases`, {
        token: steward.token,
        body: { complainantId: complainant.id, respondentId: respondent.id, summary: "Test" },
      });
      const caseId = openRes.body.id;

      const detailRes = await api("GET", `${base(projectId)}/steward/cases/${caseId}`, {
        token: steward.token,
      });
      const timeline = detailRes.body.events;
      const openedEvent = timeline.find((e: any) => e.kind === "opened");
      expect(openedEvent?.actor).toBeDefined();
      expect(openedEvent?.actor.id).toBe(steward.id);
    });
  });

  describe("Authorization Boundaries", () => {
    it("rejects non-steward on case operations (403)", async () => {
      const res = await api("POST", `${base(projectId)}/steward/cases`, {
        token: member.token,
        body: { complainantId: complainant.id, respondentId: respondent.id, summary: "Test" },
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("steward/forbidden");
    });

    it("rejects a non-owner on steward grant/revoke (403)", async () => {
      const grantRes = await api("POST", `${base(projectId)}/steward/stewards`, {
        token: steward.token,
        body: { userId: member.id },
      });
      expect(grantRes.status).toBe(403);
      expect(grantRes.body.code).toBe("roles/owner-only");

      const revokeRes = await api("DELETE", `${base(projectId)}/steward/stewards/${steward.id}`, {
        token: steward.token,
      });
      expect(revokeRes.status).toBe(403);
    });

    it("allows operator to grant steward role", async () => {
      const grantRes = await api("POST", `${base(projectId)}/steward/stewards`, {
        token: operator.token,
        body: { userId: member.id },
      });
      expect(grantRes.status).toBe(201);
    });

    it("allows operator to revoke steward role", async () => {
      // First grant
      await api("POST", `${base(projectId)}/steward/stewards`, {
        token: operator.token,
        body: { userId: member.id },
      });

      // Then revoke
      const revokeRes = await api("DELETE", `${base(projectId)}/steward/stewards/${member.id}`, {
        token: operator.token,
      });
      expect(revokeRes.status).toBe(200);
    });
  });

  describe("Edge Cases & Boundaries", () => {
    it("rejects escalate without subjectType/subjectId (400)", async () => {
      const openRes = await api("POST", `${base(projectId)}/steward/cases`, {
        token: steward.token,
        body: { complainantId: complainant.id, respondentId: respondent.id, summary: "No subject" },
      });
      const caseId = openRes.body.id;

      const escalateRes = await api("POST", `${base(projectId)}/steward/cases/${caseId}/escalate`, {
        token: steward.token,
        body: { reason: "Test" },
      });
      expect(escalateRes.status).toBe(400);
      expect(escalateRes.body.code).toBe("steward/no-subject");
    });

    it("rejects direct PATCH outcome=escalated (must use POST /escalate)", async () => {
      // Create entity to remove
      const entityRes = await api("POST", `${base(projectId)}/entities`, {
        token: member.token,
        body: { content: "Entity" },
      });

      const openRes = await api("POST", `${base(projectId)}/steward/cases`, {
        token: steward.token,
        body: {
          complainantId: complainant.id,
          respondentId: respondent.id,
          subjectType: "entity",
          subjectId: entityRes.body.id,
          summary: "Test",
        },
      });
      const caseId = openRes.body.id;

      const patchRes = await api("PATCH", `${base(projectId)}/steward/cases/${caseId}`, {
        token: steward.token,
        body: { outcome: "escalated" },
      });
      expect(patchRes.status).toBe(400);
      expect(patchRes.body.code).toBe("steward/use-escalate");
    });

    it("allows closing case without outcome (NULL outcome, auto-closes)", async () => {
      const openRes = await api("POST", `${base(projectId)}/steward/cases`, {
        token: steward.token,
        body: { complainantId: complainant.id, respondentId: respondent.id, summary: "Test" },
      });
      const caseId = openRes.body.id;

      const closeRes = await api("PATCH", `${base(projectId)}/steward/cases/${caseId}`, {
        token: steward.token,
        body: { state: "closed" },
      });
      expect(closeRes.status).toBe(200);
      expect(closeRes.body.state).toBe("closed");
      expect(closeRes.body.outcome).toBeNull();
    });
  });

  describe("Content Subject Handling", () => {
    it("case opened with entity as subject (hydrated in detail)", async () => {
      const entityRes = await api("POST", `${base(projectId)}/entities`, {
        token: member.token,
        body: { content: "Entity text" },
      });
      const entityId = entityRes.body.id;

      const caseRes = await api("POST", `${base(projectId)}/steward/cases`, {
        token: steward.token,
        body: {
          complainantId: complainant.id,
          respondentId: respondent.id,
          subjectType: "entity",
          subjectId: entityId,
          summary: "Test",
        },
      });

      const detailRes = await api("GET", `${base(projectId)}/steward/cases/${caseRes.body.id}`, {
        token: steward.token,
      });
      expect(detailRes.body.subject).toMatchObject({
        type: "entity",
        id: entityId,
        entity: expect.objectContaining({ id: entityId, content: "Entity text" }),
      });
    });

    it("case opened with comment as subject (hydrated in detail)", async () => {
      const entityRes = await api("POST", `${base(projectId)}/entities`, {
        token: member.token,
        body: { content: "Parent" },
      });

      const commentRes = await api("POST", `${base(projectId)}/comments`, {
        token: member.token,
        body: { entityId: entityRes.body.id, content: "Comment text" },
      });
      const commentId = commentRes.body.id;

      const caseRes = await api("POST", `${base(projectId)}/steward/cases`, {
        token: steward.token,
        body: {
          complainantId: complainant.id,
          respondentId: respondent.id,
          subjectType: "comment",
          subjectId: commentId,
          summary: "Test",
        },
      });

      const detailRes = await api("GET", `${base(projectId)}/steward/cases/${caseRes.body.id}`, {
        token: steward.token,
      });
      expect(detailRes.body.subject).toMatchObject({
        type: "comment",
        id: commentId,
        comment: expect.objectContaining({ id: commentId, content: "Comment text" }),
      });
    });
  });
});
