// Baseline orchestrator: (re)seed the fixture → run k6 → save a timestamped, git-stamped summary
// under perf/baselines/ for tracking latency/throughput as the API evolves. See perf/README.md.
//
//   pnpm perf:baseline                 # seed + run, default 50 VUs / 2m steady
//   PERF_VUS=100 PERF_DURATION=3m pnpm perf:baseline
//   pnpm perf:baseline -- --no-seed    # reuse the existing .fixture.json (skip re-seeding)
import "dotenv/config";
import { spawnSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const noSeed = process.argv.includes("--no-seed");

// k6 is a standalone Go binary — we detect, never auto-install.
if (spawnSync("k6", ["version"], { stdio: "ignore" }).status !== 0) {
  console.error("✗ k6 is not installed. Install it, then re-run:");
  console.error("    macOS:  brew install k6");
  console.error("    other:  https://grafana.com/docs/k6/latest/set-up/install-k6/");
  process.exit(1);
}

// 1. Seed (unless reusing the existing fixture).
if (!noSeed) {
  const seed = spawnSync("node", [join(HERE, "seed-perf-data.mjs")], { stdio: "inherit" });
  if (seed.status !== 0) process.exit(seed.status ?? 1);
} else if (!existsSync(join(HERE, ".fixture.json"))) {
  console.error("✗ --no-seed given but perf/.fixture.json is missing. Run without --no-seed first.");
  process.exit(1);
}

// 2. Build a stable, descriptive summary filename: <ISO-date>T<HHMM>-<gitsha>[-dirty].json
const now = new Date();
const stamp = `${now.toISOString().slice(0, 10)}T${pad(now.getHours())}${pad(now.getMinutes())}`;
const sha = safe(() => execSync("git rev-parse --short HEAD").toString().trim()) || "nogit";
const dirty = safe(() => execSync("git status --porcelain").toString().trim()) ? "-dirty" : "";
const summary = join(HERE, "baselines", `${stamp}-${sha}${dirty}.json`);

// 3. Run k6 against the seeded corpus.
const k6 = spawnSync("k6", ["run", join(HERE, "scenario.js")], {
  stdio: "inherit",
  env: { ...process.env, PERF_SUMMARY: summary },
});

console.log(`\n📊 baseline summary saved → ${summary}`);
console.log("   Commit it to track regressions: git add perf/baselines/ && git commit");
console.log("   Compare two runs: node perf/compare.mjs <old.json> <new.json>");
process.exit(k6.status ?? 0);

function pad(n) { return String(n).padStart(2, "0"); }
function safe(fn) { try { return fn(); } catch { return ""; } }
