// Small grouped domains mounted at the project root: oauth, projects, crypto (testing), utils.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { importPKCS8, SignJWT } from "jose";
import type { Provider } from "@supabase/supabase-js";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { oauthIdentities, oauthStates, profiles, projects, projectIntegrations } from "../db/schema/index.js";
import { pkceClient, oauthConfigured } from "../lib/oauth.js";
import { env } from "../lib/env.js";
import { mintSession } from "../lib/tokens.js";
import * as webhooks from "../lib/webhooks.js";
import { getFeedConfig, invalidateFeedConfig, feedConfigView } from "../lib/feed-config.js";
import { getModerationConfig, invalidateModerationConfig, moderationConfigView } from "../lib/moderation-config.js";
import { parseBody, oauthAuthorizeSchema, signTestingJwtSchema, webhookConfigSchema, feedConfigSchema, moderationConfigSchema, moderatorConfigSchema } from "../lib/validation.js";

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
  // ── webhook config (project-admin only; server-side admin surface, not an SDK hook) ─────
  // GET returns the URL + subscribed events + whether a secret is set (never the secret itself).
  .get("/webhooks/config", requireAuth, async (c) => {
    await requireProjectAdmin(c);
    return c.json(await webhookConfigView(c.var.projectId));
  })
  .patch("/webhooks/config", requireAuth, async (c) => {
    await requireProjectAdmin(c);
    const body = parseBody(webhookConfigSchema, await c.req.json().catch(() => ({})), "webhooks");
    const patch: Record<string, unknown> = {};
    if (body.url !== undefined) patch.webhookUrl = body.url; // null clears
    if (body.secret !== undefined) patch.webhookSecret = body.secret;
    if (body.events !== undefined) patch.webhookEvents = body.events ?? [];
    if (Object.keys(patch).length) await db.update(projects).set(patch).where(eq(projects.id, c.var.projectId));
    webhooks.invalidateConfig(c.var.projectId); // config is cached 30s — drop it now
    return c.json(await webhookConfigView(c.var.projectId));
  })
  // Send a signed test ping to the configured URL and report the delivery result.
  .post("/webhooks/test", requireAuth, async (c) => {
    await requireProjectAdmin(c);
    const result = await webhooks.sendTest(c.var.projectId);
    if (!result.configured) throw Errors.badRequest("webhooks/not-configured", "No webhook URL configured for this project");
    return c.json(result);
  })
  // ── feed ranking config (project-admin only; backs the Feed settings UI) ─────
  // GET returns the resolved config (re-rank webhook secret redacted to hasSecret).
  .get("/settings/feed", requireAuth, async (c) => {
    await requireProjectAdmin(c);
    return c.json(feedConfigView(await getFeedConfig(c.var.projectId)));
  })
  // PATCH deep-merges the provided keys into projects.feed_config (top-level + reactionWeights merge).
  .patch("/settings/feed", requireAuth, async (c) => {
    await requireProjectAdmin(c);
    const body = parseBody(feedConfigSchema, await c.req.json().catch(() => ({})), "feed");
    const [row] = await db.select({ feedConfig: projects.feedConfig }).from(projects).where(eq(projects.id, c.var.projectId)).limit(1);
    const current = (row?.feedConfig && typeof row.feedConfig === "object" ? row.feedConfig : {}) as Record<string, any>;
    const next: Record<string, any> = { ...current };
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue;
      if (v === null) { delete next[k]; continue; } // null clears a key
      if (k === "reactionWeights" && typeof v === "object") next.reactionWeights = { ...(current.reactionWeights ?? {}), ...v };
      else next[k] = v;
    }
    await db.update(projects).set({ feedConfig: next }).where(eq(projects.id, c.var.projectId));
    invalidateFeedConfig(c.var.projectId); // cached 30s — drop it now
    return c.json(feedConfigView(await getFeedConfig(c.var.projectId)));
  })
  // ── moderation config (project-admin only; backs the Moderation settings UI) ─
  .get("/settings/moderation", requireAuth, async (c) => {
    await requireProjectAdmin(c);
    return c.json(moderationConfigView(await getModerationConfig(c.var.projectId)));
  })
  .patch("/settings/moderation", requireAuth, async (c) => {
    await requireProjectAdmin(c);
    const body = parseBody(moderationConfigSchema, await c.req.json().catch(() => ({})), "moderation");
    const [row] = await db.select({ moderationConfig: projects.moderationConfig }).from(projects).where(eq(projects.id, c.var.projectId)).limit(1);
    const current = (row?.moderationConfig && typeof row.moderationConfig === "object" ? row.moderationConfig : {}) as Record<string, any>;
    const next: Record<string, any> = { ...current };
    if (body.removedContentBehavior !== undefined) next.removedContentBehavior = body.removedContentBehavior;
    await db.update(projects).set({ moderationConfig: next }).where(eq(projects.id, c.var.projectId));
    invalidateModerationConfig(c.var.projectId); // cached 30s — drop it now
    return c.json(moderationConfigView(await getModerationConfig(c.var.projectId)));
  })
  // ── moderator integration (internal @agora/moderator service; project-admin only) ─
  // Everything about automated moderation for the project: the internal notifier (url + secret, the
  // API fans content `*.complete` events here, separate from /webhooks/config) plus the auto-action
  // threshold + LLM tuning the moderator overlays on its env. `secret`/`llmApiKey` are write-only.
  .get("/settings/moderator", requireAuth, async (c) => {
    await requireProjectAdmin(c);
    return c.json(await moderatorView(c.var.projectId));
  })
  .patch("/settings/moderator", requireAuth, async (c) => {
    await requireProjectAdmin(c);
    const body = parseBody(moderatorConfigSchema, await c.req.json().catch(() => ({})), "moderator");
    // The notifier transport lives in dedicated columns; the tuning lives in the moderator_config
    // JSONB (merge-on-write: null clears a key → the moderator falls back to its env default).
    const cols: Record<string, unknown> = {};
    if (body.url !== undefined) cols.moderationWebhookUrl = body.url; // null clears (disables it)
    if (body.secret !== undefined) cols.moderationWebhookSecret = body.secret;
    const [row] = await db.select({ moderatorConfig: projects.moderatorConfig }).from(projects).where(eq(projects.id, c.var.projectId)).limit(1);
    const current = (row?.moderatorConfig && typeof row.moderatorConfig === "object" ? row.moderatorConfig : {}) as Record<string, any>;
    const next: Record<string, any> = { ...current };
    for (const k of ["autoActionThreshold", "llmProvider", "llmBaseUrl", "llmApiKey", "llmModel", "llmMaxTokens"] as const) {
      const v = (body as Record<string, unknown>)[k];
      if (v === undefined) continue;
      if (v === null) delete next[k]; // clear → moderator env default
      else next[k] = v;
    }
    cols.moderatorConfig = next;
    await db.update(projects).set(cols).where(eq(projects.id, c.var.projectId));
    webhooks.invalidateConfig(c.var.projectId); // notifier config is cached 30s — drop it now
    return c.json(await moderatorView(c.var.projectId));
  })
  // Send a signed test ping to the configured moderator URL and report the delivery result.
  .post("/settings/moderator/test", requireAuth, async (c) => {
    await requireProjectAdmin(c);
    const result = await webhooks.sendModerationTest(c.var.projectId);
    if (!result.configured) throw Errors.badRequest("moderator/not-configured", "No moderator URL configured for this project");
    return c.json(result);
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
  // ── crypto (testing only) — sign an external-auth JWT so devs can exercise verify-external-user
  // without a backend. The client sends its OWN private key (NOT secure; dev/quick-start only).
  // Output is consumed by /auth/verify-external-user, so claims must match what it checks:
  // RS256, issuer=projectId, audience="replyke.com", sub=userData.id, userData=userData.
  .post("/crypto/sign-testing-jwt/v2", async (c) => {
    const body = parseBody(signTestingJwtSchema, await c.req.json().catch(() => ({})), "crypto");
    try {
      const key = await importPKCS8(body.privateKey, "RS256");
      const jwt = await new SignJWT({ userData: body.userData })
        .setProtectedHeader({ alg: "RS256" })
        .setSubject(String(body.userData.id))
        .setIssuer(c.var.projectId)
        .setAudience("replyke.com")
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(key);
      return c.json(jwt); // SDK reads response.data as a bare JWT string
    } catch (e: any) {
      throw Errors.badRequest("crypto/sign-failed", `Could not sign JWT: ${e?.message ?? "invalid private key"}`);
    }
  })
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

// ── webhook-admin helpers ───────────────────────────────────────────────────
// Project-admin gate for project-wide config (feed ranking, webhooks). Deployment operators have the
// god-view, so they pass; otherwise the user's profile must have role "admin".
async function requireProjectAdmin(c: any): Promise<void> {
  if (c.var.auth?.isOperator) return;
  const [p] = await db.select({ role: profiles.role }).from(profiles)
    .where(and(eq(profiles.projectId, c.var.projectId), eq(profiles.id, c.var.auth!.userId))).limit(1);
  if (!p || p.role !== "admin") throw Errors.forbidden("project/not-admin", "Project admin or operator required");
}

// Safe view of the webhook config — never returns the secret, only whether one is set.
async function webhookConfigView(projectId: string) {
  const [p] = await db.select({ url: projects.webhookUrl, secret: projects.webhookSecret, events: projects.webhookEvents })
    .from(projects).where(eq(projects.id, projectId)).limit(1);
  return { url: p?.url ?? null, events: p?.events ?? [], hasSecret: !!p?.secret };
}

// Safe view of the moderator integration. The two write-only secrets (notifier secret + LLM API
// key) are redacted to hasSecret / hasLlmApiKey; tuning fields echo the stored per-project override
// (null = unset → the moderator uses its env default).
async function moderatorView(projectId: string) {
  const [p] = await db
    .select({ url: projects.moderationWebhookUrl, secret: projects.moderationWebhookSecret, cfg: projects.moderatorConfig })
    .from(projects).where(eq(projects.id, projectId)).limit(1);
  const cfg = (p?.cfg && typeof p.cfg === "object" ? p.cfg : {}) as Record<string, any>;
  return {
    url: p?.url ?? null,
    hasSecret: !!p?.secret,
    autoActionThreshold: typeof cfg.autoActionThreshold === "number" ? cfg.autoActionThreshold : null,
    llmProvider: cfg.llmProvider ?? null,
    llmBaseUrl: cfg.llmBaseUrl ?? null,
    llmModel: cfg.llmModel ?? null,
    llmMaxTokens: typeof cfg.llmMaxTokens === "number" ? cfg.llmMaxTokens : null,
    hasLlmApiKey: !!cfg.llmApiKey,
  };
}

// ── oauth helpers ───────────────────────────────────────────────────────────
// The server's PUBLIC origin (scheme + host), used to build absolute callback URLs that the
// browser (and Supabase's redirect-URL allowlist) must agree on. Behind a TLS-terminating reverse
// proxy the raw request origin is the internal `http://<internal-host>` — wrong scheme AND host —
// so prefer an explicit PUBLIC_BASE_URL, then the proxy's X-Forwarded-Proto/Host, then the request.
function publicOrigin(c: any): string {
  if (env.PUBLIC_BASE_URL) return new URL(env.PUBLIC_BASE_URL).origin;
  const reqUrl = new URL(c.req.url);
  const proto = (c.req.header("x-forwarded-proto") ?? "").split(",")[0]?.trim() || reqUrl.protocol.replace(":", "");
  const host = (c.req.header("x-forwarded-host") ?? "").split(",")[0]?.trim() || reqUrl.host;
  return `${proto}://${host}`;
}

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
  const callbackUrl = `${publicOrigin(c)}/v7/${projectId}/oauth/callback?aid=${stateId}`;
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
