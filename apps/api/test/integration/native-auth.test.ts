import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { api, createProject, deleteProject, base } from "./helpers.js";
import { getDb } from "../../src/db/index.js";
import { projects, authCredentials } from "../../src/db/schema/index.js";
import { invalidateAuthProvider } from "../../src/lib/auth/index.js";
import { setEmailSender, type EmailSender } from "../../src/lib/auth/email/sender.js";

// Capture the raw token out of the emailed link (?token=...).
class Capturing implements EmailSender {
  confirmToken: string | null = null;
  resetToken: string | null = null;
  private tok(link: string) { return new URL(link).searchParams.get("token"); }
  async sendConfirmation(_to: string, link: string) { this.confirmToken = this.tok(link); }
  async sendPasswordReset(_to: string, link: string) { this.resetToken = this.tok(link); }
}

describe("native auth (integration)", () => {
  let projectId: string; let B: string; let mail: Capturing;
  const email = "alice@example.com"; const pw = "CorrectHorse9!";

  beforeAll(async () => {
    projectId = await createProject();
    await getDb().update(projects).set({ authProvider: "native" }).where(eq(projects.id, projectId));
    invalidateAuthProvider(projectId);
    mail = new Capturing();
    setEmailSender(mail);
    B = base(projectId);
  });
  afterAll(async () => { setEmailSender(null); if (projectId) await deleteProject(projectId); });

  it("sign-up returns confirmation_required and does not mint a session", async () => {
    const res = await api("POST", `${B}/auth/sign-up`, { body: { email, password: pw } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "confirmation_required" });
    expect(mail.confirmToken).toBeTruthy();
  });

  it("cannot sign in before confirming", async () => {
    const res = await api("POST", `${B}/auth/sign-in`, { body: { email, password: pw } });
    expect(res.status).toBe(401);
  });

  it("confirms email, then signs in for a real session", async () => {
    const verify = await api("POST", `${B}/auth/verify-email`, { body: { tokenHash: mail.confirmToken, type: "signup" } });
    expect(verify.status).toBe(200);
    const signIn = await api("POST", `${B}/auth/sign-in`, { body: { email, password: pw } });
    expect(signIn.status).toBe(200);
    expect(signIn.body.accessToken).toBeTruthy();
    expect(signIn.body.refreshToken).toBeTruthy();
    expect(signIn.body.user.email).toBe(email);
    // Derived from the email local-part (lib/profiles.ts defaultUsername) since sign-up didn't pass
    // one — the same derivation OAuth first-login now uses, so neither path leaves a user nameless.
    expect(signIn.body.user.username).toBe("alice");
  });

  it("rejects a wrong password", async () => {
    const res = await api("POST", `${B}/auth/sign-in`, { body: { email, password: "nope" } });
    expect(res.status).toBe(401);
  });

  it("duplicate sign-up stays confirmation_required and creates no second credential", async () => {
    const res = await api("POST", `${B}/auth/sign-up`, { body: { email, password: "Another9!" } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "confirmation_required" });
    const rows = await getDb().select({ id: authCredentials.id }).from(authCredentials)
      .where(and(eq(authCredentials.projectId, projectId), eq(authCredentials.email, email)));
    expect(rows).toHaveLength(1);
  });

  it("rejects a confirm token reused a second time (single-use)", async () => {
    const res = await api("POST", `${B}/auth/verify-email`, { body: { tokenHash: mail.confirmToken, type: "signup" } });
    expect(res.status).toBe(400);
  });

  it("resets the password end-to-end; old password stops working", async () => {
    const req = await api("POST", `${B}/auth/request-password-reset`, { body: { email } });
    expect(req.status).toBe(200);
    expect(mail.resetToken).toBeTruthy();
    const reset = await api("POST", `${B}/auth/reset-password`, { body: { token: mail.resetToken, newPassword: "BrandNew9!" } });
    expect(reset.status).toBe(200);
    expect((await api("POST", `${B}/auth/sign-in`, { body: { email, password: "BrandNew9!" } })).status).toBe(200);
    expect((await api("POST", `${B}/auth/sign-in`, { body: { email, password: pw } })).status).toBe(401);
  });

  it("isolates tokens across tenants (a token cannot confirm under another project)", async () => {
    const other = await createProject();
    try {
      await getDb().update(projects).set({ authProvider: "native" }).where(eq(projects.id, other));
      invalidateAuthProvider(other);
      const su = await api("POST", `${base(other)}/auth/sign-up`, { body: { email: "bob@example.com", password: pw } });
      expect(su.status).toBe(200);
      const otherToken = mail.confirmToken; // captured from bob's sign-up
      const cross = await api("POST", `${B}/auth/verify-email`, { body: { tokenHash: otherToken, type: "signup" } });
      expect(cross.status).toBe(400);
    } finally { await deleteProject(other); }
  });
});
