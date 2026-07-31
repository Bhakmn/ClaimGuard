/**
 * ACRCloud service client.
 *
 * Responsibilities:
 *  1. Signing the outbound request with HMAC-SHA1 (§3.2).
 *  2. Building and sending the multipart body (§3.3).
 *  3. Parsing and normalising the response (§3.4–3.5).
 *  4. Retry: exactly once on transport failure / timeout before headers (§6).
 *  5. Circuit breaker: open after 20 consecutive failures, 30-second reset (§6).
 *  6. Concurrency semaphore: process-wide slot cap (§5).
 *
 * Nothing in this file touches the database — caching lives in the route.
 *
 * Signing string (six lines joined with "\n", no trailing newline):
 *   POST
 *   /v1/identify
 *   <ACRCLOUD_ACCESS_KEY>
 *   audio
 *   1
 *   <unix-timestamp-seconds>
 */

import crypto from "node:crypto";
import { Pool } from "undici";
import { getConfig } from "../config/env.js";
import { Semaphore } from "../lib/semaphore.js";
import {
  GatewayTimeoutError,
  AppError,
  ConfigurationError,
} from "../lib/errors.js";
import {
  ACR_IDENTIFY_PATH,
  ACR_DATA_TYPE,
  ACR_SIGNATURE_VERSION,
  IDENTIFY_SEMAPHORE_WAIT_MS,
} from "../config/constants.js";

/* ── Response shapes ─────────────────────────────────────────────────────── */

export interface IdentifyMatch {
  acrid: string;
  title: string;
  artists: string;
  album: string;
  score: number;
  sampleBeginMs?: number;
  sampleEndMs?: number;
  playOffsetMs?: number;
}

export interface IdentifyResult {
  match: IdentifyMatch | null;
}

/* ── Logger interface ────────────────────────────────────────────────────── */

export interface IdentifyLogger {
  debug: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  info?: (obj: object, msg: string) => void;
}

/* ── undici connection pool — one per host ───────────────────────────────── */

const _pools = new Map<string, Pool>();

function getPool(host: string): Pool {
  let pool = _pools.get(host);
  if (!pool) {
    pool = new Pool(`https://${host}`, {
      connections: 16,
      keepAliveTimeout: 30_000,
      pipelining: 1,
    });
    _pools.set(host, pool);
  }
  return pool;
}

/** Inject a mock pool for a given host — used in tests only. */
export function _setPoolForTest(host: string, pool: Pool): void {
  _pools.set(host, pool);
}

/* ── Concurrency semaphore ───────────────────────────────────────────────── */

let _semaphore: Semaphore | null = null;

/**
 * Get (or lazily create) the process-wide concurrency semaphore.
 * Exposed for testing so tests can inject a custom semaphore.
 */
export function getSemaphore(): Semaphore {
  if (!_semaphore) {
    const cfg = getConfig();
    _semaphore = new Semaphore(cfg.ACRCLOUD_MAX_CONCURRENCY);
  }
  return _semaphore;
}

/** Replace the semaphore — used in tests only. */
export function _setSemaphoreForTest(s: Semaphore): void {
  _semaphore = s;
}

/** Reset semaphore and pools — used in tests only. */
export function _resetForTest(): void {
  _semaphore = null;
  _pools.clear();
  _resetCircuitBreaker();
}

/* ── Circuit breaker ─────────────────────────────────────────────────────── */

const BREAKER_THRESHOLD = 20;     // consecutive failures to open
const BREAKER_OPEN_MS   = 30_000; // ms to remain open before half-open

interface BreakerState {
  consecutiveFailures: number;
  openedAt: number | null;        // timestamp when breaker opened
  halfOpen: boolean;              // one probe allowed through
}

const _breaker: BreakerState = {
  consecutiveFailures: 0,
  openedAt: null,
  halfOpen: false,
};

function _resetCircuitBreaker(): void {
  _breaker.consecutiveFailures = 0;
  _breaker.openedAt = null;
  _breaker.halfOpen = false;
}

function isBreakerOpen(log?: IdentifyLogger): boolean {
  const { openedAt, halfOpen } = _breaker;
  if (openedAt === null) return false;  // closed

  const elapsed = Date.now() - openedAt;
  if (elapsed >= BREAKER_OPEN_MS) {
    // Transition to half-open: allow exactly one probe request.
    if (!halfOpen) {
      _breaker.halfOpen = true;
      log?.warn(
        { consecutiveFailures: _breaker.consecutiveFailures },
        "Circuit breaker half-open — sending probe request"
      );
    }
    return false; // let the probe through
  }
  return true; // still open
}

