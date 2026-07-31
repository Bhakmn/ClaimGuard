/**
 * Query helpers: users
 *
 * Every function accepts a `db` parameter (the Supabase client) so callers
 * can pass a transaction-scoped client in future, and so tests can inject a
 * stub.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/* ── Row types ───────────────────────────────────────────────────────────── */

export interface UserRow {
  id: string;
  auth0_sub: string;
  email: string | null;
  email_verified: boolean;
  name: string | null;
  picture: string | null;
  created_at: string;
  updated_at: string;
  last_login_at: string;
}

export interface UpsertUserInput {
  auth0_sub: string;
  email: string | null;
  email_verified: boolean;
  name: string | null;
  picture: string | null;
}

/* ── Queries ─────────────────────────────────────────────────────────────── */

/**
 * Find a user by Auth0 subject.
 * Returns `null` when no row exists.
 */
export async function findUserByAuth0Sub(
  db: SupabaseClient,
  auth0Sub: string
): Promise<UserRow | null> {
  const { data, error } = await db
    .from("users")
    .select("*")
    .eq("auth0_sub", auth0Sub)
    .maybeSingle();

  if (error) throw error;
  return (data as UserRow | null);
}

/**
 * Find a user by internal id.
 * Returns `null` when no row exists.
 */
export async function findUserById(
  db: SupabaseClient,
  id: string
): Promise<UserRow | null> {
  const { data, error } = await db
    .from("users")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  return (data as UserRow | null);
}

/**
 * Upsert a user from an Auth0 ID-token payload.
 *
 * Inserts on first login; on subsequent logins updates profile fields and
 * `last_login_at`.  Returns `{ user, isNew }` where `isNew` is true when
 * the row was just inserted (no prior row with this auth0_sub existed).
 *
 * `isNew` is determined by a SELECT-then-upsert pattern:
 *  1. Attempt to find the existing row.
 *  2. If missing, upsert (which may race — the upsert wins safely on conflict).
 *  3. Return whichever row we end up with, plus `isNew = !existed`.
 *
 * Ownership scope: no principal filtering — this is called from the auth
 * callback with credentials already verified by Auth0.
 */
export async function upsertUser(
  db: SupabaseClient,
  input: UpsertUserInput
): Promise<{ user: UserRow; isNew: boolean }> {
  // Check for an existing row first so we can report isNew accurately.
  const existing = await findUserByAuth0Sub(db, input.auth0_sub);

  const { data, error } = await db
    .from("users")
    .upsert(
      {
        auth0_sub: input.auth0_sub,
        email: input.email,
        email_verified: input.email_verified,
        name: input.name,
        picture: input.picture,
        last_login_at: new Date().toISOString(),
      },
      {
        onConflict: "auth0_sub",
      }
    )
    .select("*")
    .single();

  if (error) throw error;
  return { user: data as UserRow, isNew: existing === null };
}
