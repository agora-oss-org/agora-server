import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetDbResolver, setDbResolver } from "@agora/core/db";
import { createSecureApp } from "./app.js";

beforeEach(() => resetDbResolver());
afterEach(() => resetDbResolver());

it("does not resolve a project DB while constructing the secure-chat app", () => {
  const resolver = vi.fn(async () => {
    throw new Error("resolveDbFor must never run at app-construction time");
  });
  setDbResolver(resolver);

  createSecureApp();

  expect(resolver).not.toHaveBeenCalled();
});
