// Shared building blocks: enums and reusable column defaults.
// NOTE: PostGIS `geography(Point,4326)` location columns + their GiST indexes are added
// in a custom SQL migration (Drizzle's customType mis-quotes the type modifier), and
// auth.users (Supabase-managed) is intentionally NOT modeled here — `profiles.auth_user_id`
// is a plain uuid the app links, so Drizzle never tries to own the auth schema.
import { pgEnum } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ─── Enums (mirror @replyke/core types) ──────────────────────────────────────
export const userRole = pgEnum("user_role", ["admin", "moderator", "visitor"]);
export const reactionType = pgEnum("reaction_type", ["upvote", "downvote", "like", "love", "wow", "sad", "angry", "funny"]);
// "message" is used by reports (chat-message reports); reactions only ever use entity|comment.
export const reactionTarget = pgEnum("reaction_target", ["entity", "comment", "message"]);
export const moderationStatus = pgEnum("moderation_status", ["approved", "removed"]);
export const moderatedByType = pgEnum("moderated_by_type", ["client", "user"]);
// Automated-moderation verdict (@agora/moderator's LLM assessment). "allow"=clean, "block"=violates,
// "review"=uncertain → human queue. Stored on moderation_analyses (the AI-flag audit trail).
export const moderationVerdict = pgEnum("moderation_verdict", ["allow", "block", "review"]);
export const readingPermission = pgEnum("reading_permission", ["anyone", "members"]);
export const postingPermission = pgEnum("posting_permission", ["anyone", "members", "admins"]);
export const spaceMemberRole = pgEnum("space_member_role", ["admin", "moderator", "member"]);
export const spaceMemberStatus = pgEnum("space_member_status", ["pending", "active", "banned", "rejected"]);
export const conversationType = pgEnum("conversation_type", ["direct", "group", "space"]);
export const convMemberRole = pgEnum("conv_member_role", ["admin", "member"]);
export const connectionStatus = pgEnum("connection_status", ["pending", "connected", "declined"]);

// ─── Steward (conflict resolution) ───────────────────────────────────────────
// Case lifecycle: open → in_mediation → closed. "Open caseload" = state <> 'closed'.
export const stewardCaseState = pgEnum("steward_case_state", ["open", "in_mediation", "closed"]);
// Disposition set when a case closes. Declared in TRANSFORMATIVE ORDER (repair → separation →
// protection → escalation → dismissal) so the admin renders the outcome menu straight from the enum:
// repair/separation/protection come first; escalate-to-removal is the last resort.
export const stewardCaseOutcome = pgEnum("steward_case_outcome", ["repaired", "separated", "protective_action", "escalated", "dismissed"]);
// Timeline event kinds (append-only audit trail — nothing on a case is silently mutated).
export const stewardCaseEventKind = pgEnum("steward_case_event_kind", ["opened", "note", "state_change", "assignment", "asymmetry", "outcome", "escalation", "mediation_opened", "mediation_closed"]);

// ─── Secure chat (E2E, MLS/RFC-9420) ────────────────────────────────────────
// Distinct from the plaintext-chat enums above — the secure surface is a separate path.
export const secureConversationType = pgEnum("secure_conversation_type", ["dm", "group", "channel"]);
export const secureMemberRole = pgEnum("secure_member_role", ["admin", "member"]);
export const secureHandshakeKind = pgEnum("secure_handshake_kind", ["welcome", "commit", "proposal"]);

// ─── Reusable jsonb default: the 8 v7 reaction counts, all zero ──────────────
export const zeroReactionCounts = sql`'{"upvote":0,"downvote":0,"like":0,"love":0,"wow":0,"sad":0,"angry":0,"funny":0}'::jsonb`;
