import { describe, it, expect, vi, beforeEach } from "vitest";

const signUp = vi.fn();
const signInWithPassword = vi.fn();
const { adminDeleteUser, adminUpdateUserById } = vi.hoisted(() => ({ adminDeleteUser: vi.fn(), adminUpdateUserById: vi.fn() }));
vi.mock("../supabase.js", () => ({
  getSupabaseAnon: () => ({ auth: { signUp, signInWithPassword } }),
  getSupabase: () => ({ auth: { admin: { deleteUser: adminDeleteUser, updateUserById: adminUpdateUserById } } }),
}));

import { SupabaseAuthProvider } from "./supabase-provider.js";
const p = new SupabaseAuthProvider();

beforeEach(() => {
  signUp.mockReset(); signInWithPassword.mockReset();
  adminDeleteUser.mockReset().mockResolvedValue({ error: null });
  adminUpdateUserById.mockReset().mockResolvedValue({ error: null });
});

describe("SupabaseAuthProvider", () => {
  it("maps a no-session sign-up to confirmation_required", async () => {
    signUp.mockResolvedValue({ data: { session: null }, error: null });
    expect(await p.signUp("proj", "a@b.com", "pw")).toEqual({ status: "confirmation_required" });
  });
  it("maps an auto-confirmed sign-up to confirmed + authUserId", async () => {
    signUp.mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null });
    expect(await p.signUp("proj", "a@b.com", "pw")).toEqual({ status: "confirmed", authUserId: "u1" });
  });
  it("returns null from verifyCredentials on error", async () => {
    signInWithPassword.mockResolvedValue({ data: { user: null }, error: { message: "bad" } });
    expect(await p.verifyCredentials("proj", "a@b.com", "pw")).toBeNull();
  });
  it("returns the authUserId from verifyCredentials on success", async () => {
    signInWithPassword.mockResolvedValue({ data: { user: { id: "u9" } }, error: null });
    expect(await p.verifyCredentials("proj", "a@b.com", "pw")).toEqual({ authUserId: "u9" });
  });

  // The three account-deletion modes map to distinct GoTrue admin calls.
  it("deleteUser hard → admin.deleteUser(id)", async () => {
    await p.deleteUser("u1", "hard");
    expect(adminDeleteUser).toHaveBeenCalledWith("u1");
    expect(adminUpdateUserById).not.toHaveBeenCalled();
  });
  it("deleteUser soft → admin.deleteUser(id, true)", async () => {
    await p.deleteUser("u1", "soft");
    expect(adminDeleteUser).toHaveBeenCalledWith("u1", true);
  });
  it("deleteUser ban → admin.updateUserById(id, { ban_duration })", async () => {
    await p.deleteUser("u1", "ban");
    expect(adminUpdateUserById).toHaveBeenCalledWith("u1", { ban_duration: "876600h" });
    expect(adminDeleteUser).not.toHaveBeenCalled();
  });
  it("deleteUser throws when the admin API errors", async () => {
    adminDeleteUser.mockResolvedValue({ error: { message: "boom" } });
    await expect(p.deleteUser("u1", "hard")).rejects.toThrow();
  });
});
