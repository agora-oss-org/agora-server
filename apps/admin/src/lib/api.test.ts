import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { api, ApiError } from "./api.js";
import { setSession, getSession } from "../auth/session.js";

const PID = "11111111-1111-1111-1111-111111111111";

// A minimal Response factory (Node/jsdom both have Response + fetch globals).
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const isRefresh = (url: unknown) => String(url).includes("request-new-access-token");
const headersOf = (call: any) => (call?.[1]?.headers ?? {}) as Record<string, string>;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  setSession({ user: { id: "u1" } as any, accessToken: "access-1", refreshToken: "refresh-1", projectId: PID });
});

afterEach(() => {
  vi.unstubAllGlobals();
  setSession(null);
});

describe("api() request building", () => {
  it("prefixes /v7/:projectId and attaches the Bearer access token", async () => {
    fetchMock.mockResolvedValue(json(200, { ok: true }));
    const out = await api<{ ok: boolean }>("/reports/pending");

    expect(out).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain(`/v7/${PID}/reports/pending`);
    expect(headersOf(fetchMock.mock.calls[0]).authorization).toBe("Bearer access-1");
    expect(init.method).toBe("GET");
  });

  it("omits the Authorization header when auth:false", async () => {
    fetchMock.mockResolvedValue(json(200, {}));
    await api("/projects/lean", { auth: false });
    expect(headersOf(fetchMock.mock.calls[0]).authorization).toBeUndefined();
  });

  it("maps a non-2xx error envelope to a typed ApiError", async () => {
    fetchMock.mockResolvedValue(json(403, { error: "Operator required", code: "admin/operator-required", field: "x" }));
    await expect(api("/admin/config")).rejects.toMatchObject({
      name: "ApiError",
      status: 403,
      code: "admin/operator-required",
      field: "x",
    });
  });
});

describe("api() token refresh on 401", () => {
  it("rotates once on 401 and retries with the fresh token", async () => {
    let dataHits = 0;
    fetchMock.mockImplementation((url) => {
      if (isRefresh(url)) return Promise.resolve(json(200, { accessToken: "access-2", refreshToken: "refresh-2" }));
      dataHits++;
      return Promise.resolve(dataHits === 1 ? json(401, { code: "auth/expired", error: "expired" }) : json(200, { ok: true }));
    });

    const out = await api<{ ok: boolean }>("/reports/pending");
    expect(out).toEqual({ ok: true });

    // Exactly one refresh round-trip.
    expect(fetchMock.mock.calls.filter((c) => isRefresh(c[0]))).toHaveLength(1);
    // The retry carried the rotated token, and the session was updated.
    const retryCall = fetchMock.mock.calls.filter((c) => !isRefresh(c[0]))[1];
    expect(headersOf(retryCall).authorization).toBe("Bearer access-2");
    expect(getSession()?.accessToken).toBe("access-2");
    expect(getSession()?.refreshToken).toBe("refresh-2");
  });

  it("is single-flight: N concurrent 401s share ONE refresh round-trip", async () => {
    const refreshDef = deferred<Response>();
    let dataHits = 0;
    fetchMock.mockImplementation((url) => {
      if (isRefresh(url)) return refreshDef.promise; // stays pending until all three subscribe
      dataHits++;
      return Promise.resolve(dataHits <= 3 ? json(401, { code: "auth/expired", error: "e" }) : json(200, { ok: true }));
    });

    const all = Promise.all([api("/a"), api("/b"), api("/c")]);
    // Let the three initial 401s resolve and all subscribe to the shared refresh.
    await new Promise((r) => setTimeout(r, 0));
    refreshDef.resolve(json(200, { accessToken: "access-2", refreshToken: "refresh-2" }));
    const results = await all;

    expect(fetchMock.mock.calls.filter((c) => isRefresh(c[0]))).toHaveLength(1);
    results.forEach((r) => expect(r).toEqual({ ok: true }));
  });

  it("clears the session (forces re-login) when the refresh itself fails", async () => {
    fetchMock.mockImplementation((url) => {
      if (isRefresh(url)) return Promise.resolve(json(401, { code: "auth/refresh-reused", error: "reused" }));
      return Promise.resolve(json(401, { code: "auth/expired", error: "expired" }));
    });

    await expect(api("/reports/pending")).rejects.toBeInstanceOf(ApiError);
    expect(getSession()).toBeNull();
  });

  it("does not attempt a refresh on a 401 when auth:false", async () => {
    fetchMock.mockResolvedValue(json(401, { code: "auth/expired", error: "expired" }));
    await expect(api("/x", { auth: false })).rejects.toMatchObject({ status: 401 });
    expect(fetchMock.mock.calls.some((c) => isRefresh(c[0]))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry
  });
});
