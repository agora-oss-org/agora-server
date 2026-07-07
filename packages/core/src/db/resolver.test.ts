// Unit tests for the pluggable per-project DB resolver (spec §2). No DB connection is ever
// made: the default branch returns the lazy sharedDb handle and we never query it.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "./context.js";
import { resetDbResolver, resolveDbFor, setDbResolver } from "./resolver.js";
import { sharedDb } from "./shared.js";

const fakeA = { __fake: "A" } as unknown as Db;

describe("resolveDbFor / setDbResolver", () => {
  afterEach(() => {
    resetDbResolver();
  });

  it("returns the shared handle when no resolver is registered (today's behavior)", async () => {
    await expect(resolveDbFor("11111111-1111-1111-1111-111111111111")).resolves.toBe(sharedDb);
  });

  it("returns the registered resolver's handle, passing the projectId through", async () => {
    const resolver = vi.fn(async (_projectId: string) => fakeA);
    setDbResolver(resolver);
    await expect(resolveDbFor("p-1")).resolves.toBe(fakeA);
    expect(resolver).toHaveBeenCalledWith("p-1");
  });

  it("throws on a second registration (register exactly once at boot)", () => {
    setDbResolver(async () => fakeA);
    expect(() => setDbResolver(async () => fakeA)).toThrow(/already registered/);
  });

  it("propagates a resolver rejection unchanged — the no-fallback invariant", async () => {
    const boom = Object.assign(new Error("db unavailable"), { status: 503, code: "project/db-unavailable" });
    setDbResolver(async () => {
      throw boom;
    });
    await expect(resolveDbFor("p-1")).rejects.toBe(boom); // same object, not wrapped, not swallowed
  });

  it("resetDbResolver restores the default", async () => {
    setDbResolver(async () => fakeA);
    resetDbResolver();
    await expect(resolveDbFor("p-1")).resolves.toBe(sharedDb);
  });
});
