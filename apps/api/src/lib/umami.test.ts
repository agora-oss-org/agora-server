import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// env.ts parses process.env at import time, so each case sets the AGORA_UMAMI_* vars, resets the
// module registry, and dynamically re-imports umami.js to pick up a fresh `env`. fetch is stubbed.
const ORIGINAL_ENV = { ...process.env };
const UMAMI_KEYS = ["AGORA_UMAMI_URL", "AGORA_UMAMI_SERVER_ID", "AGORA_UMAMI_HOSTNAME", "AGORA_UMAMI_API_KEY", "AGORA_UMAMI_SEND_PATH"] as const;

async function loadTrackEvent(umamiEnv: Partial<Record<(typeof UMAMI_KEYS)[number], string>>) {
  vi.resetModules();
  for (const k of UMAMI_KEYS) delete process.env[k];
  Object.assign(process.env, umamiEnv);
  return (await import("./umami.js")).trackEvent;
}

// Flush the fire-and-forget async IIFE so the stubbed fetch has run.
const flush = () => new Promise((r) => setImmediate(r));

describe("trackEvent (umami)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL_ENV };
  });

  it("is a no-op when unconfigured (no fetch)", async () => {
    const trackEvent = await loadTrackEvent({}); // none of the umami vars set
    trackEvent("entity-created", { projectId: "p1" });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is a no-op when only partially configured", async () => {
    const trackEvent = await loadTrackEvent({ AGORA_UMAMI_URL: "https://umami.example.com" }); // no ID/hostname
    trackEvent("entity-created", { projectId: "p1" });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts a well-formed event to /api/send with a User-Agent when configured", async () => {
    const trackEvent = await loadTrackEvent({
      AGORA_UMAMI_URL: "https://umami.example.com",
      AGORA_UMAMI_SERVER_ID: "site-123",
      AGORA_UMAMI_HOSTNAME: "agora.example.com",
    });
    trackEvent("entity-created", { projectId: "p1", spaceId: "s1" });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://umami.example.com/api/send");
    expect(init.method).toBe("POST");
    expect(init.headers["user-agent"]).toBeTruthy(); // Umami drops events with no UA
    expect(init.headers["x-umami-api-key"]).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({
      type: "event",
      payload: {
        website: "site-123",
        hostname: "agora.example.com",
        name: "entity-created",
        url: "/api/entity-created",
        data: { projectId: "p1", spaceId: "s1" },
      },
    });
  });

  it("preserves a path-prefixed base URL (consolidated /umami mount)", async () => {
    const trackEvent = await loadTrackEvent({
      AGORA_UMAMI_URL: "https://agora-oss.org/umami",
      AGORA_UMAMI_SERVER_ID: "site-123",
      AGORA_UMAMI_HOSTNAME: "agora-oss.org",
    });
    trackEvent("entity-created", { projectId: "p1" });
    await flush();
    // /umami prefix must survive — concatenation, not new URL(absolutePath, base).
    expect(fetchMock.mock.calls[0]![0]).toBe("https://agora-oss.org/umami/api/send");
  });

  it("honors a remapped AGORA_UMAMI_SEND_PATH", async () => {
    const trackEvent = await loadTrackEvent({
      AGORA_UMAMI_URL: "https://agora-oss.org",
      AGORA_UMAMI_SERVER_ID: "site-123",
      AGORA_UMAMI_HOSTNAME: "agora-oss.org",
      AGORA_UMAMI_SEND_PATH: "/v7/send",
    });
    trackEvent("entity-created", { projectId: "p1" });
    await flush();
    expect(fetchMock.mock.calls[0]![0]).toBe("https://agora-oss.org/v7/send");
  });

  it("includes the x-umami-api-key header when the key is set", async () => {
    const trackEvent = await loadTrackEvent({
      AGORA_UMAMI_URL: "https://umami.example.com",
      AGORA_UMAMI_SERVER_ID: "site-123",
      AGORA_UMAMI_HOSTNAME: "agora.example.com",
      AGORA_UMAMI_API_KEY: "secret-key",
    });
    trackEvent("user-signup", { projectId: "p1" });
    await flush();
    expect(fetchMock.mock.calls[0]![1].headers["x-umami-api-key"]).toBe("secret-key");
  });

  it("never throws out of trackEvent when fetch rejects", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const trackEvent = await loadTrackEvent({
      AGORA_UMAMI_URL: "https://umami.example.com",
      AGORA_UMAMI_SERVER_ID: "site-123",
      AGORA_UMAMI_HOSTNAME: "agora.example.com",
    });
    expect(() => trackEvent("search", { projectId: "p1", kind: "content" })).not.toThrow();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
