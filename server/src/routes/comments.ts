// /v7/:projectId/comments/*
import { Hono } from "hono";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";

export const commentRoutes = new Hono<{ Variables: Variables }>()
  .get("/", (c) => { throw Errors.notImplemented("comments/list"); })           // ?entityId &parentId -> fetch_comment_thread
  .post("/", (c) => { throw Errors.notImplemented("comments/create"); })
  .get("/by-foreign-id", (c) => { throw Errors.notImplemented("comments/by-foreign-id"); })
  .get("/:id", (c) => { throw Errors.notImplemented("comments/get"); })
  .patch("/:id", (c) => { throw Errors.notImplemented("comments/update"); })
  .delete("/:id", (c) => { throw Errors.notImplemented("comments/delete"); })   // soft delete -> user_deleted_at
  .post("/:id/reactions", (c) => { throw Errors.notImplemented("comments/react"); })
  .delete("/:id/reactions", (c) => { throw Errors.notImplemented("comments/unreact"); });
