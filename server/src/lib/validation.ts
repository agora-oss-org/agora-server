// Zod request schemas for the entities/comments/reactions vertical.
// Handlers call parseBody(schema, raw) which throws a Replyke-shaped 400 on failure.
import { z } from "zod";
import { Errors } from "../http/errors.js";
import { REACTION_TYPES } from "./shape.js";

/** Validate a parsed JSON body; throw Errors.badRequest with the offending field. */
export function parseBody<T>(schema: z.ZodType<T>, raw: unknown, feature: string): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue?.path.join(".") || undefined;
    throw Errors.badRequest(`${feature}/invalid-body`, issue?.message ?? "Invalid body", field);
  }
  return result.data;
}

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

export const reactionSchema = z.object({
  type: z.enum(REACTION_TYPES),
});

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

export const externalUserSchema = z.object({
  token: z.string().min(1), // RS256 JWT signed by the host app's private key
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
