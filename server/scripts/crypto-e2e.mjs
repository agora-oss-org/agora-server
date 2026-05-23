// E2E for /crypto/sign-testing-jwt/v2 + the verify-external-user pairing.
// Generates an RS256 keypair, sets a throwaway project's external_auth_public_key, signs a testing
// JWT via the endpoint, then verifies it mints an Agora session. Also checks the legacy `token`
// field still works. Run from server/ with the server booted on :4000. Needs DATABASE_URL in env.
import { generateKeyPair, exportPKCS8, exportSPKI } from "jose";
import postgres from "postgres";

const DB = process.env.DATABASE_URL;
if (!DB) { console.error("❌ DATABASE_URL required"); process.exit(1); }
const sql = postgres(DB, { prepare: false, onnotice: () => {} });
const fail = async (m) => { console.error("❌ FAIL:", m); await sql.end(); process.exit(1); };

// 1. keypair
const { publicKey, privateKey } = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
const privateKeyPem = await exportPKCS8(privateKey);
const publicKeyPem = await exportSPKI(publicKey);

// 2. throwaway project with the matching public key
const [proj] = await sql`
  insert into projects (client_id, name, external_auth_public_key)
  values (${"crypto-test-" + Date.now()}, ${"crypto-test"}, ${publicKeyPem}) returning id`;
const P = proj.id;
const base = `http://localhost:4000/v7/${P}`;
const call = (path, body) =>
  fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

try {
  // 3. sign
  const signRes = await call("/crypto/sign-testing-jwt/v2", {
    projectId: P, privateKey: privateKeyPem, userData: { id: "ext-user-1", name: "Ext User", username: "extu" },
  });
  if (!signRes.ok) await fail(`sign HTTP ${signRes.status}: ${await signRes.text()}`);
  const jwt = await signRes.json(); // bare string
  if (typeof jwt !== "string" || jwt.split(".").length !== 3) await fail("sign did not return a JWT string: " + JSON.stringify(jwt));
  console.log("✓ signed testing JWT:", jwt.slice(0, 24) + "…");

  // 4. verify-external-user with the SDK's `userJwt` field
  const vRes = await call("/auth/verify-external-user", { userJwt: jwt });
  if (!vRes.ok) await fail(`verify(userJwt) HTTP ${vRes.status}: ${await vRes.text()}`);
  const v = await vRes.json();
  if (!v.accessToken || !v.refreshToken) await fail("verify returned no tokens: " + JSON.stringify(v));
  if (v.user?.foreignId !== "ext-user-1") await fail("foreignId mismatch: " + JSON.stringify(v.user));
  if (v.user?.name !== "Ext User") await fail("name not applied from userData: " + JSON.stringify(v.user));
  console.log("✓ verify-external-user{userJwt} → session for", v.user.foreignId, "(name:", v.user.name + ")");

  // 5. legacy `token` field still accepted
  const v2 = await call("/auth/verify-external-user", { token: jwt });
  if (!v2.ok) await fail(`verify(token) HTTP ${v2.status}: ${await v2.text()}`);
  console.log("✓ legacy {token} field still accepted");

  // 6. bad private key → 400 crypto/sign-failed
  const badRes = await call("/crypto/sign-testing-jwt/v2", { projectId: P, privateKey: "not-a-key", userData: { id: "x" } });
  if (badRes.status !== 400) await fail(`bad key expected 400, got ${badRes.status}`);
  const bad = await badRes.json();
  if (bad.code !== "crypto/sign-failed") await fail("bad key wrong code: " + JSON.stringify(bad));
  console.log("✓ invalid private key → 400 crypto/sign-failed");

  console.log("\n🎉 /crypto/sign-testing-jwt E2E passed");
} finally {
  await sql`delete from projects where id = ${P}`; // cascade cleanup
  await sql.end();
}
process.exit(0);
