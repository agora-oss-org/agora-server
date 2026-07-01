// Steward mediation channels — built ON the existing chat (conversations / conversation_members /
// chat_messages / socket fan-out). A channel is just a conversation linked to a steward case via
// conversations.steward_case_id, with metadata.mediation = { role, party? }:
//   • caucus — a private `direct` conversation between the steward and ONE party (steward bridges; fully
//     preserves the respondent-anonymity guarantee). Always available.
//   • joint  — a `group` conversation with the steward + BOTH parties. Only in `hybrid` mode, only when
//     neither targeting (asymmetry) is flagged nor a party is missing, and both are invited to consent.
// Parties read/post through their normal client chat (they're members); the steward does too (admin member).
// Wind-down on case close is governed by the project's mediationOnClose (see lib/steward-config.ts).
import { and, eq, ne, sql } from "drizzle-orm";
import type { StewardMediationMode, StewardMediationOnClose } from "@agora-server/contract";
import { db } from "../db/index.js";
import { conversations, conversationMembers, chatMessages } from "../db/schema/index.js";
import { emitToConversation } from "../realtime/socket.js";
import { shapeChatMessage } from "./shape.js";
import { notifyMediationInvite } from "./notifications.js";
import { logger } from "./logger.js";

export type MediationRole = "caucus" | "joint";

type ConversationRow = typeof conversations.$inferSelect;
export interface MediationCase {
  id: string;
  projectId: string;
  complainantId: string | null;
  respondentId: string | null;
  asymmetry: boolean;
}

/**
 * Pure guard: may a JOINT room (steward + both parties together) be opened for this case? Requires hybrid
 * mode, no targeting/asymmetry flag, and both parties present. Caucus channels need no such gate — they're
 * always safe (steward ↔ one party). (Unit-tested.)
 */
export function canOpenJoint(mode: StewardMediationMode, asymmetry: boolean, hasBothParties: boolean): boolean {
  return mode === "hybrid" && !asymmetry && hasBothParties;
}

/** Find an existing mediation channel for a case by role (+ caucus party). Keeps opens idempotent. */
async function findChannel(projectId: string, caseId: string, role: MediationRole, party?: string): Promise<ConversationRow | null> {
  const rows = await db.select().from(conversations).where(and(
    eq(conversations.projectId, projectId),
    eq(conversations.stewardCaseId, caseId),
    sql`${conversations.metadata}->'mediation'->>'role' = ${role}`,
    party ? sql`${conversations.metadata}->'mediation'->>'party' = ${party}` : sql`true`,
  )).limit(1);
  return rows[0] ?? null;
}

/** Create a channel conversation + seed its members (steward as admin, parties as members). */
async function createChannel(opts: {
  projectId: string; caseId: string; type: "direct" | "group"; role: MediationRole;
  name?: string | null; party?: string; stewardId: string; partyIds: string[];
}): Promise<ConversationRow> {
  const [convo] = await db.insert(conversations).values({
    projectId: opts.projectId,
    type: opts.type,
    name: opts.name ?? null,
    stewardCaseId: opts.caseId,
    createdById: opts.stewardId,
    metadata: { mediation: { role: opts.role, ...(opts.party ? { party: opts.party } : {}) } },
  }).returning();
  const members = [
    { projectId: opts.projectId, conversationId: convo!.id, userId: opts.stewardId, role: "admin" as const },
    ...opts.partyIds
      .filter((id) => id !== opts.stewardId)
      .map((id) => ({ projectId: opts.projectId, conversationId: convo!.id, userId: id, role: "member" as const })),
  ];
  await db.insert(conversationMembers).values(members)
    .onConflictDoUpdate({ target: [conversationMembers.conversationId, conversationMembers.userId], set: { isActive: true, leftAt: null } });
  return convo!;
}

/**
 * Open (or return existing) caucus channels — one per present party. Idempotent: a second call returns the
 * same conversations without re-inviting. Returns [{ convo, role }].
 */
