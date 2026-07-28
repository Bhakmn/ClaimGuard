import { apiUrl } from "./config";

/* ─── Types ─────────────────────────────────────────────────────────────── */

export type SessionResponse = {
  authEnabled: boolean;
  user: {
    id: string;
    name?: string;
    email?: string;
    picture?: string;
  } | null;
};

/* ─── Server-side session fetch ─────────────────────────────────────────── */

/**
 * Read the current session from the backend.
 *
 * Runs during server render in the page shell, so the browser's cookies must
 * be forwarded by hand — a server-side fetch carries none of its own.
 *
 * A backend that is down must render the editor signed out, never a server
 * error. Errors degrade gracefully to { authEnabled: false, user: null }.
 */
export async function fetchSession(
  cookieHeader: string,
): Promise<SessionResponse> {
  try {
    const res = await fetch(apiUrl("/api/session"), {
      headers: cookieHeader ? { cookie: cookieHeader } : {},
      cache: "no-store",
    });
    if (!res.ok) return { authEnabled: false, user: null };
    return (await res.json()) as SessionResponse;
  } catch {
    return { authEnabled: false, user: null };
  }
}
