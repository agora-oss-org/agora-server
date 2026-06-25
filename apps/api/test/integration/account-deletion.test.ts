// Self-service account deletion (native auth) — SDK useRequestAccountDeletion + confirmAccountDeletion.
// Flow: request emails a confirmation CODE → confirm with the code hard-deletes the identity (profile
// row + native credential). Authored content is NOT deleted — it's set-null'd (community property), so
// threads others replied to survive. RED until the two endpoints + the provider methods exist.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { api, createProject, deleteProject, base } from "./helpers.js";
import { db } from "../../src/db/index.js";
import { projects, profiles, authCredentials, entities } from "../../src/db/schema/index.js";
import { invalidateAuthProvider } from "../../src/lib/auth/index.js";
import { setEmailSender, type EmailSender } from "../../src/lib/auth/email/sender.js";

class Capturing implements EmailSender {
  confirmToken: string | null = null;
  deletionCode: string | null = null;
  private tok(link: string) { return new URL(link).searchParams.get("token"); }
  async sendConfirmation(_to: string, link: string) { this.confirmToken = this.tok(link); }
  async sendPasswordReset(_to: string, _link: string) {}
  async sendAccountDeletionCode(_to: string, code: string) { this.deletionCode = code; }
}

describe("account deletion — native auth (integration)", () => {
  let projectId: string; let B: string; let mail: Capturing;
  let token: string; let userId: string; let credentialId: string; let entityId: string;
  const email = "deleteme@example.com"; const pw = "CorrectHorse9!";

  beforeAll(async () => {
    projectId = await createProject();
    await db.update(projects).set({ authProvider: "native" }).where(eq(projects.id, projectId));
    invalidateAuthProvider(projectId);
    mail = new Capturing();
    setEmailSender(mail);
    B = base(projectId);
    // sign up → confirm → sign in
    await api("POST", `${B}/auth/sign-up`, { body: { email, password: pw } });
    await api("POST", `${B}/auth/verify-email`, { body: { tokenHash: mail.confirmToken, type: "signup" } });
    const signIn = await api("POST", `${B}/auth/sign-in`, { body: { email, password: pw } });
    token = signIn.body.accessToken;
    userId = signIn.body.user.id;
    const [cred] = await db.select().from(authCredentials).where(eq(authCredentials.email, email)).limit(1);
    credentialId = cred!.id;
    // author content that must survive deletion as authorless
    entityId = (await api("POST", `${B}/entities`, { token, body: { title: "survives" } })).body.id;
  });
  afterAll(async () => { setEmailSender(null); if (projectId) await deleteProject(projectId); });

  it("request-account-deletion emails a code", async () => {
    const res = await api("POST", `${B}/auth/request-account-deletion`, { token, body: {} });
    expect(res.status).toBe(200);
    expect(mail.deletionCode).toBeTruthy();
  });

  it("rejects a wrong confirmation code", async () => {
    const res = await api("POST", `${B}/auth/confirm-account-deletion`, { token, body: { code: "not-the-code" } });
    expect(res.status).toBe(400);
    // still here
    const [p] = await db.select().from(profiles).where(eq(profiles.id, userId)).limit(1);
    expect(p).toBeTruthy();
  });

  it("confirm-account-deletion with the code hard-deletes the identity", async () => {
    const res = await api("POST", `${B}/auth/confirm-account-deletion`, { token, body: { code: mail.deletionCode } });
    expect(res.status).toBe(200);
    // profile + credential gone
    const [p] = await db.select().from(profiles).where(eq(profiles.id, userId)).limit(1);
    expect(p).toBeUndefined();
    const [cred] = await db.select().from(authCredentials).where(eq(authCredentials.id, credentialId)).limit(1);
    expect(cred).toBeUndefined();
  });

  it("can no longer sign in", async () => {
    const res = await api("POST", `${B}/auth/sign-in`, { body: { email, password: pw } });
    expect(res.status).toBe(401);
  });

  it("their authored content survives as authorless (community property)", async () => {
    const [e] = await db.select().from(entities)
      .where(and(eq(entities.id, entityId), isNull(entities.userId))).limit(1);
    expect(e).toBeTruthy();
    expect(e!.title).toBe("survives");
  });
});

describe("account deletion — soft mode (native)", () => {
  let projectId: string; let B: string; let mail: Capturing;
  let token: string; let userId: string; let credentialId: string;
  const email = "softdelete@example.com"; const pw = "CorrectHorse9!";

  beforeAll(async () => {
    projectId = await createProject();
    // mode = soft: disable the auth user, KEEP the profile (deactivated).
    await db.update(projects).set({ authProvider: "native", accountDeletionMode: "soft" }).where(eq(projects.id, projectId));
    invalidateAuthProvider(projectId);
    mail = new Capturing();
    setEmailSender(mail);
    B = base(projectId);
    await api("POST", `${B}/auth/sign-up`, { body: { email, password: pw } });
    await api("POST", `${B}/auth/verify-email`, { body: { tokenHash: mail.confirmToken, type: "signup" } });
    const signIn = await api("POST", `${B}/auth/sign-in`, { body: { email, password: pw } });
    token = signIn.body.accessToken; userId = signIn.body.user.id;
    credentialId = (await db.select().from(authCredentials).where(eq(authCredentials.email, email)).limit(1))[0]!.id;
  });
  afterAll(async () => { setEmailSender(null); if (projectId) await deleteProject(projectId); });

  it("soft delete: profile retained but deactivated, credential disabled, can't sign in", async () => {
    await api("POST", `${B}/auth/request-account-deletion`, { token, body: {} });
    const res = await api("POST", `${B}/auth/confirm-account-deletion`, { token, body: { code: mail.deletionCode } });
    expect(res.status).toBe(200);

    // profile kept, but is_active false
    const [p] = await db.select().from(profiles).where(eq(profiles.id, userId)).limit(1);
    expect(p).toBeTruthy();
    expect(p!.isActive).toBe(false);

    // credential kept but disabled
    const [cred] = await db.select().from(authCredentials).where(eq(authCredentials.id, credentialId)).limit(1);
    expect(cred).toBeTruthy();
    expect(cred!.disabledAt).toBeTruthy();

    // can't sign in
    const signIn = await api("POST", `${B}/auth/sign-in`, { body: { email, password: pw } });
    expect(signIn.status).toBe(401);
  });
});
