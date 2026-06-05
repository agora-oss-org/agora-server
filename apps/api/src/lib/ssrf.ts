// SSRF guard for the link-preview fetcher (routes/misc.ts `/utils/get-metadata`). The endpoint takes a
// user-supplied URL and fetches it server-side, so it must NEVER reach an internal/private address — on
// the initial URL OR any redirect hop. Two layers, dependency-free (Node ≥20 global fetch + node:net/dns):
//   1. assertPublicUrl    — scheme allowlist + literal/encoded private-IP rejection (sync, no network)
//   2. resolveAndAssertPublic — resolve the host and reject if ANY address is private (defeats DNS
//                               tricks + decimal/octal/hex IP encodings the OS resolver normalizes)
// safeFetchText follows redirects MANUALLY, re-validating every hop. Residual: a narrow DNS-rebinding
// TOCTOU between our lookup and fetch's own resolution (see SECURITY.md) — closing it needs connection
// pinning (a custom dispatcher), a later hardening.
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { ApiError, Errors } from "../http/errors.js";

const blocked = () => Errors.badRequest("utils/blocked-url", "URL not allowed", "url");

// ─── IP classification ──────────────────────────────────────────────────────
function ipv4ToInt(ip: string): number {
  const o = ip.split(".").map(Number);
  return ((o[0]! << 24) | (o[1]! << 16) | (o[2]! << 8) | o[3]!) >>> 0;
}
function inV4(nInt: number, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (nInt & mask) === (ipv4ToInt(base) & mask);
}

// Private / loopback / link-local / CGNAT / unspecified / reserved / multicast IPv4 ranges.
const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
function isPrivateIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => inV4(n, base, bits));
}

// Expand an IPv6 literal (already validated by net.isIP) to its 16 bytes, handling "::" compression and
// a trailing dotted-IPv4 (mapped) group.
function ipv6ToBytes(ipRaw: string): Uint8Array | null {
  let ip = ipRaw.split("%")[0]!; // strip zone id
  if (ip.includes(".")) {
    const idx = ip.lastIndexOf(":");
    const o = ip.slice(idx + 1).split(".").map(Number);
    if (o.length === 4 && o.every((x) => x >= 0 && x <= 255)) {
      ip = ip.slice(0, idx + 1) + (((o[0]! << 8) | o[1]!).toString(16)) + ":" + (((o[2]! << 8) | o[3]!).toString(16));
    }
  }
  const [head, tail] = ip.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail !== undefined ? (tail ? tail.split(":") : []) : null;
  let parts: string[];
  if (tailParts === null) parts = headParts;
  else parts = [...headParts, ...Array(8 - headParts.length - tailParts.length).fill("0"), ...tailParts];
  if (parts.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const v = parseInt(parts[i] || "0", 16);
    if (Number.isNaN(v)) return null;
    bytes[i * 2] = (v >> 8) & 0xff;
    bytes[i * 2 + 1] = v & 0xff;
  }
  return bytes;
}
function isPrivateIpv6(ip: string): boolean {
  const b = ipv6ToBytes(ip);
  if (!b) return true; // unparseable → treat as unsafe
  const allZeroTo = (end: number) => b.slice(0, end).every((x) => x === 0);
  if (allZeroTo(16)) return true;                                   // :: unspecified
  if (allZeroTo(15) && b[15] === 1) return true;                    // ::1 loopback
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true;        // fe80::/10 link-local
  if ((b[0]! & 0xfe) === 0xfc) return true;                         // fc00::/7 ULA
  if (b[0] === 0xff) return true;                                   // ff00::/8 multicast
  if (allZeroTo(10) && b[10] === 0xff && b[11] === 0xff)            // ::ffff:0:0/96 IPv4-mapped
    return isPrivateIpv4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
  return false;
}

/** True when an IP literal is internal/private/reserved (IPv4, IPv6, or IPv4-mapped IPv6). */
export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPrivateIpv4(ip);
  if (v === 6) return isPrivateIpv6(ip);
  return false; // not an IP literal
}

