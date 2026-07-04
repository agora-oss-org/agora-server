// Pure extractors for the API route surface and its MANIFEST mirror (string in, data out).
// Formats matched: chained Hono registrations in routes/*.ts, the mount table in
// routes/index.ts, and docs/MANIFEST.md's `| METHOD | \`/path\` … |` rows.

export interface RouteRef {
  method: string;
  path: string;
}

const ROUTE_CALL = /\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g;
export function extractRoutePaths(routeSource: string): RouteRef[] {
  const out: RouteRef[] = [];
  for (const m of routeSource.matchAll(ROUTE_CALL)) {
    if (m[1] && m[2]) out.push({ method: m[1].toUpperCase(), path: m[2] });
  }
  return out;
}

// routes/index.ts pairs `import entityRoutes from "./entities"` with
// `project.route("/entities", entityRoutes)` (or `v7.route(…)` — connections mount at
// the /v7 root). Returns { <module basename>: <mount prefix> }.
export function extractRouteMounts(indexSource: string): Record<string, string> {
  const moduleByIdent: Record<string, string> = {};
  for (const m of indexSource.matchAll(/import\s+(\w+)\s+from\s+"\.\/([\w./-]+)"/g)) {
    if (!m[1] || !m[2]) continue;
    const base = m[2].split("/").pop() ?? m[2];
    moduleByIdent[m[1]] = base.replace(/\.[jt]sx?$/, "");
  }
  const mounts: Record<string, string> = {};
  for (const m of indexSource.matchAll(/\.route\(\s*"([^"]*)"\s*,\s*(\w+)\s*\)/g)) {
    if (m[1] === undefined || !m[2]) continue;
    const mod = moduleByIdent[m[2]];
    if (mod) mounts[mod] = m[1] === "" ? "/" : m[1];
  }
  return mounts;
}

// MANIFEST rows: `| POST | \`/auth/sign-up\` (prose…) | ✅ |` — the path is the first
// backticked token; query strings and prose after the path are not part of it.
const MANIFEST_ROW = /^\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*`([^`\s?]+)/;
export function extractManifestEntries(manifestSource: string): RouteRef[] {
  const out: RouteRef[] = [];
  for (const line of manifestSource.split("\n")) {
    const m = MANIFEST_ROW.exec(line);
    if (m && m[1] && m[2]) out.push({ method: m[1], path: m[2] });
  }
  return out;
}

// `:entityId` in MANIFEST vs `:id` in code must still match — params normalize to `:*`.
export function normalizePath(p: string): string {
  const norm = p.replace(/:[A-Za-z0-9_]+/g, ":*").replace(/\/+$/, "");
  return norm === "" ? "/" : norm;
}

export function joinPath(mount: string, sub: string): string {
  const joined = `${mount}/${sub}`.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  return joined === "" ? "/" : joined;
}
