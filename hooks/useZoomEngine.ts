"use client";

import { useRef, useCallback, useLayoutEffect } from "react";
import {
  calcMinZoom,
  calcPixelsPerSecond,
  MAX_ZOOM,
  INITIAL_ZOOM,
} from "@/lib/timeline-constants";

interface UseZoomOptions {
  zoom: number;
  scrollLeft: number;
  viewportWidth: number;
  duration: number;
  onZoomChange: (z: number) => void;
  onScrollChange: (s: number) => void;
  scrollerRef: React.RefObject<HTMLDivElement | null>;
}

export function useZoomEngine({
  zoom,
  scrollLeft,
  viewportWidth,
  duration,
  onZoomChange,
  onScrollChange,
  scrollerRef,
}: UseZoomOptions) {
  const anchorRef = useRef<{ time: number; offset: number } | null>(null);
  const pendingScrollRef = useRef<number | null>(null);

  const minZoom = calcMinZoom(duration, viewportWidth);

  /* ── Apply pending scroll after zoom commits ─────────────────────────── */
  useLayoutEffect(() => {
    if (pendingScrollRef.current !== null && scrollerRef.current) {
      scrollerRef.current.scrollLeft = pendingScrollRef.current;
      onScrollChange(pendingScrollRef.current);
      pendingScrollRef.current = null;
    }
  });

  /* ── Core zoom function ──────────────────────────────────────────────── */
  const applyZoom = useCallback(
    (newZoom: number, anchorOffset: number) => {
      const pps = calcPixelsPerSecond(zoom);
      const anchorTime = (scrollLeft + anchorOffset) / pps;
      anchorRef.current = { time: anchorTime, offset: anchorOffset };

      const clamped = Math.max(minZoom, Math.min(MAX_ZOOM, newZoom));
      onZoomChange(clamped);

      const newPps = calcPixelsPerSecond(clamped);
      const newScroll = Math.max(0, anchorTime * newPps - anchorOffset);
      pendingScrollRef.current = newScroll;
    },
    [zoom, scrollLeft, minZoom, onZoomChange]
  );

  /* ── Zoom in/out buttons ─────────────────────────────────────────────── */
  const zoomIn = useCallback(() => {
    applyZoom(zoom * 1.4, viewportWidth / 2);
  }, [zoom, viewportWidth, applyZoom]);

  const zoomOut = useCallback(() => {
    applyZoom(zoom / 1.4, viewportWidth / 2);
  }, [zoom, viewportWidth, applyZoom]);

  /* ── Fit ─────────────────────────────────────────────────────────────── */
  const fit = useCallback(() => {
    const newZoom = Math.max(minZoom, Math.min(MAX_ZOOM, minZoom));
    onZoomChange(newZoom);
    pendingScrollRef.current = 0;
    if (scrollerRef.current) {
      scrollerRef.current.scrollLeft = 0;
      onScrollChange(0);
    }
  }, [minZoom, onZoomChange, onScrollChange, scrollerRef]);

  /* ── Wheel handler ───────────────────────────────────────────────────── */
  const onWheel = useCallback(
    (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        let delta = e.deltaY;
        if (e.deltaMode === 1) delta *= 16;
        delta = Math.max(-30, Math.min(30, delta));
        const factor = Math.exp(-delta / 300);
        const rect = scrollerRef.current?.getBoundingClientRect();
        const offsetX = rect ? e.clientX - rect.left : viewportWidth / 2;
        applyZoom(zoom * factor, offsetX);
      } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        const scroller = scrollerRef.current;
        if (scroller) {
          const newScroll = Math.max(0, scroller.scrollLeft + e.deltaY);
          scroller.scrollLeft = newScroll;
          onScrollChange(newScroll);
        }
      }
    },
    [zoom, viewportWidth, applyZoom, onScrollChange, scrollerRef]
  );

  /* ── Edge auto-scroll ────────────────────────────────────────────────── */
  const edgeAutoScroll = useCallback(
    (clientX: number) => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const rect = scroller.getBoundingClientRect();
      const BAND = 28;
      const MAX_SPEED = 24;
      const left = clientX - rect.left;
      const right = rect.right - clientX;
      let delta = 0;
      if (left < BAND) delta = -MAX_SPEED * (1 - left / BAND);
      else if (right < BAND) delta = MAX_SPEED * (1 - right / BAND);
      if (delta !== 0) {
        const newScroll = Math.max(0, scroller.scrollLeft + delta);
        scroller.scrollLeft = newScroll;
        onScrollChange(newScroll);
      }
    },
    [scrollerRef, onScrollChange]
  );

  /* ── Playhead following ──────────────────────────────────────────────── */
  const followPlayhead = useCallback(
    (playheadTime: number, playing: boolean, clientWidth: number) => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const pps = calcPixelsPerSecond(zoom);
      const px = playheadTime * pps;
      const sl = scroller.scrollLeft;
      if (px >= sl + 4 && px <= sl + clientWidth - 4) return;
      const newScroll = playing
        ? Math.max(0, px - 48)
        : Math.max(0, px - clientWidth / 2);
      scroller.scrollLeft = newScroll;
      onScrollChange(newScroll);
    },
    [zoom, scrollerRef, onScrollChange]
  );

  return { zoomIn, zoomOut, fit, onWheel, edgeAutoScroll, followPlayhead, minZoom };
}
