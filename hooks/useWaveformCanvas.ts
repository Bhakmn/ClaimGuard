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
  contentWidth: number;
}

export function useWaveformCanvas({
  canvasRef,
  audioSegments,
  items,
  primaryId,
  pixelsPerSecond,
  contentWidth,
}: UseWaveformOptions) {
  const depsRef = useRef({
    audioSegments, items, primaryId, pixelsPerSecond, contentWidth,
  });
  depsRef.current = { audioSegments, items, primaryId, pixelsPerSecond, contentWidth };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const { audioSegments, items, primaryId, pixelsPerSecond, contentWidth } =
      depsRef.current;

    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(contentWidth * dpr);
    const h = Math.round(56 * dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    canvas.style.width = `${contentWidth}px`;
    canvas.style.height = "56px";

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    ctx.scale(dpr, dpr);

    for (const seg of audioSegments) {
      const item = items.find((i) => i.id === seg.mediaId);
      const pxStart = seg.timelineStart * pixelsPerSecond;
      const pxEnd = segmentEnd(seg) * pixelsPerSecond;
      const segW = pxEnd - pxStart;

      // Clip to segment boundary (1 px inset)
      ctx.save();
      ctx.beginPath();
      if (ctx.roundRect) {
        ctx.roundRect(pxStart + 1, 3, segW - 2, 50, 4);
      } else {
        ctx.rect(pxStart + 1, 3, segW - 2, 50);
      }
      ctx.clip();

      const isPrimary = seg.mediaId === primaryId;
      const disabled = !seg.enabled;
      const waveform = item?.waveform;

      if (!waveform) {
        // Flat baseline placeholder
        const baseColor = disabled
          ? "rgba(31,31,31,0.18)"
          : isPrimary
          ? "rgba(43,122,75,0.28)"
          : "rgba(59,91,165,0.28)";
        ctx.fillStyle = baseColor;
        ctx.fillRect(pxStart + 1, 27, segW - 2, 1);
      } else {
        const { peaks, sampleRate, globalMax } = waveform;

        const fillColor = disabled
          ? "rgba(31,31,31,0.18)"
          : isPrimary
          ? "rgba(43,122,75,0.7)"
          : "rgba(59,91,165,0.7)";
        ctx.fillStyle = fillColor;

        // Draw every bar that falls within this segment in absolute content coords
        const firstBar = Math.floor(pxStart / WAVE_BAR_STEP);
        const lastBar = Math.ceil(pxEnd / WAVE_BAR_STEP);

        for (let i = firstBar; i <= lastBar; i++) {
          const barPx = i * WAVE_BAR_STEP;            // absolute pixel in content
          const barT = seg.srcStart + (barPx - pxStart) / pixelsPerSecond;
          const barT1 = barT + WAVE_BAR_STEP / pixelsPerSecond;

          const s0 = Math.max(0, Math.floor(barT * sampleRate));
          const s1 = Math.min(peaks.length - 1, Math.ceil(barT1 * sampleRate));
          let peak = 0;
          for (let s = s0; s <= s1; s++) {
            if (peaks[s] > peak) peak = peaks[s];
          }
          const norm = Math.min(1, peak / globalMax);
          const logH = Math.max(1, (Math.log1p(norm) / Math.log1p(1)) * 56 * 0.85);
          const y = (56 - logH) / 2;
          ctx.fillRect(barPx, y, WAVE_BAR_WIDTH, logH);
        }
      }
      ctx.restore();
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
  });
}
