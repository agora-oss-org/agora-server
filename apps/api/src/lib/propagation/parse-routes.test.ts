import { describe, expect, it } from "vitest";
import {
  extractManifestEntries,
  extractRouteMounts,
  extractRoutePaths,
  joinPath,
  normalizePath,
} from "./parse-routes";

const ROUTER = `
const app = new Hono()
  .get("/", async (c) => {})
  .post("/", requireAuth, async (c) => {})
  .get("/by-short-id", async (c) => {})
  .get("/:id", async (c) => {})
  .delete("/:id", requireAuth, async (c) => {});
`;

const INDEX = `
import authRoutes from "./auth";
import entityRoutes from "./entities";
import connectionRoutes from "./connections";
import miscRoutes from "./misc";
export function mountRoutes() {
  project.route("/auth", authRoutes);
  project.route("/entities", entityRoutes);
  project.route("/", miscRoutes);
  v7.route("/", connectionRoutes);
}
`;

const MANIFEST = `
| Method | Path | Status |
|---|---|---|
| POST | \`/auth/sign-up\` (→ \`201\` session) | ✅ |
| GET | \`/entities/:entityId\` | ✅ |
prose that is not a table row
| DELETE | \`/entities/:entityId\` | 🔶 |
`;

describe("extractRoutePaths", () => {
  it("extracts chained method registrations with their paths", () => {
    expect(extractRoutePaths(ROUTER)).toEqual([
      { method: "GET", path: "/" },
      { method: "POST", path: "/" },
      { method: "GET", path: "/by-short-id" },
      { method: "GET", path: "/:id" },
      { method: "DELETE", path: "/:id" },
    ]);
  });
});

describe("extractRouteMounts", () => {
  it("maps route module basenames to mount prefixes", () => {
    expect(extractRouteMounts(INDEX)).toEqual({
      auth: "/auth",
      entities: "/entities",
      misc: "/",
      connections: "/",
    });
  });
});

describe("extractManifestEntries", () => {
  it("parses method+path from table rows, ignoring trailing prose", () => {
    expect(extractManifestEntries(MANIFEST)).toEqual([
      { method: "POST", path: "/auth/sign-up" },
      { method: "GET", path: "/entities/:entityId" },
      { method: "DELETE", path: "/entities/:entityId" },
    ]);
  });
});

describe("normalizePath / joinPath", () => {
  it("normalizes param names and trailing slashes so :id matches :entityId", () => {
    expect(normalizePath("/entities/:entityId")).toBe("/entities/:*");
    expect(normalizePath("/entities/:id/")).toBe("/entities/:*");
    expect(normalizePath("/")).toBe("/");
  });
  it("joins mount + subpath without doubled or trailing slashes", () => {
    expect(joinPath("/entities", "/:id")).toBe("/entities/:id");
    expect(joinPath("/entities", "/")).toBe("/entities");
    expect(joinPath("/", "/sign-up")).toBe("/sign-up");
    expect(joinPath("/", "/")).toBe("/");
  });
});
