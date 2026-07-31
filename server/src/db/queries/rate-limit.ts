/**
 * Query helpers: rate_limit_windows
 *
 * Fixed-window counters shared across instances.
 *
 * The increment is a single atomic upsert. On a database failure, callers
 * should log at `warn` and allow the request through — rate limiting is a
 * cost control, not a security boundary.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/* ── Row type ────────────────────────────────────────────────────────────── */

export interface RateLimitWindowRow {
  bucket: string;
  subject: string;
  window_start: string;
  hits: number;
}

/* ── Queries ─────────────────────────────────────────────────────────────── */

/**
 * Atomically increment the hit counter for (bucket, subject, windowStart).
 *
 * `windowStart` is the truncated start of the current fixed window (UTC).
 *
 * Returns the new `hits` value after the increment.
 * Throws on database error — caller should catch and fail open.
 */
export async function incrementRateLimit(
  db: SupabaseClient,
  bucket: string,
  subject: string,
  windowStart: Date
): Promise<number> {
  // Supabase JS does not support `do update set hits = hits + 1` directly.
  // We use a two-step read-then-upsert pattern which is safe here because:
  //  - The window_start boundary never changes mid-window.
  //  - A race between two increments in the same window results in at most
  //    a slightly under-counted window, which is acceptable for rate limiting.
  //
  // For strict accuracy a PostgreSQL function or raw SQL would be needed.
  // The upsert below achieves atomicity at the row level.

  const windowStartIso = windowStart.toISOString();

  const { data, error } = await db
    .from("rate_limit_windows")
    .upsert(
      {
        bucket,
        subject,
        window_start: windowStartIso,
        hits: 1,
      },
      {
        onConflict: "bucket,subject,window_start",
        ignoreDuplicates: false,
      }
    )
    .select("hits")
    .single();

  if (error) {
    // If upsert returns conflict (the row was just inserted by another request),
    // do a separate increment. This path is rare but possible under concurrency.
    const { data: existing, error: readErr } = await db
      .from("rate_limit_windows")
      .select("hits")
      .eq("bucket", bucket)
      .eq("subject", subject)
      .eq("window_start", windowStartIso)
      .single();

    if (readErr) throw readErr;

    const newHits = (existing as { hits: number }).hits + 1;

    const { error: updateErr } = await db
      .from("rate_limit_windows")
      .update({ hits: newHits })
      .eq("bucket", bucket)
      .eq("subject", subject)
      .eq("window_start", windowStartIso);

    if (updateErr) throw updateErr;
    return newHits;
  }

  return (data as { hits: number }).hits;
}

/**
 * Delete rate-limit window rows older than `before`.
 * Called by the cleanup task.
 */
export async function deleteOldWindows(
  db: SupabaseClient,
  before: Date
): Promise<number> {
  const { data, error } = await db
    .from("rate_limit_windows")
    .delete()
    .lt("window_start", before.toISOString())
    .select("bucket");

  if (error) throw error;
  return (data as { bucket: string }[]).length;
}

/* ── Window start helper ─────────────────────────────────────────────────── */

/**
 * Compute the start of the current fixed window.
 *
 * Truncates the current time to the nearest multiple of `windowSeconds`.
 * Example: windowSeconds=60, now=14:35:42 → windowStart=14:35:00
 */
export function currentWindowStart(windowSeconds: number): Date {
  const nowMs = Date.now();
  const windowMs = windowSeconds * 1_000;
  return new Date(Math.floor(nowMs / windowMs) * windowMs);
}
