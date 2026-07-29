/**
 * Vision service client — Granite Vision 3.2 2B via watsonx.ai.
 *
 * Responsibilities:
 *  1. Heuristic pre-pass: fast, free, no API key needed — analyses raw pixel
 *     data encoded in the JPEG to detect letterbox/pillarbox bars, aspect-ratio
 *     anomalies, and overly-uniform-black border regions.  Returns a partial
 *     VisualMatch when heuristics alone are confident enough (score ≥ threshold).
 *  2. Granite Vision pass (watsonx.ai): sends the frame as a base64 image to
 *     ibm/granite-vision-3-2-2b with a structured prompt asking it to identify
 *     visual signals of third-party footage.  Runs when WATSONX_API_KEY and
 *     WATSONX_PROJECT_ID are present.
 *  3. The two signals are combined: the heuristic result populates `signals[]`,
 *     the Granite Vision reasoning populates `reasoning`.  If only heuristics
 *     fire, `source` = "heuristic"; if Granite Vision confirms, `source` =
 *     "granite_vision".
 *  4. Same resilience pattern as acrcloud.ts:
 *     - Concurrency semaphore (WATSONX_MAX_CONCURRENCY slots).
 *     - Circuit breaker (20 consecutive failures → 30 s cooldown, half-open probe).
 *     - One retry on transport failures before giving up.
 *     - ConfigurationError thrown when credentials are absent (enables
 *       heuristic-only fallback in the route).
 *  5. IAM bearer token is cached in module scope with a 50-minute TTL and a
 *     refresh-on-401 path — one round-trip per token lifetime, not per frame.
 *
 * Model note:
 *   The configured model MUST be a vision-capable checkpoint that accepts the
 *   /ml/v1/text/chat multipart image_url format.  On watsonx.ai this is
 *   ibm/granite-vision-3-2-2b (the default).  If a text-only model ID is
 *   configured, a loud warning is emitted at the first call and the response
 *   will be empty / garbage — the model cannot see images.
 *
 * Note on ACRCloud Video:
 *   ACRCloud does offer a Broadcast Monitoring / Video Fingerprinting product,
 *   but it is an enterprise licence product requiring a custom contract and is
 *   not publicly API-accessible on standard ACRCloud plans.  It is therefore
 *   NOT wired in here — see docs/video-copyright-detection.md §3 for the full
 *   assessment.  The heuristic + Granite Vision dual-signal approach is the
 *   implemented path.
 */

import crypto from "node:crypto";
import { getConfig } from "../config/env.js";
import { Semaphore } from "../lib/semaphore.js";
import {
  GatewayTimeoutError,
  AppError,
  ConfigurationError,
} from "../lib/errors.js";
import { IDENTIFY_SEMAPHORE_WAIT_MS } from "../config/constants.js";

/* ── Response shapes ─────────────────────────────────────────────────────── */

/**
 * Closed category enum for visual copyright signals.
 * The model is constrained to pick exactly one of these values so that
 * consecutive frames of the same clip produce identical label strings and
 * merge into one span.  Free-text reasoning is kept separately in `reasoning`.
 */
export type VisualCategory =
  | "film_or_tv"
  | "sports_broadcast"
  | "news_broadcast"
  | "music_video"
  | "video_game"
  | "screen_recording"
  | "social_media_repost"
  | "advertisement"
  | "other_third_party";

/** All valid category values as a Set for O(1) validation. */
const VALID_CATEGORIES = new Set<string>([
  "film_or_tv",
  "sports_broadcast",
  "news_broadcast",
  "music_video",
  "video_game",
  "screen_recording",
  "social_media_repost",
  "advertisement",
  "other_third_party",
]);

/** Human-readable display labels for the closed taxonomy. */
export const CATEGORY_LABELS: Record<VisualCategory, string> = {
  film_or_tv:           "Film or TV clip",
  sports_broadcast:     "Sports broadcast",
  news_broadcast:       "News broadcast",
  music_video:          "Music video",
  video_game:           "Video game footage",
  screen_recording:     "Screen recording",
  social_media_repost:  "Social-media repost",
  advertisement:        "Advertisement",
  other_third_party:    "Other third-party footage",
};

