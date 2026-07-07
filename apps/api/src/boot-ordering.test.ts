import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetDbResolver, setDbResolver } from "./db/index.js";
import { createApp } from "./app.js";

// The boot hook registers the per-project resolver before serving. That is only sufficient if nothing
// resolves a DB at import/construction time. Prove construction touches no resolver: a spy that would
// throw if called must stay untouched through createApp().
beforeEach(() => resetDbResolver());
afterEach(() => resetDbResolver());

it("does not resolve a project DB while constructing the app", () => {
  const resolver = vi.fn(async () => {
    throw new Error("resolveDbFor must never run at app-construction time");
  });
  setDbResolver(resolver);

  createApp();

  expect(resolver).not.toHaveBeenCalled();
});
