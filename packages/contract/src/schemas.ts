// Zod request schemas for the Agora API. Pure zod — no server/Errors coupling.
// The server's parseBody(schema, raw) wraps these to throw a Replyke-shaped 400.
import { z } from "zod";
import { REACTION_TYPES } from "./reactions.js";

// .nullish() (= nullable + optional): SDK clients commonly send absent fields as `null`
// rather than omitting them. Accepting null avoids spurious 400s; handlers coerce null →
// undefined for columns that have NOT NULL defaults.
const mentions = z.array(z.unknown()).nullish();
const metadata = z.record(z.string(), z.unknown()).nullish();

export const createEntitySchema = z.object({
  title: z.string().nullish(),
  content: z.string().nullish(),
  foreignId: z.string().nullish(),
  sourceId: z.string().nullish(),
  spaceId: z.string().uuid().nullish(),
  keywords: z.array(z.string()).nullish(),
  mentions,
  attachments: z.array(z.unknown()).nullish(),
  metadata,
  isDraft: z.boolean().nullish(),
});

export const updateEntitySchema = z
  .object({
    title: z.string().nullable().optional(),
    content: z.string().nullable().optional(),
    keywords: z.array(z.string()).optional(),
    mentions,
    attachments: z.array(z.unknown()).optional(),
    metadata,
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No updatable fields provided" });

export const createCommentSchema = z.object({
  entityId: z.string().uuid(),
  parentId: z.string().uuid().nullish(),
  content: z.string().nullish(),
  gif: z.unknown().nullish(),
  foreignId: z.string().nullish(),
  mentions,
  metadata,
});

export const updateCommentSchema = z
  .object({
    content: z.string().nullable().optional(),
    gif: z.unknown().optional(),
    mentions,
    metadata,
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No updatable fields provided" });

// The SDK posts `{ reactionType }` to /entities/:id/reactions and /comments/:id/reactions
// (see @agora-sdk useAddReaction). The field name is part of the contract — match it exactly.
export const reactionSchema = z.object({
  reactionType: z.enum(REACTION_TYPES),
});

// ─── feed ranking ─────────────────────────────────────────────────────────────
// Per-request numeric overrides for the ranking algorithm (the `rankParams` query scalar). Every
// field is finite + range-clamped so only safe numbers ever reach a `sql` template (see ranking.ts).
export const rankParamsSchema = z
  .object({
    halfLifeHours: z.number().finite().min(0.1).max(8760),
    gravity: z.number().finite().min(0.1).max(5),
    z: z.number().finite().min(0).max(10),
    C: z.number().finite().min(0).max(1_000_000),
    m: z.number().finite().min(0).max(1),
  })
  .partial();

// PATCH body for /settings/feed (admin). defaultAlgorithm is a free string here (membership is
// enforced in feed-config.ts, which falls back to "hot") to avoid a validation↔ranking import cycle.
export const feedConfigSchema = z
  .object({
    defaultAlgorithm: z.string().max(40).nullish(),
    decayMode: z.enum(["stored", "query-time"]).nullish(),
    halfLifeHours: z.number().finite().min(0.1).max(8760).nullish(),
    gravity: z.number().finite().min(0.1).max(5).nullish(),
    z: z.number().finite().min(0).max(10).nullish(),
    C: z.number().finite().min(0).max(1_000_000).nullish(),
    m: z.number().finite().min(0).max(1).nullish(),
    reactionWeights: z.record(z.enum(REACTION_TYPES), z.number().finite().min(0).max(100)).nullish(),
    diversity: z.object({ perAuthorCap: z.number().int().min(1).max(50) }).nullish(),
    rerankWebhook: z
      .object({
        url: z.string().url().nullish(),
        secret: z.string().min(1).max(512).nullish(),
        timeoutMs: z.number().int().min(100).max(30_000).nullish(),
        overFetch: z.number().int().min(1).max(50).nullish(),
      })
      .nullish(),
  })
  .partial();

// ─── users / profiles ────────────────────────────────────────────────────────
export const updateProfileSchema = z
  .object({
    name: z.string().max(120).nullable().optional(),
    username: z.string().min(1).max(60).nullable().optional(),
    avatar: z.string().url().nullable().optional(),
    bio: z.string().max(300).nullable().optional(),
    metadata,
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No updatable fields provided" });

// ─── spaces ────────────────────────────────────────────────────────────────
const readingPerm = z.enum(["anyone", "members"]);
const postingPerm = z.enum(["anyone", "members", "admins"]);

export const createSpaceSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  readingPermission: readingPerm.optional(),
  postingPermission: postingPerm.optional(),
  requireJoinApproval: z.boolean().optional(),
  parentSpaceId: z.string().uuid().optional(),
  metadata,
});

export const updateSpaceSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    slug: z.string().min(1).max(120).nullable().optional(),
    description: z.string().max(2000).nullable().optional(),
    readingPermission: readingPerm.optional(),
    postingPermission: postingPerm.optional(),
    requireJoinApproval: z.boolean().optional(),
    parentSpaceId: z.string().uuid().nullable().optional(), // reparent; null = make top-level
    metadata,
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No updatable fields provided" });

export const createRuleSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  order: z.number().int().optional(),
});

export const updateRuleSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    order: z.number().int().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No updatable fields provided" });

export const reorderRulesSchema = z.object({
  order: z.array(z.string().uuid()).min(1), // rule ids in desired order
});

export const memberRoleSchema = z.object({
  role: z.enum(["admin", "moderator", "member"]),
});

export const moderationSchema = z.object({
  status: z.enum(["approved", "removed"]),
  reason: z.string().max(500).optional(),
});

// ─── collections ─────────────────────────────────────────────────────────────
export const createCollectionSchema = z.object({
  name: z.string().min(1).max(120),
  parentId: z.string().uuid().optional(),
});

export const addEntitySchema = z.object({
  entityId: z.string().uuid(),
});

// ─── reports ─────────────────────────────────────────────────────────────────
export const createReportSchema = z.object({
  targetType: z.enum(["entity", "comment"]),
  targetId: z.string().uuid(),
  reason: z.string().min(1).max(100),
  details: z.string().max(2000).optional(),
  spaceId: z.string().uuid().optional(),
});

// ─── auth ──────────────────────────────────────────────────────────────────
export const signUpSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  name: z.string().max(120).optional(),
  username: z.string().min(1).max(60).optional(),
});

