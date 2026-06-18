import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as awsS3 from "@aws-sdk/client-s3";
import { env } from "../env.js";
import { getStorage, resetStorageForTest } from "./index.js";
import { SupabaseStorageProvider } from "./supabase.js";
import { S3StorageProvider } from "./s3.js";

// Mock the AWS SDK so the S3 path needs no network. Records sent commands; `__onSend` lets a test
// override send behavior (e.g. to simulate a bucket-already-exists race).
vi.mock("@aws-sdk/client-s3", () => {
  const __calls: { __type: string; input: unknown }[] = [];
  const __onSend = { fn: async (_cmd: unknown) => ({}) };
  class S3Client {
    constructor(public cfg: unknown) {}
    async send(cmd: { __type: string; input: unknown }) {
      __calls.push(cmd);
      return __onSend.fn(cmd);
    }
  }
  class PutObjectCommand {
    __type = "PutObject";
    constructor(public input: unknown) {}
  }
  class CreateBucketCommand {
    __type = "CreateBucket";
    constructor(public input: unknown) {}
  }
  class PutBucketPolicyCommand {
    __type = "PutBucketPolicy";
    constructor(public input: unknown) {}
  }
  return { S3Client, PutObjectCommand, CreateBucketCommand, PutBucketPolicyCommand, __calls, __onSend };
});

const mock = awsS3 as unknown as {
  __calls: { __type: string; input: Record<string, unknown> }[];
  __onSend: { fn: (cmd: { __type: string; input: unknown }) => Promise<unknown> };
};

// Snapshot the env keys these tests mutate so each case starts from the real (default) values.
const ENV_KEYS = [
  "STORAGE_PROVIDER",
  "S3_ENDPOINT",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_PUBLIC_URL",
  "S3_BUCKET",
] as const;
type EnvShape = Record<(typeof ENV_KEYS)[number], unknown>;
const snapshot: Partial<EnvShape> = {};

function setS3Env() {
  (env as unknown as EnvShape).STORAGE_PROVIDER = "s3";
  (env as unknown as EnvShape).S3_ENDPOINT = "http://minio:9000";
  (env as unknown as EnvShape).S3_ACCESS_KEY_ID = "key";
  (env as unknown as EnvShape).S3_SECRET_ACCESS_KEY = "secret";
  (env as unknown as EnvShape).S3_PUBLIC_URL = "https://media.example.com";
  (env as unknown as EnvShape).S3_BUCKET = "agora";
}

beforeEach(() => {
  for (const k of ENV_KEYS) snapshot[k] = (env as unknown as EnvShape)[k];
  mock.__calls.length = 0;
  mock.__onSend.fn = async () => ({});
  resetStorageForTest();
});

afterEach(() => {
  for (const k of ENV_KEYS) (env as unknown as EnvShape)[k] = snapshot[k];
  resetStorageForTest();
});

describe("getStorage provider selection", () => {
  it("defaults to the Supabase backend when STORAGE_PROVIDER is unset/supabase", () => {
    expect(getStorage()).toBeInstanceOf(SupabaseStorageProvider);
  });

  it("returns the S3 backend when STORAGE_PROVIDER=s3 and creds are present", () => {
    setS3Env();
    expect(getStorage()).toBeInstanceOf(S3StorageProvider);
  });

  it("memoizes the provider across calls", () => {
    expect(getStorage()).toBe(getStorage());
  });

  it("throws a clear error when s3 is selected but S3_* creds are missing", () => {
    (env as unknown as EnvShape).STORAGE_PROVIDER = "s3";
    (env as unknown as EnvShape).S3_ENDPOINT = undefined;
    (env as unknown as EnvShape).S3_ACCESS_KEY_ID = undefined;
    (env as unknown as EnvShape).S3_SECRET_ACCESS_KEY = undefined;
    (env as unknown as EnvShape).S3_PUBLIC_URL = undefined;
    expect(() => getStorage()).toThrowError(/STORAGE_PROVIDER=s3 requires/);
  });
});

describe("S3StorageProvider", () => {
  beforeEach(setS3Env);

  it("builds the public URL from S3_PUBLIC_URL + key (no internal endpoint leak)", () => {
    const p = new S3StorageProvider();
    expect(p.publicUrl("proj/files/abc.webp")).toBe("https://media.example.com/proj/files/abc.webp");
  });

  it("trims a trailing slash on S3_PUBLIC_URL", () => {
    (env as unknown as EnvShape).S3_PUBLIC_URL = "https://media.example.com/";
    const p = new S3StorageProvider();
    expect(p.publicUrl("k")).toBe("https://media.example.com/k");
  });

  it("put() sends a PutObjectCommand with the bucket/key/body/content-type and returns the public URL", async () => {
    const p = new S3StorageProvider();
    const bytes = new Uint8Array([1, 2, 3]);
    const url = await p.put("proj/files/x.webp", bytes, "image/webp");
    expect(url).toBe("https://media.example.com/proj/files/x.webp");
    const put = mock.__calls.find((c) => c.__type === "PutObject");
    expect(put?.input).toMatchObject({ Bucket: "agora", Key: "proj/files/x.webp", Body: bytes, ContentType: "image/webp" });
  });

  it("init() creates the bucket then applies a public-read policy", async () => {
    const p = new S3StorageProvider();
    await p.init();
    const types = mock.__calls.map((c) => c.__type);
    expect(types).toEqual(["CreateBucket", "PutBucketPolicy"]);
    const policy = mock.__calls.find((c) => c.__type === "PutBucketPolicy");
    expect(JSON.stringify(policy?.input)).toContain("s3:GetObject");
  });

  it("init() tolerates an already-owned bucket (idempotent) and still applies the policy", async () => {
    mock.__onSend.fn = async (cmd) => {
      if (cmd.__type === "CreateBucket") {
        const e = new Error("exists") as Error & { name: string };
        e.name = "BucketAlreadyOwnedByYou";
        throw e;
      }
      return {};
    };
    const p = new S3StorageProvider();
    await expect(p.init()).resolves.toBeUndefined();
    expect(mock.__calls.some((c) => c.__type === "PutBucketPolicy")).toBe(true);
  });

  it("init() is a no-op after the first successful run", async () => {
    const p = new S3StorageProvider();
    await p.init();
    mock.__calls.length = 0;
    await p.init();
    expect(mock.__calls).toHaveLength(0);
  });
});
