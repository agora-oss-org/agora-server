// Notification fan-out. One place that writes app_notifications rows for every social event,
// shaped to match the SDK's AppNotification metadata contract 1:1
// (agora-sdk/packages/core/src/interfaces/models/AppNotification.ts).
//
// Conventions:
// - Never notify yourself (recipient === actor is skipped).
// - Reaction notifications fire only when a reaction becomes ACTIVE (add / switch-to), never on
//   toggle-off. `upvote` maps to the dedicated *-upvote type; every other reaction to *-reaction.
// - Milestones are celebratory extras sent to the target owner when a reaction count crosses a
//   threshold in MILESTONES (specific = that reaction type; total = all reactions summed).
// - Every public helper is awaited but self-contained: it catches its own errors so a failed
//   notification can never break the underlying write. Routes await them so tests see rows.
//
// Realtime: delivered over socket.io via emitToUser() in insert() — the recipient's open sockets get a
// `notification:created` event with the shaped row. Falls back to inbox polling when no socket is open.
import { and, desc, eq } from "drizzle-orm";
import type { StewardNotifyPolicy } from "@agora-server/contract";
import { db } from "../db/index.js";
import { appNotifications, profiles, entities, comments, reactions } from "../db/schema/index.js";
import { shapeNotification } from "./shape.js";
import { getStewardConfig } from "./steward-config.js";
import * as webhooks from "./webhooks.js";
import { emitToUser } from "../realtime/socket.js";
import { logger } from "./logger.js";

// Reaction-count thresholds that trigger a milestone notification. Tune to taste.
const MILESTONES = [10, 25, 50, 100, 250, 500, 1000];

type Actor = {
  initiatorId: string;
  initiatorName: string | null;
  initiatorUsername: string | null;
  initiatorAvatar: string | null;
};

type MilestoneUser = { id: string; name: string | null; username: string | null; avatar: string | null };

/** Load the acting user's public profile fields (the "initiator" block). Null if missing. */
async function loadActor(projectId: string, userId: string): Promise<Actor | null> {
  const [p] = await db
    .select({ id: profiles.id, name: profiles.name, username: profiles.username, avatar: profiles.avatar })
    .from(profiles)
    .where(and(eq(profiles.projectId, projectId), eq(profiles.id, userId)))
    .limit(1);
  if (!p) return null;
  return { initiatorId: p.id, initiatorName: p.name, initiatorUsername: p.username, initiatorAvatar: p.avatar };
}

/** Low-level insert. Skips self-notify and falsy/duplicate recipients. */
async function insert(
  projectId: string,
  recipientId: string | null | undefined,
  actorId: string,
  type: string,
  action: string,
  metadata: Record<string, unknown>
): Promise<void> {
  if (!recipientId || recipientId === actorId) return;
  const [row] = await db.insert(appNotifications).values({ projectId, userId: recipientId, type, action, metadata }).returning();
  if (row) {
    const shaped = shapeNotification(row);
    // Push-notification bridge: fire-and-forget broadcast webhook (no-op unless subscribed).
    webhooks.broadcast(projectId, "notification.created", shaped);
    // Realtime: live-deliver to the recipient's open sockets (no-op until the socket server is attached).
    emitToUser(projectId, recipientId, "notification:created", shaped);
  }
}

/** Pull candidate user ids out of the untyped `mentions` jsonb (array of {id} | string). */
function mentionIds(mentions: unknown): string[] {
  if (!Array.isArray(mentions)) return [];
  const ids = new Set<string>();
  for (const m of mentions) {
    if (typeof m === "string") ids.add(m);
    else if (m && typeof m === "object") {
      const id = (m as Record<string, unknown>).id ?? (m as Record<string, unknown>).userId;
      if (typeof id === "string") ids.add(id);
    }
  }
  return [...ids];
}

