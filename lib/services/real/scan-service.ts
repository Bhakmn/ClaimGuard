/**
 * Real ScanService implementation.
 *
 * Extracts 5-second mono 8 kHz WAV slices from the browser's media using the
 * Web Audio API, then identifies each slice against the backend.
 *
 * The scan interface is identical to the mock: same ScanService type, same
 * ScanRequest / ScanProgress / FlaggedSpan shapes. The provider swaps this in
 * when NEXT_PUBLIC_USE_REAL_SERVICES is set.
 *
 * Note: This implementation does NOT use ffmpeg.wasm — it uses the Web Audio
 * API's OfflineAudioContext for sample extraction. The mock services remain
 * the correct path for local development without a backend.
 */

import type { MediaItem, FlaggedSpan } from "@/lib/types";
import type { ScanService, ScanProgress, ScanRequest, ScanStageIndex } from "@/lib/mock/scan-service";
import { identifySample, type IdentifyMatch } from "@/lib/api/identify";

/* ─── Audio decoding — decode once per item, slice per chunk ────────────── */

/**
 * Fetch and decode an entire media file into an AudioBuffer exactly once.
 * Returns null if the Web Audio API is unavailable or decoding fails.
 */
async function decodeMediaFile(
  url: string,
  signal: AbortSignal,
): Promise<AudioBuffer | null> {
  try {
    const resp = await fetch(url, { signal });
    const arrayBuffer = await resp.arrayBuffer();

    if (signal.aborted) return null;

    const AudioCtx =
      window.AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtx) return null;

    const audioCtx = new AudioCtx();
    let decoded: AudioBuffer;
    try {
      decoded = await audioCtx.decodeAudioData(arrayBuffer);
    } finally {
      await audioCtx.close();
    }
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Render a slice of an already-decoded AudioBuffer as a 16-bit mono 8 kHz
 * WAV Blob.  No network fetch, no re-decode — O(1) per chunk.
 */
async function sliceToWavAsync(
  decoded: AudioBuffer,
  startSeconds: number,
  durationSeconds: number,
): Promise<Blob> {
  const SAMPLE_RATE = 8_000;
  const sampleCount = Math.max(1, Math.round(durationSeconds * SAMPLE_RATE));

  const offline = new OfflineAudioContext(1, sampleCount, SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start(0, startSeconds, durationSeconds);

  const rendered = await offline.startRendering();
  return pcmToWav(rendered.getChannelData(0), SAMPLE_RATE);
}

/** Encode a Float32Array of PCM samples as a 16-bit mono WAV Blob. */
function pcmToWav(samples: Float32Array, sampleRate: number): Blob {
  const BITS = 16;
  const BYTES_PER_SAMPLE = BITS / 8;
  const numChannels = 1;
  const dataLength = samples.length * BYTES_PER_SAMPLE;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) {
      view.setUint8(offset + i, s.charCodeAt(i));
    }
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * BYTES_PER_SAMPLE, true);
  view.setUint16(32, numChannels * BYTES_PER_SAMPLE, true);
  view.setUint16(34, BITS, true);
  writeStr(36, "data");
  view.setUint32(40, dataLength, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

/* ─── ID counter ─────────────────────────────────────────────────────────── */

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `r${idCounter}`;
}

/* ─── Span management ────────────────────────────────────────────────────── */

interface ActiveSpan {
  spanId: string;
  acrid: string;
  title: string;
}

function matchesToSpan(
  match: IdentifyMatch,
  mediaId: string,
  chunkStart: number,
  chunkEnd: number,
): FlaggedSpan {
  const startAdj =
    match && match.sampleBeginMs != null
      ? chunkStart + match.sampleBeginMs / 1_000
      : chunkStart;
  const endAdj =
    match && match.sampleEndMs != null
      ? chunkStart + match.sampleEndMs / 1_000
      : chunkEnd;

  return {
    id: nextId(),
    mediaId,
    start:      startAdj,
    end:        endAdj,
    title:      match?.title ?? "",
    artists:    match?.artists ?? "",
    album:      match?.album ?? "",
    confidence: match?.score ?? 0,
    enabled:    true,
    manual:     false,
  };
}

/* ─── Cancellation ───────────────────────────────────────────────────────── */

// Module-level AbortController so any new scan cancels the previous one.
// This prevents stale identify requests from a prior scan from continuing
// to fire after the user has started a new scan or loaded a new file.
let activeScanController: AbortController | null = null;

/* ─── Real scan service ──────────────────────────────────────────────────── */

export const realScanService: ScanService = {
  async scan(request: ScanRequest, onProgress: (p: ScanProgress) => void): Promise<FlaggedSpan[]> {
    // Cancel any in-flight scan before starting a new one.
    if (activeScanController) {
      activeScanController.abort();
    }
    const controller = new AbortController();
    activeScanController = controller;
    const signal = controller.signal;

    const found: FlaggedSpan[] = [];
    const emit = (
      stage: ScanStageIndex,
      fraction: number,
      status: string,
    ) => {
      if (signal.aborted) return;
      onProgress({ stage, fraction, status, found: [...found] });
    };

    try {
      // Emit all pre-fingerprint stages in a single batched update so they
      // don't each trigger a separate React re-render + effect evaluation.
      emit(0, 0, "Preparing the audio engine…");

      // Stage 3 — fingerprint
      const CHUNK_SECS = 5;
      let totalChunks = 0;
      const itemChunkCounts: number[] = [];
      for (const item of request.items) {
        const count = Math.max(1, Math.ceil(item.duration / CHUNK_SECS));
        itemChunkCounts.push(count);
        totalChunks += count;
      }

      let chunksDone = 0;

      for (let itemIdx = 0; itemIdx < request.items.length; itemIdx++) {
        if (signal.aborted) break;

        const item = request.items[itemIdx];
        const chunkCount = itemChunkCounts[itemIdx] ?? 1;

        emit(1, 0, `Preparing ${item.name}…`);

        // Decode the entire file ONCE for this item, then slice per chunk.
        // Previously this decoded the full file once per chunk — O(n²) in
        // duration — which caused all identify requests to fire almost
        // simultaneously and pile up in memory.
        emit(2, 0, `Decoding audio for ${item.name}…`);
        const decoded = await decodeMediaFile(item.url, signal);
        if (signal.aborted) break;

        if (!decoded) {
          // Can't decode — skip this item but don't abort the whole scan.
          chunksDone += chunkCount;
          continue;
        }

        // Per-item active span tracker
        let active: ActiveSpan | null = null;

        for (let i = 0; i < chunkCount; i++) {
          if (signal.aborted) break;

          const start = i * CHUNK_SECS;
          const end = Math.min(start + CHUNK_SECS, item.duration);
          const duration = end - start;
          const globalChunk = chunksDone + i;
          const fraction = (globalChunk + 1) / totalChunks;

          emit(
            3,
            fraction,
            `Scanning ${item.name} ${formatTime(start)}–${formatTime(end)}…`,
          );

          // Slice from the already-decoded buffer — no network, no re-decode.
          const blob = await sliceToWavAsync(decoded, start, duration);
          if (signal.aborted) break;

          let match: IdentifyMatch = null;
          try {
            match = await identifySample(blob, signal);
          } catch (err) {
            // AbortError is expected when the scan is cancelled — rethrow so
            // the outer try/catch can handle it cleanly.
            if (err instanceof Error && err.name === "AbortError") throw err;
            // Other errors (network, rate-limit, etc.) — skip this chunk.
            match = null;
          }
          if (signal.aborted) break;

          if (match) {
            if (active && active.acrid === match.acrid) {
              const idx = found.findIndex((s) => s.id === active!.spanId);
              if (idx >= 0) {
                const adjusted =
                  match.sampleEndMs != null
                    ? start + match.sampleEndMs / 1_000
                    : end;
                found[idx] = { ...found[idx], end: adjusted };
                emit(3, fraction, `Pinpointing where "${match.title}" ends…`);
              }
            } else {
              active = null;
              emit(
                3,
                fraction,
                `Music detected — pinpointing where "${match.title}" starts…`,
              );
              const span = matchesToSpan(match, item.id, start, end);
              found.push(span);
              active = { spanId: span.id, acrid: match.acrid, title: match.title };
            }
          } else {
            if (active) {
              emit(3, fraction, `Pinpointing where "${active.title}" ends…`);
              active = null;
            }
          }

          onProgress({ stage: 3, fraction, status: "", found: [...found] });
        }

        chunksDone += chunkCount;
      }
    } finally {
      // Only clear the module-level reference if we are still the active scan.
      if (activeScanController === controller) {
        activeScanController = null;
      }
    }

    if (signal.aborted) {
      throw new DOMException("Scan cancelled", "AbortError");
    }

    onProgress({
      stage: 3,
      fraction: 1,
      status: "Scan complete.",
      found,
    });

    return found;
  },
};

/* ─── Formatting helper ──────────────────────────────────────────────────── */

function formatTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60)
    .toString()
    .padStart(2, "0");
  return `${m}:${s}`;
}
