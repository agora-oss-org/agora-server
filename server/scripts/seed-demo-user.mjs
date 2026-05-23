// Seed a pre-confirmed Supabase auth user for the demo app (so email/password sign-in works
// without the email-confirmation round-trip). Idempotent. Run from agora/server:
//   node scripts/seed-demo-user.mjs
// The matching `profiles` row auto-creates on first sign-in (ensureProfile in routes/auth.ts).
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Need SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in env (.env).");
  process.exit(1);
}
const email = process.env.DEMO_EMAIL || "agora-demo@gmail.com";
const password = process.env.DEMO_PASSWORD || "DemoPass123!";

const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });

if (error) {
  if (/already|exist|registered/i.test(error.message)) {
    console.log(`✓ demo user already exists: ${email}`);
    process.exit(0);
  }
  console.error("createUser failed:", error.message);
  process.exit(1);
}
console.log(`✓ created confirmed demo user: ${email}  (id ${data.user.id})  password: ${password}`);