function recordSuccess(log?: IdentifyLogger): void {
  if (_breaker.openedAt !== null) {
    log?.warn(
      { consecutiveFailures: _breaker.consecutiveFailures },
      "Circuit breaker closed after successful probe"
    );
  }
  _breaker.consecutiveFailures = 0;
  _breaker.openedAt = null;
  _breaker.halfOpen = false;
}

function recordFailure(log?: IdentifyLogger): void {
  _breaker.consecutiveFailures++;
  _breaker.halfOpen = false;

  if (
    _breaker.consecutiveFailures >= BREAKER_THRESHOLD &&
    _breaker.openedAt === null
  ) {
    _breaker.openedAt = Date.now();
    log?.warn(
      { consecutiveFailures: _breaker.consecutiveFailures },
      "Circuit breaker opened after consecutive upstream failures"
    );
  } else if (_breaker.openedAt !== null) {
    // Re-open (probe failed): reset the open timer.
    _breaker.openedAt = Date.now();
    log?.warn(
      { consecutiveFailures: _breaker.consecutiveFailures },
      "Circuit breaker re-opened after failed probe"
    );
  }
}

/* ── Signing ─────────────────────────────────────────────────────────────── */

/**
 * Build the ACRCloud HMAC-SHA1 signature.
 *
 * String-to-sign (§3.2):
 *   POST\n/v1/identify\n<accessKey>\naudio\n1\n<timestampSeconds>
 *
 * Digest is standard base64 with padding (not base64url, not hex).
 */
export function buildSignature(
  accessKey: string,
  accessSecret: string,
  timestampSeconds: number
): string {
  const stringToSign = [
    "POST",
    ACR_IDENTIFY_PATH,
    accessKey,
    ACR_DATA_TYPE,
    ACR_SIGNATURE_VERSION,
    String(timestampSeconds),
  ].join("\n");

  return crypto
    .createHmac("sha1", accessSecret)
    .update(stringToSign)
    .digest("base64");
}

/* ── Multipart body builder ──────────────────────────────────────────────── */

/**
 * Build the raw multipart/form-data body for the ACRCloud request.
 *
 * Field order per spec §3.3:
 *   sample (file), sample_bytes, access_key, data_type,
 *   signature_version, signature, timestamp
 */
export function buildMultipartBody(
  accessKey: string,
  signature: string,
  timestampSeconds: number,
  sampleBytes: Buffer,
  boundary: string
): Buffer {
  const CRLF = "\r\n";

  const textPart = (name: string, value: string): string =>
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}` +
    `${value}${CRLF}`;

  // File part header
  const fileHeader =
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="sample"; filename="sample.wav"${CRLF}` +
    `Content-Type: audio/wav${CRLF}${CRLF}`;

  // Fields after the file (per spec field order)
  const trailingFields =
    textPart("sample_bytes", String(sampleBytes.length)) +
    textPart("access_key", accessKey) +
    textPart("data_type", ACR_DATA_TYPE) +
    textPart("signature_version", ACR_SIGNATURE_VERSION) +
    textPart("signature", signature) +
    textPart("timestamp", String(timestampSeconds));

  const footer = `--${boundary}--${CRLF}`;

  return Buffer.concat([
    Buffer.from(fileHeader, "utf8"),
    sampleBytes,
    Buffer.from(CRLF, "utf8"),
    Buffer.from(trailingFields, "utf8"),
    Buffer.from(footer, "utf8"),
  ]);
}

/* ── Response normalisation ──────────────────────────────────────────────── */

interface AcrMusicItem {
  acrid?: unknown;
  title?: unknown;
  artists?: { name?: unknown }[];
  album?: { name?: unknown };
  score?: unknown;
  sample_begin_time_offset_ms?: unknown;
  sample_end_time_offset_ms?: unknown;
  play_offset_ms?: unknown;
}

interface AcrStatus {
  code?: unknown;
  msg?: unknown;
}

interface AcrResponse {
  status: AcrStatus;
  metadata?: { music?: AcrMusicItem[] };
}

function finiteNumber(v: unknown): number | undefined {
  const n = Number(v);
  return isFinite(n) ? n : undefined;
}