export const signInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

export const signOutSchema = z.object({
  refreshToken: z.string().min(1).optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(128),
});

export const emailSchema = z.object({
  email: z.string().email(),
});

export const verifyEmailSchema = z.object({
  tokenHash: z.string().min(1),
  type: z.enum(["signup", "email", "recovery"]).optional(),
});

export const externalUserSchema = z
  .object({
    // The SDK posts `userJwt`; `token` kept as a legacy alias.
    userJwt: z.string().min(1).optional(),
    token: z.string().min(1).optional(),
  })
  .refine((v) => !!(v.userJwt || v.token), { message: "userJwt is required", path: ["userJwt"] });

export const signTestingJwtSchema = z.object({
  // Dev-only: the client sends its OWN external-auth private key (PKCS8 PEM) to sign a test JWT.
  privateKey: z.string().min(1),
  userData: z.object({ id: z.union([z.string(), z.number()]) }).passthrough(),
  projectId: z.string().optional(), // SDK includes it; we sign with the path projectId
});

export const webhookConfigSchema = z.object({
  url: z.string().url().nullish(),       // null clears it
  secret: z.string().min(1).nullish(),
  events: z.array(z.string()).nullish(), // null/absent → unchanged; [] disables all
});

// Per-project moderation config (PATCH /settings/moderation). Controls how "removed" content is
// served to non-moderators: "hide" (filtered/404) or "placeholder" (blanked [removed] row).
export const moderationConfigSchema = z.object({
  removedContentBehavior: z.enum(["hide", "placeholder"]).optional(),
});

