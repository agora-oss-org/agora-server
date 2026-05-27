// Feed re-rank webhook (Tier 3 escape hatch): the server generates + filters a candidate set via the
// configured algorithm and hands it to the host app's webhook, which returns a new ordering. Unlike
// validation webhooks (fail-CLOSED), re-rank is an enhancement and FAILS OPEN — on timeout, non-2xx,
// bad signature, or malformed response we return null and the caller keeps the algorithm order.
//
// Request:  POST { type:"feed.rerank", projectId, stage:"rerank", data:{ candidates:[{id,signals}] } }
//   headers X-Timestamp = ms, X-Signature = HMAC-SHA256(secret, `${ts}.${body}`)
// Response: { order: string[] }  OR  { scores: Record<id, number> }
//   optional header X-Response-Signature = HMAC-SHA256(secret, rawBody) — verified when present.
import crypto from "node:crypto";
import type { RerankWebhookConfig } from "./feed-config.js";

const sign = (secret: string, msg: string) => crypto.createHmac("sha256", secret).update(msg).digest("hex");

function timingSafeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex"), bb = Buffer.from(b, "hex");
  return ab.length === bb.length && ab.length > 0 && crypto.timingSafeEqual(ab, bb);
}

export interface RerankCandidate { id: string; signals: Record<string, unknown>; }

/** Returns a reordered id list (known candidates only, deduped, omitted ones appended), or null to keep the original order. */
export async function rerankCandidates(
  projectId: string,
  cfg: RerankWebhookConfig,
  candidates: RerankCandidate[],
): Promise<string[] | null> {
  if (candidates.length === 0) return null;
  const ids = new Set(candidates.map((c) => c.id));
  const body = JSON.stringify({ type: "feed.rerank", projectId, stage: "rerank", data: { candidates } });
  const ts = Date.now().toString();
  try {
    const res = await fetch(cfg.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Timestamp": ts, "X-Signature": sign(cfg.secret, `${ts}.${body}`) },
      body,
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!res.ok) return null;
    const raw = await res.text();
    const respSig = res.headers.get("X-Response-Signature");
    if (respSig && !timingSafeEqualHex(respSig, sign(cfg.secret, raw))) return null; // tampered → fail open
    const data = JSON.parse(raw) as { order?: unknown; scores?: unknown };

    let order: string[] | null = null;
    if (Array.isArray(data.order)) {
      order = data.order.filter((x): x is string => typeof x === "string");
    } else if (data.scores && typeof data.scores === "object") {
      order = Object.entries(data.scores as Record<string, unknown>)
        .filter(([id, v]) => ids.has(id) && Number.isFinite(Number(v)))
        .sort((a, b) => Number(b[1]) - Number(a[1]))
        .map(([id]) => id);
    }
    if (!order) return null;

    // Keep only known candidate ids, dedupe, then append any the webhook omitted (stable fallback).
    const seen = new Set<string>();
    const result: string[] = [];
    for (const id of order) if (ids.has(id) && !seen.has(id)) { seen.add(id); result.push(id); }
    for (const c of candidates) if (!seen.has(c.id)) result.push(c.id);
    return result;
  } catch {
    return null; // fail-open (timeout / network / parse error)
  }
}
