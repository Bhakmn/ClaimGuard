/**
 * Auth0 service client.
 *
 * Responsibilities:
 *  1. OIDC discovery — fetched once, cached in memory, with conventional
 *     fallback so a discovery outage does not break sign-in.
 *  2. Authorization URL construction.
 *  3. Token exchange (authorization_code → id_token + access_token).
 *  4. ID-token verification via JWKS (RS256, cached key set).
 *  5. Claim sanitisation: lowercase email, strip control chars, https-only picture.
 *
 * Nothing is stored — the ID-token claims are consumed here and then the
 * tokens are discarded.  The only Auth0 artefact that survives past this
 * file is the `sub` claim written to `users.auth0_sub`.
 *
 * Security rules enforced here:
 *  - Algorithm `RS256` required; `none` and HMAC algorithms rejected.
 *  - `sub` validated against THIRD_PARTY_ID_PATTERN before storage.
 *  - Email lowercased and length-capped.
 *  - `picture` dropped unless it parses as an https URL.
 *  - Clock skew tolerance: 300 s.
 *  - JWKS keys cached 600 s, re-fetched at most once per 30 s.
 *  - Tokens are NEVER logged.
 */

import { createRemoteJWKSet, jwtVerify } from "jose";
import { getConfig } from "../config/env.js";
import { httpRequest } from "../lib/http.js";
import {
  UpstreamError,
  AppError,
  ConfigurationError,
} from "../lib/errors.js";
import { THIRD_PARTY_ID_PATTERN } from "../config/constants.js";

/* ── Discovery ───────────────────────────────────────────────────────────── */

interface OidcDocument {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer: string;
  end_session_endpoint?: string;
}

const DISCOVERY_CACHE_TTL_MS = 3_600_000; // 1 hour
const DISCOVERY_TIMEOUT_MS = 10_000;

let _discovery: OidcDocument | null = null;
let _discoveryFetchedAt = 0;
let _discoveryInFlight: Promise<OidcDocument> | null = null;

/**
 * Fetch (or return cached) OIDC discovery document.
 *
 * On failure, returns the conventional Auth0 document so sign-in keeps
 * working even when the discovery endpoint is temporarily unreachable.
 * Logs at `warn` when falling back.
 */
export async function getOidcDocument(
  log?: { warn: (obj: object, msg: string) => void }
): Promise<OidcDocument> {
  const now = Date.now();

  // Return from cache when still fresh
  if (_discovery && now - _discoveryFetchedAt < DISCOVERY_CACHE_TTL_MS) {
    return _discovery;
  }

  // Deduplicate concurrent fetches
  if (_discoveryInFlight) return _discoveryInFlight;

  _discoveryInFlight = fetchDiscovery(log);
  try {
    _discovery = await _discoveryInFlight;
    _discoveryFetchedAt = Date.now();
    return _discovery;
  } finally {
    _discoveryInFlight = null;
  }
}

async function fetchDiscovery(
  log?: { warn: (obj: object, msg: string) => void }
): Promise<OidcDocument> {
  const cfg = getConfig();
  if (!cfg.AUTH0_DOMAIN) throw new ConfigurationError("Auth0 is not configured.");

  const conventional = conventionalDocument(cfg.AUTH0_DOMAIN);

  try {
    const res = await httpRequest({
      url: `https://${cfg.AUTH0_DOMAIN}/.well-known/openid-configuration`,
      method: "GET",
      timeoutMs: DISCOVERY_TIMEOUT_MS,
    });

    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`HTTP ${res.statusCode}`);
    }

    const text = await res.body.text();
    const doc = JSON.parse(text) as OidcDocument;

    // Validate minimum required fields
    if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
      throw new Error("Discovery document is missing required fields.");
    }

    return doc;
  } catch (err) {
    log?.warn(
      { reason: err instanceof Error ? err.message : String(err) },
      "OIDC discovery failed, falling back to conventional paths"
    );
    return conventional;
  }
}

