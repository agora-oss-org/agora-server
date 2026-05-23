// Small grouped domains mounted at the project root: oauth, projects, crypto (testing), utils.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { Provider } from "@supabase/supabase-js";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { oauthIdentities, oauthStates, profiles, projects, projectIntegrations } from "../db/schema/index.js";
import { pkceClient, oauthConfigured } from "../lib/oauth.js";
import { mintSession } from "../lib/tokens.js";
import { parseBody, oauthAuthorizeSchema } from "../lib/validation.js";

type ProfileRow = typeof profiles.$inferSelect;

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
  // ── OAuth sign-in / link (Supabase-brokered, code + PKCE) ───────────────────
  // POST per the SDK's useOAuthSignIn: body { provider, redirectAfterAuth } → { authorizationUrl }.
  .post("/oauth/authorize", async (c) => {
    const body = parseBody(oauthAuthorizeSchema, await c.req.json().catch(() => ({})), "oauth");
    return c.json(await startOAuth(c, body, "signin", null));
  })
  // Same, but for an authenticated user linking a provider to their existing account.
  .post("/oauth/link", requireAuth, async (c) => {
    const body = parseBody(oauthAuthorizeSchema, await c.req.json().catch(() => ({})), "oauth");
    return c.json(await startOAuth(c, body, "link", c.var.auth!.userId));
  })
  // Provider redirects the browser back here with ?aid=<state>&code=… (or ?error=…). We exchange
  // the code with Supabase, upsert the profile, mint Agora tokens, and redirect to the host app
  // with the tokens in the URL fragment (where the SDK's handleOAuthCallback() reads them).
  .get("/oauth/callback", async (c) => {
    const projectId = c.var.projectId;
    const aid = c.req.query("aid");
    if (!aid) throw Errors.badRequest("oauth/missing-state", "Missing state id");
    const [state] = await db.select().from(oauthStates)
      .where(and(eq(oauthStates.projectId, projectId), eq(oauthStates.id, aid))).limit(1);
    if (!state) throw Errors.badRequest("oauth/invalid-state", "Unknown or expired OAuth state");
    await db.delete(oauthStates).where(eq(oauthStates.id, state.id)); // one-shot

    const base = state.redirectAfterAuth;
    const providerError = c.req.query("error");
    if (providerError) return errorRedirect(c, base, providerError, c.req.query("error_description") ?? "");
    const code = c.req.query("code");
    if (!code) return errorRedirect(c, base, "missing_code", "No authorization code returned");

    try {
      const { client } = pkceClient(state.pkce as Record<string, string>);
      const { data, error } = await client.auth.exchangeCodeForSession(code);
      if (error || !data.session?.user) throw new Error(error?.message ?? "Code exchange failed");
      const u = data.session.user;
      const ident = (u.identities ?? []).find((i: any) => i.provider === state.provider);
      const providerUid = (ident?.id as string) ?? (ident?.identity_data?.sub as string) ?? u.id;
      const meta = (u.user_metadata ?? {}) as Record<string, any>;

      let profile: ProfileRow;
      if (state.flow === "link" && state.profileId) {
        const [p] = await db.select().from(profiles)
          .where(and(eq(profiles.projectId, projectId), eq(profiles.id, state.profileId))).limit(1);
        if (!p) return errorRedirect(c, base, "link_failed", "Account not found");
        profile = p;
      } else {
        // Username is unique per project, so we don't auto-claim it from the provider — the user
        // can set one later via profile update.
        profile = await ensureOAuthProfile(projectId, u.id, state.provider, {
          email: u.email ?? undefined,
          name: meta.full_name ?? meta.name ?? undefined,
          avatar: meta.avatar_url ?? meta.picture ?? undefined,
        });
      }
      await recordIdentity(projectId, profile.id, state.provider, providerUid);
      const tokens = await mintSession(projectId, profile.id, profile.role);
      await db.update(profiles).set({ lastActive: new Date() }).where(eq(profiles.id, profile.id));
      const frag = `accessToken=${encodeURIComponent(tokens.accessToken)}&refreshToken=${encodeURIComponent(tokens.refreshToken)}`;
      return c.redirect(`${base}#${frag}`, 302);
    } catch (e: any) {
      return errorRedirect(c, base, "oauth_failed", e?.message ?? "OAuth failed");
    }
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

// ── oauth helpers ───────────────────────────────────────────────────────────
// Ask Supabase for the provider authorization URL, persist the PKCE verifier + flow, return the URL.
async function startOAuth(
  c: any,
  body: { provider: string; redirectAfterAuth: string },
  flow: "signin" | "link",
  profileId: string | null
): Promise<{ authorizationUrl: string }> {
  if (!oauthConfigured()) throw Errors.badRequest("oauth/not-configured", "OAuth is not configured (Supabase keys unset)");
  const projectId = c.var.projectId;
  const stateId = randomUUID();
  const origin = new URL(c.req.url).origin;
  const callbackUrl = `${origin}/v7/${projectId}/oauth/callback?aid=${stateId}`;
  const { client, dump } = pkceClient();
  const { data, error } = await client.auth.signInWithOAuth({
    provider: body.provider as Provider,
    options: { redirectTo: callbackUrl, skipBrowserRedirect: true },
  });
  if (error || !data?.url) throw Errors.badRequest("oauth/authorize-failed", error?.message ?? "Could not start OAuth");
  await db.insert(oauthStates).values({
    id: stateId, projectId, profileId, provider: body.provider, flow,
    redirectAfterAuth: body.redirectAfterAuth, pkce: dump(),
  });
  return { authorizationUrl: data.url };
}

// Create-or-return the profile for an OAuth-authenticated Supabase user (keyed by auth user id).
async function ensureOAuthProfile(
  projectId: string,
  authUserId: string,
  provider: string,
  attrs: { email?: string; name?: string; avatar?: string }
): Promise<ProfileRow> {
  const [existing] = await db.select().from(profiles)
    .where(and(eq(profiles.projectId, projectId), eq(profiles.authUserId, authUserId))).limit(1);
  if (existing) return existing;
  const [row] = await db.insert(profiles).values({
    projectId, authUserId, email: attrs.email, name: attrs.name, avatar: attrs.avatar,
    authMethods: [provider],
  }).returning();
  return row!;
}

// Record the linked provider identity (idempotent) and ensure the provider is in authMethods.
async function recordIdentity(projectId: string, profileId: string, provider: string, providerUid: string): Promise<void> {
  await db.insert(oauthIdentities).values({ projectId, profileId, provider, providerUid }).onConflictDoNothing();
  const [p] = await db.select({ am: profiles.authMethods }).from(profiles).where(eq(profiles.id, profileId)).limit(1);
  const am = (p?.am ?? []) as string[];
  if (!am.includes(provider)) {
    await db.update(profiles).set({ authMethods: [...am, provider] }).where(eq(profiles.id, profileId));
  }
}

function errorRedirect(c: any, base: string, code: string, desc: string) {
  const sep = base.includes("?") ? "&" : "?";
  return c.redirect(`${base}${sep}error=${encodeURIComponent(code)}&error_description=${encodeURIComponent(desc)}`, 302);
}

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
