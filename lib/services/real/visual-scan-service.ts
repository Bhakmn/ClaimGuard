/**
 * Real VisualScanService implementation.
 *
 * Performance design (vs. the prior O(n²) implementation):
 *
 *  1. One HTMLVideoElement per media item — created once, seeked repeatedly.
 *     The prior approach re-created a new element and re-fetched the entire
 *     video for every frame, which was O(n²) in video duration.
 *
 *  2. Coarse sampling at FRAME_INTERVAL_SECONDS (default 2 s) — a clip that
 *     matters will span multiple seconds, so 1 fps is redundant.
 *
 *  3. Scene-change pre-filter — compares a 16×9 downscaled luminance histogram
 *     of each candidate frame against the previously analysed frame.  Frames
 *     that are near-identical (histogram distance < SCENE_CHANGE_THRESHOLD)
 *     inherit the previous frame's verdict without an upstream call.  Static
 *     talking-head stretches cost one upstream call for the first frame and
 *     nothing for subsequent matching frames.
 *
 *  4. Client-side concurrency pool — up to SCAN_CONCURRENCY frame requests
 *     run in parallel.  The server already has WATSONX_MAX_CONCURRENCY and a
 *     semaphore to absorb this.
 *
 * Before/after on a 60-second clip (4× WATSONX concurrency, 2 s interval):
 *   Before: 60 sequential round-trips ×2 (token + inference) = ~120 calls
 *   After:  ~30 candidate frames, filtered to ~10–20 novel scenes,
 *           ~3–7 concurrent batches, ~1 IAM token call per 50 minutes.
 *
 * Consecutive frames belonging to the same detected category are merged into
 * a single FlaggedVisualSpan.  Hysteresis (HYSTERESIS_MISSES) prevents a
 * single non-matching frame from splitting an otherwise continuous span.
 *
 * A module-level AbortController ensures any in-flight scan from a previous
 * call is cancelled before a new one starts.
 */

import type { MediaItem, FlaggedVisualSpan, VisualCategory } from "@/lib/types";
import type {
  VisualScanService,
  VisualScanProgress,
  VisualScanRequest,
} from "@/lib/mock/vision-scan-service";
import { identifyFrame, type VisualMatch } from "@/lib/api/identify-video";

/* ─── Tuning constants ───────────────────────────────────────────────────── */

/** Seconds between captured frames. 2 s strikes the right balance for demo. */
const FRAME_INTERVAL_SECONDS = 2;

/**
 * Maximum number of frame requests to issue concurrently.
 * The server semaphore (WATSONX_MAX_CONCURRENCY=4) absorbs this comfortably.
 */
const SCAN_CONCURRENCY = 3;

/**
 * Histogram bin count for the scene-change filter (per channel).
 * 16 bins × 1 channel (luma) = 16-element vector.
 */
const HISTOGRAM_BINS = 16;

/**
 * Maximum normalised histogram distance considered "no scene change."
 * Range 0–1; values below this threshold skip the upstream call.
 */
const SCENE_CHANGE_THRESHOLD = 0.04;

/**
 * How many consecutive non-matching frames must occur before a span is closed.
 * Prevents a single noisy frame from splitting a continuous detection.
 */
const HYSTERESIS_MISSES = 2;

/* ─── Scene-change filter ────────────────────────────────────────────────── */

/**
 * Compute a normalised 16-bin luma histogram of a 16×9 thumbnail drawn onto
 * a tiny OffscreenCanvas.  Returns null if OffscreenCanvas is unavailable.
 */
function computeHistogram(
  video: HTMLVideoElement,
  canvas: OffscreenCanvas,
  ctx: OffscreenCanvasRenderingContext2D
): Float32Array | null {
  try {
    const W = canvas.width;
    const H = canvas.height;
    ctx.drawImage(video, 0, 0, W, H);
    const data = ctx.getImageData(0, 0, W, H).data;
    const hist = new Float32Array(HISTOGRAM_BINS);
    const pixelCount = W * H;
    for (let i = 0; i < data.length; i += 4) {
      // BT.601 luma: 0.299R + 0.587G + 0.114B
      const luma = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
      const bin = Math.min(HISTOGRAM_BINS - 1, Math.floor((luma / 256) * HISTOGRAM_BINS));
      hist[bin]!++;
    }
    for (let i = 0; i < HISTOGRAM_BINS; i++) hist[i]! /= pixelCount;
    return hist;
  } catch {
    return null;
  }
}

/** L1 distance between two normalised histograms.  Range 0–2. */
function histogramDistance(a: Float32Array, b: Float32Array): number {
  let d = 0;
  for (let i = 0; i < HISTOGRAM_BINS; i++) d += Math.abs(a[i]! - b[i]!);
  return d;
}

/* ─── Video element pool ─────────────────────────────────────────────────── */

/**
 * Create a dedicated HTMLVideoElement for a MediaItem and wait for it to be
 * ready to seek.  The element is set to preload="auto" but NOT auto-played.
 * Returns null if loadedmetadata does not fire within the timeout.
 */
