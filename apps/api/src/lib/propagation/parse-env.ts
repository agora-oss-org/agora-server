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
    if (m && m[1]) keys.push(m[1]);
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
    if (m && m[1]) keys.add(m[1]);
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
    if (m && m[1]) keys.add(m[1]);
    for (const ref of line.matchAll(COMPOSE_VAR_REF)) {
      if (ref[1]) keys.add(ref[1]);
    }
  }
  return keys;
}

// Word-boundary mention check for prose targets (docs/wiki/README): env var names are
// distinctive SCREAMING_SNAKE tokens, so a whole-token mention counts as "documented".
export function mentions(content: string, token: string): boolean {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${esc}\\b`).test(content);
}