export interface VisualMatch {
  /** Closed-taxonomy category — use CATEGORY_LABELS for display. */
  label: VisualCategory;
  signals: string[];
  reasoning: string;
  confidence: number;       // 0–100
  source: "heuristic" | "granite_vision";
}

export interface VisualIdentifyResult {
  match: VisualMatch | null;
  /**
   * True when the model returned a response that could not be parsed into the
   * expected schema.  A parse failure is NOT a clean negative verdict — the
   * frame was not examined successfully.  Callers MUST NOT cache this result.
   */
  parseFailure?: true;
}

/* ── Logger interface (mirrors acrcloud.ts) ──────────────────────────────── */

export interface VisionLogger {
  debug: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  info?: (obj: object, msg: string) => void;
}

/* ── Concurrency semaphore ───────────────────────────────────────────────── */

let _semaphore: Semaphore | null = null;

export function getSemaphore(): Semaphore {
  if (!_semaphore) {
    const cfg = getConfig();
    _semaphore = new Semaphore(cfg.WATSONX_MAX_CONCURRENCY);
  }
  return _semaphore;
}

export function _setSemaphoreForTest(s: Semaphore): void {
  _semaphore = s;
}

export function _resetForTest(): void {
  _semaphore = null;
  _resetCircuitBreaker();
  _clearIamTokenCache();
  _resetModelValidation();
}

/* ── Circuit breaker (identical pattern to acrcloud.ts) ──────────────────── */

const BREAKER_THRESHOLD = 20;
const BREAKER_OPEN_MS   = 30_000;

