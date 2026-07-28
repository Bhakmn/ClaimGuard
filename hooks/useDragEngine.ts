"use client";

import { useRef, useCallback } from "react";
import type { TrackSegment, FlaggedSpan } from "@/lib/types";
import { segmentEnd } from "@/lib/types";
import {
  snapToNearest,
  snapThreshold,
} from "@/lib/timeline-constants";

/* ─── Drag descriptor ────────────────────────────────────────────────────── */

export type DragMode = "move" | "start" | "end" | "region-start" | "region-end";

export interface DragState {
  mode: DragMode;
  lane?: "video" | "audio";
  clipId?: string;
  spanId?: string;
  grabOffset?: number;
  prevEnd?: number;
  nextStart?: number;
}

/* ─── Hook ───────────────────────────────────────────────────────────────── */

interface UseDragEngineOptions {
  pixelsPerSecond: number;
  contentRect: DOMRect | null;
  scrollLeft: number;
  snapEnabled: boolean;
  videoSegments: TrackSegment[];
  audioSegments: TrackSegment[];
  spans: FlaggedSpan[];
  onUpdateSegment: (
    lane: "video" | "audio",
    id: string,
    patch: Partial<TrackSegment>
  ) => void;
  onUpdateSpan: (id: string, patch: Partial<FlaggedSpan>) => void;
  onSetSnapTime: (t: number | null) => void;
  /** Edge auto-scroll: call with the pointer's clientX inside the scroller. */
  onEdgeAutoScroll: (clientX: number) => void;
  getMediaDuration: (mediaId: string) => number;
}

