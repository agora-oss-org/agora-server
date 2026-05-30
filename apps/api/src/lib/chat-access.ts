// Chat conversation membership enforcement (the server-side trust boundary for chat messages).
//
// Unlike spaces, chat has no "public" read concept: a message is readable ONLY by ACTIVE members of
// its conversation (conversation_members.is_active). The chat REST routes enforce this via
// requireMember(); this helper applies the same rule to mixed result sets (semantic search) that
// hydrate messages directly. Operators bypass (project-wide god-view); anonymous callers read none.
import type { Context } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import type { Variables } from "../http/context.js";
import { db } from "../db/index.js";
import { chatMessages, conversationMembers } from "../db/schema/index.js";

type Ctx = Context<{ Variables: Variables }>;

/**
 * Given a set of chat-message ids, return the subset the caller may READ — those in a conversation
 * the caller is an ACTIVE member of. Operators get them all; anonymous callers get none.
 */
export async function readableMessageIds(
  c: Ctx,
  messageIdList: Array<string | null | undefined>,
): Promise<Set<string>> {
  const ids = [...new Set(messageIdList.filter((m): m is string => !!m))];
  const ok = new Set<string>();
  if (ids.length === 0) return ok;
  if (c.var.auth?.isOperator) {
    ids.forEach((i) => ok.add(i));
    return ok;
  }
  const uid = c.var.auth?.userId;
  if (!uid) return ok; // anonymous → no private messages
  const rows = await db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .innerJoin(
      conversationMembers,
      and(
        eq(conversationMembers.conversationId, chatMessages.conversationId),
        eq(conversationMembers.projectId, chatMessages.projectId),
      ),
    )
    .where(
      and(
        eq(chatMessages.projectId, c.var.projectId),
        inArray(chatMessages.id, ids),
        eq(conversationMembers.userId, uid),
        eq(conversationMembers.isActive, true),
      ),
    );
  rows.forEach((r) => ok.add(r.id));
  return ok;
}
