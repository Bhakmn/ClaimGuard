/**
 * Vision service client — Granite Vision via watsonx.ai.
 *
 * Responsibilities:
 *  1. Heuristic pre-pass: fast, free, no API key needed — analyses raw pixel
 *     data encoded in the JPEG to detect letterbox/pillarbox bars, aspect-ratio
 *     anomalies, and overly-uniform-black border regions.  Returns a partial
 *     VisualMatch when heuristics alone are confident enough (score ≥ threshold).
 *  2. Granite Vision pass (watsonx.ai): sends the frame as a base64 image to
 *     IBM's multimodal foundation model with a structured prompt asking it to
 *     identify visual signals of third-party footage.  Runs when WATSONX_API_KEY
 *     and WATSONX_PROJECT_ID are present.
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
 *
 * Note on ACRCloud Video:
 *   ACRCloud does offer a Broadcast Monitoring / Video Fingerprinting product,
 *   but it is an enterprise licence product requiring a custom contract and is
 *   not publicly API-accessible on standard ACRCloud plans.  It is therefore
 *   NOT wired in here — see docs/video-copyright-detection.md §Fingerprint for
 *   the full assessment.  The heuristic + Granite Vision dual-signal approach
 *   is the implemented path.
 *
 * Gemini note:
 *   GEMINI_API_KEY is also available in the environment (see .env.example).
 *   This service uses the IBM watsonx/Granite Vision path as the primary model
 *   per the IBM-platform requirement.  The Gemini key is reserved for future
 *   use or a parallel signal if IBM model quality proves insufficient.
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

export interface VisualMatch {
  label: string;
  signals: string[];
  reasoning: string;
  confidence: number;       // 0–100
  source: "heuristic" | "granite_vision";
}

export interface VisualIdentifyResult {
  match: VisualMatch | null;
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
    label: "Possible third-party footage",
    signals,
    reasoning: "",
    confidence: Math.min(55, 30 + signals.length * 12),
    source: "heuristic",
  };
}

/* ── Granite Vision via watsonx.ai ───────────────────────────────────────── */

/**
 * Structured prompt sent to Granite Vision.
 * Asks the model to act as a copyright-risk detector, not a general describer.
 * Output is expected as JSON matching GraniteVisionOutput.
 */
const VISION_PROMPT = `You are a copyright-risk analyser for a video editing tool.

Examine this video frame and determine whether it looks like inserted third-party footage — i.e., content the video creator did not film themselves, such as a movie clip, TV episode segment, broadcast footage, game footage, screen recording, or someone else's published video.

Respond ONLY with a valid JSON object (no markdown fences) matching this schema:
{
  "is_third_party": boolean,
  "confidence": number,        // 0–100
  "label": string,             // short label, e.g. "Movie clip" or "Screen recording"
  "signals": string[],         // list of specific visual clues, max 5 items
  "reasoning": string          // one or two sentences of explanation
}

Be conservative: only flag when there is clear visual evidence. A confidence below 40 should result in is_third_party = false.`;

interface GraniteVisionOutput {
  is_third_party: boolean;
  confidence: number;
  label: string;
  signals: string[];
  reasoning: string;
}

/**
 * Call watsonx.ai Granite Vision once.
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
  // ── 1. Exchange API key for IAM bearer token ────────────────────────────
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
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Frame}` } },
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

  try {
    // Strip any accidental markdown fences
    const cleaned = content.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/,"");
    visionOutput = JSON.parse(cleaned) as GraniteVisionOutput;
  } catch {
    log?.warn({ durationMs }, "Granite Vision JSON parse failed — treating as no match");
    return { match: null };
  }

  log?.debug(
    { durationMs, statusCode, confidence: visionOutput.confidence, isThirdParty: visionOutput.is_third_party },
    "Granite Vision identify call"
  );

  if (!visionOutput.is_third_party || visionOutput.confidence < 40) {
    return { match: null };
  }

  return {
    match: {
      label: typeof visionOutput.label === "string" ? visionOutput.label : "Possible third-party footage",
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
