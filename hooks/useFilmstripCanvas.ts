"use client";

import { useEffect, useRef } from "react";
import type { MediaItem, TrackSegment } from "@/lib/types";
import { segmentEnd } from "@/lib/types";

interface UseFilmstripOptions {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  videoSegments: TrackSegment[];
  items: MediaItem[];
  pixelsPerSecond: number;
  /** Visible scroll offset — canvas only draws what's on screen */
  scrollLeft: number;
  /** Visible viewport width — canvas is sized to this, not the full content */
  viewportWidth: number;
}

export function useFilmstripCanvas({
  canvasRef,
  videoSegments,
  items,
  pixelsPerSecond,
  scrollLeft,
  viewportWidth,
}: UseFilmstripOptions) {
  const depsRef = useRef({
    videoSegments, items, pixelsPerSecond, scrollLeft, viewportWidth,
  });
  depsRef.current = { videoSegments, items, pixelsPerSecond, scrollLeft, viewportWidth };

  // Stable identity refs for the dep-array comparison
  const videoSegmentsRef = useRef(videoSegments);
  const itemsRef = useRef(items);
  videoSegmentsRef.current = videoSegments;
  itemsRef.current = items;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const { videoSegments, items, pixelsPerSecond, scrollLeft, viewportWidth } =
      depsRef.current;

    if (viewportWidth <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    // Canvas is only as wide as the visible viewport — huge memory saving vs
    // allocating a texture the full content width.
    const w = Math.round(viewportWidth * dpr);
    const h = Math.round(56 * dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    canvas.style.width = `${viewportWidth}px`;
    canvas.style.height = "56px";

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.scale(dpr, dpr);

    for (const seg of videoSegments) {
      if (!seg.enabled) continue;
      const item = items.find((i) => i.id === seg.mediaId);
      const strip = item?.thumbnails;

      // Absolute content pixel positions
      const pxStart = seg.timelineStart * pixelsPerSecond;
      const pxEnd = segmentEnd(seg) * pixelsPerSecond;

      // Skip segments entirely outside the viewport
      if (pxEnd < scrollLeft || pxStart > scrollLeft + viewportWidth) continue;

      // Translate to viewport-relative coords
      const vpStart = pxStart - scrollLeft;
      const vpEnd = pxEnd - scrollLeft;

      // Clip to the segment boundary (1 px inset), starting below the 17px label row.
      // The canvas itself is offset by top:17px in JSX, so local y=0 = just below label.
      ctx.save();
      ctx.beginPath();
      if (ctx.roundRect) {
        ctx.roundRect(vpStart + 1, 3, vpEnd - vpStart - 2, 50, 4);
      } else {
        ctx.rect(vpStart + 1, 3, vpEnd - vpStart - 2, 50);
      }
      ctx.clip();

      if (!strip) {
        // Hatch placeholder while thumbnails are loading
        const stripeW = 6;
        for (let x = vpStart - 56; x < vpEnd + 56; x += stripeW * 2) {
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

        // Only draw tiles that intersect the visible viewport
        const firstTile = Math.max(
          0,
          Math.floor((scrollLeft - pxStart) / tileW)
        );
        const lastTile = Math.ceil((scrollLeft + viewportWidth - pxStart) / tileW);

        for (let k = firstTile; k <= lastTile; k++) {
          const tilePxStart = pxStart + k * tileW;
          if (tilePxStart > pxEnd) break;

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
            // Draw at viewport-relative x; y=0 is already below the label row
            ctx.drawImage(
              nearest.bitmap,
              tilePxStart - scrollLeft,
              0,
              tileW,
              56,
            );
          }
        }
      }
      ctx.restore();
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
  // Re-run when anything that affects the visual output changes.
  // Items is compared by reference — thumbnails arriving updates the items array.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoSegments, items, pixelsPerSecond, scrollLeft, viewportWidth]);
}
