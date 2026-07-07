import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { rerankCandidates, type RerankCandidate } from "./rerank.js";
import type { RerankWebhookConfig } from "./feed-config.js";

const cfg: RerankWebhookConfig = { url: "https://host.test/rerank", secret: "sekret", timeoutMs: 1000, overFetch: 0 };
const cands = (...ids: string[]): RerankCandidate[] => ids.map((id) => ({ id, signals: {} }));
const hmac = (secret: string, msg: string) => crypto.createHmac("sha256", secret).update(msg).digest("hex");

// Build a fetch Response. `sig` optionally attaches an X-Response-Signature over the raw body
// (signed with `sigSecret`, defaulting to the config secret → a valid signature).
function reply(
  obj: unknown,
  { ok = true, status = 200, sig = false, sigSecret = cfg.secret }: { ok?: boolean; status?: number; sig?: boolean; sigSecret?: string } = {},
): Response {
  const raw = typeof obj === "string" ? obj : JSON.stringify(obj);
  const headers = new Headers();
  if (sig) headers.set("X-Response-Signature", hmac(sigSecret, raw));
  return new Response(raw, { status: ok ? status : 500, headers });
}

const stubFetch = (res: Response | Error) => {
  const fn = res instanceof Error ? vi.fn().mockRejectedValue(res) : vi.fn().mockResolvedValue(res);
  vi.stubGlobal("fetch", fn);
  return fn;
};

afterEach(() => vi.unstubAllGlobals());

describe("rerankCandidates — short-circuit", () => {
  it("returns null without calling the webhook when there are no candidates", async () => {
    const fetchMock = stubFetch(new Response("{}"));
    expect(await rerankCandidates("p", cfg, [])).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs a signed feed.rerank envelope to the configured url", async () => {
    const fetchMock = stubFetch(reply({ order: ["a"] }));
    await rerankCandidates("p", cfg, cands("a"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(cfg.url);
    expect(init.method).toBe("POST");
    expect(init.headers["X-Signature"]).toBe(hmac(cfg.secret, `${init.headers["X-Timestamp"]}.${init.body}`));
    expect(JSON.parse(init.body)).toMatchObject({ type: "feed.rerank", projectId: "p", stage: "rerank" });
  });
});

describe("rerankCandidates — { order } responses", () => {
  it("applies a full reordering", async () => {
    stubFetch(reply({ order: ["c", "a", "b"] }));
    expect(await rerankCandidates("p", cfg, cands("a", "b", "c"))).toEqual(["c", "a", "b"]);
  });

  it("drops unknown ids, dedupes, and appends omitted candidates in stable order", async () => {
    stubFetch(reply({ order: ["c", "x", "c", "a"] })); // x unknown, c duplicated, b omitted
    expect(await rerankCandidates("p", cfg, cands("a", "b", "c"))).toEqual(["c", "a", "b"]);
  });

  it("ignores non-string entries in the order array", async () => {
    stubFetch(reply({ order: ["b", 3, null, "a"] }));
    expect(await rerankCandidates("p", cfg, cands("a", "b", "c"))).toEqual(["b", "a", "c"]);
  });
});

describe("rerankCandidates — { scores } responses", () => {
  it("orders by score descending, keeping only known + finite scores", async () => {
    stubFetch(reply({ scores: { a: 1, b: 3, c: 2, zzz: 9 } })); // zzz unknown → dropped
    expect(await rerankCandidates("p", cfg, cands("a", "b", "c"))).toEqual(["b", "c", "a"]);
  });

  it("appends candidates the webhook omitted from scores", async () => {
    stubFetch(reply({ scores: { b: 3 } }));
    expect(await rerankCandidates("p", cfg, cands("a", "b", "c"))).toEqual(["b", "a", "c"]);
  });

  it("drops non-finite scores", async () => {
    stubFetch(reply({ scores: { a: "foo", b: 2 } }));
    expect(await rerankCandidates("p", cfg, cands("a", "b", "c"))).toEqual(["b", "a", "c"]);
  });
});

describe("rerankCandidates — fail-open paths (keep original order → null)", () => {
  it("returns null on a non-2xx response", async () => {
    stubFetch(reply({ order: ["c", "b", "a"] }, { ok: false }));
    expect(await rerankCandidates("p", cfg, cands("a", "b", "c"))).toBeNull();
  });

  it("accepts a correctly-signed response", async () => {
    stubFetch(reply({ order: ["b", "a"] }, { sig: true }));
    expect(await rerankCandidates("p", cfg, cands("a", "b"))).toEqual(["b", "a"]);
  });

  it("returns null when the response signature is present but wrong (tampered)", async () => {
    stubFetch(reply({ order: ["b", "a"] }, { sig: true, sigSecret: "attacker" }));
    expect(await rerankCandidates("p", cfg, cands("a", "b"))).toBeNull();
  });

  it("returns null on malformed JSON", async () => {
    stubFetch(reply("{ not json", {}));
    expect(await rerankCandidates("p", cfg, cands("a", "b"))).toBeNull();
  });

  it("returns null when the response has neither order nor scores", async () => {
    stubFetch(reply({ hello: "world" }));
    expect(await rerankCandidates("p", cfg, cands("a", "b"))).toBeNull();
  });

  it("returns null on a network/timeout error", async () => {
    stubFetch(new Error("AbortError: timeout"));
    expect(await rerankCandidates("p", cfg, cands("a", "b"))).toBeNull();
  });
});
