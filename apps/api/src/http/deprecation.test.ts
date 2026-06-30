import { describe, it, expect, vi } from "vitest";
import { markDeprecated, isDeprecatedEntitySort } from "./deprecation.js";

describe("markDeprecated", () => {
  it("sets the RFC 8594 Deprecation header and no Sunset", () => {
    const header = vi.fn();
    markDeprecated({ header } as any);
    expect(header).toHaveBeenCalledWith("Deprecation", "true");
    expect(header).toHaveBeenCalledTimes(1); // no Sunset
  });
});

describe("isDeprecatedEntitySort", () => {
  it("is true only for the legacy `new` alias", () => {
    expect(isDeprecatedEntitySort("new")).toBe(true);
    expect(isDeprecatedEntitySort("createdAt")).toBe(false);
    expect(isDeprecatedEntitySort("hot")).toBe(false);
    expect(isDeprecatedEntitySort(undefined)).toBe(false);
  });
});
