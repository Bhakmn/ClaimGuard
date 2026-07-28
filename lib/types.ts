/* ─── Domain types ───────────────────────────────────────────────────────── */

/** A media file the user brought in. */
export interface MediaItem {
  id: string;
  file: File;
  url: string;
  name: string;
  kind: "video" | "audio";
  duration: number;
  width: number;
  height: number;
  waveform: WaveformData | null;
  thumbnails: ThumbnailStrip | null;
}

/** Mono peak envelope for waveform drawing. */
export interface WaveformData {
  peaks: Float32Array;
  /** Effective samples per second — 8000. */
  sampleRate: number;
  /** Loudest value. Never 0. */
  globalMax: number;
}

/** Filmstrip frames for the video track. */
export interface ThumbnailStrip {
  frames: { time: number; bitmap: ImageBitmap }[];
  aspect: number;
}

/** A stretch of soundtrack that must go. */
export interface FlaggedSpan {
  id: string;
  mediaId: string;
  start: number;
  end: number;
  title: string;
  artists: string;
  album: string;
  confidence: number;
  enabled: boolean;
  manual: boolean;
}

/**
 * A stretch of on-screen (visual) footage that may create copyright exposure.
 *
 * Kept as a sibling type — not a union with FlaggedSpan — so Timeline,
 * FlaggedSectionsPanel, and export-service can handle them independently
 * without ever-growing discriminated unions on the audio type.
 *
 * `signals`  — human-readable heuristic triggers, e.g. ["letterbox bars",
 *               "platform watermark"].
 * `reasoning` — full model explanation when available (may be empty string).
 * `source`    — which detection path produced the flag.
 */
export interface FlaggedVisualSpan {
  id: string;
  mediaId: string;
  start: number;          // seconds into the source media
  end: number;            // seconds into the source media
  /** Short label shown in the UI, e.g. "Third-party footage". */
  label: string;
  signals: string[];
  reasoning: string;
  confidence: number;     // 0–100
  enabled: boolean;
  manual: boolean;
  source: "heuristic" | "granite_vision" | "manual";
}

/** One clip on one lane. */
export interface TrackSegment {
  id: string;
  mediaId: string;
  srcStart: number;
  srcEnd: number;
  timelineStart: number;
  enabled: boolean;
  gain?: number;
}

export type TrackName = "video" | "audio";

export type ExportStrategy = "lossless" | "precise" | "mute";

export interface AccountProfile {
  name?: string;
  email?: string;
  picture?: string;
}

export interface TimeRange {
  start: number;
  end: number;
}

/* ─── Derived helpers ───────────────────────────────────────────────────── */

export function segmentDuration(s: TrackSegment): number {
  return s.srcEnd - s.srcStart;
}

export function segmentEnd(s: TrackSegment): number {
  return s.timelineStart + segmentDuration(s);
}

export function trackEnd(segments: TrackSegment[]): number {
  if (segments.length === 0) return 0;
  return Math.max(...segments.map(segmentEnd));
}

export function sortSegments(segments: TrackSegment[]): TrackSegment[] {
  return [...segments].sort((a, b) => a.timelineStart - b.timelineStart);
}

const EPS = 1e-6;

export function resolveSourceAt(
  segments: TrackSegment[],
  t: number
): { index: number; sourceTime: number } | null {
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const end = segmentEnd(seg);
    if (t >= seg.timelineStart - EPS && t <= end + EPS) {
      const sourceTime = seg.srcStart + (t - seg.timelineStart);
      return { index: i, sourceTime };
    }
  }
  return null;
}

export function resolveTimelineAt(
  segments: TrackSegment[],
  sourceTime: number
): number | null {
  for (const seg of segments) {
    if (
      sourceTime >= seg.srcStart - EPS &&
      sourceTime <= seg.srcEnd + EPS
    ) {
      return seg.timelineStart + (sourceTime - seg.srcStart);
    }
  }
  return null;
}
