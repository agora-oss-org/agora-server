// /v7/:projectId/auth/*
import { Hono } from "hono";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";

export const authRoutes = new Hono<{ Variables: Variables }>()
  .post("/sign-up", (c) => { throw Errors.notImplemented("auth/sign-up"); })
  .post("/sign-in", (c) => { throw Errors.notImplemented("auth/sign-in"); })
  .post("/sign-out", (c) => { throw Errors.notImplemented("auth/sign-out"); })
  // refresh-token rotation + reuse detection + 30s grace lives in services/tokens.ts
  .post("/request-new-access-token", (c) => { throw Errors.notImplemented("auth/refresh"); })
  .post("/change-password", (c) => { throw Errors.notImplemented("auth/change-password"); })
  .post("/request-password-reset", (c) => { throw Errors.notImplemented("auth/request-password-reset"); })
  .post("/verify-email", (c) => { throw Errors.notImplemented("auth/verify-email"); })
  .post("/send-verification-email", (c) => { throw Errors.notImplemented("auth/send-verification-email"); })
  // external auth: verify RS256 JWT (sub/iss/aud=replyke.com/userData) → mint Agora token pair
  .post("/verify-external-user", (c) => { throw Errors.notImplemented("auth/verify-external-user"); });
