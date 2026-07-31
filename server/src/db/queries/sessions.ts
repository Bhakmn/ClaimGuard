/**
 * Query helpers: sessions
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/* ── Row type ────────────────────────────────────────────────────────────── */

export interface SessionRow {
  id: string;
  user_id: string | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
  ip: string | null;
  user_agent: string | null;
}

/* ── Queries ─────────────────────────────────────────────────────────────── */

/**
 * Load a session by id.
 *
 * Returns `null` when the row does not exist, is revoked, is past its
 * `expires_at`, or is past its idle TTL.  The caller supplies the idle TTL
 * cutoff as a Date so the policy lives in application code.
 */
export async function loadSession(
  db: SupabaseClient,
  id: string,
  idleCutoff: Date
): Promise<SessionRow | null> {
  const { data, error } = await db
    .from("sessions")
    .select("*")
    .eq("id", id)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .gt("last_seen_at", idleCutoff.toISOString())
    .maybeSingle();

  if (error) throw error;
  return (data as SessionRow | null);
}

export interface CreateSessionInput {
  userId: string | null;
  expiresAt: Date;
  ip: string | null;
  userAgent: string | null;
}

/**
 * Create a new session row.
 */
export async function createSession(
  db: SupabaseClient,
  input: CreateSessionInput
): Promise<SessionRow> {
  const { data, error } = await db
    .from("sessions")
    .insert({
      user_id: input.userId,
      expires_at: input.expiresAt.toISOString(),
      ip: input.ip,
      user_agent: input.userAgent
        ? input.userAgent.slice(0, 512)
        : null,
    })
    .select("*")
    .single();

  if (error) throw error;
  return data as SessionRow;
}

/**
 * Attach a user to an anonymous session (upgrade on login).
 */
export async function attachUserToSession(
  db: SupabaseClient,
  sessionId: string,
  userId: string
): Promise<void> {
  const { error } = await db
    .from("sessions")
    .update({ user_id: userId })
    .eq("id", sessionId)
    .is("user_id", null);

  if (error) throw error;
}

/**
 * Touch `last_seen_at` for a session.
 * Called at most once per SESSION_TOUCH_INTERVAL_MS per session.
 */
export async function touchSession(
  db: SupabaseClient,
  sessionId: string
): Promise<void> {
  const { error } = await db
    .from("sessions")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", sessionId);

  if (error) throw error;
}

/**
 * Revoke a session — sets `revoked_at` to now.
 * Scoped to a principal: only the owning user or the session itself can revoke.
 */
export async function revokeSession(
  db: SupabaseClient,
  sessionId: string,
  /** userId for an authenticated revoke; null to revoke by session id alone */
  userId: string | null
): Promise<void> {
  let query = db
    .from("sessions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", sessionId)
    .is("revoked_at", null);

  if (userId !== null) {
    query = query.eq("user_id", userId);
  }

  const { error } = await query;
  if (error) throw error;
}

/**
 * Hard-delete sessions that expired or were revoked before `before`.
 * Called by the cleanup task.
 */
export async function deleteExpiredSessions(
  db: SupabaseClient,
  before: Date
): Promise<number> {
  const { data, error } = await db
    .from("sessions")
    .delete()
    .or(
      `expires_at.lt.${before.toISOString()},revoked_at.lt.${before.toISOString()}`
    )
    .select("id");

  if (error) throw error;
  return (data as { id: string }[]).length;
}
