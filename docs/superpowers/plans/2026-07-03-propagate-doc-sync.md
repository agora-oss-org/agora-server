# `/propagate` Doc & Config Propagation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `/propagate` system — a checked-in propagation map, a deterministic drift checker, and a repo skill that fans out agents to draft every mirror edit (env examples, compose, docs, wiki, CHANGELOG) for the current branch's diff, propose-then-approve.

**Architecture:** Pure, unit-testable parser/derivation functions live in `apps/api/src/lib/propagation/` (string-in, data-out — callers do all fs/git I/O). A thin tsx CLI at `apps/api/scripts/check-propagation.ts` wires git + fs to those functions and emits a JSON/human obligation report. A project skill at `.claude/skills/propagate/SKILL.md` orchestrates: checker scout → judgment-sweep agent → audience-cluster agent fan-out → checker verify → user checklist. Spec: `docs/superpowers/specs/2026-07-03-propagate-doc-sync-design.md`.

**Tech Stack:** TypeScript, vitest (existing unit suite — `include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"]`), `yaml` (new devDependency of `@agora/api`), tsx (already a devDependency), git plumbing via `node:child_process`.

## Global Constraints

- Before claiming any task done: `pnpm --filter @agora/api typecheck` and `pnpm --filter @agora/api test` must pass (repo rule; full `pnpm -r typecheck` before the final task).
- Commits are DCO-signed: `git commit -s`, and end the message with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- The propagation lib must NEVER be imported by api runtime code (`app.ts`, routes, index) — it is tooling that happens to live in `src/lib/` so the unit suite picks it up. Its only consumers are its tests and the CLI script.
- The CLI script prints with `console.log`/`console.error` — that is its product, matching the existing `scripts/*.mjs` convention. The "no console.*" rule applies to server code only.
- Pure functions take file CONTENTS as strings, never paths. No fs/child_process imports anywhere in `src/lib/propagation/`.
- Repo-relative paths everywhere in map/obligations (e.g. `docs/SELF-HOSTING.md`, never absolute).

## File Structure

```
docs/PROPAGATION.yaml                                 # the map (human-readable repo knowledge)
apps/api/src/lib/propagation/
  map.ts            # PropagationMap types, parseMap(), matchesAny() glob matcher
  map.test.ts
  parse-env.ts      # extractEnvSchemaKeys / extractEnvExampleKeys / extractComposeKeys / mentions
  parse-env.test.ts
  parse-routes.ts   # extractRoutePaths / extractRouteMounts / extractManifestEntries / normalizePath / joinPath
  parse-routes.test.ts
  obligations.ts    # Obligation type, deriveEnvObligations(), deriveEndpointObligations()
  obligations.test.ts
apps/api/scripts/check-propagation.ts                 # tsx CLI: --diff <base> | full scan; --json
.claude/skills/propagate/SKILL.md                     # the orchestrating skill
CLAUDE.md                                             # pointer paragraph (modify)
CHANGELOG.md                                          # [Unreleased] Added entry (modify)
```

---

### Task 1: Propagation map file + parser

**Files:**
- Create: `docs/PROPAGATION.yaml`
- Create: `apps/api/src/lib/propagation/map.ts`
- Test: `apps/api/src/lib/propagation/map.test.ts`
- Modify: `apps/api/package.json` (add `yaml` devDependency)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `parseMap(source: string): PropagationMap`, `matchesAny(path: string, patterns: string[]): boolean`, types `PropagationMap { classes: Record<string, PropagationClass>; exceptions: PropagationException[] }`, `PropagationClass { detect: string[]; mechanical: string[]; prose: string[] }`, `PropagationException { subject: string; target: string; reason: string }`. Later tasks import these from `./map`.

- [ ] **Step 1: Add the `yaml` devDependency**

```bash
pnpm --filter @agora/api add -D yaml
```

- [ ] **Step 2: Create the map file**

Create `docs/PROPAGATION.yaml`:

```yaml
# What mirrors what — the propagation map consumed by the /propagate skill and
# `pnpm --filter @agora/api check:propagation` (apps/api/scripts/check-propagation.ts).
# Design: docs/superpowers/specs/2026-07-03-propagate-doc-sync-design.md
#
# Obligations derived from this map are ADVISORY: not every subject belongs in every
# target (secrets get no compose default; dev-only vars skip prod). The /propagate
# checklist marks unresolved obligations "intentionally skipped?" for the user to rule
# on; recurring rulings get recorded under `exceptions:` so they stop resurfacing.

env-var:
  detect:
    - packages/core/src/lib/env.ts
  mechanical:
    - .env.dev.example
    - .env.selfhost.example
    - .env.prod.example
    - docker-compose.dev.yml
    - docker-compose.yml
    - docker-compose.prod.yml
  prose:
    - docs/SELF-HOSTING.md
    - README.md
    - CLAUDE.md
    - wiki/Deployment.md

endpoint:
  detect:
    - apps/api/src/routes/**
    - apps/secure-chat/src/routes/**
  prose:
    - docs/MANIFEST.md
    - docs/MODELS.md
    - wiki/API-Contract.md

compose:
  detect:
    - docker-compose.dev.yml
    - docker-compose.yml
    - docker-compose.prod.yml
    - deploy/**
  prose:
    - docs/SELF-HOSTING.md
    - README.md
    - wiki/Deployment.md

catch-all:
  detect:
    - apps/**
    - packages/**
    - services/**
  prose:
    - CHANGELOG.md

exceptions: []
# Example entry (grows over time as the user rules on skipped obligations):
#   - subject: RATE_LIMIT_WINDOW_SECONDS
#     target: docker-compose.prod.yml
#     reason: tuned via .env only; compose never overrides it
```

