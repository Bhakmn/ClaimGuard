/**
 * Compile-time constants that do not come from environment variables.
 *
 * Values that vary between deployments live in src/config/env.ts.
 * Values that are fixed protocol / framework constants live here.
 */

/* ── Server limits ─────────────────────────────────────────────────────────── */

/** Global JSON body ceiling (bytes). Multipart routes override per-route. */
export const GLOBAL_JSON_BODY_LIMIT = 32_768; // 32 KiB

/** Maximum length of a route parameter value (characters). */
export const MAX_PARAM_LENGTH = 256;

/* ── Request timeouts (ms) ─────────────────────────────────────────────────── */

/**
 * Outer HTTP request timeout. The publish upload can legitimately run for
 * 5 minutes; this is that ceiling plus 10 s of slack.
 */
export const SERVER_REQUEST_TIMEOUT_MS = 310_000;

export const SERVER_KEEP_ALIVE_TIMEOUT_MS = 72_000;
export const SERVER_CONNECTION_TIMEOUT_MS = 10_000;

/* ── OAuth ─────────────────────────────────────────────────────────────────── */

/** State / PKCE nonce lifetime (seconds). */
export const OAUTH_STATE_TTL_SECONDS = 600; // 10 min

/** PKCE code verifier length (bytes, then hex or base64url encoded). */
export const PKCE_VERIFIER_BYTES = 32;

/** Byte length of the raw state nonce. */
export const OAUTH_STATE_NONCE_BYTES = 24;

/* ── Session ───────────────────────────────────────────────────────────────── */

/** How often `last_seen_at` is refreshed (ms). Avoids a write on every call. */
export const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1_000; // 5 min

/* ── Identify ──────────────────────────────────────────────────────────────── */

/** How long to wait for a semaphore slot before giving up (ms). */
export const IDENTIFY_SEMAPHORE_WAIT_MS = 20_000;

/** Number of hex characters exposed in log digest prefixes. */
export const DIGEST_LOG_PREFIX_LENGTH = 12;

/** ACRCloud endpoint path (constant, version pinned). */
export const ACR_IDENTIFY_PATH = "/v1/identify";

/** ACRCloud data type field value. */
export const ACR_DATA_TYPE = "audio";

/** ACRCloud signature version. */
export const ACR_SIGNATURE_VERSION = "1";

/* ── TikTok upload ─────────────────────────────────────────────────────────── */

/** Minimum TikTok chunk size per their API spec (5 MiB). */
export const TIKTOK_MIN_CHUNK_BYTES = 5 * 1_024 * 1_024; // 5 MiB

/** Maximum TikTok chunk size (64 MiB, well within their stated ceiling). */
export const TIKTOK_MAX_CHUNK_BYTES = 64 * 1_024 * 1_024; // 64 MiB

/** Preferred chunk size used unless the file is smaller than the minimum. */
export const TIKTOK_PREFERRED_CHUNK_BYTES = TIKTOK_MIN_CHUNK_BYTES;

/** Retry attempts per chunk before the job is marked failed. */
export const TIKTOK_CHUNK_MAX_ATTEMPTS = 3;

/** Base backoff for chunk retries (ms). Doubles on each attempt. */
export const TIKTOK_CHUNK_BACKOFF_BASE_MS = 1_000;

/** Maximum simultaneous publish jobs in this process. */
export const PUBLISH_MAX_CONCURRENT_JOBS = 4;

/**
 * How long a job may remain in `uploading` before the cleanup task treats it
 * as stale and marks it `failed` (ms).
 */
export const PUBLISH_STALE_UPLOAD_MS = 2 * 60 * 60 * 1_000; // 2 h

/* ── Cleanup ───────────────────────────────────────────────────────────────── */

/** Margin added to all TTLs when sweeping rows. Prevents boundary races. */
export const CLEANUP_EXPIRY_MARGIN_MS = 5_000;

/* ── Rate limiting ─────────────────────────────────────────────────────────── */

/** Default fixed-window size (seconds) when no per-route override is set. */
export const RATE_LIMIT_DEFAULT_WINDOW_SECONDS = 60;

/** Default maximum requests per window when no per-route override is set. */
export const RATE_LIMIT_DEFAULT_MAX = 60;

/* ── Health ────────────────────────────────────────────────────────────────── */

/** Database connectivity probe timeout (ms). */
export const HEALTH_DB_TIMEOUT_MS = 2_000;

/** Event-loop delay threshold above which health is reported as degraded (ms). */
export const HEALTH_EL_DEGRADED_MS = 1_000;

/* ── Crypto ────────────────────────────────────────────────────────────────── */

/** AES-256-GCM IV length (bytes). */
export const AES_GCM_IV_BYTES = 12;

/** AES-256-GCM auth tag length (bytes). */
export const AES_GCM_TAG_BYTES = 16;

/* ── Logging ───────────────────────────────────────────────────────────────── */

/** Maximum length of the `userAgent` field stored in request logs. */
export const LOG_USER_AGENT_MAX = 200;

/** Maximum length of any string field that appears in a log line. */
export const LOG_STRING_FIELD_MAX = 1_024;

/* ── Validation ────────────────────────────────────────────────────────────── */

/** Identifier character set accepted from third-party systems. */
export const THIRD_PARTY_ID_PATTERN = /^[A-Za-z0-9._|:-]{1,255}$/;

/** Maximum length of a video title. */
export const TITLE_MAX_LENGTH = 100;

/** Maximum length of a filename stored as display metadata. */
export const FILENAME_MAX_LENGTH = 255;
