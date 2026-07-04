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
