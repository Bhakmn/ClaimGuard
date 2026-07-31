"use client";

import { useEffect, useRef } from "react";
import type { MediaItem, TrackSegment } from "@/lib/types";
import { segmentEnd } from "@/lib/types";
import { WAVE_BAR_STEP, WAVE_BAR_WIDTH } from "@/lib/timeline-constants";

interface UseWaveformOptions {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  audioSegments: TrackSegment[];
  items: MediaItem[];
  primaryId: string;
  pixelsPerSecond: number;
  /** Visible scroll offset — canvas only draws what's on screen */
  scrollLeft: number;
  /** Visible viewport width — canvas is sized to this, not the full content */
  viewportWidth: number;
}

export function useWaveformCanvas({
  canvasRef,
  audioSegments,
  items,
  primaryId,
  pixelsPerSecond,
  scrollLeft,
  viewportWidth,
}: UseWaveformOptions) {
  const depsRef = useRef({
    audioSegments, items, primaryId, pixelsPerSecond, scrollLeft, viewportWidth,
  });
  depsRef.current = { audioSegments, items, primaryId, pixelsPerSecond, scrollLeft, viewportWidth };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const { audioSegments, items, primaryId, pixelsPerSecond, scrollLeft, viewportWidth } =
      depsRef.current;

    if (viewportWidth <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    // Canvas is only as wide as the visible viewport — huge memory saving.
    // Canvas height = audio-track (73px) - canvas top offset (20px) = 53px.
    const CANVAS_H = 53;
    const w = Math.round(viewportWidth * dpr);
    const h = Math.round(CANVAS_H * dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    canvas.style.width = `${viewportWidth}px`;
    canvas.style.height = `${CANVAS_H}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.scale(dpr, dpr);

    // Reserve 4 px at the top so tallest bars stop short of the label edge.
    const TOP_PAD = 4;
    const DRAW_H = CANVAS_H - TOP_PAD; // usable drawing height = 49 px

    for (const seg of audioSegments) {
      const item = items.find((i) => i.id === seg.mediaId);
      const pxStart = seg.timelineStart * pixelsPerSecond;
      const pxEnd = segmentEnd(seg) * pixelsPerSecond;

      // Skip segments entirely outside the viewport
      if (pxEnd < scrollLeft || pxStart > scrollLeft + viewportWidth) continue;

      // Viewport-relative positions
      const vpStart = pxStart - scrollLeft;
      const vpEnd = pxEnd - scrollLeft;
      const segW = vpEnd - vpStart;

      // Clip to segment boundary — starts at TOP_PAD, not 0, so no bar
      // can ever poke above the gap.
      ctx.save();
      ctx.beginPath();
      if (ctx.roundRect) {
        ctx.roundRect(vpStart + 1, TOP_PAD, segW - 2, DRAW_H - 1, 4);
      } else {
        ctx.rect(vpStart + 1, TOP_PAD, segW - 2, DRAW_H - 1);
      }
      ctx.clip();

      const isPrimary = seg.mediaId === primaryId;
      const disabled = !seg.enabled;
      const waveform = item?.waveform;

      if (!waveform) {
        // Flat baseline placeholder — centred in the usable area
        const baseColor = disabled
          ? "rgba(31,31,31,0.18)"
          : isPrimary
          ? "rgba(43,122,75,0.28)"
          : "rgba(59,91,165,0.28)";
        ctx.fillStyle = baseColor;
        ctx.fillRect(vpStart + 1, CANVAS_H / 2, segW - 2, 1);
      } else {
        const { peaks, sampleRate, globalMax } = waveform;

        const fillColor = disabled
          ? "rgba(31,31,31,0.18)"
          : isPrimary
          ? "rgba(43,122,75,0.7)"
          : "rgba(59,91,165,0.7)";
        ctx.fillStyle = fillColor;

        // Only draw bars that fall within the visible viewport
        const visStart = Math.max(pxStart, scrollLeft);
        const visEnd = Math.min(pxEnd, scrollLeft + viewportWidth);
        const firstBar = Math.floor(visStart / WAVE_BAR_STEP);
        const lastBar = Math.ceil(visEnd / WAVE_BAR_STEP);

        for (let i = firstBar; i <= lastBar; i++) {
          const barPx = i * WAVE_BAR_STEP;            // absolute content pixel
          const barT = seg.srcStart + (barPx - pxStart) / pixelsPerSecond;
          const barT1 = barT + WAVE_BAR_STEP / pixelsPerSecond;

          const s0 = Math.max(0, Math.floor(barT * sampleRate));
          const s1 = Math.min(peaks.length - 1, Math.ceil(barT1 * sampleRate));
          let peak = 0;
          for (let s = s0; s <= s1; s++) {
            if (peaks[s] > peak) peak = peaks[s];
          }
          const norm = Math.min(1, peak / globalMax);
          // Scale bar height to the usable drawing area
          const logH = Math.max(1, (Math.log1p(norm) / Math.log1p(1)) * DRAW_H * 0.9);
          // Centre bar on the true canvas midpoint; clamp top edge to TOP_PAD
          // so bars never enter the gap reserved beneath the label row.
          const y = Math.max(TOP_PAD, CANVAS_H / 2 - logH / 2);
          // Draw at viewport-relative x
          ctx.fillRect(barPx - scrollLeft, y, WAVE_BAR_WIDTH, logH);
        }
      }
      ctx.restore();
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioSegments, items, primaryId, pixelsPerSecond, scrollLeft, viewportWidth]);
}
