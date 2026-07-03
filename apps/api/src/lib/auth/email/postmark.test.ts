import { afterEach, describe, expect, it, vi } from "vitest";
import { PostmarkEmailSender } from "./postmark.js";
import { ConsoleEmailSender, selectEmailSender, type EmailSender } from "./sender.js";

const CFG = { token: "tok-123", from: "noreply@agora-oss.org", stream: "outbound", apiBase: "https://api.postmarkapp.com" };

function mockFetch(res: Partial<Response> & { ok: boolean; status?: number }) {
  const fn = vi.fn().mockResolvedValue({ status: 200, text: async () => "", ...res } as Response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("selectEmailSender", () => {
  it("returns the test override even when a Postmark token is present", () => {
    const override: EmailSender = new ConsoleEmailSender();
    expect(selectEmailSender(CFG, override)).toBe(override);
  });

  it("returns the Postmark transport when a token is configured", () => {
    expect(selectEmailSender(CFG, null)).toBeInstanceOf(PostmarkEmailSender);
  });

  it("falls back to the console (log-only) sender when no token is set", () => {
    expect(selectEmailSender({ ...CFG, token: undefined }, null)).toBeInstanceOf(ConsoleEmailSender);
  });
});

describe("PostmarkEmailSender", () => {
  it("POSTs the confirmation to Postmark with the token header, from, stream, and link in both bodies", async () => {
    const fetchMock = mockFetch({ ok: true });
    await new PostmarkEmailSender(CFG).sendConfirmation("user@example.com", "https://app.example.com/verify?token=abc&x=1");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]! as [string, { method: string; headers: Record<string, string>; body: string }];
    expect(url).toBe("https://api.postmarkapp.com/email");
    expect(init.method).toBe("POST");
    expect(init.headers["X-Postmark-Server-Token"]).toBe("tok-123");

    const payload = JSON.parse(init.body);
    expect(payload.From).toBe("noreply@agora-oss.org");
    expect(payload.To).toBe("user@example.com");
    expect(payload.MessageStream).toBe("outbound");
    expect(payload.Subject).toMatch(/confirm/i);
    expect(payload.HtmlBody).toContain("verify?token=abc");
    expect(payload.TextBody).toContain("verify?token=abc");
    // The ampersand must be HTML-escaped in the markup so the link can't break out of the attribute.
    expect(payload.HtmlBody).toContain("&amp;x=1");
  });

  it("sends the account-deletion CODE (not a link) in the body", async () => {
    const fetchMock = mockFetch({ ok: true });
    await new PostmarkEmailSender(CFG).sendAccountDeletionCode("user@example.com", "492013");
    const payload = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    expect(payload.Subject).toMatch(/deletion/i);
    expect(payload.TextBody).toContain("492013");
    expect(payload.HtmlBody).toContain("492013");
  });

  it("throws when Postmark returns a non-2xx response", async () => {
    mockFetch({ ok: false, status: 422, text: async () => '{"ErrorCode":11,"Message":"unverified From"}' });
    await expect(new PostmarkEmailSender(CFG).sendConfirmation("u@example.com", "https://x")).rejects.toThrow(/422/);
  });

  it("throws when the request to Postmark fails at the network layer", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(new PostmarkEmailSender(CFG).sendPasswordReset("u@example.com", "https://x")).rejects.toThrow(/Postmark request failed/);
  });
});