function createDedicatedVideoElement(
  url: string,
  signal: AbortSignal,
  timeoutMs = 15_000
): Promise<HTMLVideoElement | null> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(null); return; }

    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.crossOrigin = "anonymous";
    video.playsInline = true;

    let settled = false;
    const settle = (v: HTMLVideoElement | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(tid);
      signal.removeEventListener("abort", onAbort);
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("error", onError);
      resolve(v);
    };

    const tid = setTimeout(() => settle(null), timeoutMs);
    const onAbort = () => {
      video.src = "";
      settle(null);
    };
    const onMeta = () => settle(video);
    const onError = () => settle(null);

    signal.addEventListener("abort", onAbort, { once: true });
    video.addEventListener("loadedmetadata", onMeta, { once: true });
    video.addEventListener("error", onError, { once: true });

    video.src = url;
    video.load();
  });
}

/**
 * Seek an existing HTMLVideoElement to `timeSec` and wait for the seeked event.
 * Returns a JPEG Blob of the frame or null on failure.
 */
function seekAndCapture(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  timeSec: number,
  signal: AbortSignal
): Promise<{ blob: Blob; width: number; height: number } | null> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(null); return; }

    let settled = false;
    const settle = (v: { blob: Blob; width: number; height: number } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(tid);
      signal.removeEventListener("abort", onAbort);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      resolve(v);
    };

    const onAbort = () => settle(null);
    const onError = () => settle(null);
    const tid = setTimeout(() => settle(null), 8_000);

    const onSeeked = () => {
      try {
        const scale = Math.min(1, 640 / (video.videoWidth || 640));
        const W = Math.round((video.videoWidth || 640) * scale);
        const H = Math.round((video.videoHeight || 360) * scale);
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext("2d");
        if (!ctx) { settle(null); return; }
        ctx.drawImage(video, 0, 0, W, H);
        canvas.toBlob(
          (blob) => {
            settle(blob ? { blob, width: W, height: H } : null);
          },
          "image/jpeg",
          0.82
        );
      } catch {
        settle(null);
      }
    };

    signal.addEventListener("abort", onAbort, { once: true });
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });

    video.currentTime = timeSec;
  });
}

/* ─── ID counter ─────────────────────────────────────────────────────────── */

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `v${idCounter}`;
}

/* ─── Span management ────────────────────────────────────────────────────── */

interface ActiveVisualSpan {
  spanId: string;
  label: VisualCategory;
  /** Number of consecutive frames that did NOT match since the span opened. */
  misses: number;
}

function matchToSpan(
  match: NonNullable<VisualMatch>,
  mediaId: string,
  timeSec: number,
  interval: number
): FlaggedVisualSpan {
  return {
    id: nextId(),
    mediaId,
    start: timeSec,
    end: timeSec + interval,
    label: match.label,
    signals: match.signals,
    reasoning: match.reasoning,
    confidence: match.confidence,
    enabled: true,
    manual: false,
    source: match.source,
  };
}

/* ─── Cancellation ───────────────────────────────────────────────────────── */

let activeScanController: AbortController | null = null;

/* ─── Real scan service ──────────────────────────────────────────────────── */