export function useDragEngine({
  pixelsPerSecond,
  contentRect,
  scrollLeft,
  snapEnabled,
  videoSegments,
  audioSegments,
  spans,
  onUpdateSegment,
  onUpdateSpan,
  onSetSnapTime,
  onEdgeAutoScroll,
  getMediaDuration,
}: UseDragEngineOptions) {
  const dragRef = useRef<DragState | null>(null);

  /* ── Time from pointer ─────────────────────────────────────────────────── */
  const ptrTime = useCallback(
    (clientX: number): number => {
      if (!contentRect) return 0;
      return (clientX - contentRect.left + scrollLeft) / pixelsPerSecond;
    },
    [contentRect, scrollLeft, pixelsPerSecond]
  );

  /* ── Clip candidates for snapping ─────────────────────────────────────── */
  const clipCandidates = useCallback(
    (excludeId?: string): number[] => {
      const times: number[] = [0];
      for (const seg of [...videoSegments, ...audioSegments]) {
        if (seg.id === excludeId) continue;
        times.push(seg.timelineStart);
        times.push(segmentEnd(seg));
      }
      return times;
    },
    [videoSegments, audioSegments]
  );

  /* ── Gap list for a lane ───────────────────────────────────────────────── */
  function gapsForLane(
    segs: TrackSegment[],
    excludeId: string
  ): { start: number; end: number }[] {
    const others = segs
      .filter((s) => s.id !== excludeId)
      .sort((a, b) => a.timelineStart - b.timelineStart);
    const gaps: { start: number; end: number }[] = [];
    let cursor = 0;
    for (const s of others) {
      if (s.timelineStart - cursor > 0.01) {
        gaps.push({ start: cursor, end: s.timelineStart });
      }
      cursor = Math.max(cursor, segmentEnd(s));
    }
    gaps.push({ start: cursor, end: Infinity });
    return gaps;
  }

  /* ── Pointer move ──────────────────────────────────────────────────────── */
  const onPointerMove = useCallback(
    (e: React.PointerEvent | PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      onEdgeAutoScroll(e.clientX);
      const t = ptrTime(e.clientX);
      const thr = snapThreshold(pixelsPerSecond);

      if (drag.mode === "move" && drag.clipId && drag.lane) {
        const segs = drag.lane === "video" ? videoSegments : audioSegments;
        const clip = segs.find((s) => s.id === drag.clipId);
        if (!clip) return;
        const len = segmentEnd(clip) - clip.timelineStart;
        let s = t - (drag.grabOffset ?? 0);

        // Snap head and tail
        const cands = snapCandidates(drag.clipId);
        const headSnap = snapEnabled
          ? snapToNearest(s, cands, thr)
          : null;
        const tailSnap = snapEnabled
          ? snapToNearest(s + len, cands, thr)
          : null;
        let snapTime: number | null = null;
        if (headSnap !== null && (tailSnap === null || Math.abs(s - headSnap) <= Math.abs(s + len - (tailSnap ?? 0)))) {
          s = headSnap;
          snapTime = headSnap;
        } else if (tailSnap !== null) {
          s = tailSnap - len;
          snapTime = tailSnap;
        }
        onSetSnapTime(snapTime);
        s = Math.max(0, s);

        // Gap picking
        const gaps = gapsForLane(
          drag.lane === "video" ? videoSegments : audioSegments,
          drag.clipId
        ).filter((g) => {
          const gLen = g.end === Infinity ? len + 1 : g.end - g.start;
          return gLen >= len - 0.001;
        });
        if (gaps.length === 0) return;
        const centre = s + len / 2;
        const containingGap = gaps.find(
          (g) => centre >= g.start && (g.end === Infinity || centre <= g.end)
        );
        const chosenGap =
          containingGap ??
          gaps.reduce((best, g) => {
            const bc = best.end === Infinity ? best.start : (best.start + best.end) / 2;
            const gc = g.end === Infinity ? g.start : (g.start + g.end) / 2;
            return Math.abs(centre - gc) < Math.abs(centre - bc) ? g : best;
          });
        s = Math.max(chosenGap.start, s);
        if (chosenGap.end !== Infinity) {
          s = Math.min(chosenGap.end - len, s);
        }
        onUpdateSegment(drag.lane, drag.clipId, { timelineStart: s });
      }

      if ((drag.mode === "start" || drag.mode === "end") && drag.clipId && drag.lane) {
        const segs = drag.lane === "video" ? videoSegments : audioSegments;
        const clip = segs.find((s) => s.id === drag.clipId);
        if (!clip) return;
        const cands = snapCandidates(drag.clipId);
        const snapped = snapEnabled ? snapToNearest(t, cands, thr) : null;
        const st = snapped ?? t;
        onSetSnapTime(snapped);
        const mediaDur = getMediaDuration(clip.mediaId);

        if (drag.mode === "start") {
          const minStart = Math.max(
            drag.prevEnd ?? 0,
            clip.timelineStart - clip.srcStart,
            0
          );
          const maxStart = segmentEnd(clip) - 0.2;
          const newStart = Math.max(minStart, Math.min(maxStart, st));
          const delta = newStart - clip.timelineStart;
          onUpdateSegment(drag.lane, drag.clipId, {
            timelineStart: newStart,
            srcStart: clip.srcStart + delta,
          });
        } else {
          const maxEnd = Math.min(
            drag.nextStart ?? Infinity,
            clip.timelineStart + (mediaDur - clip.srcStart)
          );
          const minEnd = clip.timelineStart + 0.2;
          const newEnd = Math.max(minEnd, Math.min(maxEnd, st));
          const newSrcEnd = clip.srcStart + (newEnd - clip.timelineStart);
          onUpdateSegment(drag.lane, drag.clipId, { srcEnd: newSrcEnd });
        }
      }

      if (
        (drag.mode === "region-start" || drag.mode === "region-end") &&
        drag.spanId
      ) {
        const span = spans.find((s) => s.id === drag.spanId);
        if (!span) return;
        const segs = audioSegments.filter((s) => s.mediaId === span.mediaId);
        // Convert pointer to source time through audio segments
        let srcTime: number | null = null;
        for (const seg of segs) {
          const tlStart = seg.timelineStart;
          const tlEnd = segmentEnd(seg);
          const tlT = t;
          if (tlT >= tlStart - 0.01 && tlT <= tlEnd + 0.01) {
            srcTime = seg.srcStart + (tlT - tlStart);
            break;
          }
        }
        if (srcTime === null) return;

        // Snap candidates in source time
        const regionCands: number[] = [0, getMediaDuration(span.mediaId)];
        for (const s of spans) {
          if (s.id === span.id) continue;
          if (s.mediaId !== span.mediaId) continue;
          regionCands.push(s.start, s.end);
        }
        for (const seg of segs) {
          regionCands.push(seg.srcStart, seg.srcEnd);
        }
        const snapped = snapEnabled ? snapToNearest(srcTime, regionCands, thr) : null;
        const st = snapped ?? srcTime;
        onSetSnapTime(snapped !== null ? t : null);

        if (drag.mode === "region-start") {
          onUpdateSpan(span.id, { start: Math.min(st, span.end - 0.2) });
        } else {
          onUpdateSpan(span.id, { end: Math.max(st, span.start + 0.2) });
        }
      }
    },
    [
      ptrTime,
      pixelsPerSecond,
      snapEnabled,
      videoSegments,
      audioSegments,
      spans,
      onUpdateSegment,
      onUpdateSpan,
      onSetSnapTime,
      onEdgeAutoScroll,
      getMediaDuration,
    ]
  );

  function snapCandidates(excludeId: string): number[] {
    return clipCandidates(excludeId);
  }

  const onPointerUp = useCallback(() => {
    dragRef.current = null;
    onSetSnapTime(null);
  }, [onSetSnapTime]);

  return { dragRef, ptrTime, onPointerMove, onPointerUp };
}
