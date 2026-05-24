// Unit: pure variant-planning math for /storage/images (no sharp, no Supabase).
import { describe, it, expect } from "vitest";
import { parseImageOptions, computeVariants, resolveOutput, variantPath } from "./image-variants.js";

describe("parseImageOptions", () => {
  it("parses the SDK's multipart fields (JSON blobs, numbers, bools)", () => {
    const o = parseImageOptions({
      mode: "exact-dimensions",
      dimensions: JSON.stringify({ thumb: { width: 100, height: 100 } }),
      quality: "70",
      format: "jpeg",
      stripExif: "false",
      fit: "contain",
      pathParts: JSON.stringify(["avatars", "u1"]),
    });
    expect(o.mode).toBe("exact-dimensions");
    expect(o.dimensions).toEqual({ thumb: { width: 100, height: 100 } });
    expect(o.quality).toBe(70);
    expect(o.format).toBe("jpeg");
    expect(o.stripExif).toBe(false);
    expect(o.fit).toBe("contain");
    expect(o.pathParts).toEqual(["avatars", "u1"]);
  });

  it("leaves malformed JSON / missing fields undefined", () => {
    const o = parseImageOptions({ mode: "original-aspect", sizes: "{not json", quality: "x" });
    expect(o.sizes).toBeUndefined();
    expect(o.quality).toBeUndefined();
    expect(o.stripExif).toBeUndefined();
  });
});

describe("computeVariants", () => {
  it("exact-dimensions → one spec per entry (default fit cover)", () => {
    expect(computeVariants({ mode: "exact-dimensions", dimensions: { sm: { width: 100, height: 80 }, lg: { width: 400, height: 320 } } }))
      .toEqual([
        { name: "sm", width: 100, height: 80, fit: "cover" },
        { name: "lg", width: 400, height: 320, fit: "cover" },
      ]);
  });

  it("aspect-ratio-width-based derives height from the ratio", () => {
    expect(computeVariants({ mode: "aspect-ratio-width-based", aspectRatio: { width: 16, height: 9 }, widths: { card: 320 } }))
      .toEqual([{ name: "card", width: 320, height: 180, fit: "cover" }]);
  });

  it("aspect-ratio-height-based derives width from the ratio", () => {
    expect(computeVariants({ mode: "aspect-ratio-height-based", aspectRatio: { width: 1, height: 1 }, heights: { sq: 200 } }))
      .toEqual([{ name: "sq", width: 200, height: 200, fit: "cover" }]);
  });

  it("original-aspect bounds the longest side (default fit inside)", () => {
    expect(computeVariants({ mode: "original-aspect", sizes: { md: 800 } }))
      .toEqual([{ name: "md", width: 800, height: 800, fit: "inside" }]);
  });

  it("multi-aspect-ratio is the cartesian product of sizes × ratios", () => {
    const specs = computeVariants({
      mode: "multi-aspect-ratio",
      sizes: { feed: 600 },
      aspectRatios: [{ width: 16, height: 9 }, { width: 1, height: 1 }],
    });
    expect(specs).toEqual([
      { name: "feed_16x9", width: 600, height: 338, fit: "cover" },
      { name: "feed_1x1", width: 600, height: 600, fit: "cover" },
    ]);
  });

  it("honors an explicit fit override", () => {
    expect(computeVariants({ mode: "original-aspect", sizes: { md: 800 }, fit: "outside" })[0].fit).toBe("outside");
  });

  it("aspect modes with a missing ratio yield nothing", () => {
    expect(computeVariants({ mode: "aspect-ratio-width-based", widths: { x: 100 } })).toEqual([]);
  });

  it("unknown/absent mode falls back to the legacy fixed set", () => {
    expect(computeVariants({}).map((v) => v.name)).toEqual(["thumbnail", "small", "medium"]);
    expect(computeVariants({ mode: "bogus" }).map((v) => v.name)).toEqual(["thumbnail", "small", "medium"]);
  });
});

describe("resolveOutput", () => {
  it("maps format → encoder/ext/mime; quality defaults to 85", () => {
    expect(resolveOutput({ format: "jpeg", quality: 70 }, "png")).toMatchObject({ ext: "jpg", mime: "image/jpeg", format: "jpeg" });
    expect(resolveOutput({ format: "png" }, "jpeg")).toMatchObject({ ext: "png", mime: "image/png" });
    expect(resolveOutput({ format: "webp" }, "png")).toMatchObject({ ext: "webp", mime: "image/webp" });
  });
  it("'original' keeps the source format; unknown source → webp", () => {
    expect(resolveOutput({ format: "original" }, "jpeg").format).toBe("jpeg");
    expect(resolveOutput({ format: "original" }, "gif").format).toBe("webp");
    expect(resolveOutput({}, undefined).format).toBe("webp");
  });
});

describe("variantPath", () => {
  it("uses pathParts when given, else 'images', sanitizing segments", () => {
    expect(variantPath("p1", ["avatars", "u/../1"], "f1", "thumb", "webp")).toBe("p1/avatars/u1/f1/thumb.webp");
    expect(variantPath("p1", undefined, "f1", "original", "jpg")).toBe("p1/images/f1/original.jpg");
    expect(variantPath("p1", [], "f1", "small", "png")).toBe("p1/images/f1/small.png");
  });
});