function conventionalDocument(domain: string): OidcDocument {
  const base = `https://${domain}`;
  return {
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/oauth/token`,
    jwks_uri: `${base}/.well-known/jwks.json`,
    issuer: `${base}/`,
    end_session_endpoint: `${base}/v2/logout`,
  };
}

/* ── JWKS (per-document key set) ─────────────────────────────────────────── */

// Map jwks_uri → RemoteJWKSet.  Keyed because the URI can change after
// discovery refresh.
const _jwksSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwksFor(jwksUri: string): ReturnType<typeof createRemoteJWKSet> {
  let set = _jwksSets.get(jwksUri);
  if (!set) {
    set = createRemoteJWKSet(new URL(jwksUri), {
      cacheMaxAge: 600_000,     // 600 s cache
      cooldownDuration: 30_000, // refetch at most once per 30 s
    });
    _jwksSets.set(jwksUri, set);
  }
  return set;
}

/* ── ID-token claims (post-verification) ─────────────────────────────────── */

export interface Auth0IdTokenClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  iat: number;
  exp: number;
}

/** Maximum clock skew allowed in both directions (seconds). */
const CLOCK_SKEW_SECONDS = 300;

/* ── Claim sanitisation ──────────────────────────────────────────────────── */

/** Strip ASCII control characters U+0000–U+001F and U+007F. */
function stripControlChars(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f]/g, "");
}

/**
 * Sanitise and validate the raw claims returned by jose.
 *
 * Returns sanitised claims suitable for direct storage.
 * Throws AppError `token_invalid` when `sub` fails validation.
 */
export function sanitiseClaims(raw: Record<string, unknown>): Auth0IdTokenClaims {
  const sub = typeof raw["sub"] === "string" ? raw["sub"] : "";

  if (!sub || sub.length > 255 || !THIRD_PARTY_ID_PATTERN.test(sub)) {
    throw new AppError(
      400,
      "token_invalid",
      "The sign-in token contained an invalid subject claim.",
      { expose: false }
    );
  }

  // email: lowercase, max 320 chars, strip control chars
  let email: string | undefined;
  if (typeof raw["email"] === "string" && raw["email"].length > 0) {
    const cleaned = stripControlChars(raw["email"]).toLowerCase().slice(0, 320);
    if (cleaned.length > 0) email = cleaned;
  }

  // email_verified: boolean, default false
  const emailVerified =
    typeof raw["email_verified"] === "boolean" ? raw["email_verified"] : false;

  // name: strip control chars, max 255 chars
  let name: string | undefined;
  if (typeof raw["name"] === "string" && raw["name"].length > 0) {
    const cleaned = stripControlChars(raw["name"]).slice(0, 255);
    if (cleaned.length > 0) name = cleaned;
  }

  // picture: only accepted when it parses as an https URL
  let picture: string | undefined;
  if (typeof raw["picture"] === "string") {
    try {
      const u = new URL(raw["picture"]);
      if (u.protocol === "https:") {
        picture = raw["picture"].slice(0, 2048);
      }
    } catch {
      // not a URL — drop it
    }
  }

  return {
    sub,
    ...(email !== undefined ? { email } : {}),
    email_verified: emailVerified,
    ...(name !== undefined ? { name } : {}),
    ...(picture !== undefined ? { picture } : {}),
    iat: typeof raw["iat"] === "number" ? raw["iat"] : 0,
    exp: typeof raw["exp"] === "number" ? raw["exp"] : 0,
  };
}

/* ── Token exchange ──────────────────────────────────────────────────────── */

export interface TokenExchangeResult {
  idToken: string;
}

/**
 * Exchange an authorization code for an ID token at the Auth0 token endpoint.
 *
 * The access token is discarded — ClaimGuard calls no Auth0 API on the user's
 * behalf; the ID-token claims are the only artefact needed.
 *
 * Throws UpstreamError on non-2xx or unparseable body.
 * Throws ConfigurationError when credentials are absent.
 */
export async function exchangeCode(
  code: string,
  codeVerifier: string,
  redirectUri: string,
  log?: { warn: (obj: object, msg: string) => void }
): Promise<TokenExchangeResult> {
  const cfg = getConfig();
  if (!cfg.AUTH0_DOMAIN || !cfg.AUTH0_CLIENT_ID || !cfg.AUTH0_CLIENT_SECRET) {
    throw new ConfigurationError("Auth0 is not configured.");
  }

  const oidc = await getOidcDocument(log);

  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: cfg.AUTH0_CLIENT_ID,
    client_secret: cfg.AUTH0_CLIENT_SECRET,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });

  const res = await httpRequest({
    url: oidc.token_endpoint,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    timeoutMs: 15_000,
  });

  const text = await res.body.text();

  if (res.statusCode < 200 || res.statusCode >= 300) {
    // Log at warn — but never log the response body (may contain partial tokens)
    log?.warn(
      { statusCode: res.statusCode, tokenEndpoint: oidc.token_endpoint },
      "Auth0 token exchange failed"
    );
    throw new UpstreamError(
      `Auth0 token exchange failed (HTTP ${res.statusCode}).`
    );
  }

  let body: { id_token?: string; access_token?: string };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new UpstreamError("Auth0 returned an unparseable token response.");
  }

  if (!body.id_token) {
    throw new UpstreamError("Auth0 token response was missing the id_token.");
  }

  // Access token is intentionally not returned — it is discarded here.
  return { idToken: body.id_token };
}

/* ── ID-token verification ───────────────────────────────────────────────── */

/**
 * Verify an Auth0 ID token (RS256, JWKS-backed) and return sanitised claims.
 *
 * On any verification failure: logs at `warn` with the check that failed
 * (never with the token itself), and throws AppError 400 `token_invalid`.
 */
export async function verifyIdToken(
  idToken: string,
  log?: { warn: (obj: object, msg: string) => void }
): Promise<Auth0IdTokenClaims> {
  const cfg = getConfig();
  if (!cfg.AUTH0_DOMAIN || !cfg.AUTH0_CLIENT_ID) {
    throw new ConfigurationError("Auth0 is not configured.");
  }

  const oidc = await getOidcDocument(log);
  const jwks = getJwksFor(oidc.jwks_uri);

  try {
    const { payload } = await jwtVerify(idToken, jwks, {
      issuer: oidc.issuer,
      audience: cfg.AUTH0_CLIENT_ID,
      algorithms: ["RS256"],
      clockTolerance: CLOCK_SKEW_SECONDS,
    });

    const claims = sanitiseClaims(payload as Record<string, unknown>);

    return claims;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log?.warn({ reason, issuer: oidc.issuer }, "ID-token verification failed");

    // Re-throw our own error type so the route can redirect correctly
    if (err instanceof AppError) throw err;

    throw new AppError(
      400,
      "token_invalid",
      "The sign-in token could not be verified.",
      { cause: err, expose: false }
    );
  }
}

/* ── Authorization URL helper ────────────────────────────────────────────── */

export interface AuthUrlOptions {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
  screenHint?: string;
}

/**
 * Build the Auth0 authorization URL using the discovered authorization_endpoint.
 */
export async function buildAuthUrl(
  opts: AuthUrlOptions,
  log?: { warn: (obj: object, msg: string) => void }
): Promise<string> {
  const oidc = await getOidcDocument(log);

  const url = new URL(oidc.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("scope", opts.scope);
  url.searchParams.set("state", opts.state);
  url.searchParams.set("code_challenge", opts.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (opts.screenHint) url.searchParams.set("screen_hint", opts.screenHint);

  return url.toString();
}

/**
 * Build the Auth0 logout URL using the discovered end_session_endpoint.
 * Falls back to the conventional v2/logout path when the endpoint is absent.
 */
export async function buildLogoutUrl(
  clientId: string,
  returnTo: string,
  log?: { warn: (obj: object, msg: string) => void }
): Promise<string> {
  const oidc = await getOidcDocument(log);
  const base = oidc.end_session_endpoint ?? `https://${getConfig().AUTH0_DOMAIN}/v2/logout`;

  const url = new URL(base);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("returnTo", returnTo);

  return url.toString();
}
