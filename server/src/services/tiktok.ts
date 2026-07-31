/**
 * TikTok service client.
 *
 * Responsible for:
 *  - OAuth token exchange (code → tokens)
 *  - Token refresh
 *  - Inbox init (FILE_UPLOAD) with one retry on transport failure
 *  - Chunk PUT with status-code-aware retry policy
 *  - Status fetch (POST with JSON body, per spec §9.2)
 *
 * This file handles only the network calls.
 * Token storage/retrieval and job row management live in the routes and
 * query helpers.
 */

import { getConfig } from "../config/env.js";
import { httpRequest } from "../lib/http.js";
import {
  UpstreamError,
  GatewayTimeoutError,
  ConfigurationError,
  AppError,
} from "../lib/errors.js";

/* ── Token exchange ──────────────────────────────────────────────────────── */

export interface TikTokTokens {
  accessToken: string;
  refreshToken: string | null;
  accessExpiresIn: number;    // seconds
  refreshExpiresIn: number | null;
  scope: string;
  openId: string | null;
}

/**
 * Exchange an authorization code for TikTok tokens.
 */
export async function exchangeTikTokCode(
  code: string,
  codeVerifier: string,
  redirectUri: string
): Promise<TikTokTokens> {
  const cfg = getConfig();
  if (!cfg.TIKTOK_CLIENT_KEY || !cfg.TIKTOK_CLIENT_SECRET) {
    throw new ConfigurationError("TikTok is not configured.");
  }

  const params = new URLSearchParams({
    client_key:    cfg.TIKTOK_CLIENT_KEY,
    client_secret: cfg.TIKTOK_CLIENT_SECRET,
    code,
    grant_type:    "authorization_code",
    redirect_uri:  redirectUri,
    code_verifier: codeVerifier,
  });

  const res = await httpRequest({
    url: "https://open.tiktokapis.com/v2/oauth/token/",
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Cache-Control": "no-cache",
    },
    body: params.toString(),
    timeoutMs: cfg.TIKTOK_TIMEOUT_MS,
  });

  const text = await res.body.text();

  let body: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    refresh_expires_in?: number;
    scope?: string;
    open_id?: string;
    error?: string;
    error_description?: string;
    log_id?: string;
  };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new UpstreamError(
      `Could not get a TikTok token (HTTP ${res.statusCode}).`
    );
  }

  // Treat non-2xx OR missing access_token as failure.
  // Use error_description → error → "HTTP {status}" as the why string (§4.2).
  if (res.statusCode < 200 || res.statusCode >= 300 || !body.access_token) {
    const why = (
      (body.error_description ?? body.error ?? `HTTP ${res.statusCode}`) as string
    ).slice(0, 200);
    if (body.log_id) {
      // log_id is TikTok's support handle — callers should log it at warn
      (exchangeTikTokCode as { _lastLogId?: string })._lastLogId = body.log_id;
    }
    throw new UpstreamError(`Could not get a TikTok token (${why}).`);
  }

  return {
    accessToken:      body.access_token,
    refreshToken:     body.refresh_token ?? null,
    accessExpiresIn:  body.expires_in ?? 86_400,
    refreshExpiresIn: body.refresh_expires_in ?? null,
    scope:            body.scope ?? "",
    openId:           body.open_id ?? null,
  };
}

/* ── Token refresh ───────────────────────────────────────────────────────── */

export interface TikTokRefreshedTokens {
  accessToken: string;
  accessExpiresIn: number;
  refreshToken: string | null;
  refreshExpiresIn: number | null;
}

/**
 * Refresh a TikTok access token using a refresh token.
 * Throws UpstreamError when the refresh fails.
 */
