// Compact relative time ("just now", "5m ago", "3d ago", or a date for older). Browser-only.
const UNITS: [limit: number, secs: number, label: string][] = [
  [60, 1, "s"],
  [3600, 60, "m"],
  [86400, 3600, "h"],
  [604800, 86400, "d"],
];

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diff = Math.max(0, (Date.now() - then) / 1000);
  if (diff < 5) return "just now";
  for (const [limit, secs, label] of UNITS) {
    if (diff < limit) return `${Math.floor(diff / secs)}${label} ago`;
  }
  return new Date(iso).toLocaleDateString();
}

export function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : "—";
}
