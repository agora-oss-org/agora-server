// Unsaved-changes detection for settings forms. `isDirty` compares a form's current snapshot to the
// baseline it was seeded from — object key ORDER is ignored (canonical stringify), array order is not.
// Callers normalize non-JSON values first (e.g. a Set of subscribed events → a sorted array) and never
// put write-only secrets in the snapshot as their real value (use a boolean "was it (re)entered" flag).

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** True when `current` differs from `baseline` (deep, key-order-independent). */
export function isDirty(current: unknown, baseline: unknown): boolean {
  return stableStringify(current) !== stableStringify(baseline);
}