export async function refreshTikTokToken(
  refreshToken: string
): Promise<TikTokRefreshedTokens> {
  const cfg = getConfig();
  if (!cfg.TIKTOK_CLIENT_KEY || !cfg.TIKTOK_CLIENT_SECRET) {
    throw new ConfigurationError("TikTok is not configured.");
  }

  const params = new URLSearchParams({
    client_key:    cfg.TIKTOK_CLIENT_KEY,
    client_secret: cfg.TIKTOK_CLIENT_SECRET,
    grant_type:    "refresh_token",
    refresh_token: refreshToken,
  });

  const res = await httpRequest({
    url: "https://open.tiktokapis.com/v2/oauth/token/",
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Cache-Control": "no-cache",
    },
    body: params.toString(),
    timeoutMs: cfg.TIKTOK_TIMEOUT_MS,
  });

  const text = await res.body.text();

  let body: {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    refresh_expires_in?: number;
    error?: string;
    error_description?: string;
    log_id?: string;
  };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new UpstreamError(`TikTok token refresh failed (HTTP ${res.statusCode}).`);
  }

  if (res.statusCode < 200 || res.statusCode >= 300 || !body.access_token) {
    const why = (
      (body.error_description ?? body.error ?? `HTTP ${res.statusCode}`) as string
    ).slice(0, 200);
    throw new UpstreamError(`TikTok token refresh failed (${why}).`);
  }

  return {
    accessToken:      body.access_token,
    accessExpiresIn:  body.expires_in ?? 86_400,
    refreshToken:     body.refresh_token ?? null,
    refreshExpiresIn: body.refresh_expires_in ?? null,
  };
}

/* ── Inbox init ──────────────────────────────────────────────────────────── */

export interface TikTokInitResult {
  publishId: string;
  uploadUrl: string;
}

/**
 * Call TikTok's FILE_UPLOAD inbox init endpoint.
 *
 * Returns the publish_id and upload_url for subsequent chunk PUTs.
 *
 * Error handling per spec §6:
 *  - HTTP 401       → AppError 401 tiktok_session_expired (caller revokes connection)
 *  - Non-2xx        → AppError 502 tiktok_init_failed
 *  - error.code !== "ok" or upload_url absent → AppError 502 tiktok_init_failed
 *  - Timeout        → GatewayTimeoutError 504 tiktok_timeout
 *  - Transport      → AppError 502 tiktok_init_failed (tagged _retriable for caller)
 *
 * Retry: the caller performs one retry on transport/timeout with no response headers.
 */
export async function initTikTokUpload(
  accessToken: string,
  videoSize: number,
  chunkSize: number,
  totalChunkCount: number
): Promise<TikTokInitResult> {
  const cfg = getConfig();

  let res: Awaited<ReturnType<typeof httpRequest>>;
  try {
    res = await httpRequest({
      url: "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/",
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({
        source_info: {
          source:             "FILE_UPLOAD",
          video_size:         videoSize,
          chunk_size:         chunkSize,
          total_chunk_count:  totalChunkCount,
        },
      }),
      timeoutMs: cfg.TIKTOK_TIMEOUT_MS,
    });
  } catch (err) {
    // Transport failure or timeout — tag as retriable
    if (err instanceof GatewayTimeoutError) throw err;
    throw Object.assign(
      new AppError(502, "tiktok_init_failed",
        `TikTok init failed: ${err instanceof Error ? err.message.slice(0, 200) : "connection failed"}`
      ),
      { _retriable: true }
    );
  }

  // HTTP 401 → session expired; caller must revoke the connection
  if (res.statusCode === 401) {
    await res.body.text().catch(() => undefined);
    throw new AppError(401, "tiktok_session_expired", "TikTok session expired.");
  }

  const text = await res.body.text();

  let body: {
    data?: { publish_id?: string; upload_url?: string };
    error?: { code?: string; message?: string; log_id?: string };
  };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new AppError(502, "tiktok_init_failed",
      `TikTok init failed: HTTP ${res.statusCode}`
    );
  }

  // Success condition: 2xx AND error.code === "ok" AND upload_url present
  const errorCode = body.error?.code ?? "";
  const isOk      = res.statusCode >= 200 && res.statusCode < 300 && errorCode === "ok";
  const uploadUrl = body.data?.upload_url;

  if (!isOk || !uploadUrl || !body.data?.publish_id) {
    const why = (
      (body.error?.message ?? body.error?.code ?? `HTTP ${res.statusCode}`) as string
    ).slice(0, 200);
    throw new AppError(502, "tiktok_init_failed", `TikTok init failed: ${why}`);
  }

  return {
    publishId: body.data.publish_id,
    uploadUrl,
  };
}

/* ── Chunk PUT ───────────────────────────────────────────────────────────── */

