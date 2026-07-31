/**
 * Query helpers: oauth_connections
 *
 * Tokens are stored as three separate bytea columns per token:
 *   *_ciphertext  — AES-256-GCM ciphertext
 *   *_iv          — 12-byte nonce
 *   *_tag         — 16-byte auth tag
 *
 * Application code uses lib/crypto.ts seal/open; nothing in this file
 * handles plaintext tokens.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/* ── Row types ───────────────────────────────────────────────────────────── */

/** Raw row as returned from the database. Tokens are still encrypted. */
export interface OAuthConnectionRow {
  id: string;
  provider: string;
  user_id: string | null;
  session_id: string | null;
  provider_account_id: string | null;
  scope: string;
  access_token_ciphertext: string; // Supabase returns bytea as hex string
  access_token_iv: string;
  access_token_tag: string;
  access_token_expires_at: string;
  refresh_token_ciphertext: string | null;
  refresh_token_iv: string | null;
  refresh_token_tag: string | null;
  refresh_token_expires_at: string | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/* ── Queries ─────────────────────────────────────────────────────────────── */

/**
 * Find the active (non-revoked) connection for a principal and provider.
 *
 * Ownership rule: if userId is non-null, filter on user_id.
 * Otherwise, if sessionId is non-null, filter on session_id (anonymous).
 * Returns null when no connection exists.
 */
export async function findActiveConnection(
  db: SupabaseClient,
  provider: string,
  userId: string | null,
  sessionId: string | null
): Promise<OAuthConnectionRow | null> {
  if (!userId && !sessionId) return null;

  let query = db
    .from("oauth_connections")
    .select("*")
    .eq("provider", provider)
    .is("revoked_at", null)
    .order("updated_at", { ascending: false })
    .limit(1);

  if (userId) {
    query = query.eq("user_id", userId);
  } else {
    query = query.eq("session_id", sessionId!).is("user_id", null);
  }

  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return (data as OAuthConnectionRow | null);
}

/**
 * Find a connection by its internal id.
 * Scoped to the owning principal — never returns a row owned by someone else.
 */
export async function findConnectionById(
  db: SupabaseClient,
  id: string,
  userId: string | null,
  sessionId: string | null
): Promise<OAuthConnectionRow | null> {
  if (!userId && !sessionId) return null;

  let query = db
    .from("oauth_connections")
    .select("*")
    .eq("id", id)
    .is("revoked_at", null);

  if (userId) {
    query = query.eq("user_id", userId);
  } else {
    query = query.eq("session_id", sessionId!).is("user_id", null);
  }

  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return (data as OAuthConnectionRow | null);
}

export interface UpsertConnectionInput {
  provider: string;
  userId: string | null;
  sessionId: string | null;
  providerAccountId: string | null;
  scope: string;
  accessTokenCiphertext: Buffer;
  accessTokenIv: Buffer;
  accessTokenTag: Buffer;
  accessTokenExpiresAt: Date;
  refreshTokenCiphertext: Buffer | null;
  refreshTokenIv: Buffer | null;
  refreshTokenTag: Buffer | null;
  refreshTokenExpiresAt: Date | null;
}

/**
 * Upsert a connection for a principal.
 *
 * When an active connection already exists for (provider, user_id) or
 * (provider, session_id), it is updated in place — Supabase upsert on the
 * partial unique index is not directly supported, so we do a two-step
 * find-then-update-or-insert.
 */
export async function upsertConnection(
  db: SupabaseClient,
  input: UpsertConnectionInput
): Promise<OAuthConnectionRow> {
  // Try to find an existing active row for this principal+provider.
  const existing = await findActiveConnection(
    db,
    input.provider,
    input.userId,
    input.sessionId
  );

  const payload = {
    provider: input.provider,
    user_id: input.userId,
    session_id: input.sessionId,
    provider_account_id: input.providerAccountId,
    scope: input.scope,
    // bytea columns: Supabase accepts Buffer as hex-escaped literal
    access_token_ciphertext: bufToHex(input.accessTokenCiphertext),
    access_token_iv: bufToHex(input.accessTokenIv),
    access_token_tag: bufToHex(input.accessTokenTag),
    access_token_expires_at: input.accessTokenExpiresAt.toISOString(),
    refresh_token_ciphertext: input.refreshTokenCiphertext
      ? bufToHex(input.refreshTokenCiphertext)
      : null,
    refresh_token_iv: input.refreshTokenIv
      ? bufToHex(input.refreshTokenIv)
      : null,
    refresh_token_tag: input.refreshTokenTag
      ? bufToHex(input.refreshTokenTag)
      : null,
    refresh_token_expires_at: input.refreshTokenExpiresAt?.toISOString() ?? null,
  };

  if (existing) {
    const { data, error } = await db
      .from("oauth_connections")
      .update(payload)
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) throw error;
    return data as OAuthConnectionRow;
  }