/** The 3 most recent reactors of a target, newest first (for milestone metadata). */
async function lastThreeReactors(
  projectId: string,
  targetType: "entity" | "comment",
  targetId: string,
  reactionType?: string
): Promise<MilestoneUser[]> {
  const conds = [
    eq(reactions.projectId, projectId),
    eq(reactions.targetType, targetType),
    eq(reactions.targetId, targetId),
  ];
  if (reactionType) conds.push(eq(reactions.reactionType, reactionType as any));
  const rows = await db
    .select({ userId: reactions.userId, name: profiles.name, username: profiles.username, avatar: profiles.avatar })
    .from(reactions)
    .leftJoin(profiles, eq(profiles.id, reactions.userId))
    .where(and(...conds))
    .orderBy(desc(reactions.createdAt))
    .limit(3);
  return rows.map((r) => ({ id: r.userId, name: r.name, username: r.username, avatar: r.avatar }));
}

const sum = (counts: Record<string, number> | null | undefined) =>
  counts ? Object.values(counts).reduce((a, b) => a + (Number(b) || 0), 0) : 0;

// ─── public fan-out helpers ─────────────────────────────────────────────────

/**
 * On comment creation: notify the entity author and (for a reply) the parent-comment author,
 * deduped, plus any mentioned users. Pass the freshly-inserted comment row.
 */
export async function notifyOnComment(
  projectId: string,
  comment: { id: string; userId: string | null; entityId: string; parentId: string | null; content: string | null; mentions?: unknown }
): Promise<void> {
  try {
    const actorId = comment.userId;
    if (!actorId) return;
    const actor = await loadActor(projectId, actorId);
    if (!actor) return;

    const [entity] = await db
      .select({ id: entities.id, userId: entities.userId, shortId: entities.shortId, title: entities.title, content: entities.content })
      .from(entities)
      .where(and(eq(entities.projectId, projectId), eq(entities.id, comment.entityId)))
      .limit(1);
    if (!entity) return;

    const entityMeta = {
      entityId: entity.id,
      entityShortId: entity.shortId,
      entityTitle: entity.title,
      entityContent: entity.content,
    };
    const notified = new Set<string>([actorId]);

    if (comment.parentId) {
      // Reply → notify the parent comment's author …
      const [parent] = await db
        .select({ userId: comments.userId, content: comments.content })
        .from(comments)
        .where(and(eq(comments.projectId, projectId), eq(comments.id, comment.parentId)))
        .limit(1);
      if (parent?.userId && !notified.has(parent.userId)) {
        await insert(projectId, parent.userId, actorId, "comment-reply", "open-comment", {
          ...entityMeta,
          commentId: comment.parentId,
          commentContent: parent.content,
          replyId: comment.id,
          replyContent: comment.content,
          ...actor,
        });
        notified.add(parent.userId);
      }
      // … AND the entity author (deduped — skipped if they're the actor or already notified above).
      if (entity.userId && !notified.has(entity.userId)) {
        await insert(projectId, entity.userId, actorId, "entity-comment", "open-comment", {
          ...entityMeta,
          commentId: comment.id,
          commentContent: comment.content,
          ...actor,
        });
        notified.add(entity.userId);
      }
    } else {
      // Top-level comment → notify the entity author.
      if (entity.userId && !notified.has(entity.userId)) {
        await insert(projectId, entity.userId, actorId, "entity-comment", "open-comment", {
          ...entityMeta,
          commentId: comment.id,
          commentContent: comment.content,
          ...actor,
        });
        notified.add(entity.userId);
      }
    }

    // Mentions in the comment → comment-mention (deduped against whoever was already notified).
    for (const uid of mentionIds(comment.mentions)) {
      if (notified.has(uid)) continue;
      await insert(projectId, uid, actorId, "comment-mention", "open-comment", {
        ...entityMeta,
        commentId: comment.id,
        commentContent: comment.content,
        ...actor,
      });
      notified.add(uid);
    }
  } catch (err) {
    logger.error("[notifications] notifyOnComment failed");
    logger.debug({ err }, "[notifications] notifyOnComment failed");
  }
}

