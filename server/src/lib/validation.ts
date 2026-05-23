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

const mentions = z.array(z.unknown()).optional();
const metadata = z.record(z.string(), z.unknown()).optional();

export const createEntitySchema = z.object({
  title: z.string().optional(),
  content: z.string().optional(),
  foreignId: z.string().optional(),
  sourceId: z.string().optional(),
  spaceId: z.string().uuid().optional(),
  keywords: z.array(z.string()).optional(),
  mentions,
  attachments: z.array(z.unknown()).optional(),
  metadata,
  isDraft: z.boolean().optional(),
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
  parentId: z.string().uuid().optional(),
  content: z.string().optional(),
  gif: z.unknown().optional(),
  foreignId: z.string().optional(),
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
