/* ─── Timeline constants ─────────────────────────────────────────────────── */

export const BASE_PIXELS_PER_SECOND = 50;
export const MAX_PIXELS_PER_SECOND = 500;
export const MIN_SEGMENT_LENGTH = 0.2;
export const SNAP_DISTANCE = 8; // px
export const RULER_HEIGHT = 26;
export const TRACK_HEIGHT = 56;
export const CONTENT_HEIGHT = 138; // ruler + 2 tracks
export const WAVE_BAR_WIDTH = 2;
export const WAVE_BAR_STEP = 3;
export const MIN_LABEL_SPACING = 80;
export const MIN_TICK_SPACING = 10;
export const HEADER_WIDTH = 92; // px — fixed track header column

export const RULER_INTERVALS = [
  0.1, 0.2, 0.5, 1, 2, 3, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600,
];

export const INITIAL_ZOOM = 0.1;
export const FALLBACK_MIN_ZOOM = 0.02;
export const MAX_ZOOM = MAX_PIXELS_PER_SECOND / BASE_PIXELS_PER_SECOND; // 10

/* ─── Derived helpers ────────────────────────────────────────────────────── */

export function calcPixelsPerSecond(zoom: number): number {
  return BASE_PIXELS_PER_SECOND * zoom;
}

export function calcMinZoom(
  duration: number,
  viewportWidth: number
): number {
  if (duration > 0 && viewportWidth > 0) {
    return Math.min(
      (viewportWidth - 2) / (duration * BASE_PIXELS_PER_SECOND),
      MAX_ZOOM
    );
  }
  return FALLBACK_MIN_ZOOM;
}

export function calcContentDuration(duration: number): number {
  return duration + Math.max(30, duration * 0.5);
}

export function calcContentWidth(
  viewportWidth: number,
  contentDuration: number,
  pixelsPerSecond: number
): number {
  return Math.max(viewportWidth, contentDuration * pixelsPerSecond);
}

/* ─── Ruler tick algorithm ───────────────────────────────────────────────── */

export interface RulerTickInfo {
  labelInterval: number;
  tickInterval: number;
}

export function calcRulerTicks(pixelsPerSecond: number): RulerTickInfo {
  const lastInterval = RULER_INTERVALS[RULER_INTERVALS.length - 1];

  // Label interval: first one with enough pixel spacing
  let labelInterval = lastInterval;
  for (const iv of RULER_INTERVALS) {
    if (iv * pixelsPerSecond >= MIN_LABEL_SPACING) {
      labelInterval = iv;
      break;
    }
  }

  // Tick interval: finest tick that still has enough pixel spacing and divides evenly into labelInterval
  let tickInterval = labelInterval;
  for (const iv of RULER_INTERVALS) {
    if (iv * pixelsPerSecond < MIN_TICK_SPACING) continue;
    const ratio = labelInterval / iv;
    if (Math.abs(Math.round(ratio) - ratio) < 1e-6) {
      tickInterval = iv;
      break;
    }
  }

  return { labelInterval, tickInterval };
}

/* ─── Snap ───────────────────────────────────────────────────────────────── */

export function snapToNearest(
  time: number,
  candidates: number[],
  threshold: number
): number | null {
  let best: number | null = null;
  let bestDist = threshold;
  for (const c of candidates) {
    const d = Math.abs(time - c);
    if (d <= bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best;
}

export function snapThreshold(pixelsPerSecond: number): number {
  return SNAP_DISTANCE / pixelsPerSecond;
}