/** On entity creation: notify mentioned users (entity-mention). Pass the inserted entity row. */
export async function notifyOnEntityMentions(
  projectId: string,
  entity: { id: string; userId: string | null; shortId: string; title: string | null; content: string | null; mentions?: unknown }
): Promise<void> {
  try {
    const ids = mentionIds(entity.mentions);
    if (!ids.length || !entity.userId) return;
    const actor = await loadActor(projectId, entity.userId);
    if (!actor) return;
    for (const uid of ids) {
      await insert(projectId, uid, entity.userId, "entity-mention", "open-entity", {
        entityId: entity.id,
        entityShortId: entity.shortId,
        entityTitle: entity.title,
        entityContent: entity.content,
        ...actor,
      });
    }
  } catch (err) {
    logger.error("[notifications] notifyOnEntityMentions failed");
    logger.debug({ err }, "[notifications] notifyOnEntityMentions failed");
  }
}

/**
 * On a reaction becoming active: notify the target owner (entity-upvote/reaction or
 * comment-upvote/reaction) and emit milestone notifications when counts cross a threshold.
 * `isActive` must be true only when the user's reaction now equals `reactionType` (add/switch).
 */
export async function notifyOnReaction(args: {
  projectId: string;
  targetType: "entity" | "comment";
  targetId: string;
  reactorId: string;
  reactionType: string;
  isActive: boolean;
  reactionCounts: Record<string, number> | null;
}): Promise<void> {
  const { projectId, targetType, targetId, reactorId, reactionType, isActive, reactionCounts } = args;
  if (!isActive) return;
  try {
    const actor = await loadActor(projectId, reactorId);
    if (!actor) return;

    // Resolve target owner + entity context for the metadata block.
    let ownerId: string | null = null;
    let entityMeta: Record<string, unknown>;
    let commentMeta: Record<string, unknown> = {};
    if (targetType === "entity") {
      const [e] = await db
        .select({ userId: entities.userId, shortId: entities.shortId, title: entities.title, content: entities.content })
        .from(entities)
        .where(and(eq(entities.projectId, projectId), eq(entities.id, targetId)))
        .limit(1);
      if (!e) return;
      ownerId = e.userId;
      entityMeta = { entityId: targetId, entityShortId: e.shortId, entityTitle: e.title, entityContent: e.content };
    } else {
      const [cmt] = await db
        .select({ userId: comments.userId, content: comments.content, entityId: comments.entityId })
        .from(comments)
        .where(and(eq(comments.projectId, projectId), eq(comments.id, targetId)))
        .limit(1);
      if (!cmt) return;
      ownerId = cmt.userId;
      commentMeta = { commentId: targetId, commentContent: cmt.content };
      const [e] = await db
        .select({ shortId: entities.shortId, title: entities.title, content: entities.content })
        .from(entities)
        .where(and(eq(entities.projectId, projectId), eq(entities.id, cmt.entityId)))
        .limit(1);
      entityMeta = {
        entityId: cmt.entityId,
        entityShortId: e?.shortId ?? "",
        entityTitle: e?.title ?? null,
        entityContent: e?.content ?? null,
      };
    }
    if (!ownerId || ownerId === reactorId) return;

    const isUpvote = reactionType === "upvote";
    const baseType = targetType === "entity" ? "entity" : "comment";
    const action = targetType === "entity" ? "open-entity" : "open-comment";

    // Per-reaction notification.
    await insert(projectId, ownerId, reactorId, `${baseType}-${isUpvote ? "upvote" : "reaction"}`, action, {
      ...entityMeta,
      ...commentMeta,
      ...(isUpvote ? {} : { reactionType }),
      ...actor,
    });

    // Milestones: specific (this reaction type) + total (all reactions).
    const specificCount = Number(reactionCounts?.[reactionType] ?? 0);
    const totalCount = sum(reactionCounts);
    if (MILESTONES.includes(specificCount)) {
      await insert(projectId, ownerId, reactorId, `${baseType}-reaction-milestone-specific`, action, {
        ...entityMeta,
        ...commentMeta,
        reactionType,
        milestoneCount: specificCount,
        lastThreeUsers: await lastThreeReactors(projectId, targetType, targetId, reactionType),
      });
    }
    if (MILESTONES.includes(totalCount)) {
      await insert(projectId, ownerId, reactorId, `${baseType}-reaction-milestone-total`, action, {
        ...entityMeta,
        ...commentMeta,
        milestoneCount: totalCount,
        reactionCounts: reactionCounts ?? {},
        lastThreeUsers: await lastThreeReactors(projectId, targetType, targetId),
      });
    }
  } catch (err) {
    logger.error("[notifications] notifyOnReaction failed");
    logger.debug({ err }, "[notifications] notifyOnReaction failed");
  }
}

