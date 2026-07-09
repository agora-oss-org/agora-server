import { describe, it, expect, vi } from "vitest";
import { dispatchToDevices, pickProvider, notificationPushPayload } from "./dispatch.js";
import type { PushProvider } from "./provider.js";

const mk = (res: { ok: boolean; prune?: boolean }): PushProvider => ({ send: vi.fn().mockResolvedValue(res) });

describe("pickProvider", () => {
  it("routes a platform to its provider, null when absent", () => {
    const web = mk({ ok: true });
    const providers = { ios: null, android: null, web } as any;
    expect(pickProvider("web", providers)).toBe(web);
    expect(pickProvider("ios", providers)).toBeNull();
  });
});

describe("dispatchToDevices", () => {
  it("sends to every device via its provider and prunes flagged ones", async () => {
    const web = mk({ ok: true });
    const ios = mk({ ok: false, prune: true });
    const providers = { ios, android: null, web } as any;
    const prune = vi.fn().mockResolvedValue(undefined);
    const devices = [
      { id: "d1", platform: "web", token: null, subscription: {} },
      { id: "d2", platform: "ios", token: "t", subscription: null },
      { id: "d3", platform: "android", token: "t", subscription: null }, // no provider → skipped
    ];
    const out = await dispatchToDevices(devices as any, { title: "x", body: "y" }, providers, prune);
    expect(web.send).toHaveBeenCalledTimes(1);
    expect(ios.send).toHaveBeenCalledTimes(1);
    expect(out.sent).toBe(1);              // only the web send was ok
    expect(out.pruned).toBe(1);            // the ios device was pruned
    expect(prune).toHaveBeenCalledWith("d2");
  });

  it("isolates provider failures — a throwing provider doesn't abort siblings", async () => {
    const ios = { send: vi.fn().mockRejectedValue(new Error("boom")) };
    const web = mk({ ok: true });
    const providers = { ios, android: null, web } as any;
    const prune = vi.fn().mockResolvedValue(undefined);
    const devices = [
      { id: "d1", platform: "ios", token: "t", subscription: null },
      { id: "d2", platform: "web", token: null, subscription: {} },
    ];
    const out = await dispatchToDevices(devices as any, { title: "x", body: "y" }, providers, prune);
    expect(ios.send).toHaveBeenCalledTimes(1);   // first provider threw
    expect(web.send).toHaveBeenCalledTimes(1);   // sibling was still called
    expect(out.sent).toBe(1);    // only the web send succeeded
    expect(out.pruned).toBe(0);  // no prunes
  });

  it("handles prune failures distinctly from send failures", async () => {
    const web = { send: vi.fn().mockResolvedValue({ ok: true, prune: true }) };
    const providers = { ios: null, android: null, web } as any;
    const prune = vi.fn().mockRejectedValue(new Error("prune failed"));
    const devices = [
      { id: "d1", platform: "web", token: null, subscription: {} },
    ];
    const out = await dispatchToDevices(devices as any, { title: "x", body: "y" }, providers, prune);
    expect(web.send).toHaveBeenCalledTimes(1);  // send succeeded
    expect(out.sent).toBe(1);     // send still counted
    expect(out.pruned).toBe(0);   // prune failure doesn't count
    expect(prune).toHaveBeenCalledWith("d1");
  });
});

describe("notificationPushPayload", () => {
  it("produces a PII-free payload for a push-worthy type, keyed by type", () => {
    const p = notificationPushPayload("entity-comment");
    expect(p).not.toBeNull();
    expect(p!.title).toBe("New comment");
    expect(p!.body).toBe("Open the app to see what's new.");
    expect(p!.data).toEqual({ type: "entity-comment" });
  });
  it("uses the corrected new-follow key (not 'follow')", () => {
    expect(notificationPushPayload("new-follow")!.title).toBe("New follower");
    expect(notificationPushPayload("follow")).toBeNull(); // not a real type → not push-worthy
  });
  it("returns null for SILENT (in-app-only) types — reactions, milestones, AND steward events", () => {
    for (const t of [
      "entity-upvote", "comment-upvote", "entity-reaction", "comment-reaction",
      "entity-reaction-milestone-specific", "comment-reaction-milestone-total",
      // steward events are deliberately push-silent — never surface a case on a lock screen
      "steward-case-opened", "steward-case-in-mediation", "steward-case-resolved",
      "steward-content-removed", "steward-mediation-invite",
    ]) expect(notificationPushPayload(t)).toBeNull();
  });
  it("produces a payload for the chat 'message' type", () => {
    expect(notificationPushPayload("message")).toEqual({
      title: "New message",
      body: "Open the app to see what's new.",
      data: { type: "message" },
    });
  });
});
