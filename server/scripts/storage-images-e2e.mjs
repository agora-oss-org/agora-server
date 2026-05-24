// Opt-in E2E for POST /storage/images variant modes (hits REAL Supabase Storage).
// Generates a 600x400 test image and uploads it through each UploadImageOptions mode, asserting the
// produced variant dimensions. Run from server/ with the server on :4000 and Supabase Storage
// configured (SUPABASE_URL + SERVICE_ROLE_KEY). ACCESS_TOKEN_SECRET in env.
import sharp from "sharp";
import { SignJWT } from "jose";

const P = "11111111-1111-1111-1111-111111111111";
const ALICE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const base = `http://localhost:4000/v7/${P}`;
const fail = (m) => { console.error("❌ FAIL:", m); process.exit(1); };

const token = await new SignJWT({ role: "visitor" }).setProtectedHeader({ alg: "HS256" }).setSubject(ALICE)
  .setExpirationTime("1h").sign(new TextEncoder().encode(process.env.ACCESS_TOKEN_SECRET));

const png = await sharp({ create: { width: 600, height: 400, channels: 3, background: { r: 200, g: 100, b: 50 } } }).png().toBuffer();

async function upload(fields) {
  const fd = new FormData();
  fd.append("file", new Blob([png], { type: "image/png" }), "test.png");
  for (const [k, v] of Object.entries(fields)) fd.append(k, typeof v === "string" ? v : JSON.stringify(v));
  const res = await fetch(`${base}/storage/images`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd });
  const body = await res.json();
  if (!res.ok) fail(`HTTP ${res.status}: ${JSON.stringify(body)}`);
  return body;
}
const dim = (v) => `${v.width}x${v.height}`;

// 1. exact-dimensions (cover → exact 100x100)
let r = await upload({ mode: "exact-dimensions", dimensions: { thumb: { width: 100, height: 100 } } });
if (!r.fileId || !r.original) fail("exact: missing fileId/original");
if (dim(r.variants.thumb) !== "100x100") fail("exact thumb wrong: " + dim(r.variants.thumb));
console.log("✓ exact-dimensions → thumb", dim(r.variants.thumb), "| original", dim(r.original));

// 2. aspect-ratio-width-based (16:9 @ width 320 → 320x180)
r = await upload({ mode: "aspect-ratio-width-based", aspectRatio: { width: 16, height: 9 }, widths: { card: 320 } });
if (dim(r.variants.card) !== "320x180") fail("aspect card wrong: " + dim(r.variants.card));
console.log("✓ aspect-ratio-width-based → card", dim(r.variants.card));

// 3. original-aspect (bound longest side to 60, source 3:2 → 60x40)
r = await upload({ mode: "original-aspect", sizes: { md: 60 } });
if (dim(r.variants.md) !== "60x40") fail("original-aspect md wrong: " + dim(r.variants.md));
console.log("✓ original-aspect → md", dim(r.variants.md), "(aspect preserved)");

// 4. format=jpeg passthrough
r = await upload({ mode: "original-aspect", sizes: { md: 60 }, format: "jpeg", quality: "70" });
if (r.original.format !== "jpeg" || r.metadata.originalFormat !== "png") fail("format: " + JSON.stringify({ o: r.original.format, src: r.metadata.originalFormat }));
console.log("✓ format=jpeg → original.format", r.original.format, "| source", r.metadata.originalFormat);

// 5. legacy (no mode): thumbnail+small kept, medium(800) skipped (source 600 wide)
r = await upload({});
const names = Object.keys(r.variants).sort();
if (!names.includes("thumbnail") || !names.includes("small") || names.includes("medium")) fail("legacy variants: " + names.join(","));
console.log("✓ legacy (no mode) → variants", names.join(","), "(medium skipped, > source width)");

console.log("\n🎉 /storage/images variant-modes E2E passed");
process.exit(0);