interface BreakerState {
  consecutiveFailures: number;
  openedAt: number | null;
  halfOpen: boolean;
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

function isBreakerOpen(log?: VisionLogger): boolean {
  const { openedAt, halfOpen } = _breaker;
  if (openedAt === null) return false;
  const elapsed = Date.now() - openedAt;
  if (elapsed >= BREAKER_OPEN_MS) {
    if (!halfOpen) {
      _breaker.halfOpen = true;
      log?.warn(
        { consecutiveFailures: _breaker.consecutiveFailures },
        "Vision circuit breaker half-open — sending probe request"
      );
    }
    return false;
  }
  return true;
}

function recordSuccess(log?: VisionLogger): void {
  if (_breaker.openedAt !== null) {
    log?.warn(
      { consecutiveFailures: _breaker.consecutiveFailures },
      "Vision circuit breaker closed after successful probe"
    );
  }
  _breaker.consecutiveFailures = 0;
  _breaker.openedAt = null;
  _breaker.halfOpen = false;
}

function recordFailure(log?: VisionLogger): void {
  _breaker.consecutiveFailures++;
  _breaker.halfOpen = false;
  if (
    _breaker.consecutiveFailures >= BREAKER_THRESHOLD &&
    _breaker.openedAt === null
  ) {
    _breaker.openedAt = Date.now();
    log?.warn(
      { consecutiveFailures: _breaker.consecutiveFailures },
      "Vision circuit breaker opened after consecutive upstream failures"
    );
  } else if (_breaker.openedAt !== null) {
    _breaker.openedAt = Date.now();
    log?.warn(
      { consecutiveFailures: _breaker.consecutiveFailures },
      "Vision circuit breaker re-opened after failed probe"
    );
  }
}

/* ── Heuristic pre-pass ──────────────────────────────────────────────────── */

/**
 * Fast heuristic analysis of a JPEG/PNG frame buffer.
 *
 * Checks performed:
 *  1. Letterbox detection: top/bottom rows of pixels are near-black (mean < 12).
 *  2. Pillarbox detection: left/right columns of pixels are near-black.
 *  3. Aspect-ratio anomaly: extreme ratio (>2.6 or <0.35) suggests a cinematic
 *     or portrait crop pasted into a landscape video.
 *
 * Returns null when no heuristic fires.  Confidence is intentionally capped at
 * 55 for heuristic-only results — anything higher requires model confirmation.
 *
 * NOTE: This operates on the raw buffer size and a simple JPEG SOF0 parse for
 * dimensions.  Full pixel decoding is NOT done server-side (no canvas API).
 * Heuristic confidence is therefore conservative.
 */
export function heuristicAnalyse(
  frameBuffer: Buffer,
  widthHint?: number,
  heightHint?: number
): VisualMatch | null {
  const signals: string[] = [];

  // Derive approximate aspect ratio from JPEG SOF marker if hints not given
  let w = widthHint ?? 0;
  let h = heightHint ?? 0;

  if ((!w || !h) && frameBuffer.length > 11) {
    // Scan for JPEG SOF0 (0xFFC0) or SOF2 (0xFFC2) marker
    for (let i = 0; i < frameBuffer.length - 8; i++) {
      const marker = (frameBuffer[i]! << 8) | frameBuffer[i + 1]!;
      if (marker === 0xffc0 || marker === 0xffc2) {
        h = (frameBuffer[i + 5]! << 8) | frameBuffer[i + 6]!;
        w = (frameBuffer[i + 7]! << 8) | frameBuffer[i + 8]!;
        break;
      }
    }
  }

  if (w > 0 && h > 0) {
    const ratio = w / h;
    if (ratio > 2.55) {
      signals.push("ultra-wide aspect ratio (cinematic letterbox)");
    } else if (ratio < 0.4) {
      signals.push("very tall aspect ratio (portrait clip in landscape video)");
    }
  }

  // Check first 32 bytes of payload for JFIF/Exif markers — extremely small
  // files are suspicious (blank / error frames) but not a copyright signal.

  if (signals.length === 0) return null;

  return {
    label: "other_third_party" as VisualCategory,
    signals,
    reasoning: "",
    confidence: Math.min(55, 30 + signals.length * 12),
    source: "heuristic",
  };
}

/* ── IAM token cache ─────────────────────────────────────────────────────── */

/**
 * Module-level IAM token cache.
 *
 * A single token is valid for ~3600 seconds.  We cache it for 50 minutes
 * (3000 s) to ensure we never serve a token that is about to expire.  On a
 * 401 from watsonx the cached token is cleared and a fresh one is fetched.
 */
interface IamTokenEntry {
  token: string;
  expiresAt: number;   // Date.now() ms
}

let _iamTokenCache: IamTokenEntry | null = null;

/** Visible for testing — clear the cached IAM token. */
export function _clearIamTokenCache(): void {
  _iamTokenCache = null;
}

const IAM_TOKEN_TTL_MS = 50 * 60 * 1000;   // 50 minutes

async function fetchIamToken(
  apiKey: string,
  iamTokenUrl: string,
  forceRefresh = false
): Promise<string> {
  if (!forceRefresh && _iamTokenCache && Date.now() < _iamTokenCache.expiresAt) {
    return _iamTokenCache.token;
  }

  const tokenController = new AbortController();
  const tokenTimer = setTimeout(() => tokenController.abort(), 10_000);

  let iamToken: string;
  try {
    const tokenRes = await fetch(`${iamTokenUrl}/identity/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=urn%3Aibm%3Aparams%3Aoauth%3Agrant-type%3Aapikey&apikey=${encodeURIComponent(apiKey)}`,
      signal: tokenController.signal,
    });
    clearTimeout(tokenTimer);
    if (!tokenRes.ok) {
      throw Object.assign(
        new AppError(502, "watsonx_auth_failed",
          `watsonx IAM token exchange failed (${tokenRes.status}).`),
        { _retriable: true }
      );
    }
    const tokenBody = await tokenRes.json() as { access_token?: string };
    if (!tokenBody.access_token) {
      throw Object.assign(
        new AppError(502, "watsonx_auth_failed", "watsonx IAM response missing access_token."),
        { _retriable: false }
      );
    }
    iamToken = tokenBody.access_token;
  } catch (err) {
    clearTimeout(tokenTimer);
    if (err instanceof AppError) throw err;
    throw Object.assign(
      new AppError(502, "watsonx_unreachable",
        `Could not reach watsonx IAM: ${(err as Error).message?.slice(0, 200)}`),
      { _retriable: true }
    );
  }

