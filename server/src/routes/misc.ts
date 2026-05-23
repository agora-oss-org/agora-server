// Small grouped domains mounted at the project root: oauth, projects, crypto (testing), utils.
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { oauthIdentities, projects, projectIntegrations } from "../db/schema/index.js";

export const miscRoutes = new Hono<{ Variables: Variables }>()
  // ── oauth identities (the auth user's linked providers) ─────────────────────
  .get("/oauth/identities", requireAuth, async (c) => {
    const rows = await db.select({ id: oauthIdentities.id, provider: oauthIdentities.provider, createdAt: oauthIdentities.createdAt })
      .from(oauthIdentities)
      .where(and(eq(oauthIdentities.projectId, c.var.projectId), eq(oauthIdentities.profileId, c.var.auth!.userId)));
    return c.json({ data: rows });
  })
  .delete("/oauth/identities/:id", requireAuth, async (c) => {
    const [row] = await db.select({ profileId: oauthIdentities.profileId }).from(oauthIdentities)
      .where(and(eq(oauthIdentities.projectId, c.var.projectId), eq(oauthIdentities.id, c.req.param("id")))).limit(1);
    if (!row) throw Errors.notFound("oauth/not-found", "Identity not found");
    if (row.profileId !== c.var.auth!.userId) throw Errors.forbidden("oauth/not-owner", "Not your identity");
    await db.delete(oauthIdentities).where(eq(oauthIdentities.id, c.req.param("id")));
    return c.json({ success: true });
  })
  // ── lean project info ───────────────────────────────────────────────────────
  .get("/projects/lean", async (c) => {
    const [project] = await db.select({ id: projects.id, name: projects.name }).from(projects)
      .where(eq(projects.id, c.var.projectId)).limit(1);
    if (!project) throw Errors.notFound("projects/not-found", "Project not found");
    const integrations = await db.select({ id: projectIntegrations.id, name: projectIntegrations.name })
      .from(projectIntegrations).where(eq(projectIntegrations.projectId, c.var.projectId));
    return c.json({ id: project.id, name: project.name, integrations });
  })
  // ── crypto (testing only) — stubbed; external-auth JWT minting is a dev convenience ──
  .post("/crypto/sign-testing-jwt/v2", (c) => { throw Errors.notImplemented("crypto/sign-testing-jwt"); })
  // ── link/OG metadata fetcher ────────────────────────────────────────────────
  .get("/utils/get-metadata", async (c) => {
    const url = c.req.query("url");
    if (!url) throw Errors.badRequest("utils/missing-url", "url is required", "url");
    let target: URL;
    try { target = new URL(url); } catch { throw Errors.badRequest("utils/bad-url", "Invalid URL", "url"); }
    if (!/^https?:$/.test(target.protocol) || isInternalHost(target.hostname)) {
      throw Errors.badRequest("utils/blocked-url", "URL not allowed", "url");
    }
    try {
      const res = await fetch(target, {
        headers: { "User-Agent": "AgoraBot/1.0 (+link-preview)" },
        signal: AbortSignal.timeout(6000),
        redirect: "follow",
      });
      const html = (await res.text()).slice(0, 500_000); // cap parse size
      return c.json({
        url: target.toString(),
        title: meta(html, "og:title") ?? tag(html, "title"),
        description: meta(html, "og:description") ?? metaName(html, "description"),
        image: meta(html, "og:image"),
        siteName: meta(html, "og:site_name"),
      });
    } catch {
      throw Errors.badRequest("utils/fetch-failed", "Could not fetch URL metadata", "url");
    }
  });

// ── helpers ───────────────────────────────────────────────────────────────────
function isInternalHost(host: string): boolean {
  return (
    host === "localhost" || host.endsWith(".local") ||
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === "0.0.0.0" || host === "::1"
  );
}
function meta(html: string, property: string): string | undefined {
  const re = new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, "i");
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`, "i");
  return html.match(re)?.[1] ?? html.match(re2)?.[1];
}
function metaName(html: string, name: string): string | undefined {
  const re = new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, "i");
  return html.match(re)?.[1];
}
function tag(html: string, t: string): string | undefined {
  return html.match(new RegExp(`<${t}[^>]*>([^<]+)</${t}>`, "i"))?.[1]?.trim();
}
