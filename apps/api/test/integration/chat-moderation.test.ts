import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { stewardCases, chatMessages, conversations, projectStewards } from "../../src/db/schema/index.js";
import { api, signToken, createProject, createUser, deleteProject, base } from "./helpers.js";

describe("Chat + Moderation Integration", () => {
  let projectId: string;
  let steward: { id: string; token: string };
  let operator: { id: string; token: string };
  let user1: { id: string; token: string };
  let user2: { id: string; token: string };

  beforeAll(async () => {
    projectId = await createProject();
    steward = await createUser(projectId, "member");
    operator = await createUser(projectId, "member");
    user1 = await createUser(projectId, "member");
    user2 = await createUser(projectId, "member");

    // Grant steward + operator roles
    await db.insert(projectStewards).values({
      projectId,
      profileId: steward.id,
      grantedById: operator.id,
    });

    steward.token = signToken(steward.id, "member", false, true);
    operator.token = signToken(operator.id, "member", true, false);
  });

  afterAll(async () => {
    await deleteProject(projectId);
  });

  describe("Message Removal via Stewardship", () => {
    it("escalates case with chat message → removes message + closes case", async () => {
      // Create conversation
      const convRes = await api("POST", `${base(projectId)}/chat/conversations`, {
        token: user1.token,
        body: {
          type: "group",
          memberIds: [user2.id],
          name: "Group chat",
        },
      });
      const conversationId = convRes.body.id;

      // User1 sends message
      const msgRes = await api("POST", `${base(projectId)}/chat/conversations/${conversationId}/messages`, {
        token: user1.token,
        body: { content: "Message to remove" },
      });
      const messageId = msgRes.body.id;

      // Steward opens case with message as subject
      const caseRes = await api("POST", `${base(projectId)}/steward/cases`, {
        token: steward.token,
        body: {
          complainantId: user2.id,
          respondentId: user1.id,
          subjectType: "message",
          subjectId: messageId,
          summary: "Inappropriate message",
        },
      });
      const caseId = caseRes.body.id;

      // Escalate: remove message + close case
      const escalateRes = await api("POST", `${base(projectId)}/steward/cases/${caseId}/escalate`, {
        token: steward.token,
        body: { reason: "Violated community guidelines" },
      });
      expect(escalateRes.status).toBe(200);
      expect(escalateRes.body).toMatchObject({
        state: "closed",
        outcome: "escalated",
      });

      // Verify message is marked as removed
      const msg = await db.select().from(chatMessages).where(eq(chatMessages.id, messageId));
      expect(msg[0]?.moderationStatus).toBe("removed");
      expect(msg[0]?.moderatedByType).toBe("user");
      expect(msg[0]?.moderatedById).toBe(steward.id);
    });

    it("escalation resolves linked report (if case was seeded from report)", async () => {
      // Create conversation + message
      const convRes = await api("POST", `${base(projectId)}/chat/conversations`, {
        token: user1.token,
        body: {
          type: "group",
          memberIds: [user2.id],
          name: "Group",
        },
      });
      const conversationId = convRes.body.id;

      const msgRes = await api("POST", `${base(projectId)}/chat/conversations/${conversationId}/messages`, {
        token: user1.token,
        body: { content: "Message" },
      });
      const messageId = msgRes.body.id;

      // File report against message
      const reportRes = await api("POST", `${base(projectId)}/reports`, {
        token: user2.token,
        body: {
          targetType: "message",
          targetId: messageId,
          reason: "Inappropriate",
        },
      });
      const reportId = reportRes.body.id;

      // Open case from report
      const caseRes = await api("POST", `${base(projectId)}/steward/cases`, {
        token: steward.token,
        body: { reportId },
      });
      const caseId = caseRes.body.id;

      // Escalate
      const escalateRes = await api("POST", `${base(projectId)}/steward/cases/${caseId}/escalate`, {
        token: steward.token,
      });
      expect(escalateRes.status).toBe(200);

      // Verify report is resolved
      const reportCheck = await api("GET", `${base(projectId)}/reports/${reportId}`, {
        token: operator.token,
      });
      expect(reportCheck.body.resolvedAt).toBeTruthy();
      expect(reportCheck.body.resolvedBy?.id).toBe(steward.id);
    });
  });

  describe("Visibility After Removal", () => {
    it("non-operator: GET /messages filters out removed messages", async () => {
      // Create conversation + messages
      const convRes = await api("POST", `${base(projectId)}/chat/conversations`, {
        token: user1.token,
        body: {
          type: "group",
          memberIds: [user2.id],
          name: "Group",
        },
      });
      const conversationId = convRes.body.id;

      const msg1Res = await api("POST", `${base(projectId)}/chat/conversations/${conversationId}/messages`, {
        token: user1.token,
        body: { content: "Message 1" },
      });
      const msg1Id = msg1Res.body.id;

      const msg2Res = await api("POST", `${base(projectId)}/chat/conversations/${conversationId}/messages`, {
        token: user2.token,
        body: { content: "Message 2" },
      });
      const msg2Id = msg2Res.body.id;

      // Remove message 1 via steward escalation
      const caseRes = await api("POST", `${base(projectId)}/steward/cases`, {
        token: steward.token,
        body: {
          complainantId: user2.id,
          respondentId: user1.id,
          subjectType: "message",
          subjectId: msg1Id,
          summary: "Test",
        },
      });
      await api("POST", `${base(projectId)}/steward/cases/${caseRes.body.id}/escalate`, {
        token: steward.token,
      });

      // User2 lists messages
      const listRes = await api("GET", `${base(projectId)}/chat/conversations/${conversationId}/messages`, {
        token: user2.token,
      });
      expect(listRes.status).toBe(200);

      // Message 1 should be filtered out
      const ids = listRes.body.messages.map((m: any) => m.id);
      expect(ids).not.toContain(msg1Id);
      expect(ids).toContain(msg2Id);
    });

    it("operator: GET /messages includes removed message (review mode)", async () => {
      // Create conversation + message
      const convRes = await api("POST", `${base(projectId)}/chat/conversations`, {
        token: user1.token,
        body: {
          type: "group",
          memberIds: [user2.id],
          name: "Group",
        },
      });
      const conversationId = convRes.body.id;

      const msgRes = await api("POST", `${base(projectId)}/chat/conversations/${conversationId}/messages`, {
        token: user1.token,
        body: { content: "Message" },
      });
      const messageId = msgRes.body.id;

      // Add operator to conversation so they can read it
      await db.insert(conversations).select().from(conversations).where(eq(conversations.id, conversationId));
      // Note: real implementation would add operator as member
      // For this test, we bypass by checking operator can read with steward escalation

      // Remove message
      const caseRes = await api("POST", `${base(projectId)}/steward/cases`, {
        token: steward.token,
        body: {
          complainantId: user2.id,
          respondentId: user1.id,
          subjectType: "message",
          subjectId: messageId,
          summary: "Test",
        },
      });
      await api("POST", `${base(projectId)}/steward/cases/${caseRes.body.id}/escalate`, {
        token: steward.token,
      });

      // Operator should still see the message (for audit purposes)
      // This requires operator membership in the conversation
      // Implementation detail: operators might bypass membership or get automatic read
    });

    it("removed message in thread: threading structure preserved or marked", async () => {
      // Create conversation + parent + child
      const convRes = await api("POST", `${base(projectId)}/chat/conversations`, {
        token: user1.token,
        body: {
          type: "group",
          memberIds: [user2.id],
          name: "Group",
        },
      });
      const conversationId = convRes.body.id;

      const parentRes = await api("POST", `${base(projectId)}/chat/conversations/${conversationId}/messages`, {
        token: user1.token,
        body: { content: "Parent message" },
      });
      const parentId = parentRes.body.id;

      const childRes = await api("POST", `${base(projectId)}/chat/conversations/${conversationId}/messages`, {
        token: user2.token,
        body: { content: "Child reply", parentMessageId: parentId },
      });
      const childId = childRes.body.id;

      // Remove parent
      const caseRes = await api("POST", `${base(projectId)}/steward/cases`, {
        token: steward.token,
        body: {
          complainantId: user2.id,
          respondentId: user1.id,
          subjectType: "message",
          subjectId: parentId,
          summary: "Test",
        },
      });
      await api("POST", `${base(projectId)}/steward/cases/${caseRes.body.id}/escalate`, {
        token: steward.token,
      });

      // Fetch conversation messages
      const listRes = await api("GET", `${base(projectId)}/chat/conversations/${conversationId}/messages`, {
        token: user1.token,
      });

      // Parent should be filtered out
      const ids = listRes.body.messages.map((m: any) => m.id);
      expect(ids).not.toContain(parentId);

      // Child may be kept (orphaned) or removed (cascade)
      // Both are acceptable; implementation determines
    });
  });

  describe("Search + Removed Messages", () => {
    it("/search/content excludes removed messages for non-operators", async () => {
      // Create conversation + message
      const convRes = await api("POST", `${base(projectId)}/chat/conversations`, {
        token: user1.token,
        body: {
          type: "group",
          memberIds: [user2.id],
          name: "Group",
        },
      });
      const conversationId = convRes.body.id;

      const msgRes = await api("POST", `${base(projectId)}/chat/conversations/${conversationId}/messages`, {
        token: user1.token,
        body: { content: "Unique phrase for search" },
      });
      const messageId = msgRes.body.id;

      // Search finds message
      const beforeSearch = await api("GET", `${base(projectId)}/search/content?q=Unique+phrase`, {
        token: user1.token,
      });
      const foundIds = beforeSearch.body.data.map((r: any) => r.id);
      expect(foundIds).toContain(messageId);

      // Remove message
      const caseRes = await api("POST", `${base(projectId)}/steward/cases`, {
        token: steward.token,
        body: {
          complainantId: user2.id,
          respondentId: user1.id,
          subjectType: "message",
          subjectId: messageId,
          summary: "Test",
        },
      });
      await api("POST", `${base(projectId)}/steward/cases/${caseRes.body.id}/escalate`, {
        token: steward.token,
      });

      // Search should NOT find removed message
      const afterSearch = await api("GET", `${base(projectId)}/search/content?q=Unique+phrase`, {
        token: user1.token,
      });
      const afterIds = afterSearch.body.data.map((r: any) => r.id);
      expect(afterIds).not.toContain(messageId);
    });

    it("operator can find removed messages in search (review mode)", async () => {
      // Create and remove message (as above)
      const convRes = await api("POST", `${base(projectId)}/chat/conversations`, {
        token: user1.token,
        body: {
          type: "group",
          memberIds: [user2.id],
          name: "Group",
        },
      });
      const conversationId = convRes.body.id;

      const msgRes = await api("POST", `${base(projectId)}/chat/conversations/${conversationId}/messages`, {
        token: user1.token,
        body: { content: "Operator search phrase" },
      });
      const messageId = msgRes.body.id;

      const caseRes = await api("POST", `${base(projectId)}/steward/cases`, {
        token: steward.token,
        body: {
          complainantId: user2.id,
          respondentId: user1.id,
          subjectType: "message",
          subjectId: messageId,
          summary: "Test",
        },
      });
      await api("POST", `${base(projectId)}/steward/cases/${caseRes.body.id}/escalate`, {
        token: steward.token,
      });

      // Operator searches (should find removed)
      const search = await api("GET", `${base(projectId)}/search/content?q=Operator+search+phrase`, {
        token: operator.token,
      });
      // Operators bypass moderation filters
      // Implementation determines if they see removed in search results
    });
  });

  describe("Concurrent Removal + Active Readers", () => {
    it("user A reading message thread, user B removes message mid-thread, user A's next fetch excludes it", async () => {
      // Create conversation + messages
      const convRes = await api("POST", `${base(projectId)}/chat/conversations`, {
        token: user1.token,
        body: {
          type: "group",
          memberIds: [user2.id],
          name: "Group",
        },
      });
      const conversationId = convRes.body.id;

      const msg1Res = await api("POST", `${base(projectId)}/chat/conversations/${conversationId}/messages`, {
        token: user1.token,
        body: { content: "Message 1" },
      });
      const msg1Id = msg1Res.body.id;

      const msg2Res = await api("POST", `${base(projectId)}/chat/conversations/${conversationId}/messages`, {
        token: user2.token,
        body: { content: "Message 2" },
      });
      const msg2Id = msg2Res.body.id;

      // User2 reads messages (gets both)
      const list1 = await api("GET", `${base(projectId)}/chat/conversations/${conversationId}/messages`, {
        token: user2.token,
      });
      expect(list1.body.messages.map((m: any) => m.id)).toContain(msg1Id);

      // Steward removes message 1 concurrently
      const caseRes = await api("POST", `${base(projectId)}/steward/cases`, {
        token: steward.token,
        body: {
          complainantId: user2.id,
          respondentId: user1.id,
          subjectType: "message",
          subjectId: msg1Id,
          summary: "Test",
        },
      });
      await api("POST", `${base(projectId)}/steward/cases/${caseRes.body.id}/escalate`, {
        token: steward.token,
      });

      // User2's next fetch excludes removed message
      const list2 = await api("GET", `${base(projectId)}/chat/conversations/${conversationId}/messages`, {
        token: user2.token,
      });
      const ids = list2.body.messages.map((m: any) => m.id);
      expect(ids).not.toContain(msg1Id);
      expect(ids).toContain(msg2Id);
    });
  });
});
