// /v7/:projectId/steward/*  — conflict-resolution caseload + steward grant management.
//
// Gating: every route requires auth; case routes need steward / project-admin / operator
// (requireSteward), grant management needs project owner / operator (requireProjectOwner). Steward
// privilege is SCOPED HERE — the case-detail
// endpoint fetches the subject content directly (the route is already gated) rather than threading an
// isSteward bypass through the global moderation/space gates, keeping blast radius small.
//
// Lifecycle: open → in_mediation → closed. Closing sets an `outcome` (transformative order:
// repaired/separated/protective_action first; `escalated`, the only one that REMOVES content, is
// reached solely via POST /escalate). Every mutation appends a steward_case_events row — the case
// timeline is an append-only audit trail.
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { and, eq, ne, asc, desc, count, isNull } from "drizzle-orm";
import type { Variables } from "../http/context.js";
import { requireAuth } from "../middleware/auth.js";
import { getDb } from "../db/index.js";
import { logger } from "../lib/logger.js";
import { stewardCases, stewardCaseEvents, reports, entities, comments, chatMessages, profiles } from "../db/schema/index.js";
import { readPagination, paginate } from "../http/envelope.js";
import { shapeCase, shapeCaseEvent, shapeEntity, shapeComment, shapeChatMessage, shapeConversation, loadUsers } from "../lib/shape.js";
import { emitToConversation } from "../realtime/socket.js";
import { notifyStewardCaseEvent } from "../lib/notifications.js";
import { getStewardConfig } from "../lib/steward-config.js";
import { openCaucusChannels, openJointChannel, listCaseChannels, closeMediationForCase } from "../lib/mediation.js";
import { listStewardIds, grantSteward, revokeSteward } from "../lib/stewards.js";
import { parseBody } from "../lib/validation.js";
import { Errors } from "../http/errors.js";
import { isProjectAdmin, requireProjectOwner } from "../lib/project-roles.js";

type Ctx = Context<{ Variables: Variables }>;
type CaseRow = typeof stewardCases.$inferSelect;
type EventKind = typeof stewardCaseEvents.$inferInsert["kind"];

// ─── guards ──────────────────────────────────────────────────────────────────
function requireSteward(c: Ctx): void {
  const a = c.var.auth!;
  if (!(isProjectAdmin(a) || a.isSteward)) throw Errors.forbidden("steward/forbidden", "Steward access required");
}

// ─── request schemas (server-local — admin-only, not SDK contract) ────────────
const subjectTypeEnum = z.enum(["entity", "comment", "message"]);
const openCaseSchema = z.object({
  respondentId: z.string().uuid().optional(),
  complainantId: z.string().uuid().optional(),
  subjectType: subjectTypeEnum.optional(),
  subjectId: z.string().uuid().optional(),
  reportId: z.string().uuid().optional(),
  spaceId: z.string().uuid().optional(),
  summary: z.string().max(2000).optional(),
});
const patchCaseSchema = z.object({
  state: z.enum(["open", "in_mediation", "closed"]).optional(),
  assignedToId: z.string().uuid().nullable().optional(),
  asymmetry: z.boolean().optional(),
  outcome: z.enum(["repaired", "separated", "protective_action", "escalated", "dismissed"]).optional(),
  resolutionNote: z.string().max(4000).optional(),
});
const noteSchema = z.object({ body: z.string().min(1).max(4000) });
const escalateSchema = z.object({ reason: z.string().max(1000).optional() });
const openChannelSchema = z.object({ kind: z.enum(["caucus", "joint"]) });
const grantSchema = z.object({ userId: z.string().uuid() });

// Shape a mediation-channel conversation row for the steward UI (+ surface its mediation role/party).
function shapeChannel(row: Parameters<typeof shapeConversation>[0]) {
  const med = (row.metadata as { mediation?: { role?: string; party?: string } } | null)?.mediation;
  return { ...shapeConversation(row), mediationRole: med?.role ?? null, mediationParty: med?.party ?? null };
}

// ─── helpers ───────────────────────────────────────────────────────────────
async function addEvent(caseId: string, actorId: string | null, kind: EventKind, body: string | null = null, meta: unknown = null): Promise<void> {
  await getDb().insert(stewardCaseEvents).values({ caseId, actorId, kind, body, meta });
}