/**
 * Upload one chunk to TikTok's upload URL.
 *
 * `start` and `end` are zero-based byte positions (end is exclusive).
 * `total` is the total video size in bytes.
 *
 * The Content-Range header uses inclusive bounds: `bytes ${start}-${end-1}/${total}`.
 *
 * Throws with a `_statusCode` property so the caller can decide whether to retry:
 *   - retry on: transport, timeout, 429, 5xx
 *   - do NOT retry on: 4xx (except 429)
 */
export async function uploadChunk(
  uploadUrl: string,
  chunkBuffer: Buffer,
  start: number,
  end: number,
  total: number,
  contentType: string
): Promise<void> {
  const cfg = getConfig();

  let res: Awaited<ReturnType<typeof httpRequest>>;
  try {
    res = await httpRequest({
      url: uploadUrl,
      method: "PUT",
      headers: {
        "Content-Type":   contentType,
        "Content-Length": String(chunkBuffer.length),
        "Content-Range":  `bytes ${start}-${end - 1}/${total}`,
      },
      body: chunkBuffer,
      timeoutMs: cfg.TIKTOK_CHUNK_TIMEOUT_MS,
    });
  } catch (err) {
    // Transport failure or timeout — already typed correctly (UpstreamError or GatewayTimeoutError)
    throw err;
  }

  if (res.statusCode >= 200 && res.statusCode < 300) {
    // Success — consume response body to release the connection
    await res.body.text().catch(() => undefined);
    return;
  }

  // Consume the body regardless
  await res.body.text().catch(() => undefined);

  // Attach statusCode so caller can classify the failure
  throw Object.assign(
    new AppError(
      res.statusCode === 429 ? 429 : res.statusCode >= 500 ? 502 : 502,
      res.statusCode === 429 ? "rate_limited" : "tiktok_chunk_rejected",
      `TikTok rejected chunk (HTTP ${res.statusCode}).`,
    ),
    { _chunkStatusCode: res.statusCode }
  );
}

/* ── Status fetch ────────────────────────────────────────────────────────── */

export type TikTokProviderStatus =
  | "PROCESSING_UPLOAD"
  | "SEND_TO_USER_INBOX"
  | "PUBLISH_COMPLETE"
  | "FAILED";

export interface TikTokStatusResult {
  status: TikTokProviderStatus | null;
  failReason?: string;
  logId?: string;
  statusCode?: number;
}

/**
 * Fetch the publish status of a video from TikTok.
 *
 * Per spec §9.2: POST with JSON body {"publish_id":"..."}.
 *
 * Returns null status on upstream errors (caller should use cached state).
 * Exposes statusCode so caller can detect 401 and revoke the connection.
 */
export async function fetchTikTokStatus(
  accessToken: string,
  publishId: string
): Promise<TikTokStatusResult> {
  const cfg = getConfig();

  let res: Awaited<ReturnType<typeof httpRequest>>;
  try {
    res = await httpRequest({
      url: "https://open.tiktokapis.com/v2/post/publish/status/fetch/",
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({ publish_id: publishId }),
      timeoutMs: cfg.TIKTOK_TIMEOUT_MS,
    });
  } catch {
    return { status: null };
  }

  const text = await res.body.text().catch(() => "");

  let body: {
    data?: {
      status?: string;
      fail_reason?: string;
      uploaded_bytes?: number;
    };
    error?: { code?: string; message?: string; log_id?: string };
  };

  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    return { status: null, statusCode: res.statusCode };
  }

  if (res.statusCode === 401) {
    const logId = body.error?.log_id;
    return { status: null, statusCode: 401, ...(logId ? { logId } : {}) };
  }

  const rawStatus = body.data?.status;
  const validStatuses: TikTokProviderStatus[] = [
    "PROCESSING_UPLOAD",
    "SEND_TO_USER_INBOX",
    "PUBLISH_COMPLETE",
    "FAILED",
  ];

  const status = validStatuses.includes(rawStatus as TikTokProviderStatus)
    ? (rawStatus as TikTokProviderStatus)
    : null;

  const logId = body.error?.log_id;
  return {
    status,
    statusCode: res.statusCode,
    ...(logId ? { logId } : {}),
    ...(body.data?.fail_reason ? { failReason: body.data.fail_reason } : {}),
  };
}