- [ ] **Step 3: Write the failing tests**

Create `apps/api/src/lib/propagation/map.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { matchesAny, parseMap } from "./map";

const GOOD = `
env-var:
  detect: [packages/core/src/lib/env.ts]
  mechanical: [.env.dev.example]
  prose: [docs/SELF-HOSTING.md]
endpoint:
  detect: ["apps/api/src/routes/**"]
  prose: [docs/MANIFEST.md]
exceptions:
  - subject: CRON_SECRET
    target: docker-compose.prod.yml
    reason: secret, never given a compose default
`;

describe("parseMap", () => {
  it("parses classes with detect/mechanical/prose and exceptions", () => {
    const map = parseMap(GOOD);
    expect(Object.keys(map.classes)).toEqual(["env-var", "endpoint"]);
    expect(map.classes["env-var"].mechanical).toEqual([".env.dev.example"]);
    expect(map.classes["endpoint"].mechanical).toEqual([]); // omitted → empty
    expect(map.exceptions).toEqual([
      { subject: "CRON_SECRET", target: "docker-compose.prod.yml", reason: "secret, never given a compose default" },
    ]);
  });

  it("rejects a class without detect patterns", () => {
    expect(() => parseMap("bad:\n  prose: [README.md]\n")).toThrow(/detect/);
  });

  it("rejects non-mapping top level and malformed exceptions", () => {
    expect(() => parseMap("- just\n- a list\n")).toThrow(/mapping/);
    expect(() => parseMap("c:\n  detect: [x]\nexceptions:\n  - subject: A\n")).toThrow(/exceptions\[0\]/);
  });
});

describe("matchesAny", () => {
  it("matches exact paths, * within a segment, and ** across segments", () => {
    expect(matchesAny("packages/core/src/lib/env.ts", ["packages/core/src/lib/env.ts"])).toBe(true);
    expect(matchesAny("apps/api/src/routes/deep/auth.ts", ["apps/api/src/routes/**"])).toBe(true);
    expect(matchesAny("apps/api/src/lib/env.ts", ["apps/*/src/lib/env*.ts"])).toBe(true);
    expect(matchesAny("docs/SELF-HOSTING.md", ["apps/**"])).toBe(false);
    expect(matchesAny("apps/api/src/lib/env.ts", ["apps/*/lib/env*.ts"])).toBe(false); // * must not cross /
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm --filter @agora/api test -- map`
Expected: FAIL — `Cannot find module './map'` (or equivalent).

- [ ] **Step 5: Implement `map.ts`**

Create `apps/api/src/lib/propagation/map.ts`:

```ts
// Parser for docs/PROPAGATION.yaml — the checked-in map of "what mirrors what" —
// plus the minimal glob matcher its `detect` patterns need. Pure: YAML source in,
// validated map out; callers (the check-propagation CLI) do all fs I/O.
// Design: docs/superpowers/specs/2026-07-03-propagate-doc-sync-design.md
import { parse } from "yaml";

export interface PropagationClass {
  detect: string[];
  mechanical: string[];
  prose: string[];
}

export interface PropagationException {
  subject: string;
  target: string;
  reason: string;
}

export interface PropagationMap {
  classes: Record<string, PropagationClass>;
  exceptions: PropagationException[];
}

function toStringArray(v: unknown, where: string): string[] {
  if (v == null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new Error(`PROPAGATION.yaml: ${where} must be a list of strings`);
  }
  return v as string[];
}

export function parseMap(source: string): PropagationMap {
  const raw: unknown = parse(source);
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("PROPAGATION.yaml: top level must be a mapping");
  }
  const { exceptions, ...classes } = raw as Record<string, unknown>;
  const map: PropagationMap = { classes: {}, exceptions: [] };

  for (const [name, def] of Object.entries(classes)) {
    if (def == null || typeof def !== "object" || Array.isArray(def)) {
      throw new Error(`PROPAGATION.yaml: class "${name}" must be a mapping`);
    }
    const d = def as Record<string, unknown>;
    const cls: PropagationClass = {
      detect: toStringArray(d.detect, `${name}.detect`),
      mechanical: toStringArray(d.mechanical, `${name}.mechanical`),
      prose: toStringArray(d.prose, `${name}.prose`),
    };
    if (cls.detect.length === 0) {
      throw new Error(`PROPAGATION.yaml: class "${name}" needs detect patterns`);
    }
    map.classes[name] = cls;
  }

  if (exceptions != null) {
    if (!Array.isArray(exceptions)) throw new Error("PROPAGATION.yaml: exceptions must be a list");
    exceptions.forEach((e, i) => {
      if (e == null || typeof e !== "object" || Array.isArray(e)) {
        throw new Error(`PROPAGATION.yaml: exceptions[${i}] must be a mapping`);
      }
      const { subject, target, reason } = e as Record<string, unknown>;
      if (typeof subject !== "string" || typeof target !== "string" || typeof reason !== "string") {
        throw new Error(`PROPAGATION.yaml: exceptions[${i}] needs string subject/target/reason`);
      }
      map.exceptions.push({ subject, target, reason });
    });
  }
  return map;
}

// Minimal glob: `**` matches across path segments, `*` within one segment. Anchored both ends.
function globToRegExp(pattern: string): RegExp {
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const re = esc.replace(/\*\*/g, " ").replace(/\*/g, "[^/]*").replace(/ /g, ".*");
  return new RegExp(`^${re}$`);
}

export function matchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((p) => globToRegExp(p).test(path));
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @agora/api test -- map`
Expected: PASS (all `map.test.ts` tests green).

