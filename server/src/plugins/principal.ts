/**
 * Plugin: principal resolution
 *
 * Resolves the authenticated identity from the signed session cookie and
 * decorates every request with `request.principal` before any route handler
 * or rate limiter runs.
 *
 * Principal shape:
 *
 *   {
 *     sessionId: string | null;     // null when no valid cookie exists
 *     userId: string | null;        // null for anonymous / sessionless
 *     isAuthenticated: boolean;     // userId !== null
 *     rateKey: string;              // "user:<id>" | "session:<id>" | "ip:<prefix>"
 *   }
 *
 * Resolution order (§3 of 04-authentication.md):
 *  1. No cookie / invalid signature   → anonymous, rateKey = "ip:<addr>"
 *  2. Cookie valid, row unusable      → clear cookie, same as (1)
 *  3. Row usable, user_id null        → rateKey = "session:<id>"
 *  4. Row usable, user_id set         → rateKey = "user:<id>", isAuthenticated = true
 *
 * A session is "unusable" when:
 *   - the row does not exist
 *   - revoked_at is not null
 *   - expires_at <= now()
 *   - last_seen_at <= now() - SESSION_IDLE_TTL_SECONDS
 *
 * `last_seen_at` is refreshed at most once per SESSION_TOUCH_INTERVAL_MS using
 * a conditional SQL update (no write if the column is already recent).
 *
 * Sessions are never created here.
 *
 * IPv6 client addresses are normalised to their /64 prefix so a single client
 * cannot walk the address space to multiply rate-limit quota.
 *
 * The cookie-clear signal (_clearSessionCookie flag) is acted on in an onSend
 * hook so the Set-Cookie header reaches the response even from an async hook.
 */

import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { getDb } from "../db/client.js";
import { getConfig } from "../config/env.js";
import { defaultCookieOpts } from "./cookies.js";
import { SESSION_TOUCH_INTERVAL_MS } from "../config/constants.js";
import { UnauthorizedError } from "../lib/errors.js";

/* ── Cookie names (spec §2.1) ────────────────────────────────────────────── */

/** Session cookie (spec: cg_session). */
export const SESSION_COOKIE_NAME = "cg_session";
/** In-flight Auth0 state cookie. */
export const AUTH_STATE_COOKIE_NAME = "cg_auth_state";
/** In-flight TikTok state cookie. */
export const TIKTOK_STATE_COOKIE_NAME = "cg_tiktok_state";

/* ── Principal type ──────────────────────────────────────────────────────── */

export interface Principal {
  sessionId: string | null;
  userId: string | null;
  isAuthenticated: boolean;
  rateKey: string;
}

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal;
    /** Set by resolvePrincipal when a stale cookie should be cleared. */
    _clearSessionCookie?: boolean;
  }
}

/* ── Placeholder for the decorator initial value ─────────────────────────── */

const PRINCIPAL_PLACEHOLDER: Principal = {
  sessionId: null,
  userId: null,
  isAuthenticated: false,
  rateKey: "ip:unknown",
};

/* ── Plugin ──────────────────────────────────────────────────────────────── */

const principalPlugin: FastifyPluginAsync = async (fastify) => {
  // Fastify 5 requires getter/setter pairs for object decorator types.
  fastify.decorateRequest<Principal>("principal", {
    getter() { return ((this as unknown as Record<string, unknown>)["__principal"] as Principal) ?? PRINCIPAL_PLACEHOLDER; },
    setter(val: Principal) { (this as unknown as Record<string, unknown>)["__principal"] = val; },
  });
  fastify.decorateRequest<boolean | undefined>("_clearSessionCookie", {
    getter() { return (this as unknown as Record<string, unknown>)["__clearSessionCookie"] as boolean | undefined; },
    setter(val: boolean | undefined) { (this as unknown as Record<string, unknown>)["__clearSessionCookie"] = val; },
  });

  // Resolve principal on every request before rate limiting sees it.
  fastify.addHook("preHandler", async (request: FastifyRequest) => {
    request.principal = await resolvePrincipal(request);
  });

  // Clear the session cookie when the resolver signalled to do so.
  fastify.addHook("onSend", async (request: FastifyRequest, reply: FastifyReply) => {
    if (request._clearSessionCookie) {
      reply.setCookie(SESSION_COOKIE_NAME, "", {
        ...defaultCookieOpts(),
        maxAge: 0,
        signed: false,
      });
    }
  });
};

export default fp(principalPlugin, {
  name: "principal",
  fastify: "5.x",
  dependencies: ["cookies"],
});

/* ── Resolution ──────────────────────────────────────────────────────────── */

