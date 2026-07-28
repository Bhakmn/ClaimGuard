import type { MediaItem, TrackSegment } from "./types";

/**
 * Returns true when the timeline has been manually edited beyond its
 * freshly-loaded single-clip state.
 */
export function clipsEdited(
  items: MediaItem[],
  videoSegments: TrackSegment[],
  audioSegments: TrackSegment[],
  primaryDuration: number
): boolean {
  if (items.length > 1) return true;
  if (videoSegments.length > 1) return true;
  if (audioSegments.length > 1) return true;

  const EPS = 0.01;

  for (const seg of videoSegments) {
    if (!seg.enabled) return true;
    if (seg.timelineStart > EPS) return true;
    if (seg.srcStart > EPS) return true;
    if (primaryDuration > 0 && seg.srcEnd < primaryDuration - EPS) return true;
  }

  for (const seg of audioSegments) {
    if (!seg.enabled) return true;
    if (seg.timelineStart > EPS) return true;
    if (seg.srcStart > EPS) return true;
    if (primaryDuration > 0 && seg.srcEnd < primaryDuration - EPS) return true;
    if (Math.abs((seg.gain ?? 1) - 1) > 0.01) return true;
  }

  return false;
}
