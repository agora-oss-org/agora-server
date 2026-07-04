import { describe, expect, it, afterEach, vi } from "vitest";
import { fileObjectKeys, removeMedia } from "./storage-cleanup.js";
import { setStorageForTest } from "./storage/index.js";
import type { StorageProvider } from "./storage/provider.js";

const PROJECT = "11111111-1111-1111-1111-111111111111";
const FILE_ID = "3a23cf81-aae8-400d-8526-dc0b425839e6";

// Mirrors the real row shape (observed in prod 2026-07-03): original_path is a FULL public
// URL; variants carry bare keys in image.variants.*.path.
function imageRow() {
  return {
    projectId: PROJECT,
    originalPath: `https://api.example.org/media/${PROJECT}/images/${FILE_ID}/original.png`,
    image: {
      fileId: FILE_ID,
      variants: {
        thumbnail: { path: `${PROJECT}/images/${FILE_ID}/thumbnail.png` },
        small: { path: `${PROJECT}/images/${FILE_ID}/small.png` },
        medium: { path: `${PROJECT}/images/${FILE_ID}/medium.png` },
      },
    },
  };
}

afterEach(() => setStorageForTest(null));

describe("fileObjectKeys", () => {
  it("derives the original key (public URL → key) plus every variant key", () => {
    expect(fileObjectKeys(imageRow()).sort()).toEqual(
      [
        `${PROJECT}/images/${FILE_ID}/original.png`,
        `${PROJECT}/images/${FILE_ID}/thumbnail.png`,
        `${PROJECT}/images/${FILE_ID}/small.png`,
        `${PROJECT}/images/${FILE_ID}/medium.png`,
      ].sort(),
    );
  });

  it("handles a bare-key original_path (marker at position 0)", () => {
    const row = { projectId: PROJECT, originalPath: `${PROJECT}/files/${FILE_ID}.pdf`, image: null };
    expect(fileObjectKeys(row)).toEqual([`${PROJECT}/files/${FILE_ID}.pdf`]);
  });

  it("skips the original when the projectId marker is absent, keeps variants", () => {
    const row = { ...imageRow(), originalPath: "https://cdn.example.org/somewhere/else.png" };
    const keys = fileObjectKeys(row);
    expect(keys).toHaveLength(3);
    expect(keys.every((k) => k.startsWith(`${PROJECT}/`))).toBe(true);
  });

  it("tolerates missing/partial image json (non-image files, processing errors)", () => {
    expect(fileObjectKeys({ projectId: PROJECT, originalPath: `${PROJECT}/files/x.bin`, image: null })).toEqual([
      `${PROJECT}/files/x.bin`,
    ]);
    expect(
      fileObjectKeys({ projectId: PROJECT, originalPath: `${PROJECT}/files/y.bin`, image: { variants: { small: {} } } }),
    ).toEqual([`${PROJECT}/files/y.bin`]);
  });

  it("dedups when a variant path equals the original key", () => {
    const key = `${PROJECT}/images/${FILE_ID}/original.png`;
    const row = { projectId: PROJECT, originalPath: key, image: { variants: { small: { path: key } } } };
    expect(fileObjectKeys(row)).toEqual([key]);
  });
});

describe("removeMedia", () => {
  it("removes the dedup'd union of keys across rows via the storage provider", async () => {
    const removed: string[][] = [];
    setStorageForTest({
      put: async () => "",
      publicUrl: () => "",
      remove: async (keys) => {
        removed.push(keys);
      },
    } satisfies StorageProvider);
    await removeMedia([imageRow(), imageRow()], "test");
    expect(removed).toHaveLength(1);
    expect(removed[0]).toHaveLength(4); // duplicate row contributes no extra keys
  });

  it("is a no-op for zero rows (provider not touched)", async () => {
    const remove = vi.fn();
    setStorageForTest({ put: async () => "", publicUrl: () => "", remove } satisfies StorageProvider);
    await removeMedia([], "test");
    expect(remove).not.toHaveBeenCalled();
  });

  it("never throws when the provider rejects", async () => {
    setStorageForTest({
      put: async () => "",
      publicUrl: () => "",
      remove: async () => {
        throw new Error("s3 down");
      },
    } satisfies StorageProvider);
    await expect(removeMedia([imageRow()], "test")).resolves.toBeUndefined();
  });
});
