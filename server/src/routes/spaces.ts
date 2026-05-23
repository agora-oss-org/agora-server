// /v7/:projectId/spaces/*
import { Hono } from "hono";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";

export const spaceRoutes = new Hono<{ Variables: Variables }>()
  .get("/", (c) => { throw Errors.notImplemented("spaces/list"); })
  .post("/", (c) => { throw Errors.notImplemented("spaces/create"); })
  .get("/by-short-id", (c) => { throw Errors.notImplemented("spaces/by-short-id"); })
  .get("/by-slug", (c) => { throw Errors.notImplemented("spaces/by-slug"); })
  .get("/check-slug", (c) => { throw Errors.notImplemented("spaces/check-slug"); })
  .get("/user-spaces", (c) => { throw Errors.notImplemented("spaces/user-spaces"); })
  .get("/:id", (c) => { throw Errors.notImplemented("spaces/get"); })
  .patch("/:id", (c) => { throw Errors.notImplemented("spaces/update"); })
  .delete("/:id", (c) => { throw Errors.notImplemented("spaces/delete"); })
  .get("/:id/breadcrumb", (c) => { throw Errors.notImplemented("spaces/breadcrumb"); })
  .get("/:id/children", (c) => { throw Errors.notImplemented("spaces/children"); })
  // membership
  .post("/:id/join", (c) => { throw Errors.notImplemented("spaces/join"); })
  .delete("/:id/leave", (c) => { throw Errors.notImplemented("spaces/leave"); })
  .get("/:id/membership/me", (c) => { throw Errors.notImplemented("spaces/my-membership"); })
  .get("/:id/members", (c) => { throw Errors.notImplemented("spaces/members"); })
  .delete("/:id/members/:memberId", (c) => { throw Errors.notImplemented("spaces/remove-member"); })
  .patch("/:id/members/:memberId/role", (c) => { throw Errors.notImplemented("spaces/member-role"); })
  .patch("/:id/members/:memberId/approve", (c) => { throw Errors.notImplemented("spaces/approve-member"); })
  .patch("/:id/members/:memberId/decline", (c) => { throw Errors.notImplemented("spaces/decline-member"); })
  .patch("/:id/members/:memberId/unban", (c) => { throw Errors.notImplemented("spaces/unban-member"); })
  .get("/:id/team", (c) => { throw Errors.notImplemented("spaces/team"); })
  // digest config
  .get("/:id/digest-config", (c) => { throw Errors.notImplemented("spaces/get-digest"); })
  .patch("/:id/digest-config", (c) => { throw Errors.notImplemented("spaces/set-digest"); })
  // rules
  .get("/:id/rules", (c) => { throw Errors.notImplemented("spaces/rules"); })
  .post("/:id/rules", (c) => { throw Errors.notImplemented("spaces/create-rule"); })
  .patch("/:id/rules/reorder", (c) => { throw Errors.notImplemented("spaces/reorder-rules"); })
  .get("/:id/rules/:ruleId", (c) => { throw Errors.notImplemented("spaces/rule"); })
  .patch("/:id/rules/:ruleId", (c) => { throw Errors.notImplemented("spaces/update-rule"); })
  .delete("/:id/rules/:ruleId", (c) => { throw Errors.notImplemented("spaces/delete-rule"); })
  // moderation
  .patch("/:id/entities/:entityId/moderation", (c) => { throw Errors.notImplemented("spaces/moderate-entity"); })
  .patch("/:id/comments/:commentId/moderation", (c) => { throw Errors.notImplemented("spaces/moderate-comment"); })
  .patch("/:id/reports/entity/:entityId", (c) => { throw Errors.notImplemented("spaces/resolve-entity-report"); })
  .patch("/:id/reports/comment/:commentId", (c) => { throw Errors.notImplemented("spaces/resolve-comment-report"); });
