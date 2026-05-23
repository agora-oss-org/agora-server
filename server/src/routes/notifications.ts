// /v7/:projectId/app-notifications/*
import { Hono } from "hono";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";

export const notificationRoutes = new Hono<{ Variables: Variables }>()
  .get("/", (c) => { throw Errors.notImplemented("notifications/list"); })
  .get("/count", (c) => { throw Errors.notImplemented("notifications/count"); })
  .post("/mark-all-as-read", (c) => { throw Errors.notImplemented("notifications/mark-all"); })
  .patch("/:id/mark-as-read", (c) => { throw Errors.notImplemented("notifications/mark-one"); });
