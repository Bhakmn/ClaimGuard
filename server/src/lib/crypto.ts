/**
 * Cryptographic helpers.
 *
 * - AES-256-GCM seal / open  (provider tokens at rest)
 * - HMAC-SHA1                (ACRCloud request signing)
 * - SHA-256 digest           (sample cache keys, PKCE challenges for Auth0)
 * - PKCE helpers             (Auth0: base64url challenge; TikTok: hex challenge)
 * - Random nonces            (OAuth state, session IDs)
 *
 * All operations are synchronous wrappers over node:crypto.  No external
 * dependencies.
 */

import crypto from "node:crypto";
import { AES_GCM_IV_BYTES, AES_GCM_TAG_BYTES, PKCE_VERIFIER_BYTES, OAUTH_STATE_NONCE_BYTES } from "../config/constants.js";

/* ── AES-256-GCM ─────────────────────────────────────────────────────────── */

/**
 * Encrypt `plaintext` with AES-256-GCM.
 *
 * Layout of the returned Buffer:
 *   [ IV (12 bytes) | ciphertext (variable) | auth tag (16 bytes) ]
 */
export function seal(plaintext: Buffer | string, keyHex: string): Buffer {
  const key = Buffer.from(keyHex, "hex");
  const iv = crypto.randomBytes(AES_GCM_IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const body =
    typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;

  const encrypted = Buffer.concat([cipher.update(body), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, encrypted, tag]);
}

/**
 * Decrypt a buffer produced by `seal()`.
 * Throws when the auth tag does not verify (tampered or wrong key).
 */
export function open(sealed: Buffer, keyHex: string): Buffer {
  if (sealed.length < AES_GCM_IV_BYTES + AES_GCM_TAG_BYTES) {
    throw new Error("Sealed buffer is too short to be valid.");
  }

  const key = Buffer.from(keyHex, "hex");
  const iv = sealed.subarray(0, AES_GCM_IV_BYTES);
  const tag = sealed.subarray(sealed.length - AES_GCM_TAG_BYTES);
  const ciphertext = sealed.subarray(AES_GCM_IV_BYTES, sealed.length - AES_GCM_TAG_BYTES);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Convenience: seal a UTF-8 string, return hex. */
export function sealString(plaintext: string, keyHex: string): string {
  return seal(Buffer.from(plaintext, "utf8"), keyHex).toString("hex");
}

/** Convenience: open a hex-encoded sealed blob, return UTF-8 string. */
export function openString(sealedHex: string, keyHex: string): string {
  return open(Buffer.from(sealedHex, "hex"), keyHex).toString("utf8");
}

/* ── HMAC-SHA1 (ACRCloud) ────────────────────────────────────────────────── */

/**
 * Sign `message` with HMAC-SHA1 using `secret`.
 * Returns a base64-encoded string — the format ACRCloud expects.
 */
export function hmacSha1Base64(message: string, secret: string): string {
  return crypto
    .createHmac("sha1", secret)
    .update(message)
    .digest("base64");
}

/* ── SHA-256 ─────────────────────────────────────────────────────────────── */

/** SHA-256 over a Buffer or string, returns a lowercase hex digest. */
export function sha256Hex(input: Buffer | string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

/** SHA-256 over a string, returns a Buffer (used for PKCE). */
export function sha256Buffer(input: string): Buffer {
  return crypto.createHash("sha256").update(input).digest();
}

/* ── PKCE — Auth0 (standard: base64url challenge) ────────────────────────── */

/**
 * Generate a PKCE code verifier: 32 random bytes, base64url-encoded.
 * Auth0 follows RFC 7636 — the challenge is SHA-256(verifier) as base64url.
 */
export function generatePkceVerifier(): string {
  return crypto
    .randomBytes(PKCE_VERIFIER_BYTES)
    .toString("base64url");
}

/**
 * Compute the S256 code challenge for Auth0.
 * challenge = BASE64URL(SHA-256(ASCII(verifier)))
 */
export function pkceChallenge(verifier: string): string {
  return sha256Buffer(verifier).toString("base64url");
}

/* ── PKCE — TikTok (non-standard: hex challenge) ─────────────────────────── */

/**
 * Generate a PKCE code verifier suitable for TikTok: 32 random bytes as hex.
 * TikTok uses a hex-encoded SHA-256 hash as the code challenge — not base64url.
 */
export function generateTikTokPkceVerifier(): string {
  return crypto.randomBytes(PKCE_VERIFIER_BYTES).toString("hex");
}

/**
 * Compute the S256 code challenge for TikTok.
 * challenge = HEX(SHA-256(verifier))
 *
 * This is non-standard — standard PKCE uses base64url, but TikTok requires hex.
 */
export function tikTokPkceChallenge(verifier: string): string {
  return sha256Buffer(verifier).toString("hex");
}

/* ── Random nonces ───────────────────────────────────────────────────────── */

/** Generate a random OAuth state nonce as a URL-safe hex string. */
export function generateStateNonce(): string {
  return crypto.randomBytes(OAUTH_STATE_NONCE_BYTES).toString("hex");
}

/** Generate a new session ID as a UUID v4. */
export function generateSessionId(): string {
  return crypto.randomUUID();
}
