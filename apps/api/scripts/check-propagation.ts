#!/usr/bin/env tsx
// Propagation drift checker — wires git + fs to the pure lib in src/lib/propagation/.
// Design: docs/superpowers/specs/2026-07-03-propagate-doc-sync-design.md · Map: docs/PROPAGATION.yaml
//
//   pnpm --filter @agora/api check:propagation --diff <base>   # obligations from the branch diff
//   pnpm --filter @agora/api check:propagation                 # full-repo audit (CI-ready later)
//   … --json                                                   # machine output for /propagate
//
// Exit 1 iff any obligation is missing/unparseable (advisory/excepted don't fail).
// This is a CLI: console output IS its product (the server-side no-console rule doesn't apply).
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { matchesAny, parseMap } from "../src/lib/propagation/map";
import { extractEnvSchemaKeys } from "../src/lib/propagation/parse-env";
import {
  extractManifestEntries,
  extractRouteMounts,
  extractRoutePaths,
  joinPath,
  normalizePath,
  type RouteRef,
} from "../src/lib/propagation/parse-routes";
import {
  deriveEndpointObligations,
  deriveEnvObligations,
  type Obligation,
} from "../src/lib/propagation/obligations";

const ENV_SOURCE = "packages/core/src/lib/env.ts";
const ROUTES_INDEX = "apps/api/src/routes/index.ts";
const MANIFEST = "docs/MANIFEST.md";

const args = process.argv.slice(2);
const json = args.includes("--json");
const diffIdx = args.indexOf("--diff");
const base = diffIdx >= 0 ? args[diffIdx + 1] : null;
if (diffIdx >= 0 && !base) {
  console.error("--diff requires a base ref");
  process.exit(2);
}

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const git = (...a: string[]) => execFileSync("git", a, { encoding: "utf8", cwd: root });

function read(rel: string): string | null {
  try {
    return readFileSync(join(root, rel), "utf8");
  } catch {
    return null;
  }
}
function gitShow(ref: string, rel: string): string | null {
  try {
    return execFileSync("git", ["show", `${ref}:${rel}`], {
      encoding: "utf8",
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null; // file didn't exist at base
  }
}
function moduleName(file: string): string {
  return basename(file).replace(/\.[jt]sx?$/, "");
}

const mapSource = read("docs/PROPAGATION.yaml");
if (mapSource == null) {
  console.error("docs/PROPAGATION.yaml not found");
  process.exit(2);
}
const map = parseMap(mapSource);

// Every mapped target's content, read once. null (unreadable) flows into "unparseable".
const targetContents: Record<string, string | null> = {};
for (const cls of Object.values(map.classes)) {
  for (const t of [...cls.mechanical, ...cls.prose]) {
    if (!(t in targetContents)) targetContents[t] = read(t);
  }
}

const changed: string[] = base
  ? [
      ...git("diff", "--name-only", base).split("\n"),
      ...git("ls-files", "--others", "--exclude-standard").split("\n"),
    ].filter(Boolean)
  : [];

const obligations: Obligation[] = [];

// ── env-var class ────────────────────────────────────────────────────────────
const envCls = map.classes["env-var"];
if (envCls) {
  let addedKeys: string[] = [];
  let removedKeys: string[] = [];
  if (base) {
    if (changed.some((f) => matchesAny(f, envCls.detect))) {
      const before = new Set(extractEnvSchemaKeys(gitShow(base, ENV_SOURCE) ?? ""));
      const after = new Set(extractEnvSchemaKeys(read(ENV_SOURCE) ?? ""));
      addedKeys = [...after].filter((k) => !before.has(k));
      removedKeys = [...before].filter((k) => !after.has(k));
    }
  } else {
    addedKeys = extractEnvSchemaKeys(read(ENV_SOURCE) ?? "");
  }
  obligations.push(
    ...deriveEnvObligations({ addedKeys, removedKeys, targets: targetContents, cls: envCls, exceptions: map.exceptions })
  );
}

// ── endpoint class ───────────────────────────────────────────────────────────
const epCls = map.classes["endpoint"];
if (epCls) {
  const mounts = extractRouteMounts(read(ROUTES_INDEX) ?? "");
  const manifestEntries = extractManifestEntries(read(MANIFEST) ?? "");
  const routeKey = (r: RouteRef) => `${r.method} ${normalizePath(r.path)}`;
  const mountFor = (file: string) => mounts[moduleName(file)] ?? `/${moduleName(file)}`;
  const addedRoutes: RouteRef[] = [];

  const routeFiles = base
    ? changed.filter((f) => matchesAny(f, epCls.detect) && !f.endsWith("/index.ts"))
    : readdirSync(join(root, "apps/api/src/routes"))
        .filter((f) => /\.ts$/.test(f) && f !== "index.ts")
        .map((f) => `apps/api/src/routes/${f}`);

  for (const file of routeFiles) {
    const now = extractRoutePaths(read(file) ?? "");
    const beforeSet = base ? new Set(extractRoutePaths(gitShow(base, file) ?? "").map(routeKey)) : new Set<string>();
    const mount = mountFor(file);
    for (const r of now) {
      if (!beforeSet.has(routeKey(r))) {
        addedRoutes.push({ method: r.method, path: joinPath(mount, r.path) });
      }
    }
  }
  obligations.push(
    ...deriveEndpointObligations({ addedRoutes, cls: epCls, exceptions: map.exceptions, manifestEntries })
  );
}

// ── compose + catch-all classes (diff mode only) ─────────────────────────────
if (base) {
  const compCls = map.classes["compose"];
  if (compCls) {
    for (const f of changed.filter((f) => matchesAny(f, compCls.detect))) {
      for (const t of compCls.prose) {
        obligations.push({ cls: "compose", subject: f, kind: "prose", target: t, status: "advisory", note: "deploy surface changed — check this doc" });
      }
    }
  }
  const allCls = map.classes["catch-all"];
  if (allCls && changed.some((f) => matchesAny(f, allCls.detect))) {
    const changelogTouched = changed.includes("CHANGELOG.md");
    for (const t of allCls.prose) {
      obligations.push({
        cls: "catch-all",
        subject: "branch diff",
        kind: "prose",
        target: t,
        status: t === "CHANGELOG.md" ? (changelogTouched ? "present" : "missing") : "advisory",
        note: t === "CHANGELOG.md" ? "behavior-affecting change needs an [Unreleased] entry" : undefined,
      });
    }
  }
}

// ── report ───────────────────────────────────────────────────────────────────
if (json) {
  console.log(JSON.stringify({ base, obligations }, null, 2));
} else {
  if (obligations.length === 0) {
    console.log(base ? `No propagation obligations in diff vs ${base}.` : "No obligations derived.");
  }
  const byCls = new Map<string, Obligation[]>();
  for (const o of obligations) {
    byCls.set(o.cls, [...(byCls.get(o.cls) ?? []), o]);
  }
  const ICON: Record<string, string> = { present: "✅", missing: "❌", excepted: "⏭️ ", advisory: "❓", unparseable: "💥" };
  for (const [cls, obs] of byCls) {
    console.log(`\n[${cls}]`);
    for (const o of obs) {
      console.log(`  ${ICON[o.status]} ${o.status.padEnd(11)} ${o.subject}  →  ${o.target}${o.note ? `   (${o.note})` : ""}`);
    }
  }
  const bad = obligations.filter((o) => o.status === "missing" || o.status === "unparseable").length;
  console.log(`\n${obligations.length} obligations · ${bad} missing/unparseable`);
}

process.exit(obligations.some((o) => o.status === "missing" || o.status === "unparseable") ? 1 : 0);
