/**
 * Routes: Auth0 authorization-code flow with PKCE
 *
 *   GET /auth/login    — begin flow → redirect to Auth0
 *   GET /auth/callback — exchange code, verify token, issue session → redirect home
 *   GET /auth/logout   — revoke session → redirect to Auth0 end_session
 *
 * Security requirements satisfied here (§6 of 04-authentication.md):
 *  - State compared with timingSafeEqual (§6, timing)
 *  - returnTo validated as single-leading-/ path (§6, open redirect)
 *  - Session fixation closed: pre-login anonymous session revoked, new id issued (§6)
 *  - Access token discarded immediately after exchange (§4.4)
 *  - No OAuth params logged: code, state, id_token never in log lines
 *  - Discovery-sourced URLs used for authorization, token, logout endpoints (§4.1)
 */

import crypto from "node:crypto";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import { getConfig } from "../config/env.js";
import { getDb } from "../db/client.js";
import { upsertUser } from "../db/queries/users.js";
import {
  createSession,
  revokeSession,
} from "../db/queries/sessions.js";
import {
  createOAuthState,
  consumeOAuthState,
} from "../db/queries/oauth-states.js";
import { adoptOrRevokeAnonConnection } from "../db/queries/oauth-connections.js";
import {
  SESSION_COOKIE_NAME,
  AUTH_STATE_COOKIE_NAME,
} from "../plugins/principal.js";
import { defaultCookieOpts } from "../plugins/cookies.js";
import { applyRateLimit } from "../plugins/rate-limit.js";
import {
  exchangeCode,
  verifyIdToken,
  buildAuthUrl,
  buildLogoutUrl,
  sanitiseClaims,
} from "../services/auth0.js";
import { OAUTH_STATE_TTL_SECONDS } from "../config/constants.js";

/* ── returnTo validation ─────────────────────────────────────────────────── */

// Accept only a string that:
//  - starts with exactly one "/"
//  - does not start with "//"  (open-redirect via protocol-relative URL)
//  - contains no control characters
//  - is at most 512 characters
const RETURN_TO_RE = /^\/(?!\/).{0,511}$/;

function validateReturnTo(raw: unknown): string {
  if (typeof raw !== "string") return "/";
  const s = raw.replace(/[\x00-\x1f\x7f]/g, "");
  return RETURN_TO_RE.test(s) ? s : "/";
}

/* ── Timing-safe state comparison ────────────────────────────────────────── */

/**
 * Compare two state strings in constant time.
 * Returns false (not just throwing) on a length mismatch to avoid timing
 * differences from early-exit length checks.
 */
function stateEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Run a dummy comparison anyway to consume consistent time, then return false.
    crypto.timingSafeEqual(bufA.slice(0, 1), bufA.slice(0, 1));
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/* ── Cookie helpers ──────────────────────────────────────────────────────── */

function clearCookie(reply: FastifyReply, name: string): void {
  reply.setCookie(name, "", {
    ...defaultCookieOpts(),
    maxAge: 0,
    signed: false,
  });
}

/* ── Login-unavailable HTML (§7) ─────────────────────────────────────────── */

const loginUnavailableHtml = `<!doctype html>
<meta charset="utf-8">
<title>ClaimGuard</title>
<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#F4F1EA;color:#1F1F1F">
<p>Sign-in is not available on this server.</p>
</body>`;

/* ── Route plugin ────────────────────────────────────────────────────────── */

