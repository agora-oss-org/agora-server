// k6 load scenario for the Agora API — the baseline workload (perf/README.md).
//
// Models a realistic READ-heavy social-feed traffic mix against a fixed, pre-seeded corpus
// (perf/.fixture.json from seed-perf-data.mjs). Every request carries a seeded user's bearer token,
// so the authed hot path (token verify + per-request suspension check) is measured too.
//
// Run via `pnpm perf:baseline` (perf/run.mjs orchestrates seed → k6 → saved summary), or directly:
//   k6 run -e PERF_VUS=50 -e PERF_DURATION=2m perf/scenario.js
//
// Each request is tagged with a `name` so latency groups per ENDPOINT (not per URL) in the summary,
// and the per-name thresholds below both REPORT and GATE each endpoint. The thresholds ship permissive
// so the FIRST run establishes the baseline; tighten them to ~1.2× the observed p95 afterwards.
import http from "k6/http";
import { check } from "k6";

const fixture = JSON.parse(open("./.fixture.json"));
const BASE = `${fixture.baseUrl}/v7/${fixture.projectId}`;
const TOKENS = fixture.tokens;
const ENTITY_IDS = fixture.entityIds;
const THREAD_IDS = fixture.threadEntityIds;

const VUS = Number(__ENV.PERF_VUS || 50);
const DURATION = __ENV.PERF_DURATION || "2m";
const WARMUP = __ENV.PERF_WARMUP || "30s";

export const options = {
  // Warm up (JIT, pg pool fill, plan cache) then hold steady — the steady block is the baseline.
  scenarios: {
    warmup: { executor: "ramping-vus", startVUs: 0, gracefulStop: "5s",
      stages: [{ duration: WARMUP, target: Math.ceil(VUS / 3) }] },
    steady: { executor: "constant-vus", vus: VUS, duration: DURATION, startTime: WARMUP },
  },
  // Only the steady block counts toward pass/fail — abortOnFail off so a first over-budget run still
  // produces a full baseline summary. Tune these up after you have real numbers.
  thresholds: {
    "http_req_failed": ["rate<0.01"],
    "http_req_duration{name:feed}": ["p(95)<800"],
    "http_req_duration{name:entity}": ["p(95)<500"],
    "http_req_duration{name:comments}": ["p(95)<600"],
    "http_req_duration{name:thread}": ["p(95)<1000"],
    "http_req_duration{name:react}": ["p(95)<800"],
    "http_req_duration{name:comment_create}": ["p(95)<800"],
  },
};

const rnd = (n) => Math.floor(Math.random() * n);
const oneOf = (arr) => arr[rnd(arr.length)];
const authGet = (url, name) =>
  http.get(url, { headers: { Authorization: `Bearer ${oneOf(TOKENS)}` }, tags: { name } });
const authPost = (url, body, name) =>
  http.post(url, JSON.stringify(body), {
    headers: { Authorization: `Bearer ${oneOf(TOKENS)}`, "Content-Type": "application/json" },
    tags: { name },
  });

export default function () {
  const roll = Math.random();
  let res;
  if (roll < 0.45) {
    // Feed list — the dominant read. Page 1-5, default page size.
    res = authGet(`${BASE}/entities?page=${1 + rnd(5)}&limit=20`, "feed");
  } else if (roll < 0.65) {
    res = authGet(`${BASE}/entities/${oneOf(ENTITY_IDS)}`, "entity");
  } else if (roll < 0.80) {
    res = authGet(`${BASE}/comments?entityId=${oneOf(THREAD_IDS)}&limit=20`, "comments");
  } else if (roll < 0.90) {
    // Recursive comment thread — the heaviest read (fetch_comment_thread RPC).
    res = authGet(`${BASE}/comments/thread?entityId=${oneOf(THREAD_IDS)}`, "thread");
  } else if (roll < 0.95) {
    // Reaction toggle — write through toggle_reaction RPC + count trigger.
    res = authPost(`${BASE}/entities/${oneOf(ENTITY_IDS)}/reactions`, { reactionType: "like" }, "react");
  } else {
    // Comment create — write path with notification fan-out.
    res = authPost(`${BASE}/comments`,
      { entityId: oneOf(THREAD_IDS), content: `perf comment ${Date.now()}-${rnd(1e6)}` }, "comment_create");
  }
  check(res, { "status 2xx": (r) => r.status >= 200 && r.status < 300 });
}

// Replace k6's default stdout summary with a compact per-endpoint table + dump the full JSON to the
// path run.mjs passes (the committed baseline artifact). No network/jslib import → fully hermetic.
export function handleSummary(data) {
  const out = { stdout: briefSummary(data) };
  if (__ENV.PERF_SUMMARY) out[__ENV.PERF_SUMMARY] = JSON.stringify(data, null, 2);
  return out;
}

function briefSummary(data) {
  const names = ["feed", "entity", "comments", "thread", "react", "comment_create"];
  const ms = (v) => (v == null ? "   —  " : `${v.toFixed(1)}ms`.padStart(8));
  const m = (key) => data.metrics[key]?.values || {};
  const lines = [];
  lines.push("");
  lines.push("  Agora API — load-test baseline");
  lines.push("  ──────────────────────────────────────────────────────────");
  lines.push("  endpoint          p50      p95      p99");
  for (const n of names) {
    const v = m(`http_req_duration{name:${n}}`);
    lines.push(`  ${n.padEnd(15)} ${ms(v["p(50)"])} ${ms(v["p(95)"])} ${ms(v["p(99)"])}`);
  }
  const all = m("http_req_duration");
  const reqs = m("http_reqs");
  const failed = m("http_req_failed");
  lines.push("  ──────────────────────────────────────────────────────────");
  lines.push(`  overall p95 ${ms(all["p(95)"])}   p99 ${ms(all["p(99)"])}`);
  lines.push(`  throughput  ${(reqs.rate || 0).toFixed(1).padStart(7)} req/s   ` +
    `errors ${((failed.rate || 0) * 100).toFixed(2)}%   total ${reqs.count || 0} reqs`);
  lines.push("");
  return lines.join("\n");
}