/** On follow: notify the followed user (new-follow). */
export async function notifyOnFollow(projectId: string, followerId: string, followedId: string): Promise<void> {
  try {
    const actor = await loadActor(projectId, followerId);
    if (!actor) return;
    await insert(projectId, followedId, followerId, "new-follow", "open-profile", { ...actor });
  } catch (err) {
    logger.error("[notifications] notifyOnFollow failed");
    logger.debug({ err }, "[notifications] notifyOnFollow failed");
  }
}

/** On a connection request: notify the addressee (connection-request). */
export async function notifyOnConnectionRequest(
  projectId: string, recipientId: string, requesterId: string, connectionId: string,
): Promise<void> {
  try {
    const actor = await loadActor(projectId, requesterId);
    if (!actor) return;
    await insert(projectId, recipientId, requesterId, "connection-request", "open-profile", { connectionId, ...actor });
  } catch (err) {
    logger.error("[notifications] notifyOnConnectionRequest failed");
    logger.debug({ err }, "[notifications] notifyOnConnectionRequest failed");
  }
}

/** On a connection accept: notify the original requester (connection-accepted). */
export async function notifyOnConnectionAccept(
  projectId: string, recipientId: string, accepterId: string, connectionId: string,
): Promise<void> {
  try {
    const actor = await loadActor(projectId, accepterId);
    if (!actor) return;
    await insert(projectId, recipientId, accepterId, "connection-accepted", "open-profile", { connectionId, ...actor });
  } catch (err) {
    logger.error("[notifications] notifyOnConnectionAccept failed");
    logger.debug({ err }, "[notifications] notifyOnConnectionAccept failed");
  }
}

// ─── steward conflict-resolution notifications ───────────────────────────────
// The case lifecycle stage being announced.
export type StewardCaseKind = "opened" | "in_mediation" | "closed";
// Outcomes that DID something to the respondent's content (so they're told, content-framed).
const RESPONDENT_AFFECTING_OUTCOMES = new Set(["escalated", "protective_action"]);
const CASE_TYPE: Record<StewardCaseKind, string> = {
  opened: "steward-case-opened",
  in_mediation: "steward-case-in-mediation",
  closed: "steward-case-resolved",
};

export interface StewardCaseCtx {
  caseId: string;
  complainantId?: string | null;
  respondentId?: string | null;
  subjectType?: string | null;
}
interface StewardNote { recipientId: string; type: string; action: string; metadata: Record<string, unknown> }

/**
 * Pure policy matrix — the single place that decides who is notified about a steward case, with what,
 * and when. Respondent notifications NEVER carry the complainant's identity. (Unit-tested.)
 * - power-aware:     complainant every stage; respondent only on content-affecting outcomes (content-framed).
 * - symmetric:       both parties every stage (respondent still case-framed, no complainant info).
 * - resolution-only: complainant only at close; respondent only on content-affecting outcomes.
 */
