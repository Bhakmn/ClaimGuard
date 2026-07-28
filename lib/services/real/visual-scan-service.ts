/**
 * Real VisualScanService implementation.
 *
 * Extracts one JPEG frame per second from the decoded video using an
 * OfflineAudioContext-free approach: HTMLCanvasElement + HTMLVideoElement
 * (available in browser, not in Node).
 *
 * Each frame is sent to POST /api/identify-video. The server runs a
 * heuristic pre-pass plus optional Granite Vision and returns a VisualMatch
 * or null.
 *
 * Consecutive frames belonging to the same detected "event" are merged into
 * a single FlaggedVisualSpan, extending its `end` field as new matching
 * frames arrive — identical to the audio span-merging logic in scan-service.ts.
 *
 * A module-level AbortController ensures any in-flight scan from a previous
 * call is cancelled before a new one starts.
 */

import type { MediaItem, FlaggedVisualSpan } from "@/lib/types";
import type {
  VisualScanService,
  VisualScanProgress,
  VisualScanRequest,
} from "@/lib/mock/vision-scan-service";
import { identifyFrame, type VisualMatch } from "@/lib/api/identify-video";

/* ─── Frame extraction ───────────────────────────────────────────────────── */

/**
 * Extract a JPEG Blob for `timeSec` from an HTMLVideoElement that has already
 * had its `src` set and been seeked.
 *
 * Returns null if the canvas API is unavailable or the element has no video.
 */
async function captureFrameAtTime(
  url: string,
  timeSec: number,
  signal: AbortSignal
): Promise<{ blob: Blob; width: number; height: number } | null> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(null); return; }

    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.crossOrigin = "anonymous";

    const cleanup = () => {
      video.pause();
      video.removeAttribute("src");
      video.load();
    };

    const onAbort = () => { cleanup(); resolve(null); };
    signal.addEventListener("abort", onAbort, { once: true });

    video.addEventListener("error", () => {
      signal.removeEventListener("abort", onAbort);
      cleanup();
      resolve(null);
    }, { once: true });

    video.addEventListener("seeked", () => {
      signal.removeEventListener("abort", onAbort);
      try {
        const canvas = document.createElement("canvas");
        // Scale down to max 640 px wide to keep frame payloads small
        const scale = Math.min(1, 640 / (video.videoWidth || 640));
        canvas.width = Math.round((video.videoWidth || 640) * scale);
        canvas.height = Math.round((video.videoHeight || 360) * scale);
        const ctx = canvas.getContext("2d");
        if (!ctx) { cleanup(); resolve(null); return; }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(
          (blob) => {
            cleanup();
            if (!blob) { resolve(null); return; }
            resolve({ blob, width: canvas.width, height: canvas.height });
          },
          "image/jpeg",
          0.82
        );
      } catch {
        cleanup();
        resolve(null);
      }
    }, { once: true });

    video.src = url;
    video.load();
    video.addEventListener("loadedmetadata", () => {
      video.currentTime = timeSec;
    }, { once: true });
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
  label: string;
}

function matchToSpan(
  match: NonNullable<VisualMatch>,
  mediaId: string,
  timeSec: number
): FlaggedVisualSpan {
  return {
    id: nextId(),
    mediaId,
    start: timeSec,
    end: timeSec + 1,
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

    try {
      // Count total frames across all items (1 frame per second)
      let totalFrames = 0;
      const itemFrameCounts: number[] = [];
      for (const item of request.items) {
        const count = Math.max(1, Math.ceil(item.duration));
        itemFrameCounts.push(count);
        totalFrames += count;
      }

      let framesDone = 0;

      for (let itemIdx = 0; itemIdx < request.items.length; itemIdx++) {
        if (signal.aborted) break;

        const item = request.items[itemIdx];
        const frameCount = itemFrameCounts[itemIdx] ?? 1;
        let active: ActiveVisualSpan | null = null;

        for (let i = 0; i < frameCount; i++) {
          if (signal.aborted) break;

          const timeSec = i;
          const fraction = (framesDone + i + 1) / totalFrames;

          emit(fraction, `Scanning frame ${i + 1}/${frameCount} of ${item.name}…`);

          const captured = await captureFrameAtTime(item.url, timeSec, signal);
          if (signal.aborted) break;

          let match: VisualMatch = null;
          if (captured) {
            try {
              match = await identifyFrame(
                captured.blob,
                captured.width,
                captured.height,
                signal
              );
            } catch (err) {
              if (err instanceof Error && err.name === "AbortError") throw err;
              match = null; // skip on error, don't abort the whole scan
            }
          }
          if (signal.aborted) break;

          if (match) {
            if (active && active.label === match.label) {
              // Extend the current span
              const idx = found.findIndex((s) => s.id === active!.spanId);
              if (idx >= 0) {
                found[idx] = { ...found[idx], end: timeSec + 1 };
                emit(fraction, `Extending visual flag "${match.label}"…`);
              }
            } else {
              active = null;
              const span = matchToSpan(match, item.id, timeSec);
              found.push(span);
              active = { spanId: span.id, label: match.label };
              emit(fraction, `Visual signal detected — "${match.label}" at ${Math.round(timeSec)}s…`);
            }
          } else {
            if (active) {
              emit(fraction, `Visual flag "${active.label}" ended.`);
              active = null;
            }
          }
        }

        framesDone += frameCount;
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
