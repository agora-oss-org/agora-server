// Demo-data GATE — asks whether to seed the demo CONTENT (sample posts, comments, images), and if not,
// halts the rest of the `seed.mjs` run. Everything BEFORE this (the 00- admin login) has already run;
// everything AFTER it (03-seed-engine, 04-seed-homepage-comments, the seed-*-post fixtures) is demo
// content this gate guards.
//
// Contract with the orchestrator: exit 0 → proceed (run the remaining seeders); exit 78 → a clean
// "no", which seed.mjs recognizes as STOP and breaks the loop (the remaining seeders are skipped). 78
// is a sentinel — distinct from a real failure (non-zero ≠ 78) so a broken seeder still gets the
// normal continue/abort handling, not silently confused with an opt-out.
//
//   node scripts/seeds/01-confirm-demo-data.mjs      # prompts [Y/n] on a TTY
//   SEED_DEMO_DATA=1 (or yes/true)  → proceed without prompting (CI)
//   SEED_DEMO_DATA=0 (or no/false)  → decline without prompting  (admin-only seed)
// Non-interactive with no env set defaults to PROCEED, preserving the historical `pnpm seed` behavior.
import readline from "node:readline";

const STOP_CODE = 78; // keep in sync with seed.mjs

function ask(query) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

let proceed;
const env = process.env.SEED_DEMO_DATA?.trim().toLowerCase();
if (env) {
  proceed = ["1", "true", "yes", "y"].includes(env);
} else if (process.stdin.isTTY && process.stdout.isTTY) {
  const answer = await ask("Seed demo content now (sample posts, comments, images)? [Y/n]: ");
  proceed = !/^n/i.test(answer); // default = yes
} else {
  proceed = true; // non-interactive, no preference set → proceed (back-compat)
}

if (proceed) {
  console.log("✓ demo data: proceeding with the content seeders.");
  process.exit(0);
}
console.log("↷ demo data: declined — skipping the remaining content seeders (the admin login is already seeded).");
process.exit(STOP_CODE);
