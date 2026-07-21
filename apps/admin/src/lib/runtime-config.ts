// Runtime config seam for the admin SPA.
//
// The admin is a STATIC Vite build baked into the agora-proxy image, so every `VITE_*` var is inlined
// at BUILD time — a deployment that PULLS the published image (docker-compose.prod.yml) cannot change
// them. `/config.js` is served from the same static root and is (re)written by the proxy container's
// entrypoint from the deployment's env on every start, so anything read through here is settable at
// RUNTIME. Mirrors the seam agora-demo already uses.
//
// Precedence is always: runtime `/config.js` → build-time `VITE_*` → hardcoded default.

declare global {
  interface Window {
    __AGORA_CONFIG__?: Record<string, unknown>;
  }
}

/** A value counts as "set" only if it's a non-blank string — empty env vars read as unset. */
export function nonEmpty(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * First non-blank candidate, in precedence order. Callers pass
 * `resolve(runtimeConfig(key), import.meta.env.VITE_X, "default")`.
 */
export function resolve(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    const v = nonEmpty(c);
    if (v !== undefined) return v;
  }
  return undefined;
}

/**
 * Accept a value only if it parses as an http(s) URL. Resolved config values get interpolated into
 * `<a href>` deep links, and `new URL()` alone happily accepts `javascript:` / `data:` — so anything
 * that isn't a web origin is dropped here and the caller falls through to its next candidate.
 */
export function httpUrl(v: unknown): string | undefined {
  const s = nonEmpty(v);
  if (s === undefined) return undefined;
  try {
    const proto = new URL(s).protocol;
    return proto === "http:" || proto === "https:" ? s : undefined;
  } catch {
    return undefined; // malformed
  }
}

/**
 * A service base: either an absolute http(s) URL (cross-origin API) or a root-relative path like
 * `/v7` (same-origin, the default — the front door reverse-proxies it). Trailing slashes are
 * stripped so call sites can always append `/…`.
 *
 * Protocol-relative values (`//evil.example`) are REJECTED: they read like a path but silently
 * repoint every API call — including the Bearer token they carry — at another origin.
 */
export function baseUrl(v: unknown): string | undefined {
  const s = nonEmpty(v);
  if (s === undefined) return undefined;
  const stripped = s.replace(/\/+$/, "");
  if (stripped.startsWith("//")) return undefined; // protocol-relative → off-origin
  if (stripped.startsWith("/")) return stripped; // root-relative, same-origin
  return httpUrl(stripped) === undefined ? undefined : stripped; // else must be an http(s) URL
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A uuid, lowercased. Anything else (an unsubstituted placeholder, a typo) reads as unset. */
export function uuid(v: unknown): string | undefined {
  const s = nonEmpty(v);
  return s !== undefined && UUID_RE.test(s) ? s.toLowerCase() : undefined;
}

/**
 * A boolean flag. Only an explicit affirmative turns a feature on; anything unrecognised reads as
 * `undefined` (not `false`) so it falls through to the next candidate rather than silently
 * overriding a build-time `true` with garbage.
 */
export function bool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  const s = nonEmpty(v)?.toLowerCase();
  if (s === undefined) return undefined;
  if (s === "true" || s === "1" || s === "yes" || s === "on") return true;
  if (s === "false" || s === "0" || s === "no" || s === "off") return false;
  return undefined;
}

/** `resolve()` for flags: first candidate that's an explicit boolean wins. */
export function resolveBool(...candidates: unknown[]): boolean | undefined {
  for (const c of candidates) {
    const v = bool(c);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** Read one key off the runtime `/config.js` payload. Safe before/without the script loading. */
export function runtimeConfig(key: string, win: { __AGORA_CONFIG__?: Record<string, unknown> } | undefined = typeof window === "undefined" ? undefined : window): string | undefined {
  return nonEmpty(win?.__AGORA_CONFIG__?.[key]);
}
