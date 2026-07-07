import { afterEach, describe, expect, it } from "vitest";
import { loadBootModule } from "./boot.js";

const RAN = new URL("./__fixtures__/boot-ran.ts", import.meta.url).href;
const THROWS = new URL("./__fixtures__/boot-throws.ts", import.meta.url).href;

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__agoraBootRan;
});

describe("loadBootModule", () => {
  it("is a no-op when the specifier is undefined", async () => {
    const result = await loadBootModule(undefined);
    expect(result).toBeNull();
    expect((globalThis as Record<string, unknown>).__agoraBootRan).toBeUndefined();
  });

  it("is a no-op when the specifier is an empty string", async () => {
    const result = await loadBootModule("");
    expect(result).toBeNull();
    expect((globalThis as Record<string, unknown>).__agoraBootRan).toBeUndefined();
  });

  it("imports the module (running its side effect) and returns the specifier", async () => {
    const result = await loadBootModule(RAN);
    expect(result).toBe(RAN);
    expect((globalThis as Record<string, unknown>).__agoraBootRan).toBe(1);
  });

  it("propagates a failure thrown by the boot module", async () => {
    await expect(loadBootModule(THROWS)).rejects.toThrow("boot fixture boom");
  });
});
