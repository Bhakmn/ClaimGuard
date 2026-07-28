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

/* ─── Audio extraction ───────────────────────────────────────────────────── */

/**
 * Extract a 5-second mono 8 kHz PCM WAV slice from `url` starting at
 * `startSeconds`. Returns a Blob of type audio/wav, or null when the Web Audio
 * API is not available (e.g. in a test environment).
 */
async function extractAudioChunk(
  url: string,
  startSeconds: number,
  durationSeconds: number,
): Promise<Blob | null> {
  try {
    const SAMPLE_RATE = 8_000;
    const sampleCount = Math.round(durationSeconds * SAMPLE_RATE);

    // Fetch the media into an ArrayBuffer
    const resp = await fetch(url);
    const arrayBuffer = await resp.arrayBuffer();

    // Decode
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

    // Render the slice at 8 kHz mono
    const offline = new OfflineAudioContext(
      1,                    // 1 channel (mono)
      sampleCount,
      SAMPLE_RATE,
    );

    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start(0, startSeconds, durationSeconds);

    const rendered = await offline.startRendering();
    const pcm = rendered.getChannelData(0);

    // Encode as 16-bit PCM WAV
    return pcmToWav(pcm, SAMPLE_RATE);
  } catch {
    return null;
  }
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
  view.setUint32(16, 16, true);         // PCM chunk size
  view.setUint16(20, 1, true);          // PCM format
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

/* ─── Real scan service ──────────────────────────────────────────────────── */

export const realScanService: ScanService = {
  async scan(request: ScanRequest, onProgress: (p: ScanProgress) => void): Promise<FlaggedSpan[]> {
    const found: FlaggedSpan[] = [];
    const emit = (
      stage: ScanStageIndex,
      fraction: number,
      status: string,
    ) => {
      onProgress({ stage, fraction, status, found: [...found] });
    };

    // Stage 0 — engine load (instantaneous in real mode, but we still show it)
    emit(0, 0, "Preparing the audio engine…");

    // Stage 1 — prepare
    for (const item of request.items) {
      emit(1, 0, `Preparing ${item.name}…`);
    }

    // Stage 2 — waveform (already handled elsewhere; skip if present)
    for (const item of request.items) {
      if (!item.waveform) {
        emit(2, 0, "Generating waveform…");
      }
    }

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
      const item = request.items[itemIdx];
      const chunkCount = itemChunkCounts[itemIdx] ?? 1;

      // Per-item active span tracker
      let active: ActiveSpan | null = null;

      for (let i = 0; i < chunkCount; i++) {
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

        // Extract audio slice
        const blob = await extractAudioChunk(item.url, start, duration);

        let match: IdentifyMatch = null;
        if (blob) {
          match = await identifySample(blob);
        }

        if (match) {
          if (active && active.acrid === match.acrid) {
            // Same song — extend the existing span
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
            // New song — close any active span and open a new one
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
          // No match — close active span if open
          if (active) {
            emit(3, fraction, `Pinpointing where "${active.title}" ends…`);
            active = null;
          }
        }

        onProgress({ stage: 3, fraction, status: "", found: [...found] });
      }

      chunksDone += chunkCount;
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