export function normalise(raw: AcrResponse): IdentifyResult {
  const code = typeof raw.status?.code === "number" ? raw.status.code : null;

  if (code === null) {
    // status.code is not a number — treat as unparseable
    throw new AppError(
      502,
      "acrcloud_unreachable",
      "Could not reach ACRCloud: unexpected response."
    );
  }

  // Status 1001 = no result — always a clean null match
  // Status 2004 = can't generate fingerprint (silent/too-short sample) — also a clean no-match
  if (code === 1001 || code === 2004) return { match: null };

  // Status 0 = success
  if (code === 0) {
    const music = raw.metadata?.music;
    if (!music || music.length === 0) return { match: null };

    const m = music[0] as AcrMusicItem;

    const acrid =
      typeof m.acrid === "string" && m.acrid.length > 0 ? m.acrid : "";
    const title =
      typeof m.title === "string" && m.title.length > 0
        ? m.title
        : "Unknown title";
    const artists = Array.isArray(m.artists)
      ? m.artists
          .map((a) => (typeof a?.name === "string" ? a.name : ""))
          .filter((s) => s.length > 0)
          .join(", ")
      : "";
    const album =
      typeof m.album?.name === "string" ? m.album.name : "";
    const score =
      typeof m.score === "number" && isFinite(m.score) ? m.score : 0;

    const match: IdentifyMatch = { acrid, title, artists, album, score };

    // Offset fields: coerce via Number(), omit when not finite (§3.5).
    const begin = finiteNumber(m.sample_begin_time_offset_ms);
    const end   = finiteNumber(m.sample_end_time_offset_ms);
    const play  = finiteNumber(m.play_offset_ms);

    if (begin !== undefined) match.sampleBeginMs = begin;
    if (end   !== undefined) match.sampleEndMs   = end;
    if (play  !== undefined) match.playOffsetMs  = play;

    return { match };
  }

  // Any other status code is a business-level error
  const msg =
    typeof raw.status.msg === "string" && raw.status.msg.length > 0
      ? raw.status.msg
      : "unknown error";
  throw new AppError(502, "acrcloud_error", `ACRCloud error ${code}: ${msg}`);
}

/* ── Single upstream attempt ─────────────────────────────────────────────── */

/**
 * Make one HTTP call to ACRCloud and return the normalised result.
 *
 * Does NOT acquire or release the semaphore — the caller does that.
 * Throws on transport failure, timeout, 429, bad JSON, or non-zero status.
 *
 * `isRetry` controls whether a transport error is re-thrown as retriable or
 * as a definitive failure (on retry we don't retry again).
 */
