// Unit tests for the ALS-backed request-scoped DB accessor. No DB connection is
// ever made: postgres.js is lazy (connects on first query) and these tests never query.
import { describe, expect, it } from "vitest";
import { getDb, runWithDb, type Db } from "./context.js";
import { sharedDb } from "./shared.js";

const fakeA = { __fake: "A" } as unknown as Db;
const fakeB = { __fake: "B" } as unknown as Db;

describe("getDb / runWithDb", () => {
  it("returns the shared singleton outside any scope", () => {
    expect(getDb()).toBe(sharedDb);
  });

  it("returns the scoped handle inside runWithDb", () => {
    runWithDb(fakeA, () => {
      expect(getDb()).toBe(fakeA);
    });
    expect(getDb()).toBe(sharedDb); // scope ends cleanly
  });

  it("isolates two interleaved async scopes (no cross-request contamination)", async () => {
    const seen = { a: [] as Db[], b: [] as Db[] };
    const yield_ = () => new Promise<void>((r) => setTimeout(r, 0));
    const runA = runWithDb(fakeA, async () => {
      seen.a.push(getDb());
      await yield_(); // give B the event loop mid-flight
      seen.a.push(getDb());
      await yield_();
      seen.a.push(getDb());
    });
    const runB = runWithDb(fakeB, async () => {
      seen.b.push(getDb());
      await yield_();
      seen.b.push(getDb());
    });
    await Promise.all([runA, runB]);
    expect(seen.a).toEqual([fakeA, fakeA, fakeA]);
    expect(seen.b).toEqual([fakeB, fakeB]);
  });

  it("propagates into a detached (un-awaited) promise — the fire-and-forget guarantee", async () => {
    let detached: Promise<Db> | undefined;
    runWithDb(fakeA, () => {
      // fired without await, resolves AFTER the scope callback has returned
      detached = new Promise<void>((r) => setTimeout(r, 5)).then(() => getDb());
    });
    expect(getDb()).toBe(sharedDb); // scope is over on the outside...
    await expect(detached!).resolves.toBe(fakeA); // ...but the detached work kept its handle
  });
});