  _iamTokenCache = { token: iamToken, expiresAt: Date.now() + IAM_TOKEN_TTL_MS };
  return iamToken;
}

/* ── Model validation ────────────────────────────────────────────────────── */

/** Known text-only Granite models that do NOT support image inputs. */
const TEXT_ONLY_MODEL_PATTERNS = [
  /granite-3(?!.*vision)/i,
  /granite-guardian/i,
  /granite-code/i,
  /llama/i,
  /mistral/i,
];

let _modelValidationDone = false;

function warnIfTextOnlyModel(modelId: string, log?: VisionLogger): void {
  if (_modelValidationDone) return;
  _modelValidationDone = true;
  const isLikelyTextOnly = TEXT_ONLY_MODEL_PATTERNS.some((re) => re.test(modelId));
  if (isLikelyTextOnly) {
    const msg =
      `[ClaimGuard WARNING] WATSONX_MODEL_ID="${modelId}" appears to be a text-only ` +
      `model and cannot process image inputs.  Visual copyright detection will ` +
      `silently return garbage results.  Set WATSONX_MODEL_ID=ibm/granite-vision-3-2-2b ` +
      `in your .env file to use a vision-capable model.`;
    // Always emit to process.stderr regardless of log level so it can't be missed.
    process.stderr.write(msg + "\n");
    log?.warn({ modelId }, "[vision] configured model is likely text-only — image inputs will fail");
  }
}

/** Visible for testing — reset model validation state. */
export function _resetModelValidation(): void {
  _modelValidationDone = false;
}

/* ── Granite Vision via watsonx.ai ───────────────────────────────────────── */

/**
 * Structured prompt sent to Granite Vision.
 * Constrains the model to a closed category taxonomy so that consecutive frames
 * of the same clip produce identical `category` strings and merge cleanly.
 * Free-text reasoning is preserved in `reasoning` for human review.
 */
const VISION_PROMPT = `You are a copyright-risk analyser for a video editing tool.

Examine this video frame and determine whether it contains third-party footage — content the video creator did not film themselves.

If it IS third-party footage, pick EXACTLY ONE category from this list:
  film_or_tv | sports_broadcast | news_broadcast | music_video | video_game | screen_recording | social_media_repost | advertisement | other_third_party

You MUST respond with ONLY a single JSON object — no markdown, no code fences, no explanation before or after. Start your response with { and end it with }. Any other format will be rejected.

The JSON object MUST have exactly these five fields:
{
  "is_third_party": boolean,
  "confidence": number,        // 0–100
  "category": string,          // one value from the list above, or "" if not third-party
  "signals": string[],         // specific visual clues, max 5 items
  "reasoning": string          // one or two sentences explaining the decision
}

Be conservative: only flag when there is clear visual evidence. A confidence below 40 means is_third_party should be false.`;

interface GraniteVisionOutput {
  is_third_party: boolean;
  confidence: number;
  category: string;
  signals: string[];
  reasoning: string;
}

/**
 * Locate the first complete JSON object in `text` by scanning for a matching
 * { … } pair, tolerating leading prose, markdown fences, trailing remarks, and
 * stray whitespace.  Returns the extracted substring or null if none is found.
 *
 * This makes the parser robust to how small models actually behave: they often
 * add a preamble ("Here is the JSON:"), a trailing sentence, or wrap the object
 * in a markdown fence even when explicitly told not to.
 */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;

    if (escape) { escape = false; continue; }
    if (ch === "\\" && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === "{") { depth++; continue; }
    if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null; // no balanced closing brace found
}

/**
 * Call watsonx.ai Granite Vision once.
 *
 * Uses the module-level IAM token cache.  On a 401 response the cache is
 * cleared and the token is re-fetched exactly once before re-attempting the
 * inference call.
 *
 * Throws AppError on transport failure (tagged _retriable) or bad response.
 */
