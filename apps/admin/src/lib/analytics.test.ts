// Umami tracking is loaded from the RUNTIME /config.js seam, not baked in at build time — so the
// thing worth testing is the gate: nothing is injected unless BOTH values are configured, the tag is
// built via DOM APIs (no markup injection), and it happens at most once.
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// config.ts reads import.meta.env at module load, so the values are mocked per-suite rather than
// driven through the real resolver (runtime-config.test.ts covers the resolver itself).
const mockConfig = vi.hoisted(() => ({ UMAMI_URL: "", UMAMI_ID: "" }));
vi.mock("../config", () => mockConfig);

const { initAnalytics, track, resetAnalyticsForTest } = await import("./analytics");

const ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

/** A minimal Document stand-in that records what got appended to <head>. */
function fakeDoc() {
  const appended: any[] = [];
  return {
    appended,
    createElement: () => ({ setAttribute(this: any, k: string, v: string) { (this.attrs ??= {})[k] = v; } }) as any,
    head: { appendChild: (el: any) => appended.push(el) },
  } as unknown as Document & { appended: any[] };
}

describe("initAnalytics", () => {
  beforeEach(() => {
    resetAnalyticsForTest();
    mockConfig.UMAMI_URL = "";
    mockConfig.UMAMI_ID = "";
  });

  it("injects nothing when neither value is configured", () => {
    const doc = fakeDoc();
    expect(initAnalytics(doc)).toBe(false);
    expect((doc as any).appended).toHaveLength(0);
  });

  it("injects nothing when only the URL is set", () => {
    mockConfig.UMAMI_URL = "https://umami.example.com";
    const doc = fakeDoc();
    expect(initAnalytics(doc)).toBe(false);
    expect((doc as any).appended).toHaveLength(0);
  });

  it("injects nothing when only the site id is set", () => {
    mockConfig.UMAMI_ID = ID;
    const doc = fakeDoc();
    expect(initAnalytics(doc)).toBe(false);
    expect((doc as any).appended).toHaveLength(0);
  });

  it("injects the tracking script when both are set, preserving a path prefix in data-host-url", () => {
    // A Umami mounted under a path prefix must keep it in data-host-url — the script's src origin
    // alone would drop it and every event would POST to the wrong path.
    mockConfig.UMAMI_URL = "https://host.example.com/umami";
    mockConfig.UMAMI_ID = ID;
    const doc = fakeDoc();
    expect(initAnalytics(doc)).toBe(true);
    const [el] = (doc as any).appended;
    expect(el.src).toBe("https://host.example.com/umami/script.js");
    expect(el.attrs["data-website-id"]).toBe(ID);
    expect(el.attrs["data-host-url"]).toBe("https://host.example.com/umami");
    expect(el.defer).toBe(true);
  });

  it("injects at most once even if called repeatedly", () => {
    mockConfig.UMAMI_URL = "https://umami.example.com";
    mockConfig.UMAMI_ID = ID;
    const doc = fakeDoc();
    expect(initAnalytics(doc)).toBe(true);
    expect(initAnalytics(doc)).toBe(false);
    expect((doc as any).appended).toHaveLength(1);
  });

  it("is a no-op without a document (SSR / non-browser)", () => {
    mockConfig.UMAMI_URL = "https://umami.example.com";
    mockConfig.UMAMI_ID = ID;
    // `null` is the explicit no-document signal — passing `undefined` would re-trigger the default
    // parameter and resolve to jsdom's real document, silently testing nothing.
    expect(initAnalytics(null)).toBe(false);
  });
});

describe("track", () => {
  afterEach(() => {
    delete (globalThis as any).window?.umami;
    vi.restoreAllMocks();
  });

  it("no-ops silently when the tracker never loaded", () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    (globalThis as any).window = {};
    expect(() => track("admin-login", { operator: true })).not.toThrow();
  });

  it("forwards the event and payload to window.umami", () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const spy = vi.fn();
    (globalThis as any).window = { umami: { track: spy } };
    track("admin-settings-save", { panel: "moderator" });
    expect(spy).toHaveBeenCalledWith("admin-settings-save", { panel: "moderator" });
  });

  it("swallows a throwing tracker so the UI is never affected", () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    (globalThis as any).window = { umami: { track: () => { throw new Error("blocked by adblock"); } } };
    expect(() => track("admin-logout")).not.toThrow();
  });
});
