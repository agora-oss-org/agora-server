// Shared admin-credential resolver for the seed flow. ONE place resolves the admin email + password —
// from env (ADMIN_* / DEMO_*) or an interactive prompt — so the value is decided ONCE and can be
// propagated to every child seeder. Both the `00-seed-auth-admin.mjs` master and the `seed.mjs`
// orchestrator import this; the orchestrator resolves up front and injects `credsEnv(...)` into each
// child's env, so a password TYPED at the prompt reaches the post-seeders that sign in as the admin
// (they read DEMO_EMAIL / DEMO_PASSWORD). Previously the prompt lived only inside the `00` CHILD, whose
// in-memory password could never flow back up to its parent or across to its siblings — so a custom
// password silently broke every post-seeder, which fell back to the hardcoded demo default (401).
//
// `resolveAdminCreds` is dependency-injected (env, ask, log, warn) so its branching is unit-testable
// with no TTY — see resolve-admin-creds.test.mjs. It THROWS on invalid input; callers decide how to
// fail (print + exit).
import readline from "node:readline";

export const DEMO_EMAIL = "agora-admin@agora-oss.org";
export const DEMO_PASSWORD = "DemoPass123!";

// Prompt on the TTY. The query label is always shown; with { hidden: true } the typed keystrokes that
// FOLLOW are not echoed (password entry — the visible default hint stays, the secret you type doesn't).
// Returns the trimmed line; rejects when there's no interactive terminal (caller falls back to a default).
export function ask(query, { hidden = false } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return Promise.reject(new Error("no TTY"));
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = (str) => {
      if (!muted) rl.output.write(str);
    };
    rl.question(query, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
    if (hidden) muted = true;
  });
}

/**
 * Resolve the admin email + password ONCE. Env wins over the prompt (so a non-interactive/CI run never
 * blocks): email from ADMIN_EMAIL || DEMO_EMAIL, password from ADMIN_PASSWORD || DEMO_PASSWORD. When
 * neither is set it prompts — Enter at the password prompt accepts the known demo default (with a
 * warning); a typed password is hidden and confirmed twice. Throws on invalid input (bad email, mismatch,
 * too-short password). Injectable deps make it TTY-free testable.
 *
 * @returns {Promise<{ email: string, password: string }>}
 */
export async function resolveAdminCreds({ env = process.env, ask: askFn = ask, log = console.log, warn = console.warn } = {}) {
  // Email: ADMIN_EMAIL / DEMO_EMAIL env wins; else prompt (empty = demo default).
  let email = (env.ADMIN_EMAIL || env.DEMO_EMAIL)?.trim().toLowerCase();
  if (!email) {
    email = (await askFn(`Admin email [${DEMO_EMAIL}]: `).catch(() => "")) || DEMO_EMAIL;
    email = email.toLowerCase();
  }
  if (!email.includes("@")) throw new Error("A valid email is required.");

  // Password: ADMIN_PASSWORD / DEMO_PASSWORD env wins; else prompt. Enter = demo default (hint shown);
  // a typed password is hidden (echo off) and confirmed twice (guard against a typo).
  let password = env.ADMIN_PASSWORD || env.DEMO_PASSWORD;
  if (!password) {
    const typed = await askFn(`Admin password [${DEMO_PASSWORD}]: `, { hidden: true }).catch(() => "");
    if (!typed) {
      password = DEMO_PASSWORD;
      warn("⚠ using the known demo password — change it for any non-demo deployment.");
    } else {
      const confirm = await askFn("Confirm password: ", { hidden: true }).catch(() => "");
      if (typed !== confirm) throw new Error("Passwords don't match.");
      password = typed;
    }
  }
  if (password.length < 8) throw new Error("Password must be at least 8 characters.");

  return { email, password };
}

/**
 * The propagation contract: map resolved creds onto the FOUR env vars downstream seeders read. Native
 * reads ADMIN_*, the Supabase helper + every post-seeder read DEMO_*, so both name pairs are set. Spread
 * over a base env to hand a child the resolved credential:
 *   spawnSync(node, [seeder], { env: { ...process.env, ...credsEnv(creds) } })
 */
export function credsEnv({ email, password }) {
  return { ADMIN_EMAIL: email, ADMIN_PASSWORD: password, DEMO_EMAIL: email, DEMO_PASSWORD: password };
}
