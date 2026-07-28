"use client";

import { useEffect, useRef } from "react";
import type { MediaItem, TrackSegment } from "@/lib/types";
import { segmentEnd } from "@/lib/types";

interface UseFilmstripOptions {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  videoSegments: TrackSegment[];
  items: MediaItem[];
  pixelsPerSecond: number;
  contentWidth: number;
}

export function useFilmstripCanvas({
  canvasRef,
  videoSegments,
  items,
  pixelsPerSecond,
  contentWidth,
}: UseFilmstripOptions) {
  const depsRef = useRef({ videoSegments, items, pixelsPerSecond, contentWidth });
  depsRef.current = { videoSegments, items, pixelsPerSecond, contentWidth };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const { videoSegments, items, pixelsPerSecond, contentWidth } = depsRef.current;

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

    for (const seg of videoSegments) {
      if (!seg.enabled) continue;
      const item = items.find((i) => i.id === seg.mediaId);
      const strip = item?.thumbnails;

      const pxStart = seg.timelineStart * pixelsPerSecond;
      const pxEnd = segmentEnd(seg) * pixelsPerSecond;

      // Clip to the segment boundary (1 px inset to avoid bleed onto the outline)
      ctx.save();
      ctx.beginPath();
      if (ctx.roundRect) {
        ctx.roundRect(pxStart + 1, 3, pxEnd - pxStart - 2, 50, 4);
      } else {
        ctx.rect(pxStart + 1, 3, pxEnd - pxStart - 2, 50);
      }
      ctx.clip();

      if (!strip) {
        // Hatch placeholder while thumbnails are loading
        const stripeW = 6;
        for (let x = pxStart - 56; x < pxEnd + 56; x += stripeW * 2) {
          ctx.fillStyle = "rgba(31,31,31,0.06)";
          ctx.save();
          ctx.translate(x, 0);
          ctx.rotate(-Math.PI / 4);
          ctx.fillRect(0, -56, stripeW, 56 * 4);
          ctx.restore();
        }
      } else {
        const aspect = strip.aspect || 16 / 9;
        const tileW = Math.max(24, 56 * aspect);
        const firstTile = Math.floor(0);
        const lastTile = Math.ceil((pxEnd - pxStart) / tileW);

        for (let k = firstTile; k <= lastTile; k++) {
          const srcTime = seg.srcStart + ((k + 0.5) * tileW) / pixelsPerSecond;
          const clampedTime = Math.min(seg.srcEnd, srcTime);

          // Find nearest captured frame
          let nearest = strip.frames[0];
          let nearestDist = Infinity;
          for (const f of strip.frames) {
            const d = Math.abs(f.time - clampedTime);
            if (d < nearestDist) { nearest = f; nearestDist = d; }
          }

          if (nearest) {
            ctx.drawImage(nearest.bitmap, pxStart + k * tileW, 0, tileW, 56);
          }
        }
      }
      ctx.restore();
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
  });
}