  const { data, error } = await db
    .from("oauth_connections")
    .insert(payload)
    .select("*")
    .single();
  if (error) throw error;
  return data as OAuthConnectionRow;
}

/**
 * Adopt an anonymous connection onto a user account after login.
 *
 * When a user already has an active connection for the same provider, revoke
 * the anonymous one instead to avoid violating the partial unique index.
 */
export async function adoptOrRevokeAnonConnection(
  db: SupabaseClient,
  provider: string,
  sessionId: string,
  userId: string
): Promise<void> {
  // Does the user already own a connection for this provider?
  const userConn = await findActiveConnection(db, provider, userId, null);

  const { error } = await db
    .from("oauth_connections")
    .update(
      userConn
        ? { revoked_at: new Date().toISOString() }
        : { user_id: userId, session_id: null }
    )
    .eq("provider", provider)
    .eq("session_id", sessionId)
    .is("user_id", null)
    .is("revoked_at", null);

  if (error) throw error;
}

/**
 * Revoke all active (non-revoked) connections for an owner+provider.
 *
 * Used during callback to replace rather than accumulate connections —
 * the new connection is inserted after all prior ones are revoked.
 */
export async function revokeActiveConnectionsForOwner(
  db: SupabaseClient,
  provider: string,
  userId: string | null,
  sessionId: string | null
): Promise<void> {
  if (!userId && !sessionId) return;

  let query = db
    .from("oauth_connections")
    .update({ revoked_at: new Date().toISOString() })
    .eq("provider", provider)
    .is("revoked_at", null);

  if (userId) {
    query = query.eq("user_id", userId);
  } else {
    query = query.eq("session_id", sessionId!).is("user_id", null);
  }

  const { error } = await query;
  if (error) throw error;
}

/**
 * Revoke a connection — sets revoked_at.
 * Scoped to the owning principal.
 */
export async function revokeConnection(
  db: SupabaseClient,
  id: string,
  userId: string | null,
  sessionId: string | null
): Promise<void> {
  if (!userId && !sessionId) return;

  let query = db
    .from("oauth_connections")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .is("revoked_at", null);

  if (userId) {
    query = query.eq("user_id", userId);
  } else {
    query = query.eq("session_id", sessionId!).is("user_id", null);
  }

  const { error } = await query;
  if (error) throw error;
}

/**
 * Touch last_used_at for a connection.
 */
export async function touchConnection(
  db: SupabaseClient,
  id: string
): Promise<void> {
  const { error } = await db
    .from("oauth_connections")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

/**
 * Hard-delete connections that were revoked before `before`.
 * Called by the cleanup task (90-day grace after revocation).
 */
export async function deleteOldRevokedConnections(
  db: SupabaseClient,
  before: Date
): Promise<number> {
  const { data, error } = await db
    .from("oauth_connections")
    .delete()
    .lt("revoked_at", before.toISOString())
    .not("revoked_at", "is", null)
    .select("id");
  if (error) throw error;
  return (data as { id: string }[]).length;
}

/* ── Internal helper ─────────────────────────────────────────────────────── */

/**
 * Convert a Buffer to the hex string format Supabase expects for bytea
 * columns: "\x" prefix followed by lowercase hex pairs.
 */
function bufToHex(buf: Buffer): string {
  return `\\x${buf.toString("hex")}`;
}