const authRoutes: FastifyPluginAsync = async (fastify) => {

  /* ── GET /auth/login ────────────────────────────────────────────────────── */
  fastify.get(
    "/auth/login",
    {
      preHandler: [
        applyRateLimit({ bucket: "auth_login", max: 20, windowSeconds: 600 }),
      ],
    },
    async (request, reply) => {
      const cfg = getConfig();

      if (!cfg.authEnabled) {
        return reply
          .status(503)
          .type("text/html; charset=utf-8")
          .send(loginUnavailableHtml);
      }

      const qs = request.query as Record<string, string>;
      const screenHint = qs["screen_hint"] === "signup" ? "signup" : undefined;
      const returnTo = validateReturnTo(qs["returnTo"]);

      // PKCE: verifier = 32 random bytes as 64 hex chars (§4.2)
      const stateNonce = crypto.randomBytes(16).toString("hex");
      const codeVerifier = crypto.randomBytes(32).toString("hex");
      const codeChallenge = crypto
        .createHash("sha256")
        .update(codeVerifier, "ascii")
        .digest("base64url");

      const redirectUri = `${cfg.API_BASE_URL}/auth/callback`;

      const stateRow = await createOAuthState(getDb(), {
        provider: "auth0",
        state: stateNonce,
        codeVerifier,
        redirectUri,
        returnTo,
        sessionId: request.principal.sessionId,
        expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_SECONDS * 1_000),
      });

      reply.setCookie(AUTH_STATE_COOKIE_NAME, stateRow.id, {
        ...defaultCookieOpts(),
        maxAge: OAUTH_STATE_TTL_SECONDS,
        signed: true,
      });

      // Build authorization URL from discovered endpoint (§4.1)
      const authUrl = await buildAuthUrl(
        {
          clientId: cfg.AUTH0_CLIENT_ID!,
          redirectUri,
          scope: cfg.AUTH0_SCOPE,
          state: stateNonce,
          codeChallenge,
          ...(screenHint !== undefined ? { screenHint } : {}),
        },
        request.log
      );

      return reply
        .header("cache-control", "no-store")
        .redirect(authUrl, 302);
    }
  );

  /* ── GET /auth/callback ─────────────────────────────────────────────────── */
  fastify.get(
    "/auth/callback",
    {
      preHandler: [
        applyRateLimit({ bucket: "auth_callback", max: 40, windowSeconds: 600 }),
      ],
    },
    async (request, reply) => {
      const cfg = getConfig();
      const qs = request.query as Record<string, string>;
      const db = getDb();

      // Helper: redirect to the frontend with an error code and clear the state cookie
      const failRedirect = (code: string) => {
        clearCookie(reply, AUTH_STATE_COOKIE_NAME);
        return reply
          .header("cache-control", "no-store")
          .redirect(`${cfg.APP_BASE_URL}/?auth_error=${code}`, 302);
      };

      // §7: Auth0 not configured
      if (!cfg.authEnabled) return failRedirect("unavailable");

      // User declined consent (Auth0 sent error=access_denied or similar)
      if (qs["error"]) return failRedirect("access_denied");

      // ── State cookie ──────────────────────────────────────────────────────
      const rawStateCookie = request.cookies[AUTH_STATE_COOKIE_NAME];
      if (!rawStateCookie) return failRedirect("state_expired");

      const { valid: cookieValid, value: stateRowId } =
        request.unsignCookie(rawStateCookie);
      if (!cookieValid || !stateRowId) return failRedirect("state_expired");

      // ── State row: atomic consume ─────────────────────────────────────────
      // consumeOAuthState does: UPDATE … WHERE state=$stateParam AND consumed_at IS NULL
      // returning the row.  Zero rows = replay.  We then check the row id matches
      // the cookie value with timingSafeEqual to close the timing channel.
      const incomingState = qs["state"] ?? "";
      const stateRow = await consumeOAuthState(db, "auth0", incomingState);

      if (
        !stateRow ||
        !stateEqual(stateRow.id, stateRowId)
      ) {
        return failRedirect("state_mismatch");
      }

      const code = qs["code"];
      if (!code) return failRedirect("exchange_failed");

      // ── Token exchange (§4.4) ─────────────────────────────────────────────
      let idToken: string;
      try {
        const result = await exchangeCode(
          code,
          stateRow.code_verifier,
          stateRow.redirect_uri,
          request.log
        );
        idToken = result.idToken;
        // Access token is already discarded inside exchangeCode()
      } catch {
        return failRedirect("exchange_failed");
      }

      // ── ID-token verification (§4.5) ──────────────────────────────────────
      let claims: Awaited<ReturnType<typeof verifyIdToken>>;
      try {
        claims = await verifyIdToken(idToken, request.log);
      } catch {
        return failRedirect("token_invalid");
      }

      // ── User upsert (§4.6) ────────────────────────────────────────────────
      // Claims are already sanitised by verifyIdToken → sanitiseClaims.
      const { user, isNew } = await upsertUser(db, {
        auth0_sub: claims.sub,
        email: claims.email ?? null,
        email_verified: claims.email_verified ?? false,
        name: claims.name ?? null,
        picture: claims.picture ?? null,
      });

      // ── Session creation ──────────────────────────────────────────────────
      const userAgent = String(request.headers["user-agent"] ?? "").slice(0, 512);
      const session = await createSession(db, {
        userId: user.id,
        expiresAt: new Date(Date.now() + cfg.SESSION_TTL_SECONDS * 1_000),
        ip: request.ip ?? null,
        userAgent: userAgent || null,
      });

      request.log.info(
        { sessionId: session.id, userId: user.id, isNewUser: isNew },
        "Session issued"
      );

      // ── Anonymous TikTok connection adoption (§4.7) ───────────────────────
      const preLoginSessionId = stateRow.session_id;
      if (preLoginSessionId) {
        await adoptOrRevokeAnonConnection(
          db, "tiktok", preLoginSessionId, user.id
        ).catch((err) => {
          request.log.warn({ err }, "Failed to adopt anonymous TikTok connection");
        });

        // Session fixation: revoke the pre-login anonymous session (§6)
        await revokeSession(db, preLoginSessionId, null).catch((err) => {
          request.log.warn({ err }, "Failed to revoke pre-login session");
        });
      }

      // ── Issue cookie (§2.2) ───────────────────────────────────────────────
      const returnTo = stateRow.return_to ?? "/";

      clearCookie(reply, AUTH_STATE_COOKIE_NAME);
      reply.setCookie(SESSION_COOKIE_NAME, session.id, {
        ...defaultCookieOpts(),
        maxAge: cfg.SESSION_TTL_SECONDS,
        signed: true,
      });

      return reply
        .header("cache-control", "no-store")
        .redirect(`${cfg.APP_BASE_URL}${returnTo}`, 302);
    }
  );

  /* ── GET /auth/logout ────────────────────────────────────────────────────── */
  fastify.get(
    "/auth/logout",
    {
      preHandler: [
        applyRateLimit({ bucket: "auth_logout", max: 30, windowSeconds: 600 }),
      ],
    },
    async (request, reply) => {
      const cfg = getConfig();
      const { principal } = request;

      // Revoke local session first (§4.8) — happens even if Auth0 redirect fails
      if (principal.sessionId) {
        await revokeSession(
          getDb(),
          principal.sessionId,
          principal.userId
        ).catch((err) => {
          request.log.warn({ err }, "Failed to revoke session on logout");
        });
        request.log.info(
          { sessionId: principal.sessionId, reason: "logout" },
          "Session revoked"
        );
      }

      clearCookie(reply, SESSION_COOKIE_NAME);

      // When Auth0 is not configured, redirect home only (§7)
      if (!cfg.authEnabled) {
        return reply
          .header("cache-control", "no-store")
          .redirect(cfg.APP_BASE_URL, 302);
      }

      // Build logout URL from discovered end_session_endpoint (§4.8)
      const logoutUrl = await buildLogoutUrl(
        cfg.AUTH0_CLIENT_ID!,
        cfg.APP_BASE_URL,
        request.log
      );

      return reply
        .header("cache-control", "no-store")
        .redirect(logoutUrl, 302);
    }
  );
};

export default fp(authRoutes, { name: "route-auth", fastify: "5.x" });
