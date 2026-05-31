// Verifies inbound webhook signatures produced by @agora/api's lib/webhooks.ts. The API signs each
// delivery as HMAC-SHA256(webhookSecret, `${timestamp}.${rawBody}`) in the X-Signature header. We
// look the per-project secret up from the shared DB (projects.webhook_secret), cached 30s to mirror
// the API's own config cache.
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { projects } from "../db/schema.js";

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { secret: string | null; at: number }>();

export async function getProjectSecret(projectId: string): Promise<string | null> {
  const hit = cache.get(projectId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.secret;
  const [p] = await db
    .select({ secret: projects.webhookSecret })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const secret = p?.secret ?? null;
  cache.set(projectId, { secret, at: Date.now() });
  return secret;
}

const sign = (secret: string, msg: string) => crypto.createHmac("sha256", secret).update(msg).digest("hex");

function timingSafeEqualHex(a: string, b: string): boolean {
  try {
    const ab = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

/** True when `signature` is a valid HMAC over `${timestamp}.${rawBody}` for the secret. */
export function verifySignature(secret: string, timestamp: string, rawBody: string, signature: string | null): boolean {
  if (!signature || !timestamp) return false;
  return timingSafeEqualHex(sign(secret, `${timestamp}.${rawBody}`), signature);
}
