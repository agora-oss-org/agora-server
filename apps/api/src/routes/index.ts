// Mounts every domain router under the project-scoped base path.
// Final shape: /v7/:projectId/<domain>/...  (matches the SDK contract).
import { Hono } from "hono";
import type { Variables } from "../http/context.js";
import { resolveProject } from "../middleware/project.js";
import { optionalAuth } from "../middleware/auth.js";
import { meterUsage } from "../middleware/metrics.js";

import { authRoutes } from "./auth.js";
import { entityRoutes } from "./entities.js";
import { commentRoutes } from "./comments.js";
import { userRoutes } from "./users.js";
import { followRoutes } from "./follows.js";
import { connectionRoutes } from "./connections.js";
import { spaceRoutes } from "./spaces.js";
import { chatRoutes } from "./chat.js";
import { collectionRoutes } from "./collections.js";
import { notificationRoutes } from "./notifications.js";
import { reportRoutes } from "./reports.js";
import { searchRoutes } from "./search.js";
import { storageRoutes } from "./storage.js";
import { adminRoutes } from "./admin.js";
import { miscRoutes } from "./misc.js";

export function mountRoutes() {
  // Project-scoped app: every request resolves :projectId, then attaches optional auth.
  const project = new Hono<{ Variables: Variables }>();
  project.use("*", meterUsage);                  // time + count every request (reads projectId after next())
  project.use("*", resolveProject, optionalAuth);

  project.route("/auth", authRoutes);
  project.route("/entities", entityRoutes);
  project.route("/comments", commentRoutes);
  project.route("/users", userRoutes);
  project.route("/follows", followRoutes);
  project.route("/spaces", spaceRoutes);
  project.route("/chat", chatRoutes);
  project.route("/collections", collectionRoutes);
  project.route("/app-notifications", notificationRoutes);
  project.route("/reports", reportRoutes);
  project.route("/search", searchRoutes);
  project.route("/storage", storageRoutes);
  project.route("/admin", adminRoutes);
  // oauth, projects, crypto, utils — small, grouped in misc
  project.route("/", miscRoutes);

  const v7 = new Hono<{ Variables: Variables }>();
  // Connections live at the /v7 root (project derived from the auth user), NOT under :projectId.
  // Registered before the param route so the static /connections + /users segments win.
  v7.route("/", connectionRoutes);
  v7.route("/:projectId", project);
  return v7;
}
