// S3-compatible storage backend (MinIO for the fully self-hosted stack, or real AWS S3). Selected by
// STORAGE_PROVIDER=s3. Bytes live in a public-read bucket; the public URL is built from S3_PUBLIC_URL
// (the browser-reachable base, e.g. the edge's /media mount) — never the internal S3_ENDPOINT.
import {
  S3Client,
  PutObjectCommand,
  CreateBucketCommand,
  PutBucketPolicyCommand,
} from "@aws-sdk/client-s3";
import { env } from "../env.js";
import { logger } from "../logger.js";
import type { StorageProvider } from "./provider.js";

/** Anonymous public-read policy (`s3:GetObject` on every object), matching the Supabase public bucket. */
function publicReadPolicy(bucket: string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { AWS: ["*"] },
        Action: ["s3:GetObject"],
        Resource: [`arn:aws:s3:::${bucket}/*`],
      },
    ],
  });
}

export class S3StorageProvider implements StorageProvider {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicBase: string;
  private bucketReady = false;

  constructor() {
    // Fail closed with a clear message rather than letting the SDK throw an opaque error mid-upload.
    if (!env.S3_ENDPOINT || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY || !env.S3_PUBLIC_URL) {
      throw new Error(
        "STORAGE_PROVIDER=s3 requires S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, and S3_PUBLIC_URL.",
      );
    }
    this.bucket = env.S3_BUCKET;
    this.publicBase = env.S3_PUBLIC_URL.replace(/\/+$/, "");
    this.client = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
    });
  }

  async init(): Promise<void> {
    if (this.bucketReady) return;
    try {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    } catch (err) {
      // Already-owned/exists is the steady state — anything else is a real failure.
      const name = (err as { name?: string }).name ?? "";
      if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") {
        logger.error("creating storage bucket failed");
        logger.debug({ err }, "creating storage bucket failed");
        throw err;
      }
    }
    await this.client.send(new PutBucketPolicyCommand({ Bucket: this.bucket, Policy: publicReadPolicy(this.bucket) }));
    this.bucketReady = true;
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<string> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, ContentType: contentType }));
    return this.publicUrl(key);
  }

  publicUrl(key: string): string {
    return `${this.publicBase}/${key}`;
  }
}