async function resolvePrincipal(request: FastifyRequest): Promise<Principal> {
  const clientIp = normaliseIp(request.ip ?? "unknown");

  // 1. No cookie present
  const raw = request.cookies[SESSION_COOKIE_NAME];
  if (!raw) return anonymousPrincipal(clientIp);

  // 2. Signature verification
  const { valid, value: sessionId } = request.unsignCookie(raw);
  if (!valid || !sessionId) {
    request._clearSessionCookie = true;
    return anonymousPrincipal(clientIp);
  }

  const db = getDb();
  const cfg = getConfig();

  const now = new Date();
  const idleCutoff = new Date(now.getTime() - cfg.SESSION_IDLE_TTL_SECONDS * 1_000);

  // 3. Load and validate session row in one query (§2.3)
  const { data: session, error } = await db
    .from("sessions")
    .select("id, user_id, expires_at, last_seen_at, revoked_at")
    .eq("id", sessionId)
    .maybeSingle();

  if (error || !session) {
    request._clearSessionCookie = true;
    return anonymousPrincipal(clientIp);
  }

  // Check revoked_at
  if (session.revoked_at) {
    request._clearSessionCookie = true;
    return anonymousPrincipal(clientIp);
  }

  // Check absolute expiry
  if (new Date(session.expires_at as string) <= now) {
    request._clearSessionCookie = true;
    return anonymousPrincipal(clientIp);
  }

  // Check idle TTL
  if (new Date(session.last_seen_at as string) <= idleCutoff) {
    request._clearSessionCookie = true;
    return anonymousPrincipal(clientIp);
  }

  // 4. Conditionally touch last_seen_at (at most once per SESSION_TOUCH_INTERVAL_MS)
  const lastSeenMs = new Date(session.last_seen_at as string).getTime();
  if (now.getTime() - lastSeenMs > SESSION_TOUCH_INTERVAL_MS) {
    // Conditional update: only writes when last_seen_at is still old,
    // preventing a second concurrent request from writing unnecessarily.
    const touchCutoff = new Date(now.getTime() - SESSION_TOUCH_INTERVAL_MS);
    db.from("sessions")
      .update({ last_seen_at: now.toISOString() })
      .eq("id", sessionId)
      .lt("last_seen_at", touchCutoff.toISOString())
      .then(() => undefined, () => undefined);
  }

  const userId = (session.user_id as string | null) ?? null;

  if (userId) {
    // 4. Authenticated principal
    return {
      sessionId,
      userId,
      isAuthenticated: true,
      rateKey: `user:${userId}`,
    };
  }

  // 3. Anonymous with session
  return {
    sessionId,
    userId: null,
    isAuthenticated: false,
    rateKey: `session:${sessionId}`,
  };
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function anonymousPrincipal(ip: string): Principal {
  return {
    sessionId: null,
    userId: null,
    isAuthenticated: false,
    rateKey: `ip:${ip}`,
  };
}

/**
 * Normalise an IP address for use as a rate-limit key.
 *
 * IPv4 addresses are left as-is.
 * IPv6 addresses are truncated to their /64 prefix (first four groups) so a
 * single client cannot walk the remaining 64-bit address space to multiply quota.
 */
function normaliseIp(ip: string): string {
  // Strip zone ID if present (fe80::1%eth0 → fe80::1)
  const noZone = ip.includes("%") ? ip.split("%")[0]! : ip;

  // Detect IPv6: contains a colon
  if (!noZone.includes(":")) return noZone; // IPv4 or unknown

  // Expand compressed IPv6 to full form and take the first 4 groups (/64 prefix)
  try {
    const groups = expandIPv6(noZone);
    return groups.slice(0, 4).join(":");
  } catch {
    return noZone; // cannot parse — use as-is
  }
}

/**
 * Expand a potentially compressed IPv6 address into its 8 groups.
 * Throws on invalid input.
 */
function expandIPv6(addr: string): string[] {
  const halves = addr.split("::");
  if (halves.length > 2) throw new Error("invalid IPv6");

  const toGroups = (s: string) => (s === "" ? [] : s.split(":"));

  if (halves.length === 1) {
    const groups = toGroups(halves[0]!);
    if (groups.length !== 8) throw new Error("invalid IPv6");
    return groups;
  }

  const left = toGroups(halves[0]!);
  const right = toGroups(halves[1]!);
  const missing = 8 - left.length - right.length;
  const middle = Array<string>(missing).fill("0000");

  return [...left, ...middle, ...right];
}

/* ── Route-level auth guard ──────────────────────────────────────────────── */

/**
 * Assert the request carries a valid authenticated session.
 * Throws UnauthorizedError when not authenticated.
 * Use in preHandler hooks for routes that require a user account.
 */
export function requireAuth(request: FastifyRequest): void {
  if (!request.principal.isAuthenticated) {
    throw new UnauthorizedError("Sign in to continue.");
  }
}
