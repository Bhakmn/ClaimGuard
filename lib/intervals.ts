import type { TimeRange } from "./types";

/**
 * Clamp to [0, duration], drop anything shorter than 0.05 s, sort, and merge
 * ranges that overlap or sit within 0.05 s of each other.
 */
export function mergeRanges(
  ranges: TimeRange[],
  duration: number
): TimeRange[] {
  const MIN = 0.05;
  const MERGE_GAP = 0.05;

  // Clamp and filter short ones
  const clamped = ranges
    .map((r) => ({
      start: Math.max(0, Math.min(r.start, duration)),
      end: Math.max(0, Math.min(r.end, duration)),
    }))
    .filter((r) => r.end - r.start >= MIN);

  if (clamped.length === 0) return [];

  // Sort by start
  clamped.sort((a, b) => a.start - b.start);

  const merged: TimeRange[] = [{ ...clamped[0] }];

  for (let i = 1; i < clamped.length; i++) {
    const current = clamped[i];
    const last = merged[merged.length - 1];

    if (current.start <= last.end + MERGE_GAP) {
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push({ ...current });
    }
  }

  return merged;
}

/**
 * The parts of [0, duration] that the given ranges do NOT cover.
 * Gaps shorter than 0.15 s are dropped rather than emitted as slivers.
 */
export function complementRanges(
  remove: TimeRange[],
  duration: number
): TimeRange[] {
  const MIN_GAP = 0.15;
  const merged = mergeRanges(remove, duration);

  const complement: TimeRange[] = [];
  let cursor = 0;

  for (const r of merged) {
    if (r.start - cursor >= MIN_GAP) {
      complement.push({ start: cursor, end: r.start });
    }
    cursor = r.end;
  }

  if (duration - cursor >= MIN_GAP) {
    complement.push({ start: cursor, end: duration });
  }

  return complement;
}
