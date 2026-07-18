import { describe, it, expect, vi } from "vitest";
import { resolveAdminCreds, credsEnv, DEMO_EMAIL, DEMO_PASSWORD } from "./resolve-admin-creds.mjs";

// A stub `ask` that returns a scripted sequence of answers (one per prompt call), so the resolver's
// branching can be exercised with no TTY. Records the queries it was asked, so a test can assert a
// prompt was (or was NOT) shown.
function scriptedAsk(answers) {
  const queries = [];
  const seq = [...answers];
  const ask = (query) => {
    queries.push(query);
    return Promise.resolve(seq.shift() ?? "");
  };
  ask.queries = queries;
  return ask;
}

const silent = { log: () => {}, warn: () => {} };
// A valid email in env so the password-focused tests don't consume a scripted answer on the email prompt.
const withEmail = (extra = {}) => ({ ADMIN_EMAIL: "admin@example.com", ...extra });

describe("resolveAdminCreds — password resolution", () => {
  // THE BUG: a custom password TYPED at the prompt must be the one returned — not silently replaced by
  // the demo default. Regression guard for the seed-cred-propagation fix.
  it("returns the custom typed password (confirmed), not the demo default", async () => {
    const ask = scriptedAsk(["s3cret-pw-typed", "s3cret-pw-typed"]); // password + confirm
    const { password } = await resolveAdminCreds({ env: withEmail(), ask, ...silent });
    expect(password).toBe("s3cret-pw-typed");
    expect(password).not.toBe(DEMO_PASSWORD);
  });

  it("uses the demo default (with a warning) when the password prompt is left empty", async () => {
    const warn = vi.fn();
    const ask = scriptedAsk([""]); // press Enter at the password prompt
    const { password } = await resolveAdminCreds({ env: withEmail(), ask, log: () => {}, warn });
    expect(password).toBe(DEMO_PASSWORD);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("throws when the typed password and its confirmation differ", async () => {
    const ask = scriptedAsk(["typed-one-here", "typed-two-here"]);
    await expect(resolveAdminCreds({ env: withEmail(), ask, ...silent })).rejects.toThrow(/don't match/i);
  });

  it("prefers ADMIN_PASSWORD / DEMO_PASSWORD from env and never prompts", async () => {
    const ask = scriptedAsk(["should-not-be-read", "should-not-be-read"]);
    const fromAdmin = await resolveAdminCreds({ env: withEmail({ ADMIN_PASSWORD: "env-admin-pw-8" }), ask, ...silent });
    expect(fromAdmin.password).toBe("env-admin-pw-8");
    const fromDemo = await resolveAdminCreds({ env: withEmail({ DEMO_PASSWORD: "env-demo-pw-88" }), ask, ...silent });
    expect(fromDemo.password).toBe("env-demo-pw-88");
    expect(ask.queries).toHaveLength(0); // no password prompt at all
  });

  it("rejects a too-short password", async () => {
    const ask = scriptedAsk(["short", "short"]);
    await expect(resolveAdminCreds({ env: withEmail(), ask, ...silent })).rejects.toThrow(/at least 8/i);
  });
});

describe("resolveAdminCreds — email resolution", () => {
  it("uses ADMIN_EMAIL / DEMO_EMAIL from env, lowercased, without prompting", async () => {
    const ask = scriptedAsk([]);
    const { email } = await resolveAdminCreds({
      env: { ADMIN_EMAIL: "Owner@Example.COM", ADMIN_PASSWORD: "env-admin-pw-8" },
      ask,
      ...silent,
    });
    expect(email).toBe("owner@example.com");
    expect(ask.queries).toHaveLength(0);
  });

  it("falls back to the demo email when the email prompt is left empty", async () => {
    const ask = scriptedAsk(["", ""]); // empty email → default, then empty password → default
    const { email } = await resolveAdminCreds({ env: {}, ask, ...silent });
    expect(email).toBe(DEMO_EMAIL);
  });

  it("throws on an email with no @", async () => {
    const ask = scriptedAsk(["not-an-email"]);
    await expect(resolveAdminCreds({ env: {}, ask, ...silent })).rejects.toThrow(/valid email/i);
  });
});

describe("credsEnv — propagation contract", () => {
  // The fix's essence: resolved creds map onto the FOUR env vars every downstream seeder reads, so a
  // custom password reaches the post-seeders that sign in as the admin.
  it("maps resolved creds onto ADMIN_* and DEMO_* so downstream seeders inherit them", () => {
    const env = credsEnv({ email: "owner@example.com", password: "s3cret-pw-typed" });
    expect(env).toEqual({
      ADMIN_EMAIL: "owner@example.com",
      ADMIN_PASSWORD: "s3cret-pw-typed",
      DEMO_EMAIL: "owner@example.com",
      DEMO_PASSWORD: "s3cret-pw-typed",
    });
  });

  it("gives the post-seeder default (DEMO_PASSWORD) the custom password, not the hardcoded fallback", () => {
    // seed-*-post.mjs read: process.env.DEMO_PASSWORD || "DemoPass123!"
    const env = credsEnv({ email: DEMO_EMAIL, password: "s3cret-pw-typed" });
    const seederPassword = env.DEMO_PASSWORD || "DemoPass123!";
    expect(seederPassword).toBe("s3cret-pw-typed");
  });
});