export function stewardCaseRecipients(
  policy: StewardNotifyPolicy,
  kind: StewardCaseKind,
  outcome: string | null | undefined,
  ctx: StewardCaseCtx,
): StewardNote[] {
  const notes: StewardNote[] = [];
  const caseMeta = { caseId: ctx.caseId, ...(outcome ? { outcome } : {}) };

  // Complainant — case-framed.
  const complainantStage = policy === "resolution-only" ? kind === "closed" : true;
  if (ctx.complainantId && complainantStage) {
    notes.push({ recipientId: ctx.complainantId, type: CASE_TYPE[kind], action: "steward-case", metadata: caseMeta });
  }

  // Respondent — symmetric mirrors the complainant (case-framed, no complainant info); otherwise only a
  // content-framed notice when their content was actually removed / a protective action was taken.
  if (ctx.respondentId) {
    if (policy === "symmetric") {
      notes.push({ recipientId: ctx.respondentId, type: CASE_TYPE[kind], action: "steward-case", metadata: caseMeta });
    } else if (kind === "closed" && outcome && RESPONDENT_AFFECTING_OUTCOMES.has(outcome)) {
      notes.push({
        recipientId: ctx.respondentId,
        type: "steward-content-removed",
        action: "steward-content",
        metadata: { outcome, ...(ctx.subjectType ? { subjectType: ctx.subjectType } : {}) }, // no caseId / complainant
      });
    }
  }
  return notes;
}

/** Fire steward-case notifications for a lifecycle event, honoring the project's notifyPolicy. */
export async function notifyStewardCaseEvent(
  projectId: string,
  args: StewardCaseCtx & { kind: StewardCaseKind; actorId: string; outcome?: string | null },
): Promise<void> {
  try {
    const { notifyPolicy } = await getStewardConfig(projectId);
    const notes = stewardCaseRecipients(notifyPolicy, args.kind, args.outcome ?? null, args);
    for (const n of notes) await insert(projectId, n.recipientId, args.actorId, n.type, n.action, n.metadata);
  } catch (err) {
    logger.error("[notifications] notifyStewardCaseEvent failed");
    logger.debug({ err }, "[notifications] notifyStewardCaseEvent failed");
  }
}

/**
 * Invite a party into a steward mediation channel (caucus or joint). Carries only the conversation id +
 * role — never any other party's identity. A caucus channel is steward↔party only (so there's nothing to
 * leak); a joint room's members are visible by membership, which is the consensual point of a joint room
 * (only opened when both parties consent and the case isn't flagged targeting — see lib/mediation.ts).
 */
export async function notifyMediationInvite(
  projectId: string,
  args: { recipientId: string; actorId: string; conversationId: string; role: "caucus" | "joint" },
): Promise<void> {
  try {
    await insert(projectId, args.recipientId, args.actorId, "steward-mediation-invite", "open-conversation", {
      conversationId: args.conversationId,
      mediationRole: args.role,
    });
  } catch (err) {
    logger.error("[notifications] notifyMediationInvite failed");
    logger.debug({ err }, "[notifications] notifyMediationInvite failed");
  }
}

/** On space membership approval: notify the approved member (space-membership-approved). */
export async function notifyOnSpaceApproved(
  projectId: string,
  memberId: string,
  approverId: string,
  space: { id: string; name: string; shortId: string; slug: string | null; avatar: string | null }
): Promise<void> {
  try {
    await insert(projectId, memberId, approverId, "space-membership-approved", "open-space", {
      spaceId: space.id,
      spaceName: space.name,
      spaceShortId: space.shortId,
      spaceSlug: space.slug,
      spaceAvatar: space.avatar,
    });
  } catch (err) {
    logger.error("[notifications] notifyOnSpaceApproved failed");
    logger.debug({ err }, "[notifications] notifyOnSpaceApproved failed");
  }
}