export const realVisualScanService: VisualScanService = {
  async scan(
    request: VisualScanRequest,
    onProgress: (p: VisualScanProgress) => void
  ): Promise<FlaggedVisualSpan[]> {
    if (activeScanController) activeScanController.abort();
    const controller = new AbortController();
    activeScanController = controller;
    const signal = controller.signal;

    const found: FlaggedVisualSpan[] = [];
    const emit = (fraction: number, status: string) => {
      if (signal.aborted) return;
      onProgress({ fraction, status, found: [...found] });
    };

    // Build a tiny OffscreenCanvas for scene-change histograms (16×9).
    const histCanvas = typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(16, 9)
      : null;
    const histCtx = histCanvas
      ? (histCanvas.getContext("2d") as OffscreenCanvasRenderingContext2D | null)
      : null;

    try {
      // Build timestamp lists for all items up front
      const itemTimestamps: number[][] = request.items.map((item) => {
        const frames: number[] = [];
        for (
          let t = 0;
          t < item.duration - FRAME_INTERVAL_SECONDS * 0.5;
          t += FRAME_INTERVAL_SECONDS
        ) {
          frames.push(t);
        }
        if (frames.length === 0) frames.push(0);
        return frames;
      });

      const totalFrames = itemTimestamps.reduce((s, ts) => s + ts.length, 0);
      let framesDone = 0;

      for (let itemIdx = 0; itemIdx < request.items.length; itemIdx++) {
        if (signal.aborted) break;

        const item = request.items[itemIdx];
        const timestamps = itemTimestamps[itemIdx] ?? [];

        emit(
          framesDone / totalFrames,
          `Setting up video decoder for ${item.name}…`
        );

        // ── One video element per item ─────────────────────────────────
        const video = await createDedicatedVideoElement(item.url, signal);
        if (signal.aborted) break;
        if (!video) {
          framesDone += timestamps.length;
          emit(framesDone / totalFrames, `Could not decode ${item.name}, skipping…`);
          continue;
        }

        // One reused capture canvas per item
        const captureCanvas = document.createElement("canvas");

        let active: ActiveVisualSpan | null = null;
        let lastHistogram: Float32Array | null = null;

        // ── Process timestamps in concurrent batches ──────────────────
        for (let batchStart = 0; batchStart < timestamps.length; batchStart += SCAN_CONCURRENCY) {
          if (signal.aborted) break;

          const batchEnd = Math.min(batchStart + SCAN_CONCURRENCY, timestamps.length);
          const batchTimes = timestamps.slice(batchStart, batchEnd);

          // Sequential within batch to avoid race on the shared video element's
          // currentTime.  Concurrency comes from issuing HTTP requests in parallel
          // after capture.
          type FrameResult = {
            timeSec: number;
            match: VisualMatch;
            inherited: boolean;
          };

          // Capture all frames sequentially (single video element)
          const captures: Array<{
            timeSec: number;
            blob: Blob | null;
            width: number;
            height: number;
            inherited: boolean;
            inheritedMatch: VisualMatch;
          }> = [];

          for (const timeSec of batchTimes) {
            const captured = await seekAndCapture(video, captureCanvas, timeSec, signal);
            if (signal.aborted) break;

            let inherited = false;
            let inheritedMatch: VisualMatch = null;

            if (captured && histCanvas && histCtx) {
              const hist = computeHistogram(video, histCanvas, histCtx);
              if (hist && lastHistogram) {
                const dist = histogramDistance(hist, lastHistogram);
                if (dist < SCENE_CHANGE_THRESHOLD) {
                  // Near-identical frame — inherit previous verdict, skip upstream call
                  inherited = true;
                  inheritedMatch = active
                    ? {
                        label: active.label,
                        signals: [],
                        reasoning: "(inherited from previous frame — scene unchanged)",
                        confidence: 50,
                        source: "heuristic",
                      }
                    : null;
                }
              }
              if (hist) lastHistogram = hist;
            }

            captures.push({
              timeSec,
              blob: captured?.blob ?? null,
              width: captured?.width ?? 0,
              height: captured?.height ?? 0,
              inherited,
              inheritedMatch,
            });
          }

          if (signal.aborted) break;

          // Issue HTTP requests concurrently for non-inherited frames
          const frameResults: FrameResult[] = await Promise.all(
            captures.map(async ({ timeSec, blob, width, height, inherited, inheritedMatch }) => {
              if (inherited) {
                return { timeSec, match: inheritedMatch, inherited: true };
              }
              if (!blob) {
                return { timeSec, match: null, inherited: false };
              }
              try {
                const match = await identifyFrame(blob, width, height, signal);
                return { timeSec, match, inherited: false };
              } catch (err) {
                if (err instanceof Error && err.name === "AbortError") throw err;
                return { timeSec, match: null, inherited: false };
              }
            })
          );

          // Apply results in timestamp order, maintaining hysteresis
          for (const { timeSec, match } of frameResults) {
            if (signal.aborted) break;

            const fraction = (framesDone + 1) / totalFrames;
            framesDone++;

            if (match) {
              if (active && active.label === match.label) {
                // Extend or re-activate the current span (absorbs hysteresis misses)
                active.misses = 0;
                const idx = found.findIndex((s) => s.id === active!.spanId);
                if (idx >= 0) {
                  found[idx] = { ...found[idx]!, end: timeSec + FRAME_INTERVAL_SECONDS };
                  emit(fraction, `Extending visual flag "${match.label}" at ${Math.round(timeSec)}s…`);
                }
              } else {
                // New category — close any existing active span and open a new one
                active = null;
                const span = matchToSpan(match, item.id, timeSec, FRAME_INTERVAL_SECONDS);
                found.push(span);
                active = { spanId: span.id, label: match.label, misses: 0 };
                emit(fraction, `Visual signal detected — "${match.label}" at ${Math.round(timeSec)}s…`);
              }
            } else {
              if (active) {
                active.misses++;
                if (active.misses >= HYSTERESIS_MISSES) {
                  emit(fraction, `Visual flag "${active.label}" ended.`);
                  active = null;
                } else {
                  // Absorb the miss — extend span tentatively
                  const idx = found.findIndex((s) => s.id === active!.spanId);
                  if (idx >= 0) {
                    found[idx] = { ...found[idx]!, end: timeSec + FRAME_INTERVAL_SECONDS };
                  }
                }
              } else {
                emit(fraction, `Scanning frame at ${Math.round(timeSec)}s of ${item.name}…`);
              }
            }
          }
        }

        // Release the video element
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
    } finally {
      if (activeScanController === controller) activeScanController = null;
    }

    if (signal.aborted) {
      throw new DOMException("Visual scan cancelled", "AbortError");
    }

    onProgress({ fraction: 1, status: "Visual scan complete.", found });
    return found;
  },
};