// The @agora/moderator integration (PATCH /settings/moderator). Groups everything about automated
// moderation for one project:
//   - the internal notifier the API fans content `*.complete` events to (url + write-only secret) —
//     separate from the project's (external) webhook notifier;
//   - the block/review auto-action thresholds + LLM-provider tuning the moderator overlays on its env defaults.
// Every field is nullish: omit to leave unchanged, null to clear (→ the moderator's env default).
// `secret` and `llmApiKey` are write-only (GET exposes only hasSecret / hasLlmApiKey).
export const moderatorConfigSchema = z.object({
  url: z.string().url().nullish(),
  secret: z.string().min(1).nullish(),
  blockAutoActionThreshold: z.number().min(0).max(1).nullish(),
  reviewAutoActionThreshold: z.number().min(0).max(1).nullish(),
  llmProvider: z.enum(["openai", "anthropic"]).nullish(),
  llmBaseUrl: z.string().url().nullish(),
  llmApiKey: z.string().min(1).nullish(),
  llmModel: z.string().min(1).nullish(),
  llmMaxTokens: z.number().int().positive().nullish(),
});

// ─── automated moderation (@agora/moderator) ────────────────────────────────
// Body for the moderator's on-demand POST /moderation/analyze (admin "Re-analyze"). The admin
// already has the content loaded, so it passes the text directly along with what's being judged.
export const moderationAnalyzeSchema = z.object({
  targetType: z.enum(["entity", "comment", "message"]),
  targetId: z.string().uuid(),
  spaceId: z.string().uuid().nullish(),
  text: z.string().min(1).max(40000),
  context: z.string().max(40000).optional(), // optional surrounding context (e.g. parent entity)
});

export const oauthAuthorizeSchema = z.object({
  provider: z.string().min(1), // e.g. "google", "github", "apple" — passed through to Supabase
  // Where to send the browser after auth completes (default: the SDK sends window.location.href).
  // Not .url() so mobile deep links (myapp://) are allowed.
  redirectAfterAuth: z.string().min(1),
});

// ─── chat ──────────────────────────────────────────────────────────────────
export const createConversationSchema = z.object({
  type: z.enum(["group", "space"]).optional(),
  name: z.string().max(120).optional(),
  description: z.string().max(2000).optional(),
  spaceId: z.string().uuid().optional(),
  memberIds: z.array(z.string().uuid()).optional(),
  postingPermission: z.enum(["members", "admins"]).optional(),
});

export const directConversationSchema = z.object({
  userId: z.string().uuid(), // the other participant
});

export const updateConversationSchema = z
  .object({
    name: z.string().max(120).nullable().optional(),
    description: z.string().max(2000).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No updatable fields provided" });

const messageBody = {
  content: z.string().max(10000).optional(),
  gif: z.unknown().optional(),
  mentions,
  metadata,
};
export const sendMessageSchema = z.object({
  ...messageBody,
  parentMessageId: z.string().uuid().optional(),
  quotedMessageId: z.string().uuid().optional(),
  localId: z.string().optional(), // client optimistic-reconciliation token, echoed back, not persisted
}).refine((v) => v.content || v.gif, { message: "Message needs content or a gif" });

export const editMessageSchema = z
  .object(messageBody)
  .refine((v) => Object.keys(v).length > 0, { message: "No updatable fields provided" });

export const messageReactionSchema = z.object({
  emoji: z.string().min(1).max(64),
});

export const reportMessageSchema = z.object({
  reason: z.string().min(1).max(100),
  details: z.string().max(2000).optional(),
});

export const addConversationMemberSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(["admin", "member"]).optional(),
});

export const convMemberRoleSchema = z.object({
  role: z.enum(["admin", "member"]),
});

// ─── connections ─────────────────────────────────────────────────────────────
export const connectionRequestSchema = z.object({
  message: z.string().max(500).optional(),
});
