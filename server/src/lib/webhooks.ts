// Project webhooks, Replyke-style (docs.replyke.com/v7/webhooks).
//
// - validation events (e.g. "entity.created") are SYNCHRONOUS + BLOCKING: we POST the proposed
//   object and wait. The host replies { valid: true } (signed) to allow; anything else rejects.
// - broadcast events ("entity.created.complete", "notification.created", …) are fire-and-forget.
// - If no webhook is configured, or the event isn't in the project's subscribed list, validation
//   passes automatically. Once configured+subscribed, a slow/unavailable/invalid response BLOCKS
//   the operation (fail-closed) — matching Replyke.
//
// Envelope:  { type, projectId, stage, data }
// Request headers:  X-Signature = HMAC-SHA256(secret, `${ts}.${body}`),  X-Timestamp = ms
// Response (validation):  body { valid, message? } + header X-Response-Signature = HMAC(secret, body)
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { projects } from "../db/schema/index.js";

const TIMEOUT_MS = 4000;
const CONFIG_TTL_MS = 30_000;

type WebhookConfig = { url: string; secret: string; events: string[] };
const cache = new Map<string, { cfg: WebhookConfig | null; at: number }>();

async function getConfig(projectId: string): Promise<WebhookConfig | null> {
  const hit = cache.get(projectId);
  if (hit && Date.now() - hit.at < CONFIG_TTL_MS) return hit.cfg;
  const [p] = await db
    .select({ url: projects.webhookUrl, secret: projects.webhookSecret, events: projects.webhookEvents })
    .from(projects).where(eq(projects.id, projectId)).limit(1);
  const cfg = p?.url && p?.secret ? { url: p.url, secret: p.secret, events: p.events ?? [] } : null;
  cache.set(projectId, { cfg, at: Date.now() });
  return cfg;
}

const sign = (secret: string, msg: string) => crypto.createHmac("sha256", secret).update(msg).digest("hex");

/** Drop the cached config (call after an admin updates the project's webhook settings). */
export function invalidateConfig(projectId: string): void {
  cache.delete(projectId);
}

/** Send a signed test ping to the configured URL (ignores the subscribed-events list). */
export async function sendTest(projectId: string): Promise<{ configured: boolean; ok?: boolean; status?: number; error?: string }> {
  const cfg = await getConfig(projectId);
  if (!cfg) return { configured: false };
  const ts = Date.now().toString();
  const body = JSON.stringify({ type: "webhook.test", projectId, stage: "complete", data: { message: "Agora test webhook", at: new Date().toISOString() } });
  try {
    const res = await fetch(cfg.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-signature": sign(cfg.secret, `${ts}.${body}`), "x-timestamp": ts },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { configured: true, ok: res.ok, status: res.status };
  } catch (e: any) {
    return { configured: true, ok: false, error: e?.message ?? "unreachable" };
  }
}

function timingSafeEqualHex(a: string, b: string): boolean {
  try {
    const ab = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

export interface ValidationResult {
  valid: boolean;
  message?: string;
}

/**
 * Blocking validation webhook. Returns { valid:true } when allowed (incl. when no webhook is
 * configured or the event isn't subscribed). Rejects on { valid:false }, non-2xx, timeout,
 * network error, or a missing/invalid response signature.
 */
export async function validate(projectId: string, type: string, data: unknown): Promise<ValidationResult> {
  const cfg = await getConfig(projectId);
  if (!cfg || !cfg.events.includes(type)) return { valid: true };

  const ts = Date.now().toString();
  const body = JSON.stringify({ type, projectId, stage: "validate", data });
  try {
    const res = await fetch(cfg.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-signature": sign(cfg.secret, `${ts}.${body}`), "x-timestamp": ts },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { valid: false, message: "Rejected by validation webhook" };
    const text = await res.text();
    const respSig = res.headers.get("x-response-signature");
    if (!respSig || !timingSafeEqualHex(sign(cfg.secret, text), respSig)) {
      return { valid: false, message: "Invalid validation-webhook response signature" };
    }
    const parsed = JSON.parse(text) as ValidationResult;
    return parsed?.valid === true ? { valid: true } : { valid: false, message: parsed?.message || "Rejected by validation webhook" };
  } catch {
    // slow / unavailable → block (fail-closed), per Replyke
    return { valid: false, message: "Validation webhook unavailable" };
  }
}

/** Fire-and-forget broadcast webhook (never blocks or throws). */
export function broadcast(projectId: string, type: string, data: unknown): void {
  void (async () => {
    try {
      const cfg = await getConfig(projectId);
      if (!cfg || !cfg.events.includes(type)) return;
      const ts = Date.now().toString();
      const body = JSON.stringify({ type, projectId, stage: "complete", data });
      await fetch(cfg.url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-signature": sign(cfg.secret, `${ts}.${body}`), "x-timestamp": ts },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      /* broadcast is best-effort */
    }
  })();
}
