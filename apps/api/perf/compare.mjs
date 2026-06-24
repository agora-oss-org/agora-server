// Diff two saved baseline summaries → per-endpoint p95/p99 + throughput deltas, so a regression is
// a number, not a vibe. See perf/README.md.
//
//   node perf/compare.mjs perf/baselines/<old>.json perf/baselines/<new>.json
import { readFileSync } from "node:fs";

const [, , oldPath, newPath] = process.argv;
if (!oldPath || !newPath) {
  console.error("usage: node perf/compare.mjs <old.json> <new.json>");
  process.exit(1);
}
const a = JSON.parse(readFileSync(oldPath, "utf8"));
const b = JSON.parse(readFileSync(newPath, "utf8"));

const NAMES = ["feed", "entity", "comments", "thread", "react", "comment_create"];
const p95 = (d, n) => d.metrics[`http_req_duration{name:${n}}`]?.values?.["p(95)"];
const overall = (d, k) => d.metrics.http_req_duration?.values?.[k];
const rps = (d) => d.metrics.http_reqs?.values?.rate;

// A higher p95 is WORSE (positive delta = regression); higher throughput is BETTER.
function pct(oldV, newV) {
  if (oldV == null || newV == null) return null;
  return ((newV - oldV) / oldV) * 100;
}
function fmt(oldV, newV, lowerIsBetter = true) {
  if (oldV == null || newV == null) return "      —";
  const d = pct(oldV, newV);
  const bad = lowerIsBetter ? d > 5 : d < -5;
  const good = lowerIsBetter ? d < -5 : d > 5;
  const mark = bad ? " ⚠️ " : good ? " ✅ " : "    ";
  return `${(d >= 0 ? "+" : "")}${d.toFixed(1)}%${mark}`;
}
const ms = (v) => (v == null ? "    —  " : `${v.toFixed(1)}ms`.padStart(8));

console.log(`\n  old: ${oldPath}`);
console.log(`  new: ${newPath}`);
console.log("  ───────────────────────────────────────────────────────────────");
console.log("  endpoint           old p95    new p95    Δ p95");
for (const n of NAMES) {
  const o = p95(a, n), c = p95(b, n);
  console.log(`  ${n.padEnd(16)} ${ms(o)}   ${ms(c)}   ${fmt(o, c, true)}`);
}
console.log("  ───────────────────────────────────────────────────────────────");
console.log(`  overall p95      ${ms(overall(a, "p(95)"))}   ${ms(overall(b, "p(95)"))}   ${fmt(overall(a, "p(95)"), overall(b, "p(95)"), true)}`);
console.log(`  overall p99      ${ms(overall(a, "p(99)"))}   ${ms(overall(b, "p(99)"))}   ${fmt(overall(a, "p(99)"), overall(b, "p(99)"), true)}`);
console.log(`  throughput      ${String((rps(a) ?? 0).toFixed(1)).padStart(7)}/s  ${String((rps(b) ?? 0).toFixed(1)).padStart(7)}/s   ${fmt(rps(a), rps(b), false)}`);
console.log("");
