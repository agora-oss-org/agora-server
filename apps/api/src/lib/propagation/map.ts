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
  const re = esc.replace(/\*\*|\*/g, (match) => (match === "**" ? ".*" : "[^/]*"));
  return new RegExp(`^${re}$`);
}

export function matchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((p) => globToRegExp(p).test(path));
}
