/**
 * Development seed script.
 *
 * Inserts deterministic rows so developers can test authenticated routes
 * without a real Auth0 tenant or TikTok account.
 *
 * Refuses to run when NODE_ENV=production.
 * Every insert uses ON CONFLICT DO NOTHING so the script is idempotent.
 *
 * Usage:
 *   npm run db:seed
 *
 * After running, paste the printed session cookie value into the browser's
 * DevTools under Application → Cookies → session.
 *
 * What is inserted:
 *   1. One user (auth0_sub = "dev|local-user")
 *   2. One authenticated session (fixed UUID, expires 1 year out)
 *   3. Three identify_cache rows:
 *      a. A music match (acr_status_code 0)
 *      b. No match (acr_status_code 1001)
 *      c. An expired row (expires_at in the past)
 */

import { createHash, createHmac } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/* ── Guard ────────────────────────────────────────────────────────────────── */

if (process.env["NODE_ENV"] === "production") {
  console.error("Seed script must not run in production.");
  process.exit(1);
}

/* ── Environment ──────────────────────────────────────────────────────────── */

const SUPABASE_URL = process.env["SUPABASE_URL"];
const SUPABASE_SERVICE_ROLE_KEY = process.env["SUPABASE_SERVICE_ROLE_KEY"];
const COOKIE_SECRET = process.env["COOKIE_SECRET"];

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !COOKIE_SECRET) {
  console.error(
    "SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and COOKIE_SECRET must be set."
  );
  process.exit(1);
}

/* ── Fixed IDs ────────────────────────────────────────────────────────────── */

const DEV_USER_ID   = "00000000-0000-4000-8000-000000000000";
const DEV_SESSION_ID = "00000000-0000-4000-8000-000000000001";
const SESSION_TTL_SECONDS = 365 * 24 * 60 * 60; // 1 year

/* ── Supabase client ──────────────────────────────────────────────────────── */

const { createClient } = await import("@supabase/supabase-js");
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/* ── 1. User ──────────────────────────────────────────────────────────────── */

console.log("Seeding user…");
const { error: userErr } = await db.from("users").upsert(
  {
    id: DEV_USER_ID,
    auth0_sub: "dev|local-user",
    email: "dev@example.test",
    email_verified: true,
    name: "Local Developer",
    picture: null,
  },
  { onConflict: "auth0_sub" }
);

if (userErr) {
  console.error("Failed to upsert user:", userErr.message);
  process.exit(1);
}
console.log(`  ✓ user ${DEV_USER_ID}`);

/* ── 2. Session ───────────────────────────────────────────────────────────── */

console.log("Seeding session…");
const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1_000).toISOString();

const { error: sessErr } = await db.from("sessions").upsert(
  {
    id: DEV_SESSION_ID,
    user_id: DEV_USER_ID,
    expires_at: expiresAt,
    ip: "127.0.0.1",
    user_agent: "ClaimGuard dev seed",
  },
  { onConflict: "id" }
);

if (sessErr) {
  console.error("Failed to upsert session:", sessErr.message);
  process.exit(1);
}
console.log(`  ✓ session ${DEV_SESSION_ID}`);

/* ── 3. Identify cache rows ───────────────────────────────────────────────── */

console.log("Seeding identify_cache…");

/** Hex-encode a buffer for Supabase bytea columns. */
function bufToHex(buf: Buffer): string {
  return `\\x${buf.toString("hex")}`;
}

// 3a. Music match — deterministic WAV-like 32-byte digest
const MATCH_DIGEST = createHash("sha256")
  .update("seed-fixture-match-sample")
  .digest();

const matchRow = {
  sample_sha256: bufToHex(MATCH_DIGEST),
  sample_bytes: 81920,
  acr_status_code: 0,
  match: {
    acrid: "b1e9a8e0f3a24d0b8c6d1a2e3f405162",
    title: "Neon Corridor",
    artists: "Halvorsen & The Tallow",
    album: "Streetlight Cartography",
    score: 94,
    sampleBeginMs: 0,
    sampleEndMs: 4800,
    playOffsetMs: 12400,
  },
  expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  hit_count: 0,
};

// 3b. No-match — acr_status_code 1001, match null
const NOMATCH_DIGEST = createHash("sha256")
  .update("seed-fixture-nomatch-sample")
  .digest();

const nomatchRow = {
  sample_sha256: bufToHex(NOMATCH_DIGEST),
  sample_bytes: 81920,
  acr_status_code: 1001,
  match: null,
  expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  hit_count: 0,
};

// 3c. Expired row — exercises the stale path
const EXPIRED_DIGEST = createHash("sha256")
  .update("seed-fixture-expired-sample")
  .digest();

const expiredRow = {
  sample_sha256: bufToHex(EXPIRED_DIGEST),
  sample_bytes: 40960,
  acr_status_code: 0,
  match: {
    acrid: "expired000000000000000000000",
    title: "Paper Lanterns",
    artists: "Mira Solvang",
    album: "Low Tide Sessions",
    score: 88,
    sampleBeginMs: 0,
    sampleEndMs: 4800,
    playOffsetMs: 5000,
  },
  // Expired 1 hour ago
  expires_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  hit_count: 3,
};

for (const row of [matchRow, nomatchRow, expiredRow]) {
  const { error } = await db.from("identify_cache").upsert(row, {
    onConflict: "sample_sha256",
  });
  if (error) {
    console.error("Failed to upsert cache row:", error.message);
    process.exit(1);
  }
}
console.log(`  ✓ 3 identify_cache rows (match, no-match, expired)`);

/* ── Print dev cookie ─────────────────────────────────────────────────────── */

// Produce a @fastify/cookie-compatible signed cookie value.
// Format: <value>.<HMAC-SHA256-base64url>
const key = Buffer.from(COOKIE_SECRET, "hex");
const hmac = createHmac("sha256", key)
  .update(DEV_SESSION_ID)
  .digest("base64url");
const signedCookie = `${DEV_SESSION_ID}.${hmac}`;

console.log(`
──────────────────────────────────────────────────────────
Dev session cookie:

  Name:   session
  Value:  ${signedCookie}
  Path:   /
  Domain: localhost

Paste in DevTools → Application → Cookies → http://localhost:3000

Active for: 1 year (until ${new Date(Date.now() + SESSION_TTL_SECONDS * 1_000).toLocaleDateString()})
──────────────────────────────────────────────────────────
`);