// inet_aton-style parse of a legacy-encoded IPv4 host (decimal `2130706433`, octal `0177.0.0.1`,
// hex `0x7f.0.0.1`, 1–4 parts) → dotted-quad, or null if it isn't one. Catches encodings that string
// checks miss, deterministically, before any network call.
function parsePart(s: string): number | null {
  let v: number;
  if (/^0x[0-9a-f]+$/i.test(s)) v = parseInt(s, 16);
  else if (/^0[0-7]+$/.test(s)) v = parseInt(s, 8);
  else if (/^[0-9]+$/.test(s)) v = parseInt(s, 10);
  else return null;
  return Number.isFinite(v) ? v : null;
}
export function tryParseLegacyIpv4(host: string): string | null {
  if (isIP(host)) return null; // a normal literal IP — handled by isPrivateIp directly
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4) return null;
  const n = parts.map(parsePart);
  if (n.some((x) => x === null)) return null;
  const nums = n as number[];
  let value: number;
  if (nums.length === 1) { if (nums[0]! > 0xffffffff) return null; value = nums[0]!; }
  else if (nums.length === 2) { if (nums[0]! > 0xff || nums[1]! > 0xffffff) return null; value = (nums[0]! * 2 ** 24 + nums[1]!); }
  else if (nums.length === 3) { if (nums[0]! > 0xff || nums[1]! > 0xff || nums[2]! > 0xffff) return null; value = (nums[0]! * 2 ** 24 + nums[1]! * 2 ** 16 + nums[2]!); }
  else { if (nums.some((x) => x > 0xff)) return null; value = (nums[0]! * 2 ** 24 + nums[1]! * 2 ** 16 + nums[2]! * 2 ** 8 + nums[3]!); }
  value = value >>> 0;
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(".");
}

// ─── URL / host validation ──────────────────────────────────────────────────
/** Parse + validate a URL for outbound fetch: http(s) only, no internal/private/encoded-private host.
 *  Throws ApiError (utils/bad-url for malformed, utils/blocked-url for disallowed). */
export function assertPublicUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw Errors.badRequest("utils/bad-url", "Invalid URL", "url"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw blocked();
  const host = u.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (!host || host === "localhost" || host.endsWith(".local")) throw blocked();
  if (isIP(host) && isPrivateIp(host)) throw blocked();
  const legacy = tryParseLegacyIpv4(host);
  if (legacy && isPrivateIp(legacy)) throw blocked();
  return u;
}

export type LookupFn = (host: string) => Promise<{ address: string; family: number }[]>;
const defaultLookup: LookupFn = (host) => dnsLookup(host, { all: true });

/** Resolve a hostname and reject if ANY resolved address is private. Skips IP literals (already checked). */
export async function resolveAndAssertPublic(host: string, lookup: LookupFn = defaultLookup): Promise<void> {
  if (isIP(host)) return;
  const results = await lookup(host);
  if (!results.length) throw Errors.badRequest("utils/fetch-failed", "Could not resolve host", "url");
  for (const r of results) if (isPrivateIp(r.address)) throw blocked();
}

// ─── safe fetch with manual, per-hop-validated redirects ──────────────────────
export interface SafeFetchOptions { maxRedirects?: number; timeoutMs?: number; maxBytes?: number }
export interface SafeFetchDeps { fetchImpl?: typeof fetch; lookupImpl?: LookupFn }

/** Fetch a user-supplied URL safely: validate (and resolve-check) the host on the initial request and
 *  on every redirect hop, following 3xx manually up to maxRedirects. Returns the final URL + capped body.
 *  Throws ApiError consistently (blocked-url / bad-url / fetch-failed). */
export async function safeFetchText(
  raw: string,
  opts: SafeFetchOptions = {},
  deps: SafeFetchDeps = {},
): Promise<{ url: string; html: string }> {
  const { maxRedirects = 5, timeoutMs = 6000, maxBytes = 500_000 } = opts;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const lookupImpl = deps.lookupImpl ?? defaultLookup;
  const signal = AbortSignal.timeout(timeoutMs);
  let current = raw;

  for (let i = 0; i <= maxRedirects; i++) {
    const u = assertPublicUrl(current);
    await resolveAndAssertPublic(u.hostname.replace(/^\[|\]$/g, ""), lookupImpl);
    let res: Response;
    try {
      res = await fetchImpl(u, {
        headers: { "User-Agent": "AgoraBot/1.0 (+link-preview)" },
        redirect: "manual",
        signal,
      });
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw Errors.badRequest("utils/fetch-failed", "Could not fetch URL metadata", "url");
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw Errors.badRequest("utils/fetch-failed", "Redirect without location", "url");
      current = new URL(loc, u).toString(); // resolve relative redirects against the current URL
      continue;
    }
    const html = (await res.text()).slice(0, maxBytes);
    return { url: u.toString(), html };
  }
  throw Errors.badRequest("utils/fetch-failed", "Too many redirects", "url");
}