// Hydrate a page of cases' parties (complainant/respondent/assignee/opener) in one batched query.
async function hydrateCases(projectId: string, rows: CaseRow[]): Promise<ReturnType<typeof shapeCase>[]> {
  const users = await loadUsers(projectId, rows.flatMap((r) => [r.complainantId, r.respondentId, r.assignedToId, r.openedById]));
  const get = (id: string | null) => (id ? users.get(id) ?? null : null);
  return rows.map((r) => shapeCase(r, {
    complainant: get(r.complainantId), respondent: get(r.respondentId),
    assignedTo: get(r.assignedToId), openedBy: get(r.openedById),
  }));
}

// The content at issue, hydrated directly (privileged — this route is steward/operator-gated, and a
// steward must be able to review removed/members-only content).
async function loadSubject(projectId: string, type: CaseRow["subjectType"], id: string | null) {
  if (!type || !id) return null;
  if (type === "entity") {
    const [e] = await getDb().select().from(entities).where(and(eq(entities.projectId, projectId), eq(entities.id, id))).limit(1);
    if (!e) return { type, id, entity: null };
    const user = e.userId ? (await loadUsers(projectId, [e.userId])).get(e.userId) ?? null : null;
    return { type, id, entity: shapeEntity(e, { user }) };
  }
  if (type === "comment") {
    const [cm] = await getDb().select().from(comments).where(and(eq(comments.projectId, projectId), eq(comments.id, id))).limit(1);
    if (!cm) return { type, id, comment: null };
    const user = cm.userId ? (await loadUsers(projectId, [cm.userId])).get(cm.userId) ?? null : null;
    return { type, id, comment: shapeComment(cm, { user }) };
  }
  const [m] = await getDb().select().from(chatMessages).where(and(eq(chatMessages.projectId, projectId), eq(chatMessages.id, id))).limit(1);
  if (!m) return { type, id, message: null };
  const user = m.userId ? (await loadUsers(projectId, [m.userId])).get(m.userId) ?? null : null;
  return { type, id, message: shapeChatMessage(m, { user }) };
}

async function getCase(projectId: string, id: string): Promise<CaseRow> {
  const [row] = await getDb().select().from(stewardCases)
    .where(and(eq(stewardCases.projectId, projectId), eq(stewardCases.id, id))).limit(1);
  if (!row) throw Errors.notFound("steward/case-not-found", "Case not found");
  return row;
}

