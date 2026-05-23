// Small grouped domains mounted at the project root:
// oauth, projects, crypto (testing), utils.
import { Hono } from "hono";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";

export const miscRoutes = new Hono<{ Variables: Variables }>()
  // oauth identities
  .get("/oauth/identities", (c) => { throw Errors.notImplemented("oauth/identities"); })
  .delete("/oauth/identities/:id", (c) => { throw Errors.notImplemented("oauth/delete-identity"); })
  // projects
  .get("/projects/lean", (c) => { throw Errors.notImplemented("projects/lean"); })
  // crypto (testing only): mint an RS256 external-auth JWT for local dev
  .post("/crypto/sign-testing-jwt/v2", (c) => { throw Errors.notImplemented("crypto/sign-testing-jwt"); })
  // utils
  .get("/utils/get-metadata", (c) => { throw Errors.notImplemented("utils/get-metadata"); }); // OG/link metadata
