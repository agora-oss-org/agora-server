// Image variant planning for POST /storage/images, matching the SDK's UploadImageOptions
// (agora-sdk .../interfaces/models/Image.ts). The SDK sends `mode` + JSON-stringified params as
// multipart fields; we parse them, compute a flat list of {name,width,height,fit} variant specs,
// then sharp-resize + upload each. The spec math is pure (computeVariants) so it's unit-testable.
import type { Sharp } from "sharp";

export type Fit = "cover" | "contain" | "inside" | "outside";
export type ImageFormat = "webp" | "jpeg" | "png" | "original";

export interface ParsedImageOptions {
  mode?: string;
  dimensions?: Record<string, { width: number; height: number }>;
  aspectRatio?: { width: number; height: number };
  widths?: Record<string, number>;
  heights?: Record<string, number>;
  sizes?: Record<string, number>;
  aspectRatios?: { width: number; height: number }[];
  fit?: Fit;
  quality?: number;
  format?: ImageFormat;
  stripExif?: boolean;
  pathParts?: string[];
}

export interface VariantSpec { name: string; width?: number; height?: number; fit?: Fit }

const num = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const json = <T>(v: unknown): T | undefined => {
  if (typeof v !== "string") return undefined;
  try { return JSON.parse(v) as T; } catch { return undefined; }
};

/** Parse the multipart fields the SDK appends into a typed options object. */
export function parseImageOptions(body: Record<string, unknown>): ParsedImageOptions {
  const stripExifRaw = body["stripExif"];
  return {
    mode: typeof body["mode"] === "string" ? (body["mode"] as string) : undefined,
    dimensions: json(body["dimensions"]),
    aspectRatio: json(body["aspectRatio"]),
    widths: json(body["widths"]),
    heights: json(body["heights"]),
    sizes: json(body["sizes"]),
    aspectRatios: json(body["aspectRatios"]),
    fit: typeof body["fit"] === "string" ? (body["fit"] as Fit) : undefined,
    quality: num(body["quality"]),
    format: typeof body["format"] === "string" ? (body["format"] as ImageFormat) : undefined,
    stripExif: stripExifRaw === undefined ? undefined : stripExifRaw === "true" || stripExifRaw === true,
    pathParts: json(body["pathParts"]),
  };
}

const LEGACY: VariantSpec[] = [
  { name: "thumbnail", width: 150 },
  { name: "small", width: 400 },
  { name: "medium", width: 800 },
];

/**
 * Pure: turn parsed options into a flat list of variant specs. Unknown/absent mode → the legacy
 * fixed set (thumbnail/small/medium) for back-compat. Heights/widths derived from the aspect ratio.
 */
export function computeVariants(o: ParsedImageOptions): VariantSpec[] {
  const fit = o.fit;
  switch (o.mode) {
    case "exact-dimensions":
      return Object.entries(o.dimensions ?? {}).map(([name, d]) => ({ name, width: d.width, height: d.height, fit: fit ?? "cover" }));
    case "aspect-ratio-width-based": {
      const ar = o.aspectRatio;
      if (!ar?.width || !ar?.height) return [];
      return Object.entries(o.widths ?? {}).map(([name, width]) => ({ name, width, height: Math.round((width * ar.height) / ar.width), fit: fit ?? "cover" }));
    }
    case "aspect-ratio-height-based": {
      const ar = o.aspectRatio;
      if (!ar?.width || !ar?.height) return [];
      return Object.entries(o.heights ?? {}).map(([name, height]) => ({ name, height, width: Math.round((height * ar.width) / ar.height), fit: fit ?? "cover" }));
    }
    case "original-aspect":
      // size bounds the longest side; aspect preserved via fit:inside (default).
      return Object.entries(o.sizes ?? {}).map(([name, size]) => ({ name, width: size, height: size, fit: fit ?? "inside" }));
    case "multi-aspect-ratio": {
      const ars = o.aspectRatios ?? [];
      const out: VariantSpec[] = [];
      for (const [name, size] of Object.entries(o.sizes ?? {})) {
        for (const ar of ars) {
          if (!ar?.width || !ar?.height) continue;
          out.push({ name: `${name}_${ar.width}x${ar.height}`, width: size, height: Math.round((size * ar.height) / ar.width), fit: fit ?? "cover" });
        }
      }
      return out;
    }
    default:
      return LEGACY.map((v) => ({ ...v, fit }));
  }
}

/** Resolve the output encoder/extension/mime from options (+ source format for "original"). */
export function resolveOutput(o: ParsedImageOptions, sourceFormat: string | undefined): {
  apply: (p: Sharp) => Sharp; ext: string; mime: string; format: string;
} {
  const want = o.format && o.format !== "original" ? o.format : sourceFormat;
  const quality = o.quality ?? 85;
  if (want === "jpeg" || want === "jpg") return { apply: (p) => p.jpeg({ quality }), ext: "jpg", mime: "image/jpeg", format: "jpeg" };
  if (want === "png") return { apply: (p) => p.png(), ext: "png", mime: "image/png", format: "png" };
  return { apply: (p) => p.webp({ quality }), ext: "webp", mime: "image/webp", format: "webp" }; // default/fallback
}

/** Storage path for a variant: <project>/<pathParts|images>/<fileId>/<name>.<ext> */
export function variantPath(projectId: string, pathParts: string[] | undefined, fileId: string, name: string, ext: string): string {
  const folder = pathParts && pathParts.length ? pathParts.map((s) => String(s).replace(/[^A-Za-z0-9_-]/g, "")).filter(Boolean).join("/") : "images";
  return `${projectId}/${folder}/${fileId}/${name}.${ext}`;
}
