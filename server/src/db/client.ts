/**
 * Supabase service-role client — single instance for the whole process.
 *
 * Uses the service-role key, which bypasses Row Level Security.  Every query
 * must scope itself to the authenticated principal in application code rather
 * than relying on RLS policies.
 *
 * Export `db` for use everywhere; do not create additional client instances.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getConfig } from "../config/env.js";

let _client: SupabaseClient | null = null;

export function getDb(): SupabaseClient {
  if (_client) return _client;

  const cfg = getConfig();
  _client = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      // Service-role key — disable Auth0 session management inside the client.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    db: {
      schema: "public",
    },
    global: {
      headers: {
        // Statement timeout sent as a PostgREST header so every query honours it.
        "statement-timeout": String(cfg.DB_STATEMENT_TIMEOUT_MS),
      },
    },
  });

  return _client;
}

/**
 * Lightweight database connectivity probe.
 * Runs `SELECT 1` with the given timeout and resolves with the round-trip ms.
 * Throws on any error or timeout.
 */
export async function probeDatabase(timeoutMs: number): Promise<number> {
  const start = Date.now();

  const timer = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`Database probe timed out after ${timeoutMs} ms`)),
      timeoutMs
    )
  );

  // Lightweight round-trip: HEAD on the sessions table — zero rows transferred.
  const selectProbe = getDb()
    .from("sessions")
    .select("id", { count: "exact", head: true });

  const result = await Promise.race([
    selectProbe,
    timer,
  ]);

  // If the timer fired it would have thrown; we have a Supabase result here.
  const { error } = result as Awaited<typeof selectProbe>;
  if (error) {
    throw new Error(`Database probe failed: ${error.message}`);
  }

  return Date.now() - start;
}