- [ ] **Step 7: Typecheck and commit**

```bash
pnpm --filter @agora/api typecheck
git add docs/PROPAGATION.yaml apps/api/src/lib/propagation/map.ts apps/api/src/lib/propagation/map.test.ts apps/api/package.json pnpm-lock.yaml
git commit -s -m "feat(propagation): propagation map (docs/PROPAGATION.yaml) + parser

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Env-surface extractors

**Files:**
- Create: `apps/api/src/lib/propagation/parse-env.ts`
- Test: `apps/api/src/lib/propagation/parse-env.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `extractEnvSchemaKeys(source: string): string[]`, `extractEnvExampleKeys(source: string): Set<string>`, `extractComposeKeys(source: string): Set<string>`, `mentions(content: string, token: string): boolean`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/lib/propagation/parse-env.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { extractComposeKeys, extractEnvExampleKeys, extractEnvSchemaKeys, mentions } from "./parse-env";

const ENV_TS = `
import { z } from "zod";
const schema = z.object({
  PORT: z.coerce.number().default(4000),
  // Supabase transaction pooler — Drizzle owns DB access.
  DATABASE_URL: z.string().url(),
  CONTENT_DELETE_MODE: z.preprocess((v) => (v === "" ? undefined : v), z.enum(["soft", "hard"]).default("soft")),
});
export const env = schema.parse(process.env);
`;

const EXAMPLE = `
# ── Bring it up — local Postgres (the default) ────────────────────────────────
AGORA_ENV=dev
ACCESS_TOKEN_SECRET=<GENERATE: openssl rand -base64 48>
# CLOUD switch — uncomment to use Supabase instead:
# SUPABASE_URL=https://xyz.supabase.co
#   RATE_LIMIT_MAX=300
`;

const COMPOSE = `
services:
  agora:
    image: agora
    environment:
      CONTENT_DELETE_MODE: \${CONTENT_DELETE_MODE:-soft}
      OTEL_SDK_DISABLED: \${OTEL_SDK_DISABLED:-true}
    ports:
      - "\${DB_PORT:-5432}:5432"
`;

describe("extractEnvSchemaKeys", () => {
  it("extracts top-level z.object keys, skipping comments and nested lines", () => {
    expect(extractEnvSchemaKeys(ENV_TS)).toEqual(["PORT", "DATABASE_URL", "CONTENT_DELETE_MODE"]);
  });
});

describe("extractEnvExampleKeys", () => {
  it("counts active and commented-switch assignments, not prose comments", () => {
    const keys = extractEnvExampleKeys(EXAMPLE);
    expect(keys).toEqual(new Set(["AGORA_ENV", "ACCESS_TOKEN_SECRET", "SUPABASE_URL", "RATE_LIMIT_MAX"]));
  });
});

describe("extractComposeKeys", () => {
  it("counts environment keys and \${VAR} interpolations, not yaml config keys", () => {
    const keys = extractComposeKeys(COMPOSE);
    expect(keys.has("CONTENT_DELETE_MODE")).toBe(true);
    expect(keys.has("OTEL_SDK_DISABLED")).toBe(true);
    expect(keys.has("DB_PORT")).toBe(true); // interpolation-only ref still counts
    expect(keys.has("image")).toBe(false);
  });
});

