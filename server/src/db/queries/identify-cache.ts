/**
 * Query helpers: identify_cache
 *
 * Content-addressed: keyed by SHA-256 of the audio sample bytes (32 raw bytes
 * stored as bytea).  Results are cached for IDENTIFY_CACHE_TTL_SECONDS.
 * Setting that to 0 disables both reads and writes.
 *
 * What is cached: ACRCloud status 0 (match) and 1001 (no match).
 * What is never cached: upstream errors, timeouts, rate-limits.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/* ── Row type ────────────────────────────────────────────────────────────── */

export interface IdentifyCacheRow {
  sample_sha256: string; // Supabase returns bytea as hex string ("\x...")
  sample_bytes: number;
  acr_status_code: number;
  match: IdentifyMatch | null;
  created_at: string;
  expires_at: string;
  hit_count: number;
  last_hit_at: string | null;
}

export interface IdentifyMatch {
  acrid: string;
  title: string;
  artists: string;
  album: string;
  score: number;
  sampleBeginMs?: number;
  sampleEndMs?: number;
  playOffsetMs?: number;
}

/* ── Queries ─────────────────────────────────────────────────────────────── */

/**
 * Look up a cached identify result by sample digest.
 *
 * `digestBuffer` is the raw 32-byte SHA-256 of the sample.
 *
 * Returns null on a miss or when the row has expired.
 * Increments hit_count and updates last_hit_at on a hit (fire-and-forget).
 */
export async function getCachedResult(
  db: SupabaseClient,
  digestBuffer: Buffer
): Promise<IdentifyCacheRow | null> {
  const digestHex = bufToHex(digestBuffer);

  const { data, error } = await db
    .from("identify_cache")
    .select("*")
    .eq("sample_sha256", digestHex)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const row = data as IdentifyCacheRow;

  // Fire-and-forget hit counter update — do not block the response.
  db.from("identify_cache")
    .update({
      hit_count: row.hit_count + 1,
      last_hit_at: new Date().toISOString(),
    })
    .eq("sample_sha256", digestHex)
    .then(() => undefined, () => undefined);

  return row;
}

export interface WriteCacheInput {
  digestBuffer: Buffer;
  sampleBytes: number;
  acrStatusCode: number;
  match: IdentifyMatch | null;
  ttlSeconds: number;
}

/**
 * Write a result to the cache.
 *
 * Uses upsert so a re-submitted identical sample updates the expiry rather
 * than creating a duplicate.
 */
export async function writeCachedResult(
  db: SupabaseClient,
  input: WriteCacheInput
): Promise<void> {
  if (input.ttlSeconds <= 0) return;

  const digestHex = bufToHex(input.digestBuffer);
  const expiresAt = new Date(
    Date.now() + input.ttlSeconds * 1_000
  ).toISOString();

  const { error } = await db.from("identify_cache").upsert(
    {
      sample_sha256: digestHex,
      sample_bytes: input.sampleBytes,
      acr_status_code: input.acrStatusCode,
      match: input.match,
      expires_at: expiresAt,
    },
    { onConflict: "sample_sha256" }
  );

  if (error) throw error;
}

/**
 * Delete expired cache rows.
 * Called by the cleanup task.
 */
export async function deleteExpiredCacheRows(
  db: SupabaseClient,
  before: Date
): Promise<number> {
  const { data, error } = await db
    .from("identify_cache")
    .delete()
    .lt("expires_at", before.toISOString())
    .select("sample_sha256");

  if (error) throw error;
  return (data as { sample_sha256: string }[]).length;
}

/* ── Internal helper ─────────────────────────────────────────────────────── */

function bufToHex(buf: Buffer): string {
  return `\\x${buf.toString("hex")}`;
}