async function callOnce(
  host: string,
  accessKey: string,
  accessSecret: string,
  timeoutMs: number,
  sampleBuffer: Buffer,
  log?: IdentifyLogger
): Promise<IdentifyResult> {
  const timestampSeconds = Math.floor(Date.now() / 1_000);
  const signature = buildSignature(accessKey, accessSecret, timestampSeconds);
  const boundary = `----ACRCloudBoundary${crypto.randomBytes(8).toString("hex")}`;
  const body = buildMultipartBody(
    accessKey, signature, timestampSeconds, sampleBuffer, boundary
  );

  const url = `https://${host}${ACR_IDENTIFY_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();

  let statusCode: number;
  let responseText: string;

  try {
    const pool = getPool(host);
    const res = await pool.request({
      path: ACR_IDENTIFY_PATH,
      method: "POST",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": String(body.length),
      },
      body,
      signal: controller.signal,
    });
    statusCode = res.statusCode;
    responseText = await res.body.text();
  } catch (err) {
    const durationMs = Date.now() - start;
    const errMsg = err instanceof Error ? err.message : String(err);
    const isTimeout =
      err instanceof Error &&
      (err.name === "AbortError" ||
        (err as NodeJS.ErrnoException).code === "UND_ERR_CONNECT_TIMEOUT" ||
        (err as NodeJS.ErrnoException).code === "UND_ERR_SOCKET");

    log?.warn(
      { host, durationMs, reason: errMsg.slice(0, 200) },
      "ACRCloud transport failure"
    );

    if (isTimeout) {
      throw new GatewayTimeoutError(
        "ACRCloud did not answer in time. Try scanning again."
      );
    }
    throw Object.assign(
      new AppError(
        502,
        "acrcloud_unreachable",
        `Could not reach ACRCloud (${host}): ${errMsg.slice(0, 200)}`
      ),
      { _retriable: true }
    );
  } finally {
    clearTimeout(timer);
  }

  const durationMs = Date.now() - start;

  // ACRCloud rate limiting
  if (statusCode === 429) {
    log?.warn({ host, durationMs, statusCode }, "ACRCloud rate-limited this server");
    throw new AppError(429, "rate_limited",
      "The music matching service is rate limiting this server. Try again shortly.",
      { retryAfterSeconds: 30 }
    );
  }

  // Parse JSON
  let parsed: AcrResponse;
  try {
    parsed = JSON.parse(responseText) as AcrResponse;
    if (typeof parsed.status?.code !== "number") throw new Error("Missing status.code");
  } catch {
    log?.warn({ host, durationMs, statusCode }, "ACRCloud unparseable response");
    throw new AppError(
      502,
      "acrcloud_unreachable",
      `Could not reach ACRCloud (${host}): unexpected response.`
    );
  }

  const result = normalise(parsed);

  log?.debug(
    {
      host,
      durationMs,
      statusCode,
      acrStatusCode: parsed.status.code,
      matched: result.match !== null,
    },
    "ACRCloud identify call"
  );

  return result;
}

/* ── Public API ──────────────────────────────────────────────────────────── */

/**
 * Identify music in `sampleBuffer` via ACRCloud.
 *
 * Acquires a concurrency slot, makes the upstream call (with one retry on
 * transport failure), normalises the result.  Callers handle caching; this
 * function always calls the network unless the circuit breaker is open.
 *
 * Throws:
 *  - ConfigurationError   when ACRCloud credentials are absent
 *  - AppError 503         when the semaphore times out or the breaker is open
 *  - AppError 502         when ACRCloud returns a non-zero status code
 *  - AppError 429         when ACRCloud rate-limits this server
 *  - GatewayTimeoutError  when the upstream call times out
 */
export async function identifyAudio(
  sampleBuffer: Buffer,
  log?: IdentifyLogger
): Promise<IdentifyResult> {
  const cfg = getConfig();

  if (
    !cfg.acrcloudEnabled ||
    !cfg.ACRCLOUD_HOST ||
    !cfg.ACRCLOUD_ACCESS_KEY ||
    !cfg.ACRCLOUD_ACCESS_SECRET
  ) {
    throw new ConfigurationError(
      "Audio identification is not configured on this server."
    );
  }

  const {
    ACRCLOUD_HOST: host,
    ACRCLOUD_ACCESS_KEY: accessKey,
    ACRCLOUD_ACCESS_SECRET: accessSecret,
    ACRCLOUD_TIMEOUT_MS: timeoutMs,
  } = cfg;

  // ── Circuit breaker check ────────────────────────────────────────────────
  if (isBreakerOpen(log)) {
    throw new AppError(
      503,
      "identify_busy",
      "The music matching service is unavailable. Try again in a minute."
    );
  }

  // ── Acquire concurrency slot ─────────────────────────────────────────────
  const semaphore = getSemaphore();
  let release: (() => void) | null = null;

  try {
    release = await semaphore.acquire(IDENTIFY_SEMAPHORE_WAIT_MS);
  } catch {
    log?.warn(
      { waitedMs: IDENTIFY_SEMAPHORE_WAIT_MS, inFlight: semaphore.inFlight, queueDepth: semaphore.queueDepth },
      "Semaphore wait exceeded"
    );
    throw new AppError(
      503,
      "identify_busy",
      "The scanner is busy. Try again in a few seconds.",
      { retryAfterSeconds: 5 }
    );
  }

  try {
    // ── First attempt ──────────────────────────────────────────────────────
    try {
      const result = await callOnce(
        host, accessKey, accessSecret, timeoutMs, sampleBuffer, log
      );
      recordSuccess(log);
      return result;
    } catch (err) {
      // Only retry on transport failures (tagged _retriable) or timeout before headers.
      const isRetriable =
        (err instanceof GatewayTimeoutError) ||
        ((err as { _retriable?: boolean })._retriable === true);

      // Never retry 429 or business-level errors (code ≠ acrcloud_unreachable).
      const isBusiness =
        err instanceof AppError && err.code === "acrcloud_error";

      if (!isRetriable || isBusiness) {
        recordFailure(log);
        throw err;
      }

      // ── Single retry after 500 ms ────────────────────────────────────────
      log?.warn(
        { host, reason: err instanceof Error ? err.message.slice(0, 200) : String(err) },
        "ACRCloud transient failure — retrying once"
      );

      await new Promise<void>((r) => setTimeout(r, 500));

      try {
        const result = await callOnce(
          host, accessKey, accessSecret, timeoutMs, sampleBuffer, log
        );
        recordSuccess(log);
        return result;
      } catch (retryErr) {
        recordFailure(log);
        throw retryErr;
      }
    }
  } finally {
    release?.();
  }
}

/* ── Observability gauges ────────────────────────────────────────────────── */

export function getIdentifyGauges(): {
  inFlight: number;
  queueDepth: number;
  circuitBreakerOpen: boolean;
  consecutiveFailures: number;
} {
  const sem = _semaphore;
  return {
    inFlight: sem?.inFlight ?? 0,
    queueDepth: sem?.queueDepth ?? 0,
    circuitBreakerOpen: _breaker.openedAt !== null && !_breaker.halfOpen,
    consecutiveFailures: _breaker.consecutiveFailures,
  };
}
