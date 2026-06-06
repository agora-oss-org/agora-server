import { describe, expect, it } from "vitest";
import { inferFileType, assertUploadSize } from "./storage.js";

describe("inferFileType", () => {
  it("returns 'other' for a missing mime type", () => {
    expect(inferFileType(undefined)).toBe("other");
    expect(inferFileType("")).toBe("other");
  });

  it("classifies any image/* mime as 'image'", () => {
    expect(inferFileType("image/png")).toBe("image");
    expect(inferFileType("image/jpeg")).toBe("image");
    expect(inferFileType("image/webp")).toBe("image");
    expect(inferFileType("image/svg+xml")).toBe("image");
  });

  it("classifies any video/* mime as 'video'", () => {
    expect(inferFileType("video/mp4")).toBe("video");
    expect(inferFileType("video/quicktime")).toBe("video");
  });

  it("classifies pdf, text/*, and document-ish mimes as 'document'", () => {
    expect(inferFileType("application/pdf")).toBe("document");
    expect(inferFileType("text/plain")).toBe("document");
    expect(inferFileType("text/csv")).toBe("document");
    expect(inferFileType("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(
      "document",
    );
    expect(inferFileType("application/msword-document")).toBe("document");
  });

  it("falls back to 'other' for unrecognized mimes", () => {
    expect(inferFileType("application/zip")).toBe("other");
    expect(inferFileType("application/octet-stream")).toBe("other");
    expect(inferFileType("audio/mpeg")).toBe("other");
  });

  it("is case-sensitive on the mime prefix (matches the implementation's literal checks)", () => {
    // The shaper compares lowercase prefixes; uppercase input is treated as unknown.
    expect(inferFileType("IMAGE/PNG")).toBe("other");
  });
});

describe("assertUploadSize", () => {
  // Default cap is 25 MiB (MAX_UPLOAD_BYTES) when unset.
  it("allows files at or under the cap", () => {
    expect(() => assertUploadSize({ size: 1024 })).not.toThrow();
    expect(() => assertUploadSize({ size: 26_214_400 })).not.toThrow(); // exactly 25 MiB
  });
  it("rejects oversized files with 413 storage/file-too-large", () => {
    expect(() => assertUploadSize({ size: 26_214_401 })).toThrowError(
      expect.objectContaining({ status: 413, code: "storage/file-too-large" }),
    );
  });
});