export const stewardRoutes = new Hono<{ Variables: Variables }>()
  // ── Caseload list. Default scope = active (state <> closed); ?state=open|in_mediation|closed|all,
  //    ?assigned=me|<userId>. Newest first.
  .get("/cases", requireAuth, async (c) => {
    requireSteward(c);
    const { page, limit, offset } = readPagination(c);
    const conds = [eq(stewardCases.projectId, c.var.projectId)];
    const state = c.req.query("state");
    if (state === "open" || state === "in_mediation" || state === "closed") conds.push(eq(stewardCases.state, state));
    else if (state !== "all") conds.push(ne(stewardCases.state, "closed"));
    const assigned = c.req.query("assigned");
    if (assigned === "me") conds.push(eq(stewardCases.assignedToId, c.var.auth!.userId));
    else if (assigned) conds.push(eq(stewardCases.assignedToId, assigned));
    const where = and(...conds);
    const [{ n } = { n: 0 }] = await getDb().select({ n: count() }).from(stewardCases).where(where);
    const rows = await getDb().select().from(stewardCases).where(where)
      .orderBy(desc(stewardCases.createdAt)).limit(limit).offset(offset);
    return c.json(paginate(await hydrateCases(c.var.projectId, rows), n, page, limit));
  })
  // ── Open a case. Cold, or seeded from a report (copies target/space/reporter when not supplied).
  .post("/cases", requireAuth, async (c) => {
    requireSteward(c);
    const body = parseBody(openCaseSchema, await c.req.json().catch(() => ({})), "steward");
    let { respondentId, complainantId, subjectType, subjectId, spaceId } = body;
    const { reportId, summary } = body;
    if (reportId) {
      const [rep] = await getDb().select().from(reports)
        .where(and(eq(reports.projectId, c.var.projectId), eq(reports.id, reportId))).limit(1);
      if (!rep) throw Errors.notFound("steward/report-not-found", "Report not found");
      subjectType = subjectType ?? rep.targetType;
      subjectId = subjectId ?? rep.targetId;
      spaceId = spaceId ?? rep.spaceId ?? undefined;
      complainantId = complainantId ?? rep.reporterId ?? undefined;
    }
    const [row] = await getDb().insert(stewardCases).values({
      projectId: c.var.projectId,
      reportId: reportId ?? null,
      complainantId: complainantId ?? null,
      respondentId: respondentId ?? null,
      subjectType: subjectType ?? null,
      subjectId: subjectId ?? null,
      spaceId: spaceId ?? null,
      summary: summary ?? "",
      openedById: c.var.auth!.userId,
    }).returning();
    await addEvent(row!.id, c.var.auth!.userId, "opened", summary ?? null, reportId ? { reportId } : null);
    await notifyStewardCaseEvent(c.var.projectId, {
      kind: "opened", caseId: row!.id, actorId: c.var.auth!.userId,
      complainantId: row!.complainantId, respondentId: row!.respondentId, subjectType: row!.subjectType,
    });
    logger.info({ projectId: c.var.projectId, caseId: row!.id, openedBy: c.var.auth!.userId, reportId: reportId ?? null }, "steward: case opened");
    const [shaped] = await hydrateCases(c.var.projectId, [row!]);
    return c.json(shaped, 201);
  })
  // ── Case detail: parties + the subject content + the full timeline.
  .get("/cases/:id", requireAuth, async (c) => {
    requireSteward(c);
    const row = await getCase(c.var.projectId, c.req.param("id"));
    const [base] = await hydrateCases(c.var.projectId, [row]);
    const subject = await loadSubject(c.var.projectId, row.subjectType, row.subjectId);
    const events = await getDb().select().from(stewardCaseEvents)
      .where(eq(stewardCaseEvents.caseId, row.id)).orderBy(asc(stewardCaseEvents.createdAt));
    const actors = await loadUsers(c.var.projectId, events.map((e) => e.actorId));
    const timeline = events.map((e) => shapeCaseEvent(e, e.actorId ? actors.get(e.actorId) ?? null : null));
    return c.json({ ...base, subject, events: timeline });
  })
  // ── Update state / assignee / asymmetry / outcome + note. Each delta appends its event; setting an
  //    outcome closes the case. `escalated` is rejected here — it removes content, so it goes through
  //    POST /escalate.
  .patch("/cases/:id", requireAuth, async (c) => {
    requireSteward(c);
    const body = parseBody(patchCaseSchema, await c.req.json().catch(() => ({})), "steward");
    if (body.outcome === "escalated") throw Errors.badRequest("steward/use-escalate", "Use POST /cases/:id/escalate to escalate (it removes the content)");
    const row = await getCase(c.var.projectId, c.req.param("id"));
    const actor = c.var.auth!.userId;
    const set: Partial<typeof stewardCases.$inferInsert> = {};
    const events: { kind: EventKind; body: string | null; meta: unknown }[] = [];

    if (body.assignedToId !== undefined && body.assignedToId !== row.assignedToId) {
      set.assignedToId = body.assignedToId;
      events.push({ kind: "assignment", body: null, meta: { from: row.assignedToId, to: body.assignedToId } });
    }
    if (body.asymmetry !== undefined && body.asymmetry !== row.asymmetry) {
      set.asymmetry = body.asymmetry;
      events.push({ kind: "asymmetry", body: null, meta: { asymmetry: body.asymmetry } });
    }
    if (body.resolutionNote !== undefined) set.resolutionNote = body.resolutionNote;

    if (body.outcome !== undefined && body.outcome !== row.outcome) {
      set.outcome = body.outcome;
      set.state = "closed";
      set.closedAt = new Date();
      events.push({ kind: "outcome", body: body.resolutionNote ?? null, meta: { outcome: body.outcome } });
    } else if (body.state !== undefined && body.state !== row.state) {
      set.state = body.state;
      set.closedAt = body.state === "closed" ? new Date() : null;
      events.push({ kind: "state_change", body: null, meta: { from: row.state, to: body.state } });
    }

    if (Object.keys(set).length === 0) {
      const [shaped] = await hydrateCases(c.var.projectId, [row]);
      return c.json(shaped);
    }
    set.updatedAt = new Date();
    const [updated] = await getDb().update(stewardCases).set(set)
      .where(and(eq(stewardCases.projectId, c.var.projectId), eq(stewardCases.id, row.id))).returning();
    for (const e of events) await addEvent(updated!.id, actor, e.kind, e.body, e.meta);
    // Notify the parties per the project policy: a non-escalate close, or a move into mediation.
    if (set.outcome) {
      await notifyStewardCaseEvent(c.var.projectId, {
        kind: "closed", caseId: row.id, actorId: actor, outcome: set.outcome,
        complainantId: updated!.complainantId, respondentId: updated!.respondentId, subjectType: updated!.subjectType,
      });
      const { mediationOnClose } = await getStewardConfig(c.var.projectId);
      await closeMediationForCase(c.var.projectId, row.id, mediationOnClose);
    } else if (set.state === "in_mediation") {
      await notifyStewardCaseEvent(c.var.projectId, {
        kind: "in_mediation", caseId: row.id, actorId: actor,
        complainantId: updated!.complainantId, respondentId: updated!.respondentId,
      });
    }
    logger.info({ projectId: c.var.projectId, caseId: row.id, actor, changes: Object.keys(set) }, "steward: case updated");
    const [shaped] = await hydrateCases(c.var.projectId, [updated!]);
    return c.json(shaped);
  })
  // ── Append a note to the case timeline (the steward's running log).
  .post("/cases/:id/notes", requireAuth, async (c) => {
    requireSteward(c);
    const body = parseBody(noteSchema, await c.req.json().catch(() => ({})), "steward");
    const row = await getCase(c.var.projectId, c.req.param("id"));
    await addEvent(row.id, c.var.auth!.userId, "note", body.body, null);
    return c.json({ success: true }, 201);
  })
  // ── Escalate: remove the subject content (moderatedByType="user", stamps the steward), close the
  //    case as `escalated`, and resolve the originating report if any. The existing
  //    moderation-visibility gate then hides the content from non-privileged reads.
  .post("/cases/:id/escalate", requireAuth, async (c) => {
    requireSteward(c);
    const body = parseBody(escalateSchema, await c.req.json().catch(() => ({})), "steward");
    const row = await getCase(c.var.projectId, c.req.param("id"));
    if (!row.subjectType || !row.subjectId) throw Errors.badRequest("steward/no-subject", "This case has no content subject to remove");
    const reason = body.reason?.trim() || `Removed via steward case ${row.id}`;
    const mod = {
      moderationStatus: "removed" as const, moderationReason: reason, moderatedAt: new Date(),
      moderatedById: c.var.auth!.userId, moderatedByType: "user" as const,
    };
    let removed = false;
    let msgConversationId: string | undefined;
    if (row.subjectType === "entity") {
      const [u] = await getDb().update(entities).set(mod)
        .where(and(eq(entities.projectId, c.var.projectId), eq(entities.id, row.subjectId))).returning({ id: entities.id });
      removed = !!u;
    } else if (row.subjectType === "comment") {
      const [u] = await getDb().update(comments).set(mod)
        .where(and(eq(comments.projectId, c.var.projectId), eq(comments.id, row.subjectId))).returning({ id: comments.id });
      removed = !!u;
    } else {
      const [u] = await getDb().update(chatMessages).set(mod)
        .where(and(eq(chatMessages.projectId, c.var.projectId), eq(chatMessages.id, row.subjectId)))
        .returning({ id: chatMessages.id, conversationId: chatMessages.conversationId });
      removed = !!u;
      msgConversationId = u?.conversationId;
    }
    if (!removed) throw Errors.notFound("steward/subject-not-found", "Case subject content not found");

    const [updated] = await getDb().update(stewardCases).set({
      outcome: "escalated", state: "closed", closedAt: new Date(), resolutionNote: reason, updatedAt: new Date(),
    }).where(and(eq(stewardCases.projectId, c.var.projectId), eq(stewardCases.id, row.id))).returning();
    await addEvent(row.id, c.var.auth!.userId, "escalation", reason, { subjectType: row.subjectType, subjectId: row.subjectId });
    if (row.reportId) {
      await getDb().update(reports).set({ resolvedAt: new Date(), resolvedById: c.var.auth!.userId })
        .where(and(eq(reports.projectId, c.var.projectId), eq(reports.id, row.reportId), isNull(reports.resolvedAt)));
    }
    // Tell connected chat clients to drop the removed message live (entities/comments hide on next read).
    if (msgConversationId) emitToConversation(msgConversationId, "message:removed", { messageId: row.subjectId, conversationId: msgConversationId });
    await notifyStewardCaseEvent(c.var.projectId, {
      kind: "closed", caseId: row.id, actorId: c.var.auth!.userId, outcome: "escalated",
      complainantId: row.complainantId, respondentId: row.respondentId, subjectType: row.subjectType,
    });
    const { mediationOnClose } = await getStewardConfig(c.var.projectId);
    await closeMediationForCase(c.var.projectId, row.id, mediationOnClose);
    logger.info({ projectId: c.var.projectId, caseId: row.id, stewardId: c.var.auth!.userId, subjectType: row.subjectType, subjectId: row.subjectId }, "steward: case escalated → content removed");
    const [shaped] = await hydrateCases(c.var.projectId, [updated!]);
    return c.json(shaped);
  })
  // ── Mediation channels for a case (built on chat). Steward/operator-gated; the steward + parties are
  //    seeded as conversation members, so messaging itself flows through the normal /chat routes. List +
  //    open here; wind-down happens automatically when the case closes (per project mediationOnClose).
  .get("/cases/:id/channels", requireAuth, async (c) => {
    requireSteward(c);
    const row = await getCase(c.var.projectId, c.req.param("id"));
    const channels = await listCaseChannels(c.var.projectId, row.id);
    return c.json({ channels: channels.map(shapeChannel) });
  })
  .post("/cases/:id/channels", requireAuth, async (c) => {
    requireSteward(c);
    const body = parseBody(openChannelSchema, await c.req.json().catch(() => ({})), "steward");
    const row = await getCase(c.var.projectId, c.req.param("id"));
    const stewardId = c.var.auth!.userId;
    let opened;
    if (body.kind === "caucus") {
      opened = await openCaucusChannels(row, stewardId);
      if (opened.length === 0) throw Errors.badRequest("steward/no-parties", "This case has no parties to open a caucus with");
    } else {
      const { mediationMode } = await getStewardConfig(c.var.projectId);
      const joint = await openJointChannel(row, stewardId, mediationMode);
      if (!joint) {
        throw Errors.badRequest(
          "steward/joint-not-allowed",
          mediationMode !== "hybrid"
            ? "Joint rooms are disabled (mediation mode is caucus-only)"
            : row.asymmetry
              ? "A joint room can't be opened for a targeting case — use caucus channels"
              : "A joint room needs both a complainant and a respondent",
        );
      }
      opened = [joint];
    }
    await addEvent(row.id, stewardId, "mediation_opened", null, { kind: body.kind, conversationIds: opened.map((o) => o.id) });
    logger.info({ projectId: c.var.projectId, caseId: row.id, stewardId, kind: body.kind, channels: opened.length }, "steward: mediation channel(s) opened");
    return c.json({ channels: opened.map(shapeChannel) }, 201);
  })
  // ── Steward grant management (project owner / operator).
  .get("/stewards", requireAuth, async (c) => {
    requireProjectOwner(c);
    const ids = await listStewardIds(c.var.projectId);
    const users = await loadUsers(c.var.projectId, ids);
    return c.json({ stewards: ids.map((id) => users.get(id)).filter(Boolean) });
  })
  .post("/stewards", requireAuth, async (c) => {
    requireProjectOwner(c);
    const body = parseBody(grantSchema, await c.req.json().catch(() => ({})), "steward");
    const [p] = await getDb().select({ id: profiles.id }).from(profiles)
      .where(and(eq(profiles.projectId, c.var.projectId), eq(profiles.id, body.userId))).limit(1);
    if (!p) throw Errors.notFound("steward/user-not-found", "User not found in this project");
    await grantSteward(c.var.projectId, body.userId, c.var.auth!.userId);
    logger.info({ projectId: c.var.projectId, profileId: body.userId, grantedBy: c.var.auth!.userId }, "steward: granted");
    return c.json({ success: true }, 201);
  })
  .delete("/stewards/:userId", requireAuth, async (c) => {
    requireProjectOwner(c);
    await revokeSteward(c.var.projectId, c.req.param("userId"));
    logger.info({ projectId: c.var.projectId, profileId: c.req.param("userId"), revokedBy: c.var.auth!.userId }, "steward: revoked");
    return c.json({ success: true });
  });