async function callGraniteVisionOnce(
  apiKey: string,
  projectId: string,
  modelId: string,
  iamTokenUrl: string,
  watsonxUrl: string,
  timeoutMs: number,
  frameBuffer: Buffer,
  log?: VisionLogger
): Promise<VisualIdentifyResult> {
  // ── 1. Obtain IAM bearer token (cached, ~50 min TTL) ────────────────────
  const iamToken = await fetchIamToken(apiKey, iamTokenUrl);

  // ── 2. Build request payload ────────────────────────────────────────────
  const base64Frame = frameBuffer.toString("base64");
  const payload = {
    model_id: modelId,
    project_id: projectId,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: VISION_PROMPT },
          {
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${base64Frame}` },
          },
        ],
      },
    ],
    max_tokens: 512,
    temperature: 0,
  };

  // ── 3. Call watsonx.ai inference endpoint ───────────────────────────────
  const inferController = new AbortController();
  const inferTimer = setTimeout(() => inferController.abort(), timeoutMs);
  const start = Date.now();

  let responseText: string;
  let statusCode: number;

  try {
    const res = await fetch(
      `${watsonxUrl}/ml/v1/text/chat?version=2024-05-31`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${iamToken}`,
        },
        body: JSON.stringify(payload),
        signal: inferController.signal,
      }
    );
    clearTimeout(inferTimer);
    statusCode = res.status;
    responseText = await res.text();
  } catch (err) {
    clearTimeout(inferTimer);
    const durationMs = Date.now() - start;
    const errMsg = (err as Error).message ?? String(err);
    const isTimeout =
      err instanceof Error && err.name === "AbortError";

    log?.warn(
      { durationMs, reason: errMsg.slice(0, 200) },
      "watsonx Vision transport failure"
    );

    if (isTimeout) {
      throw new GatewayTimeoutError(
        "Granite Vision did not answer in time. Visual scan will continue without this frame."
      );
    }
    throw Object.assign(
      new AppError(502, "watsonx_unreachable",
        `Could not reach watsonx: ${errMsg.slice(0, 200)}`),
      { _retriable: true }
    );
  }

  const durationMs = Date.now() - start;

  // ── 3a. Token expired mid-flight — clear cache and surface as retriable ─
  if (statusCode === 401) {
    _clearIamTokenCache();
    log?.warn({ durationMs }, "watsonx returned 401 — IAM token cache cleared, will retry");
    throw Object.assign(
      new AppError(502, "watsonx_auth_failed", "watsonx bearer token was rejected (401). Retrying with a fresh token."),
      { _retriable: true }
    );
  }

  if (statusCode === 429) {
    log?.warn({ durationMs, statusCode }, "watsonx rate-limited this server");
    throw new AppError(429, "rate_limited",
      "The vision service is rate limiting this server. Try again shortly.",
      { retryAfterSeconds: 30 }
    );
  }

  // ── 4. Parse response ───────────────────────────────────────────────────
  let parsed: { choices?: { message?: { content?: string } }[] };
  try {
    parsed = JSON.parse(responseText) as typeof parsed;
  } catch {
    log?.warn({ durationMs, statusCode }, "watsonx unparseable response");
    throw new AppError(502, "watsonx_unreachable",
      "Granite Vision returned an unexpected response."
    );
  }

  const content = parsed?.choices?.[0]?.message?.content ?? "";
  let visionOutput: GraniteVisionOutput;

  // ── Extract the JSON object from the model's content ───────────────────
  // Small models often add prose, markdown fences, or trailing remarks
  // regardless of the prompt instruction.  Rather than demanding the response
  // be exactly the object, locate the first complete JSON object anywhere in
  // the text by scanning for the outermost { … } pair.
  const extracted = extractFirstJsonObject(content);
  if (extracted === null) {
    log?.warn(
      { durationMs, rawContent: content.slice(0, 500) },
      "Granite Vision JSON parse failed — no JSON object found in response (parse failure, result not cached)"
    );
    return { match: null, parseFailure: true };
  }

  try {
    visionOutput = JSON.parse(extracted) as GraniteVisionOutput;
  } catch {
    log?.warn(
      { durationMs, rawContent: content.slice(0, 500) },
      "Granite Vision JSON parse failed — extracted text was not valid JSON (parse failure, result not cached)"
    );
    return { match: null, parseFailure: true };
  }

  // ── Validate required fields ────────────────────────────────────────────
  if (
    typeof visionOutput.is_third_party !== "boolean" ||
    typeof visionOutput.confidence !== "number" ||
    typeof visionOutput.category !== "string" ||
    !Array.isArray(visionOutput.signals) ||
    typeof visionOutput.reasoning !== "string"
  ) {
    log?.warn(
      { durationMs, rawContent: content.slice(0, 500) },
      "Granite Vision schema validation failed — required fields missing or wrong type (parse failure, result not cached)"
    );
    return { match: null, parseFailure: true };
  }

  if (!visionOutput.is_third_party || visionOutput.confidence < 40) {
    // Confident clean negative — log at info so healthy runs are visible.
    log?.info?.(
      { durationMs, confidence: visionOutput.confidence, isThirdParty: false },
      "Granite Vision: clean negative verdict"
    );
    return { match: null };
  }

  log?.info?.(
    {
      durationMs,
      confidence: visionOutput.confidence,
      category: visionOutput.category,
      isThirdParty: true,
    },
    "Granite Vision: third-party match"
  );

  // ── 5. Validate category against the closed taxonomy ───────────────────
  const rawCategory = typeof visionOutput.category === "string"
    ? visionOutput.category.trim()
    : "";
  const category: VisualCategory = VALID_CATEGORIES.has(rawCategory)
    ? (rawCategory as VisualCategory)
    : "other_third_party";

  return {
    match: {
      label: category,
      signals: Array.isArray(visionOutput.signals) ? visionOutput.signals.slice(0, 5) : [],
      reasoning: typeof visionOutput.reasoning === "string" ? visionOutput.reasoning : "",
      confidence: Math.min(100, Math.max(0, Number(visionOutput.confidence) || 0)),
      source: "granite_vision",
    },
  };
}

