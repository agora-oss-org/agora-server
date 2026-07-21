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

/** Read one key off the runtime `/config.js` payload. Safe before/without the script loading. */
export function runtimeConfig(key: string, win: { __AGORA_CONFIG__?: Record<string, unknown> } | undefined = typeof window === "undefined" ? undefined : window): string | undefined {
  return nonEmpty(win?.__AGORA_CONFIG__?.[key]);
}
