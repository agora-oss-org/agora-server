// apps/api/src/lib/push/native.ts
// FCM (HTTP v1) + APNs (HTTP/2) providers. Credentials live in project_integrations (name 'fcm'/'apns').
// Both return null when unconfigured → that transport is simply skipped (fail-safe). Tokens/creds are
// never logged. Unregistered/410 → prune.
import http2 from "node:http2";
import { and, eq } from "drizzle-orm";
import { SignJWT, importPKCS8 } from "jose";
import { db } from "../../db/index.js";
import { projectIntegrations } from "../../db/schema/index.js";
import type { DeviceLike, PushPayload, PushProvider } from "./provider.js";

async function loadIntegration(projectId: string, name: string): Promise<Record<string, unknown> | null> {
  const [row] = await db.select({ data: projectIntegrations.data }).from(projectIntegrations)
    .where(and(eq(projectIntegrations.projectId, projectId), eq(projectIntegrations.name, name))).limit(1);
  const data = row?.data as Record<string, unknown> | undefined;
  return data && Object.keys(data).length ? data : null;
}

// ── FCM HTTP v1 ──
async function fcmAccessToken(sa: { client_email: string; private_key: string; token_uri?: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const key = await importPKCS8(sa.private_key, "RS256");
  const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/firebase.messaging" })
    .setProtectedHeader({ alg: "RS256" }).setIssuer(sa.client_email).setSubject(sa.client_email)
    .setAudience(sa.token_uri ?? "https://oauth2.googleapis.com/token")
    .setIssuedAt(now).setExpirationTime(now + 3600).sign(key);
  const res = await fetch(sa.token_uri ?? "https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  const json = await res.json() as { access_token?: string };
  if (!json.access_token) throw new Error("fcm: token exchange failed");
  return json.access_token;
}

export async function getFcmProvider(projectId: string): Promise<PushProvider | null> {
  const sa = await loadIntegration(projectId, "fcm") as { client_email: string; private_key: string; project_id: string } | null;
  if (!sa?.client_email || !sa?.private_key || !sa?.project_id) return null;
  return {
    async send(device: DeviceLike, payload: PushPayload) {
      if (!device.token) return { ok: false };
      const accessToken = await fcmAccessToken(sa);
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
        method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ message: { token: device.token, notification: { title: payload.title, body: payload.body }, data: payload.data ?? {} } }),
      });
      if (res.ok) return { ok: true };
      // UNREGISTERED / NOT_FOUND → the token is dead.
      return { ok: false, prune: res.status === 404 || res.status === 410 };
    },
  };
}

// ── APNs HTTP/2 ──
export async function getApnsProvider(projectId: string): Promise<PushProvider | null> {
  const cfg = await loadIntegration(projectId, "apns") as { key: string; keyId: string; teamId: string; bundleId: string; production?: boolean } | null;
  if (!cfg?.key || !cfg?.keyId || !cfg?.teamId || !cfg?.bundleId) return null;
  const host = cfg.production ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com";
  return {
    async send(device: DeviceLike, payload: PushPayload) {
      if (!device.token) return { ok: false };
      const now = Math.floor(Date.now() / 1000);
      const jwt = await new SignJWT({})
        .setProtectedHeader({ alg: "ES256", kid: cfg.keyId }).setIssuer(cfg.teamId).setIssuedAt(now)
        .sign(await importPKCS8(cfg.key, "ES256"));
      const body = JSON.stringify({ aps: { alert: { title: payload.title, body: payload.body } }, data: payload.data ?? {} });
      return await new Promise<{ ok: boolean; prune?: boolean }>((resolve) => {
        const client = http2.connect(host);
        const req = client.request({
          ":method": "POST", ":path": `/3/device/${device.token}`,
          authorization: `bearer ${jwt}`, "apns-topic": cfg.bundleId, "apns-push-type": "alert",
        });
        let status = 0;
        req.on("response", (h) => { status = Number(h[":status"]) || 0; });
        req.on("end", () => { client.close(); resolve({ ok: status === 200, prune: status === 410 }); });
        req.on("error", () => { client.close(); resolve({ ok: false }); });
        req.end(body);
      });
    },
  };
}