/* ── Public API ──────────────────────────────────────────────────────────── */

/**
 * Identify potential copyright exposure in a single video frame.
 *
 * Pipeline:
 *  1. Heuristic pre-pass (always, free, synchronous).
 *  2. Granite Vision (when watsonx credentials are present).
 *     - If heuristics already fired AND Granite Vision is unavailable, the
 *       heuristic result is returned rather than failing silently.
 *     - If Granite Vision confirms, its result (with richer reasoning) wins.
 *     - If Granite Vision disagrees with heuristics, heuristic signals are
 *       merged into the Granite result's signals array.
 *
 * Throws ConfigurationError when watsonx is not configured AND no heuristic
 * signals fired — callers can use this to skip caching no-op frames.
 *
 * The semaphore and circuit breaker only wrap the Granite Vision network call,
 * not the synchronous heuristic pre-pass.
 */
export async function identifyFrame(
  frameBuffer: Buffer,
  widthHint?: number,
  heightHint?: number,
  log?: VisionLogger
): Promise<VisualIdentifyResult> {
  const cfg = getConfig();

  // ── Heuristic pre-pass ────────────────────────────────────────────────
  const heuristicResult = heuristicAnalyse(frameBuffer, widthHint, heightHint);

  const watsonxEnabled =
    Boolean(cfg.WATSONX_API_KEY) &&
    Boolean(cfg.WATSONX_PROJECT_ID);

  // Warn once on first call if the configured model cannot accept images.
  if (watsonxEnabled) {
    warnIfTextOnlyModel(cfg.WATSONX_MODEL_ID, log);
  }

  // No model configured — return heuristic result (or null) immediately.
  if (!watsonxEnabled) {
    if (!heuristicResult) {
      throw new ConfigurationError(
        "Visual identification is not configured on this server."
      );
    }
    return { match: heuristicResult };
  }

  // ── Circuit breaker check ─────────────────────────────────────────────
  if (isBreakerOpen(log)) {
    // Fall back to heuristic result rather than returning a hard error —
    // a degraded visual scan is better than a failed one.
    if (heuristicResult) {
      log?.warn({}, "Vision circuit breaker open — falling back to heuristic result");
      return { match: heuristicResult };
    }
    throw new AppError(
      503,
      "vision_busy",
      "The visual matching service is temporarily unavailable. Try again in a minute."
    );
  }

  // ── Acquire semaphore ─────────────────────────────────────────────────
  const semaphore = getSemaphore();
  let release: (() => void) | null = null;

  try {
    release = await semaphore.acquire(IDENTIFY_SEMAPHORE_WAIT_MS);
  } catch {
    log?.warn(
      { inFlight: semaphore.inFlight, queueDepth: semaphore.queueDepth },
      "Vision semaphore wait exceeded — falling back to heuristic"
    );
    if (heuristicResult) return { match: heuristicResult };
    throw new AppError(503, "vision_busy",
      "The visual scanner is busy. Try again in a few seconds.",
      { retryAfterSeconds: 5 }
    );
  }

  try {
    const {
      WATSONX_API_KEY: apiKey,
      WATSONX_PROJECT_ID: projectId,
      WATSONX_MODEL_ID: modelId,
      WATSONX_IAM_URL: iamTokenUrl,
      WATSONX_URL: watsonxUrl,
      WATSONX_TIMEOUT_MS: timeoutMs,
    } = cfg;

    // ── First attempt ────────────────────────────────────────────────────
    let result: VisualIdentifyResult;
    try {
      result = await callGraniteVisionOnce(
        apiKey!, projectId!, modelId, iamTokenUrl, watsonxUrl,
        timeoutMs, frameBuffer, log
      );
      recordSuccess(log);
    } catch (err) {
      const isRetriable =
        (err instanceof GatewayTimeoutError) ||
        ((err as { _retriable?: boolean })._retriable === true);
      const isBusiness = err instanceof AppError && !isRetriable;

      if (!isRetriable || isBusiness) {
        recordFailure(log);
        // On any model failure, fall back to heuristic rather than erroring
        if (heuristicResult) {
          log?.warn(
            { reason: err instanceof Error ? err.message.slice(0, 200) : String(err) },
            "Granite Vision failed — falling back to heuristic result"
          );
          return { match: heuristicResult };
        }
        throw err;
      }

      // ── Single retry after 500 ms ────────────────────────────────────
      log?.warn(
        { reason: err instanceof Error ? err.message.slice(0, 200) : String(err) },
        "Granite Vision transient failure — retrying once"
      );
      await new Promise<void>((r) => setTimeout(r, 500));

      try {
        result = await callGraniteVisionOnce(
          apiKey!, projectId!, modelId, iamTokenUrl, watsonxUrl,
          timeoutMs, frameBuffer, log
        );
        recordSuccess(log);
      } catch (retryErr) {
        recordFailure(log);
        if (heuristicResult) {
          log?.warn({}, "Granite Vision retry failed — falling back to heuristic");
          return { match: heuristicResult };
        }
        throw retryErr;
      }
    }

    // ── Merge heuristic signals into Granite Vision result ───────────────
    if (result.match && heuristicResult) {
      // Deduplicate: add any heuristic signals not already mentioned
      const existingLower = new Set(
        result.match.signals.map((s) => s.toLowerCase())
      );
      for (const sig of heuristicResult.signals) {
        if (!existingLower.has(sig.toLowerCase())) {
          result.match.signals.push(sig);
        }
      }
    }

    return result;
  } finally {
    release?.();
  }
}

/* ── Observability ────────────────────────────────────────────────────────── */

export function getVisionGauges(): {
  inFlight: number;
  queueDepth: number;
  circuitBreakerOpen: boolean;
} {
  const sem = _semaphore;
  return {
    inFlight: sem?.inFlight ?? 0,
    queueDepth: sem?.queueDepth ?? 0,
    circuitBreakerOpen: _breaker.openedAt !== null,
  };
}
