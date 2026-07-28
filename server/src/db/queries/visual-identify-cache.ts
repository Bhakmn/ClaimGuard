/**
 * Query helpers: visual_identify_cache
 *
 * Content-addressed: keyed by SHA-256 of the raw frame bytes (32 raw bytes
 * stored as bytea, same scheme as identify_cache).
 * Setting VISUAL_IDENTIFY_CACHE_TTL_SECONDS to 0 disables reads and writes.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/* ── Row type ─────────────────────────────────────────────────────────────── */

export interface VisualCacheRow {
  frame_sha256: string; // Supabase returns bytea as hex string ("\x...")
  frame_bytes: number;
  source: string;
  result: VisualMatch | null;
  created_at: string;
  expires_at: string;
  hit_count: number;
  last_hit_at: string | null;
}

/**
 * Normalised result stored in the cache.
 * `signals` mirrors FlaggedVisualSpan.signals on the client.
 */
export interface VisualMatch {
  label: string;
  signals: string[];
  reasoning: string;
  confidence: number;
  source: "heuristic" | "granite_vision";
}

/* ── Queries ──────────────────────────────────────────────────────────────── */

export async function getVisualCachedResult(
  db: SupabaseClient,
  digestBuffer: Buffer
): Promise<VisualCacheRow | null> {
  const digestHex = bufToHex(digestBuffer);

  const { data, error } = await db
    .from("visual_identify_cache")
    .select("*")
    .eq("frame_sha256", digestHex)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const row = data as VisualCacheRow;

  // Fire-and-forget hit counter — do not block the response.
  db.from("visual_identify_cache")
    .update({
      hit_count: row.hit_count + 1,
      last_hit_at: new Date().toISOString(),
    })
    .eq("frame_sha256", digestHex)
    .then(() => undefined, () => undefined);

  return row;
}

export interface WriteVisualCacheInput {
  digestBuffer: Buffer;
  frameBytes: number;
  source: "heuristic" | "granite_vision";
  result: VisualMatch | null;
  ttlSeconds: number;
}

export async function writeVisualCachedResult(
  db: SupabaseClient,
  input: WriteVisualCacheInput
): Promise<void> {
  if (input.ttlSeconds <= 0) return;

  const digestHex = bufToHex(input.digestBuffer);
  const expiresAt = new Date(
    Date.now() + input.ttlSeconds * 1_000
  ).toISOString();

  const { error } = await db.from("visual_identify_cache").upsert(
    {
      frame_sha256: digestHex,
      frame_bytes: input.frameBytes,
      source: input.source,
      result: input.result,
      expires_at: expiresAt,
    },
    { onConflict: "frame_sha256" }
  );

  if (error) throw error;
}

export async function deleteExpiredVisualCacheRows(
  db: SupabaseClient,
  before: Date
): Promise<number> {
  const { data, error } = await db
    .from("visual_identify_cache")
    .delete()
    .lt("expires_at", before.toISOString())
    .select("frame_sha256");

  if (error) throw error;
  return (data as { frame_sha256: string }[]).length;
}

/* ── Internal helper ──────────────────────────────────────────────────────── */

function bufToHex(buf: Buffer): string {
  return `\\x${buf.toString("hex")}`;
}
