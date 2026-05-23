// /v7/:projectId/reports/*
import { Hono } from "hono";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";

export const reportRoutes = new Hono<{ Variables: Variables }>()
  .post("/", (c) => { throw Errors.notImplemented("reports/create"); })
  .get("/moderated", (c) => { throw Errors.notImplemented("reports/moderated"); });
