/**
 * Query helpers: oauth_states
 *
 * An OAuth state is valid when consumed_at is null and expires_at > now() and
 * the state value matches and the row id matches the cookie.
 *
 * Consumption is atomic: update … where consumed_at is null returning *
 * — zero rows means a replay.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/* ── Row type ────────────────────────────────────────────────────────────── */

export interface OAuthStateRow {
  id: string;
  provider: "auth0" | "tiktok";
  state: string;
  code_verifier: string;
  redirect_uri: string;
  return_to: string | null;
  session_id: string | null;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

/* ── Queries ─────────────────────────────────────────────────────────────── */

export interface CreateOAuthStateInput {
  provider: "auth0" | "tiktok";
  state: string;
  codeVerifier: string;
  redirectUri: string;
  returnTo: string | null;
  sessionId: string | null;
  expiresAt: Date;
}

/**
 * Insert a new OAuth state row.
 */
export async function createOAuthState(
  db: SupabaseClient,
  input: CreateOAuthStateInput
): Promise<OAuthStateRow> {
  const { data, error } = await db
    .from("oauth_states")
    .insert({
      provider: input.provider,
      state: input.state,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
      return_to: input.returnTo,
      session_id: input.sessionId,
      expires_at: input.expiresAt.toISOString(),
    })
    .select("*")
    .single();

  if (error) throw error;
  return data as OAuthStateRow;
}

/**
 * Atomically consume an OAuth state.
 *
 * Validates that:
 *  - the row exists for this provider + state value
 *  - it has not already been consumed
 *  - it has not expired
 *
 * Sets consumed_at to now() and returns the row.
 * Returns null when any condition fails (replay, expiry, mismatch).
 */
export async function consumeOAuthState(
  db: SupabaseClient,
  provider: "auth0" | "tiktok",
  state: string
): Promise<OAuthStateRow | null> {
  const now = new Date().toISOString();

  // Atomic compare-and-set: only matches unconsumed, unexpired rows.
  const { data, error } = await db
    .from("oauth_states")
    .update({ consumed_at: now })
    .eq("provider", provider)
    .eq("state", state)
    .is("consumed_at", null)
    .gt("expires_at", now)
    .select("*")
    .maybeSingle();

  if (error) throw error;
  return (data as OAuthStateRow | null);
}

/**
 * Delete expired or consumed oauth_states rows older than `before`.
 * Called by the cleanup task.
 */
export async function deleteStaleOAuthStates(
  db: SupabaseClient,
  before: Date
): Promise<number> {
  const { data, error } = await db
    .from("oauth_states")
    .delete()
    .or(
      `expires_at.lt.${before.toISOString()},consumed_at.lt.${before.toISOString()}`
    )
    .select("id");

  if (error) throw error;
  return (data as { id: string }[]).length;
}
