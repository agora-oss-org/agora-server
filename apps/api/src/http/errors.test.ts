import { describe, it, expect } from "vitest";
import { ApiError, Errors } from "./errors.js";

describe("Errors factories", () => {
  it("badRequest carries status, code, message, and field", () => {
    const e = Errors.badRequest("entities/invalid-body", "bad", "title");
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 400, code: "entities/invalid-body", message: "bad", field: "title" });
  });

  it("uses sensible default codes per status", () => {
    expect(Errors.unauthorized()).toMatchObject({ status: 401, code: "auth/unauthorized" });
    expect(Errors.forbidden()).toMatchObject({ status: 403, code: "auth/forbidden" });
    expect(Errors.notFound()).toMatchObject({ status: 404, code: "common/not-found" });
    expect(Errors.rateLimited()).toMatchObject({ status: 429, code: "common/rate-limited" });
  });

  it("conflict and notImplemented map to their statuses", () => {
    expect(Errors.conflict("x/dup", "exists")).toMatchObject({ status: 409, code: "x/dup" });
    expect(Errors.notImplemented().status).toBe(501);
  });

  it("ApiError is a real Error (throwable, has message)", () => {
    const e = Errors.notFound("entities/not-found", "Entity not found");
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe("Entity not found");
  });
});