describe("mentions", () => {
  it("matches whole tokens only", () => {
    expect(mentions("set CONTENT_DELETE_MODE=hard to enable", "CONTENT_DELETE_MODE")).toBe(true);
    expect(mentions("CONTENT_DELETE_MODE_V2 is different", "CONTENT_DELETE_MODE")).toBe(false);
    expect(mentions("unrelated prose", "CONTENT_DELETE_MODE")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @agora/api test -- parse-env`
Expected: FAIL — `Cannot find module './parse-env'`.

- [ ] **Step 3: Implement `parse-env.ts`**

Create `apps/api/src/lib/propagation/parse-env.ts`:

```ts
// Pure extractors over env-surface file CONTENTS (callers do fs I/O), so unit tests
// need no fixtures on disk. Formats matched are this repo's actual conventions:
// packages/core/src/lib/env.ts (zod schema), .env.*.example, docker-compose*.yml.

// Keys of the top-level z.object literal: exactly-two-space-indented `KEY:` properties,
// SCREAMING_SNAKE only — comment lines and deeper-nested properties never match.
const SCHEMA_KEY = /^ {2}([A-Z][A-Z0-9_]*):/;
export function extractEnvSchemaKeys(source: string): string[] {
  const keys: string[] = [];
  for (const line of source.split("\n")) {
    const m = SCHEMA_KEY.exec(line);
    if (m) keys.push(m[1]);
  }
  return keys;
}

// A var is "documented in a template" when it appears as an assignment — active
// (`KEY=`) or a commented switch (`# KEY=`), the templates' LOCAL/CLOUD convention.
const EXAMPLE_KEY = /^#?\s*([A-Z][A-Z0-9_]*)=/;
export function extractEnvExampleKeys(source: string): Set<string> {
  const keys = new Set<string>();
  for (const line of source.split("\n")) {
    const m = EXAMPLE_KEY.exec(line);
    if (m) keys.add(m[1]);
  }
  return keys;
}

// A var is "surfaced in compose" when a service sets it (`KEY:` under environment:)
// or the file interpolates it from .env (`${KEY}` / `${KEY:-default}`). The
// uppercase-only pattern filters out yaml config keys (image:, ports:, …).
const COMPOSE_ENV_KEY = /^\s+([A-Z][A-Z0-9_]*):/;
const COMPOSE_VAR_REF = /\$\{([A-Z][A-Z0-9_]*)(?::?-[^}]*)?\}/g;
export function extractComposeKeys(source: string): Set<string> {
  const keys = new Set<string>();
  for (const line of source.split("\n")) {
    const m = COMPOSE_ENV_KEY.exec(line);
    if (m) keys.add(m[1]);
    for (const ref of line.matchAll(COMPOSE_VAR_REF)) keys.add(ref[1]);
  }
  return keys;
}

// Word-boundary mention check for prose targets (docs/wiki/README): env var names are
// distinctive SCREAMING_SNAKE tokens, so a whole-token mention counts as "documented".
export function mentions(content: string, token: string): boolean {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${esc}\\b`).test(content);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @agora/api test -- parse-env`
Expected: PASS.

- [ ] **Step 5: Sanity-check against the real files, then commit**

```bash
cd apps/api && npx tsx -e '
import { readFileSync } from "node:fs";
import { extractEnvSchemaKeys } from "./src/lib/propagation/parse-env";
const keys = extractEnvSchemaKeys(readFileSync("../../packages/core/src/lib/env.ts", "utf8"));
console.log(keys.length, "keys; sample:", keys.slice(0, 5));
' && cd ../..
```
Expected: a plausible key count (≳30) starting `PORT, SECURE_CHAT_PORT, DATABASE_URL, …`. If 0, the schema indentation changed — fix the regex, not the file.

```bash
git add apps/api/src/lib/propagation/parse-env.ts apps/api/src/lib/propagation/parse-env.test.ts
git commit -s -m "feat(propagation): env-surface extractors (schema/example/compose/mentions)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Route & MANIFEST extractors

**Files:**
- Create: `apps/api/src/lib/propagation/parse-routes.ts`
- Test: `apps/api/src/lib/propagation/parse-routes.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `interface RouteRef { method: string; path: string }`, `extractRoutePaths(routeSource: string): RouteRef[]`, `extractRouteMounts(indexSource: string): Record<string, string>` (module basename → mount prefix), `extractManifestEntries(manifestSource: string): RouteRef[]`, `normalizePath(p: string): string` (`:param` → `:*`, trailing-slash-trimmed), `joinPath(mount: string, sub: string): string`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/lib/propagation/parse-routes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  extractManifestEntries,
  extractRouteMounts,
  extractRoutePaths,
  joinPath,
  normalizePath,
} from "./parse-routes";

const ROUTER = `
const app = new Hono()
  .get("/", async (c) => {})
  .post("/", requireAuth, async (c) => {})
  .get("/by-short-id", async (c) => {})
  .get("/:id", async (c) => {})
  .delete("/:id", requireAuth, async (c) => {});
`;

const INDEX = `
import authRoutes from "./auth";
import entityRoutes from "./entities";
import connectionRoutes from "./connections";
import miscRoutes from "./misc";
export function mountRoutes() {
  project.route("/auth", authRoutes);
  project.route("/entities", entityRoutes);
  project.route("/", miscRoutes);
  v7.route("/", connectionRoutes);
}
`;

const MANIFEST = `
| Method | Path | Status |
|---|---|---|
| POST | \`/auth/sign-up\` (→ \`201\` session) | ✅ |
| GET | \`/entities/:entityId\` | ✅ |
prose that is not a table row
| DELETE | \`/entities/:entityId\` | 🔶 |
`;

describe("extractRoutePaths", () => {
  it("extracts chained method registrations with their paths", () => {
    expect(extractRoutePaths(ROUTER)).toEqual([
      { method: "GET", path: "/" },
      { method: "POST", path: "/" },
      { method: "GET", path: "/by-short-id" },
      { method: "GET", path: "/:id" },
      { method: "DELETE", path: "/:id" },
    ]);
  });
});

describe("extractRouteMounts", () => {
  it("maps route module basenames to mount prefixes", () => {
    expect(extractRouteMounts(INDEX)).toEqual({
      auth: "/auth",
      entities: "/entities",
      misc: "/",
      connections: "/",
    });
  });
});

describe("extractManifestEntries", () => {
  it("parses method+path from table rows, ignoring trailing prose", () => {
    expect(extractManifestEntries(MANIFEST)).toEqual([
      { method: "POST", path: "/auth/sign-up" },
      { method: "GET", path: "/entities/:entityId" },
      { method: "DELETE", path: "/entities/:entityId" },
    ]);
  });
});

describe("normalizePath / joinPath", () => {
  it("normalizes param names and trailing slashes so :id matches :entityId", () => {
    expect(normalizePath("/entities/:entityId")).toBe("/entities/:*");
    expect(normalizePath("/entities/:id/")).toBe("/entities/:*");
    expect(normalizePath("/")).toBe("/");
  });
  it("joins mount + subpath without doubled or trailing slashes", () => {
    expect(joinPath("/entities", "/:id")).toBe("/entities/:id");
    expect(joinPath("/entities", "/")).toBe("/entities");
    expect(joinPath("/", "/sign-up")).toBe("/sign-up");
    expect(joinPath("/", "/")).toBe("/");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @agora/api test -- parse-routes`
Expected: FAIL — `Cannot find module './parse-routes'`.

- [ ] **Step 3: Implement `parse-routes.ts`**

Create `apps/api/src/lib/propagation/parse-routes.ts`:

```ts
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
    out.push({ method: m[1].toUpperCase(), path: m[2] });
  }
  return out;
}

// routes/index.ts pairs `import entityRoutes from "./entities"` with
// `project.route("/entities", entityRoutes)` (or `v7.route(…)` — connections mount at
// the /v7 root). Returns { <module basename>: <mount prefix> }.
export function extractRouteMounts(indexSource: string): Record<string, string> {
  const moduleByIdent: Record<string, string> = {};
  for (const m of indexSource.matchAll(/import\s+(\w+)\s+from\s+"\.\/([\w./-]+)"/g)) {
    const base = m[2].split("/").pop() ?? m[2];
    moduleByIdent[m[1]] = base.replace(/\.[jt]sx?$/, "");
  }
  const mounts: Record<string, string> = {};
  for (const m of indexSource.matchAll(/\.route\(\s*"([^"]*)"\s*,\s*(\w+)\s*\)/g)) {
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
    if (m) out.push({ method: m[1], path: m[2] });
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @agora/api test -- parse-routes`
Expected: PASS.

- [ ] **Step 5: Sanity-check against the real MANIFEST, then commit**

```bash
cd apps/api && npx tsx -e '
import { readFileSync } from "node:fs";
import { extractManifestEntries } from "./src/lib/propagation/parse-routes";
const entries = extractManifestEntries(readFileSync("../../docs/MANIFEST.md", "utf8"));
console.log(entries.length, "manifest endpoints; sample:", entries.slice(0, 3));
' && cd ../..
```
Expected: a large count (≳100). If ~0, MANIFEST's table style diverges from the regex — adjust the regex to the file.

```bash
git add apps/api/src/lib/propagation/parse-routes.ts apps/api/src/lib/propagation/parse-routes.test.ts
git commit -s -m "feat(propagation): route + MANIFEST extractors

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Obligation derivation

**Files:**
- Create: `apps/api/src/lib/propagation/obligations.ts`
- Test: `apps/api/src/lib/propagation/obligations.test.ts`

**Interfaces:**
- Consumes: `PropagationClass`, `PropagationException` from `./map` (Task 1); `extractEnvExampleKeys`, `extractComposeKeys`, `mentions` from `./parse-env` (Task 2); `RouteRef`, `normalizePath` from `./parse-routes` (Task 3).
- Produces: `type ObligationStatus = "missing" | "present" | "excepted" | "advisory" | "unparseable"`, `interface Obligation { cls: string; subject: string; kind: "mechanical" | "prose"; target: string; status: ObligationStatus; note?: string }`, `deriveEnvObligations(input: EnvObligationInput): Obligation[]`, `deriveEndpointObligations(input: EndpointObligationInput): Obligation[]`. Input shapes are in the code below; the CLI (Task 5) constructs them.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/lib/propagation/obligations.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { PropagationClass } from "./map";
import { deriveEndpointObligations, deriveEnvObligations } from "./obligations";

const ENV_CLS: PropagationClass = {
  detect: ["packages/core/src/lib/env.ts"],
  mechanical: [".env.dev.example", "docker-compose.yml"],
  prose: ["docs/SELF-HOSTING.md"],
};

describe("deriveEnvObligations", () => {
  it("reports present/missing per target for an added key", () => {
    const obs = deriveEnvObligations({
      addedKeys: ["NEW_VAR"],
      removedKeys: [],
      targets: {
        ".env.dev.example": "NEW_VAR=1\n",
        "docker-compose.yml": "services:\n  agora:\n    environment:\n      OTHER: x\n",
        "docs/SELF-HOSTING.md": "no mention here\n",
      },
      cls: ENV_CLS,
      exceptions: [],
    });
    const by = Object.fromEntries(obs.map((o) => [o.target, o.status]));
    expect(by[".env.dev.example"]).toBe("present");
    expect(by["docker-compose.yml"]).toBe("missing");
    expect(by["docs/SELF-HOSTING.md"]).toBe("missing");
  });

  it("marks exceptions excepted and unreadable targets unparseable", () => {
    const obs = deriveEnvObligations({
      addedKeys: ["SECRET_VAR"],
      removedKeys: [],
      targets: { ".env.dev.example": null, "docker-compose.yml": "", "docs/SELF-HOSTING.md": "" },
      cls: ENV_CLS,
      exceptions: [{ subject: "SECRET_VAR", target: "docker-compose.yml", reason: "secret, no compose default" }],
    });
    expect(obs.find((o) => o.target === ".env.dev.example")?.status).toBe("unparseable");
    expect(obs.find((o) => o.target === "docker-compose.yml")?.status).toBe("excepted");
  });

  it("flags stale references to a removed key", () => {
    const obs = deriveEnvObligations({
      addedKeys: [],
      removedKeys: ["OLD_VAR"],
      targets: {
        ".env.dev.example": "OLD_VAR=1\n",
        "docker-compose.yml": "services: {}\n",
        "docs/SELF-HOSTING.md": "set OLD_VAR to tune\n",
      },
      cls: ENV_CLS,
      exceptions: [],
    });
    expect(obs).toHaveLength(2); // only the two targets still referencing it
    expect(obs.every((o) => o.status === "missing" && /stale/.test(o.note ?? ""))).toBe(true);
  });
});

describe("deriveEndpointObligations", () => {
  const CLS: PropagationClass = {
    detect: ["apps/api/src/routes/**"],
    mechanical: [],
    prose: ["docs/MANIFEST.md", "docs/MODELS.md"],
  };

  it("checks MANIFEST deterministically (param names normalized) and marks the rest advisory", () => {
    const obs = deriveEndpointObligations({
      addedRoutes: [
        { method: "GET", path: "/entities/:id" },
        { method: "POST", path: "/entities/brand-new" },
      ],
      cls: CLS,
      exceptions: [],
      manifestEntries: [{ method: "GET", path: "/entities/:entityId" }],
    });
    const get = obs.filter((o) => o.subject === "GET /entities/:id");
    expect(get.find((o) => o.target === "docs/MANIFEST.md")?.status).toBe("present");
    expect(get.find((o) => o.target === "docs/MODELS.md")?.status).toBe("advisory");
    const post = obs.filter((o) => o.subject === "POST /entities/brand-new");
    expect(post.find((o) => o.target === "docs/MANIFEST.md")?.status).toBe("missing");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @agora/api test -- obligations`
Expected: FAIL — `Cannot find module './obligations'`.

- [ ] **Step 3: Implement `obligations.ts`**

Create `apps/api/src/lib/propagation/obligations.ts`:

```ts
// Obligation derivation — the deterministic heart of the checker. Pure: pre-extracted
// facts + target CONTENTS in, obligation rows out. Statuses:
//   present     the mirror already carries the subject
//   missing     it doesn't (or still carries a REMOVED subject — see note)
//   excepted    an exceptions: entry in docs/PROPAGATION.yaml rules it out
//   advisory    not deterministically checkable (agent/user judgment resolves it)
//   unparseable a mapped target could not be read — NEVER silently dropped
import type { PropagationClass, PropagationException } from "./map";
import { extractComposeKeys, extractEnvExampleKeys, mentions } from "./parse-env";
import { normalizePath, type RouteRef } from "./parse-routes";

export type ObligationStatus = "missing" | "present" | "excepted" | "advisory" | "unparseable";

export interface Obligation {
  cls: string;
  subject: string;
  kind: "mechanical" | "prose";
  target: string;
  status: ObligationStatus;
  note?: string;
}

export interface EnvObligationInput {
  addedKeys: string[];
  removedKeys: string[];
  targets: Record<string, string | null>; // target path → content; null = unreadable
  cls: PropagationClass;
  exceptions: PropagationException[];
}

function findException(exceptions: PropagationException[], subject: string, target: string) {
  return exceptions.find((e) => e.subject === subject && e.target === target);
}

// Which extraction applies to a mechanical target is decided by its filename shape.
function mechanicalHas(target: string, content: string, key: string): boolean | null {
  if (/\.example$/.test(target)) return extractEnvExampleKeys(content).has(key);
  if (/docker-compose[^/]*\.ya?ml$/.test(target)) return extractComposeKeys(content).has(key);
  return null; // unknown mechanical target type
}

export function deriveEnvObligations(input: EnvObligationInput): Obligation[] {
  const out: Obligation[] = [];
  const targets = [
    ...input.cls.mechanical.map((t) => ({ t, kind: "mechanical" as const })),
    ...input.cls.prose.map((t) => ({ t, kind: "prose" as const })),
  ];

  for (const key of input.addedKeys) {
    for (const { t, kind } of targets) {
      const ex = findException(input.exceptions, key, t);
      if (ex) {
        out.push({ cls: "env-var", subject: key, kind, target: t, status: "excepted", note: ex.reason });
        continue;
      }
      const content = input.targets[t];
      if (content == null) {
        out.push({ cls: "env-var", subject: key, kind, target: t, status: "unparseable", note: "target unreadable" });
        continue;
      }
      const has = kind === "mechanical" ? mechanicalHas(t, content, key) : mentions(content, key);
      if (has == null) {
        out.push({ cls: "env-var", subject: key, kind, target: t, status: "unparseable", note: "no extractor for this target type" });
        continue;
      }
      out.push({ cls: "env-var", subject: key, kind, target: t, status: has ? "present" : "missing" });
    }
  }

  for (const key of input.removedKeys) {
    for (const { t, kind } of targets) {
      const content = input.targets[t];
      if (content == null) continue; // unreadable targets already surface via addedKeys or the CLI
      const still = kind === "mechanical" ? mechanicalHas(t, content, key) ?? false : mentions(content, key);
      if (still) {
        out.push({ cls: "env-var", subject: key, kind, target: t, status: "missing", note: "stale reference to removed var — scrub it" });
      }
    }
  }
  return out;
}

export interface EndpointObligationInput {
  addedRoutes: RouteRef[]; // full mount-prefixed paths
  cls: PropagationClass;
  exceptions: PropagationException[];
  manifestEntries: RouteRef[];
}

export function deriveEndpointObligations(input: EndpointObligationInput): Obligation[] {
  const out: Obligation[] = [];
  const manifest = new Set(input.manifestEntries.map((r) => `${r.method} ${normalizePath(r.path)}`));

  for (const r of input.addedRoutes) {
    const subject = `${r.method} ${r.path}`;
    for (const t of input.cls.prose) {
      const ex = findException(input.exceptions, subject, t);
      if (ex) {
        out.push({ cls: "endpoint", subject, kind: "prose", target: t, status: "excepted", note: ex.reason });
        continue;
      }
      if (t.endsWith("MANIFEST.md")) {
        const present = manifest.has(`${r.method} ${normalizePath(r.path)}`);
        out.push({ cls: "endpoint", subject, kind: "prose", target: t, status: present ? "present" : "missing" });
      } else {
        out.push({ cls: "endpoint", subject, kind: "prose", target: t, status: "advisory", note: "coverage needs judgment" });
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @agora/api test -- obligations`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm --filter @agora/api typecheck
git add apps/api/src/lib/propagation/obligations.ts apps/api/src/lib/propagation/obligations.test.ts
git commit -s -m "feat(propagation): obligation derivation (env + endpoint, removals, exceptions)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `check-propagation` CLI

**Files:**
- Create: `apps/api/scripts/check-propagation.ts`
- Modify: `apps/api/package.json` (add `"check:propagation"` script)

**Interfaces:**
- Consumes: everything Tasks 1–4 produced (imports from `../src/lib/propagation/*`).
- Produces: `pnpm --filter @agora/api check:propagation [--diff <base>] [--json]`. JSON mode emits `{ base: string | null, obligations: Obligation[] }` on stdout — the `/propagate` skill (Task 6) parses exactly this. Exit code 1 iff any obligation is `missing` or `unparseable`.

- [ ] **Step 1: Implement the CLI**

Create `apps/api/scripts/check-propagation.ts`:

```ts
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
```

- [ ] **Step 2: Add the package script**

In `apps/api/package.json`, in `"scripts"`, after the `"genesis"` line add:

```json
    "check:propagation": "tsx scripts/check-propagation.ts",
```

- [ ] **Step 3: Smoke-test diff mode against a ref where env vars were added**

`CONTENT_DELETE_MODE` landed recently, so diffing from before it must surface it:

```bash
cd apps/api
pnpm check:propagation --diff af312fc~1
```
Expected: `[env-var]` block with `CONTENT_DELETE_MODE` rows — ✅ present for the three `.env.*.example` files and the compose files (it was fully propagated), plus prose rows; `[catch-all]` shows CHANGELOG ✅ present. Exit code may be 0 or 1 depending on prose coverage — both fine; what matters is the subjects are detected and no crash.

Also verify a no-op diff is quiet:

```bash
pnpm check:propagation --diff HEAD; echo "exit=$?"
```
Expected: obligations only from currently-uncommitted work (or none), no crash.

- [ ] **Step 4: Smoke-test full-scan mode**

```bash
pnpm check:propagation || true
pnpm check:propagation --json | head -30
cd ../..
```
Expected: a long table (every schema env key × every target; every route vs MANIFEST). It WILL report existing drift — that's the point of full-scan mode and does not block this task. `--json` must emit valid JSON with `base: null`.

- [ ] **Step 5: Typecheck, test, commit**

```bash
pnpm --filter @agora/api typecheck && pnpm --filter @agora/api test
git add apps/api/scripts/check-propagation.ts apps/api/package.json
git commit -s -m "feat(propagation): check-propagation CLI (--diff/full-scan, --json)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: The `/propagate` skill + repo docs

**Files:**
- Create: `.claude/skills/propagate/SKILL.md`
- Modify: `CLAUDE.md` (pointer in the Commands section)
- Modify: `CHANGELOG.md` (`[Unreleased]` → `Added`)

**Interfaces:**
- Consumes: the CLI contract from Task 5 (`check:propagation --diff <base> --json` → `{ base, obligations: Obligation[] }`).
- Produces: the user-invocable `/propagate` skill.

- [ ] **Step 1: Write the skill**

Create `.claude/skills/propagate/SKILL.md`:

```markdown
---
name: propagate
description: Use when a feature branch is done (or the user asks to sync docs/config) to propagate the branch's changes into every mirror — .env examples, compose files, docs/, wiki/, CHANGELOG. Checker-driven agent fan-out; propose-then-approve (drafts edits in the working tree, never commits).
---

# /propagate — diff-driven doc & config propagation

Design: `docs/superpowers/specs/2026-07-03-propagate-doc-sync-design.md`.
Map (what mirrors what): `docs/PROPAGATION.yaml`.
Checker: `pnpm --filter @agora/api check:propagation --diff <base> --json`.

**Prime directive: propose-then-approve.** Draft every edit in the working tree, present a
checklist, then STOP. Never commit, never push. The user reviews and commits.

## Flow

### 1. Establish the base
Use an explicit ref if the user gave one as an argument; otherwise `git merge-base HEAD root`.
If the merge-base equals HEAD (working directly on root), fall back to `HEAD` — the diff is
then just uncommitted work. All diffing includes uncommitted changes.

### 2. Scout (deterministic)
Run the checker and parse its JSON:
```bash
pnpm --filter @agora/api check:propagation --diff <base> --json
```
`obligations[]` rows are `{ cls, subject, kind, target, status, note? }`. Work only the
`missing` ones; carry `advisory` rows forward as judgment items; report `unparseable` rows
verbatim in the final checklist (never swallow them). `excepted`/`present` need no work.

### 3. Judgment sweep (one agent, read-only)
Dispatch ONE agent with the full diff (`git diff <base>` + untracked files) and the list of
mapped targets. Its job — it EDITS NOTHING, it returns data:
- Which prose docs beyond the mapped targets are affected? (It should list `docs/` and
  `wiki/` filenames and skim candidates before answering.)
- Draft the CHANGELOG `[Unreleased]` entry (Keep a Changelog sections: Added/Changed/Fixed/Removed).
- For each `advisory` obligation from the scout: is it real work or ignorable, and why?

### 4. Fan out drafting agents (parallel, one file : one agent)
Partition by audience cluster so each agent tells one coherent story across related docs.
**No two agents may touch the same file.** Standard clusters (skip any with no work; add
clusters for sweep-discovered targets):
- **mechanical** — `.env.*.example` ×3 + `docker-compose*.yml` ×3. Rote edits: match each
  template's comment style and the LOCAL/CLOUD commented-switch convention; compose entries
  use `KEY: ${KEY:-default}` with a brief comment, mirroring existing entries.
- **deployment prose** — `docs/SELF-HOSTING.md` + `README.md` + `wiki/Deployment.md`
  (+ `CLAUDE.md` when env/commands/architecture summaries are affected).
- **API contract prose** — `docs/MANIFEST.md` + `docs/MODELS.md` + `wiki/API-Contract.md`.
- **CHANGELOG** — apply the sweep's drafted entry under `[Unreleased]`.

Every drafting agent gets: the relevant diff hunks, its obligation rows, the instruction to
match each doc's existing voice/structure/heading style, and the hard rule: **if you cannot
find a sensible home for content, REPORT it back — do not invent new doc sections.**

### 5. Verify (deterministic again)
Re-run the checker. Every remaining `missing`/`unparseable` row must be explained in the
checklist (candidate for `exceptions:` in `docs/PROPAGATION.yaml`, or a real gap the user
must rule on). Then one critic agent, read-only: "Given this diff and these edits, what's
still missing — a doc not updated, a removal not scrubbed, a stale wiki page?"

### 6. Report and stop
Present:
- ✅ propagated (subject → files)
- ⏭️ excepted (with reasons)
- ⚠️ intentionally skipped? (unresolved obligations — offer to add recurring ones to
  `exceptions:` in `docs/PROPAGATION.yaml`)
- ❓ needs your judgment (advisory + anything agents reported instead of guessing)
- 💥 unparseable (checker could not read/parse a mapped target — fix the map or the file)
- `git diff --stat` of the working tree
Then STOP. The user reviews and commits.
```

- [ ] **Step 2: Add the CLAUDE.md pointer**

In `CLAUDE.md`, at the end of the `## Commands` section's code block (after the `pnpm seed:graph` line, still inside the fence), add:

```bash
pnpm check:propagation           # (in apps/api) propagation drift checker — see docs/PROPAGATION.yaml
pnpm check:propagation --diff X  # obligations arising from the diff vs ref X (what /propagate uses)
```

And immediately after that code block's closing fence, add this paragraph:

```markdown
**Propagation (docs/config mirrors).** One change often has many mirrors (env var →
`.env.*.example` ×3, compose ×3, docs, wiki). `docs/PROPAGATION.yaml` maps what mirrors what;
the `/propagate` skill (`.claude/skills/propagate/`) runs the checker over the branch diff,
fans out drafting agents per audience cluster, and presents a propose-then-approve checklist.
When you add an env var / endpoint / compose service by hand, consult the map — or run
`/propagate` before finishing the branch.
```

- [ ] **Step 3: Add the CHANGELOG entry**

In `CHANGELOG.md` under `## [Unreleased]`, add (creating the `### Added` heading if absent):

```markdown
### Added
- `/propagate` doc & config propagation system: `docs/PROPAGATION.yaml` (the map of what
  mirrors what), `check:propagation` drift checker CLI in `@agora/api` (`--diff <base>` /
  full-scan, `--json`), and the `.claude/skills/propagate` skill that drafts mirror edits
  (env templates, compose, docs, wiki, CHANGELOG) via agent fan-out, propose-then-approve.
```

- [ ] **Step 4: Full typecheck + unit suite, then commit**

```bash
pnpm -r typecheck && pnpm --filter @agora/api test
git add .claude/skills/propagate/SKILL.md CLAUDE.md CHANGELOG.md
git commit -s -m "feat(propagation): /propagate skill + repo docs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Live validation on a real branch

**Files:** none created — this exercises the whole system end-to-end.

**Interfaces:**
- Consumes: everything.
- Produces: a validated `/propagate` run + any fixes it shakes out.

- [ ] **Step 1: Pick the validation diff**

The current working tree carries the auth/email `redirectTo` work (modified
`apps/api/src/lib/auth/*`, `routes/auth.ts`, `packages/contract/src/schemas.ts`, docs). If it
has been committed meanwhile, diff from just before it instead (`--diff <that-commit>~1`).

- [ ] **Step 2: Run the checker alone first**

```bash
pnpm --filter @agora/api check:propagation --diff $(git merge-base HEAD root 2>/dev/null || echo HEAD)
```
Expected: obligations reflecting the real diff (contract schema changes → catch-all CHANGELOG
row at minimum; any new env keys → env-var rows). Hand-verify 2–3 rows against the actual
files: a reported `missing` must really be missing, a `present` really present. A false
report here is a parser bug — fix the extractor + add a regression test to its `*.test.ts`
before proceeding.

- [ ] **Step 3: Run the skill**

Invoke `/propagate` (no argument). Follow it end-to-end: scout → sweep → fan-out → verify →
checklist. Confirm:
- no two agents edited the same file
- the checklist accounts for EVERY obligation the scout emitted (nothing silently dropped)
- drafted edits match each doc's voice (spot-check `docs/SELF-HOSTING.md` and one wiki page)
- nothing was committed by the skill

- [ ] **Step 4: User review gate**

Present the checklist and working-tree diff to the user. Apply any corrections they request.
Whatever they rule "intentionally skipped" → offer to add as `exceptions:` entries in
`docs/PROPAGATION.yaml` (and commit that as part of their normal branch commit).

---

## Self-Review (completed during planning)

- **Spec coverage:** map (`docs/PROPAGATION.yaml`) → Task 1; checker pure lib → Tasks 2–4; CLI two modes + JSON + loud parse failures → Task 5; skill with scout/sweep/cluster-fan-out/verify/checklist → Task 6; live validation on the current branch → Task 7; advisory obligations + exceptions → Tasks 1/4/6; removals/renames → Task 4; testing-in-same-change → every lib task; non-goals (no codegen, no CI, no auto-commit) — nothing in the plan builds them.
- **Placeholder scan:** no TBDs; every code step carries complete code; expected outputs stated for every run step.
- **Type consistency:** `Obligation`/`ObligationStatus` defined once (Task 4), consumed by Task 5's CLI and described to the skill (Task 6) with matching field names (`cls, subject, kind, target, status, note`); `PropagationClass.mechanical/prose` names match between map.ts, obligations.ts, and PROPAGATION.yaml; `RouteRef` shared via parse-routes.