export async function openCaucusChannels(caseRow: MediationCase, stewardId: string): Promise<ConversationRow[]> {
  const out: ConversationRow[] = [];
  for (const party of [caseRow.complainantId, caseRow.respondentId]) {
    if (!party) continue;
    let convo = await findChannel(caseRow.projectId, caseRow.id, "caucus", party);
    if (!convo) {
      convo = await createChannel({
        projectId: caseRow.projectId, caseId: caseRow.id, type: "direct", role: "caucus",
        party, stewardId, partyIds: [party],
      });
      await notifyMediationInvite(caseRow.projectId, { recipientId: party, actorId: stewardId, conversationId: convo.id, role: "caucus" });
    }
    out.push(convo);
  }
  return out;
}

/**
 * Open (or return existing) the joint room, if the mode + case allow it (canOpenJoint). Returns null when
 * a joint room isn't permitted (caucus mode, targeting flagged, or a party missing) — callers surface that.
 */
export async function openJointChannel(caseRow: MediationCase, stewardId: string, mode: StewardMediationMode): Promise<ConversationRow | null> {
  const hasBoth = !!(caseRow.complainantId && caseRow.respondentId);
  if (!canOpenJoint(mode, caseRow.asymmetry, hasBoth)) return null;
  let convo = await findChannel(caseRow.projectId, caseRow.id, "joint");
  if (!convo) {
    convo = await createChannel({
      projectId: caseRow.projectId, caseId: caseRow.id, type: "group", role: "joint",
      name: "Mediation", stewardId, partyIds: [caseRow.complainantId!, caseRow.respondentId!],
    });
    for (const party of [caseRow.complainantId!, caseRow.respondentId!]) {
      await notifyMediationInvite(caseRow.projectId, { recipientId: party, actorId: stewardId, conversationId: convo.id, role: "joint" });
    }
  }
  return convo;
}

/** List a case's mediation channels (caucus + joint). */
export async function listCaseChannels(projectId: string, caseId: string): Promise<ConversationRow[]> {
  return db.select().from(conversations)
    .where(and(eq(conversations.projectId, projectId), eq(conversations.stewardCaseId, caseId)))
    .orderBy(conversations.createdAt);
}

/** Post a system message (no author) into a channel and fan it out. */
async function postSystemMessage(projectId: string, conversationId: string, content: string): Promise<void> {
  const [msg] = await db.insert(chatMessages).values({
    projectId, conversationId, userId: null, content, metadata: { system: true },
  }).returning();
  if (msg) emitToConversation(conversationId, "message:created", shapeChatMessage(msg));
}

/**
 * Wind down a case's mediation channels when the case closes, per the project's mediationOnClose:
 *   • leave-open        — do nothing (channels stay normal active chats).
 *   • archive-read-only — lock posting to the steward (postingPermission='admins') + a system resolved line.
 *   • lock-leave        — same lock, plus drop the party members (they leave the chat; steward keeps access).
 * Error-guarded — never breaks the case-close mutation.
 */
export async function closeMediationForCase(projectId: string, caseId: string, onClose: StewardMediationOnClose): Promise<void> {
  if (onClose === "leave-open") return;
  try {
    const channels = await listCaseChannels(projectId, caseId);
    for (const ch of channels) {
      await db.update(conversations).set({ postingPermission: "admins", updatedAt: new Date() }).where(eq(conversations.id, ch.id));
      await postSystemMessage(projectId, ch.id, "🕊️ This case has been resolved. This channel is now read-only.");
      if (onClose === "lock-leave") {
        const dropped = await db.update(conversationMembers).set({ isActive: false, leftAt: new Date() })
          .where(and(
            eq(conversationMembers.conversationId, ch.id),
            eq(conversationMembers.isActive, true),
            ne(conversationMembers.role, "admin"), // keep the steward (admin) for the audit trail
          )).returning({ userId: conversationMembers.userId });
        for (const m of dropped) emitToConversation(ch.id, "member:left", { conversationId: ch.id, userId: m.userId });
      }
    }
  } catch (err) {
    logger.error("[mediation] closeMediationForCase failed");
    logger.debug({ err }, "[mediation] closeMediationForCase failed");
  }
}
