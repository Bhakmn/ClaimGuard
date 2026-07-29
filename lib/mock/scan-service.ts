import type { MediaItem, FlaggedSpan } from "../types";
import { formatClock } from "../formatters";
import { delay, getControls } from "./delay";

/* ─── Types ──────────────────────────────────────────────────────────────── */

export type ScanStageIndex = 0 | 1 | 2 | 3;

export interface ScanProgress {
  stage: ScanStageIndex;
  fraction: number;
  status: string;
  found: FlaggedSpan[];
}

export interface ScanRequest {
  items: MediaItem[];
  mode: "replace" | "append";
}

export interface ScanService {
  scan(
    request: ScanRequest,
    onProgress: (p: ScanProgress) => void
  ): Promise<FlaggedSpan[]>;
  /**
   * Abort any in-flight scan immediately.  Safe to call when nothing is
   * running.  The pending scan() promise will reject with an AbortError.
   */
  cancel(): void;
}

/* ─── Fixture flags ──────────────────────────────────────────────────────── */

interface FixtureFlag {
  from: number;
  to: number;
  title: string;
  artists: string;
  album: string;
  confidence: number;
}

const FIXTURE_FLAGS: FixtureFlag[] = [
  {
    from: 0.08,
    to: 0.27,
    title: "Neon Corridor",
    artists: "Halvorsen & The Tallow",
    album: "Streetlight Cartography",
    confidence: 94,
  },
  {
    from: 0.41,
    to: 0.55,
    title: "Paper Lanterns",
    artists: "Mira Solvang",
    album: "Low Tide Sessions",
    confidence: 88,
  },
  {
    from: 0.78,
    to: 0.93,
    title: "Slow Ascender",
    artists: "Delphine Rusk",
    album: "Altitude Studies",
    confidence: 71,
  },
];

const FIXTURE_FLAGS_SECONDARY: FixtureFlag[] = [
  {
    from: 0.14,
    to: 0.62,
    title: "Ferrous Bloom",
    artists: "Okonkwo Trio",
    album: "Cast Iron Sky",
    confidence: 63,
  },
];

/* ─── Monotonic ID counter ───────────────────────────────────────────────── */

let idCounter = 0;
export function nextId(): string {
  idCounter += 1;
  return `r${idCounter}`;
}

/* ─── Mock implementation ────────────────────────────────────────────────── */

export const mockScanService: ScanService = {
  cancel() { /* mock resolves quickly; no abort needed */ },
  async scan(request, onProgress) {
    const controls = getControls();

    // Offline — immediate failure
    if (controls.offline) {
      await delay(200);
      throw new Error(
        "No connection. Reconnect, then start the scan again."
      );
    }

    const found: FlaggedSpan[] = [];
    const emit = (stage: ScanStageIndex, fraction: number, status: string) => {
      onProgress({ stage, fraction, status, found: [...found] });
    };

    // ── Stage 0: Load Engine ────────────────────────────────────────────── //
    emit(0, 0, "Loading the audio engine (first run downloads ~10 MB)…");
    await delay(1400);

    // ── Stage 1: Prepare Video ──────────────────────────────────────────── //
    for (const item of request.items) {
      emit(1, 0, `Preparing ${item.name}…`);
      await delay(900);
    }

    // ── Stage 2: Waveform ───────────────────────────────────────────────── //
    for (const item of request.items) {
      if (!item.waveform) {
        emit(2, 0, "Generating waveform…");
        await delay(1100);
      }
    }

    // ── Stage 3: Fingerprint ────────────────────────────────────────────── //

    // Rate-limit check at start of stage 3
    if (controls.rateLimited) {
      emit(3, 0, "Checking rate limits…");
      await delay(300);
      throw new Error(
        "Too many scans right now. Wait a minute, then start the scan again."
      );
    }

    // Compute chunks across all items
    let totalChunks = 0;
    const itemChunkCounts: number[] = [];
    for (const item of request.items) {
      const count = Math.max(1, Math.floor(item.duration / 5));
      itemChunkCounts.push(count);
      totalChunks += count;
    }

    let chunksDone = 0;
    const failChunk = Math.floor(totalChunks * 0.4);

    for (let itemIdx = 0; itemIdx < request.items.length; itemIdx++) {
      const item = request.items[itemIdx];
      const chunkCount = itemChunkCounts[itemIdx];
      const fixtures =
        itemIdx === 0 ? FIXTURE_FLAGS : FIXTURE_FLAGS_SECONDARY;

      // Map fixture fractions to seconds
      const windows = fixtures
        .map((f) => ({
          ...f,
          startSec: f.from * item.duration,
          endSec: f.to * item.duration,
          spanId: null as string | null,
        }))
        .filter((w) => w.endSec - w.startSec >= 2);

      let activeWindow: (typeof windows)[0] | null = null;

      for (let i = 0; i < chunkCount; i++) {
        const chunkLen = i < chunkCount - 1 ? 5 : item.duration - i * 5;
        const start = i * 5;
        const end = start + chunkLen;

        const globalChunk = chunksDone + i;

        // Scan-error check
        if (controls.scanFails && globalChunk >= failChunk) {
          throw new Error(
            "The music-recognition service didn't answer. Start the scan again."
          );
        }

        const fraction = (globalChunk + 1) / totalChunks;

        // Check window entry
        const entering = windows.find(
          (w) => !w.spanId && start >= w.startSec - 5 && start < w.endSec
        );
        if (entering && !activeWindow) {
          activeWindow = entering;
          emit(
            3,
            fraction,
            `Music detected — pinpointing where "${entering.title}" starts…`
          );
          await delay(540);

          // Push the span
          const id = nextId();
          entering.spanId = id;
          found.push({
            id,
            mediaId: item.id,
            start: entering.startSec,
            end: end, // will be extended
            title: entering.title,
            artists: entering.artists,
            album: entering.album,
            confidence: entering.confidence,
            enabled: true,
            manual: false,
          });
        }

        // Extend active span end
        if (activeWindow?.spanId) {
          const spanIdx = found.findIndex((s) => s.id === activeWindow!.spanId);
          if (spanIdx >= 0) {
            found[spanIdx] = { ...found[spanIdx], end: end };
          }
        }

        // Check window exit
        if (activeWindow && end >= activeWindow.endSec) {
          emit(
            3,
            fraction,
            `Pinpointing where "${activeWindow.title}" ends…`
          );
          await delay(540);

          // Finalise span end
          const spanIdx = found.findIndex((s) => s.id === activeWindow!.spanId);
          if (spanIdx >= 0) {
            found[spanIdx] = { ...found[spanIdx], end: activeWindow.endSec };
          }
          activeWindow = null;
        }

        // Ordinary scanning line
        emit(
          3,
          fraction,
          `Scanning ${item.name} ${formatClock(start)}–${formatClock(end)} (chunk ${i + 1}/${chunkCount})…`
        );
        await delay(260);
      }

      chunksDone += chunkCount;
    }

    // Empty scan — discard everything found
    if (controls.emptyScan) {
      onProgress({ stage: 3, fraction: 1, status: "Scan complete.", found: [] });
      return [];
    }

    onProgress({ stage: 3, fraction: 1, status: "Scan complete.", found });
    return found;
  },
};
