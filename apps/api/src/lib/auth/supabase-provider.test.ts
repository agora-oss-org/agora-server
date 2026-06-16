import { describe, it, expect, vi, beforeEach } from "vitest";

const signUp = vi.fn();
const signInWithPassword = vi.fn();
vi.mock("../supabase.js", () => ({
  getSupabaseAnon: () => ({ auth: { signUp, signInWithPassword } }),
  getSupabase: () => ({ auth: { admin: { updateUserById: vi.fn() } } }),
}));

import { SupabaseAuthProvider } from "./supabase-provider.js";
const p = new SupabaseAuthProvider();

beforeEach(() => { signUp.mockReset(); signInWithPassword.mockReset(); });

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
});
