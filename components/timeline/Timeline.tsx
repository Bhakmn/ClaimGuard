"use client";

import React, {
  useRef,
  useState,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import type {
  MediaItem,
  TrackSegment,
  FlaggedSpan,
  FlaggedVisualSpan,
  TrackName,
} from "@/lib/types";
import {
  segmentEnd,
  trackEnd,
  resolveSourceAt,
  sortSegments,
  VISUAL_CATEGORY_LABELS,
} from "@/lib/types";
import { formatClock, formatRulerLabel } from "@/lib/formatters";
import {
  calcPixelsPerSecond,
  calcMinZoom,
  calcContentDuration,
  calcContentWidth,
  calcRulerTicks,
  snapThreshold,
  snapToNearest,
  INITIAL_ZOOM,
  MAX_ZOOM,
  RULER_HEIGHT,
  TRACK_HEIGHT,
} from "@/lib/timeline-constants";
import { takeSnapshot, pushUndo, type WorkspaceState } from "@/lib/workspace-state";
import { useFilmstripCanvas } from "@/hooks/useFilmstripCanvas";
import { useWaveformCanvas } from "@/hooks/useWaveformCanvas";
import { useDragEngine } from "@/hooks/useDragEngine";
import { useZoomEngine } from "@/hooks/useZoomEngine";
import { RegionTooltip, type TooltipData } from "./RegionTooltip";
import {
  RegionContextMenu,
  ClipContextMenu,
  EmptyAreaContextMenu,
} from "./ContextMenus";
import { applyUndo, applyRedo } from "@/lib/workspace-state";

/* ─── Types ──────────────────────────────────────────────────────────────── */

interface ContextMenuState {
  kind: "region" | "clip" | "empty";
  x: number;
  y: number;
  spanId?: string;
  clipId?: string;
  lane?: TrackName;
  clickTime?: number;
}

/** Imperative handle populated by Timeline for the playback engine to call
 *  on every RAF tick — moves the playhead needle and drives scroll following
 *  without touching React state. */
export interface TimelineTickHandle {
  tick(t: number): void;
}

interface TimelineProps {
  state: WorkspaceState;
  update: (patch: Partial<WorkspaceState>) => void;
  onSeek: (t: number) => void;
  onOpenImport: () => void;
  /** Ref populated by Timeline with an imperative tick() handle. */
  tickRef?: React.RefObject<TimelineTickHandle | null>;
}

/* ─── Helpers ────────────────────────────────────────────────────────────── */
function getMediaDuration(items: MediaItem[], mediaId: string): number {
  return items.find((i) => i.id === mediaId)?.duration ?? 0;
}

/* ─── Main component ─────────────────────────────────────────────────────── */
export function Timeline({ state, update, onSeek, onOpenImport, tickRef }: TimelineProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const filmRef = useRef<HTMLCanvasElement>(null);
  const waveRef = useRef<HTMLCanvasElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // DOM ref for the playhead needle — moved imperatively on every RAF tick
  const playheadElRef = useRef<HTMLDivElement>(null);

  const [zoom, setZoom] = useState(INITIAL_ZOOM);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [snapTime, setSnapTime] = useState<number | null>(null);
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const firstFitDoneRef = useRef(false);
  // When true the user has manually panned — suppress playhead following until
  // an action that legitimately means "take me back to the playhead" clears it.
  // Set by ANY manual scroll or zoom-scroll, regardless of playback state.
  // Cleared by: play start, play stop, explicit seek, fit, re-centre.
  const userScrolledRef = useRef(false);

  const primaryItem = state.items[0] ?? null;
  const duration = primaryItem?.duration ?? 0;
  const timelineDuration = Math.max(
    trackEnd(state.videoSegments),
    trackEnd(state.audioSegments)
  );

  const pps = calcPixelsPerSecond(zoom);
  const minZoom = calcMinZoom(duration, viewportWidth);
  const contentDuration = calcContentDuration(timelineDuration);
  const contentWidth = calcContentWidth(viewportWidth, contentDuration, pps);

  /* ── ResizeObserver ────────────────────────────────────────────────────── */
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const ro = new ResizeObserver(([entry]) => {
      setViewportWidth(entry.contentRect.width);
    });
    ro.observe(scroller);
    return () => ro.disconnect();
  }, []);

  /* ── First fit ─────────────────────────────────────────────────────────── */
  useEffect(() => {
    if (!firstFitDoneRef.current && duration > 0 && viewportWidth > 0) {
      firstFitDoneRef.current = true;
      const fz = Math.max(minZoom, Math.min(MAX_ZOOM, minZoom));
      setZoom(fz);
      setScrollLeft(0);
      if (scrollerRef.current) scrollerRef.current.scrollLeft = 0;
    }
  }, [duration, viewportWidth, minZoom]);

  /* ── Clamp zoom when bounds change ────────────────────────────────────── */
  useEffect(() => {
    if (!firstFitDoneRef.current) return;
    setZoom((z) => Math.max(minZoom, Math.min(MAX_ZOOM, z)));
  }, [minZoom]);

  /* ── Zoom engine ───────────────────────────────────────────────────────── */
  const { zoomIn, zoomOut, fit: fitBase, onWheel: onWheelBase, edgeAutoScroll, followPlayhead } =
    useZoomEngine({
      zoom,
      scrollLeft,
      viewportWidth,
      duration: timelineDuration,
      onZoomChange: setZoom,
      onScrollChange: setScrollLeft,
      scrollerRef: scrollerRef as React.RefObject<HTMLDivElement | null>,
    });

  // Wrap fit so it also re-enables following.
  const fit = useCallback(() => {
    userScrolledRef.current = false;
    fitBase();
  }, [fitBase]);

  // Wrap onWheel so any scroll/zoom gesture suppresses following, regardless
  // of whether playback is running.  A manual pan is always intentional.
  const onWheel = useCallback((e: WheelEvent) => {
    userScrolledRef.current = true;
    onWheelBase(e);
  }, [onWheelBase]);

  // Wrap onSeek so any seek gesture (ruler click, arrow key, scrub) clears the
  // flag — the user is asking to go to a specific time, so following should
  // bring that into view.
  const handleSeek = useCallback((t: number) => {
    userScrolledRef.current = false;
    onSeek(t);
  }, [onSeek]);

  /* ── Playhead following ────────────────────────────────────────────────── */
  // Clear the user-scrolled flag on both play-start AND play-stop transitions.
  //   • play-start: a user who panned while paused should be re-followed when
  //     they hit play, not left staring at an empty stretch of timeline.
  //   • play-stop: following resumes after the user finishes watching.
  const prevPlayingRef = useRef(false);
  const playingRef = useRef(state.playing);
  playingRef.current = state.playing;
  useEffect(() => {
    const wasPlaying = prevPlayingRef.current;
    const isPlaying = state.playing;
    if (wasPlaying !== isPlaying) {
      // Any play/pause transition re-enables following.
      userScrolledRef.current = false;
    }
    prevPlayingRef.current = isPlaying;
  }, [state.playing]);

  // During playback the needle and scroll are driven imperatively via tickRef
  // (no React state writes on every frame).  When not playing, or after a seek,
  // state.playhead still drives a one-shot re-position.
  useEffect(() => {
    if (!scrollerRef.current) return;
    if (userScrolledRef.current) return;
    followPlayhead(state.playhead, state.playing, viewportWidth);
    // Also move the needle synchronously for seeks / pause position.
    if (playheadElRef.current) {
      playheadElRef.current.style.left = `${state.playhead * calcPixelsPerSecond(zoom)}px`;
    }
  }, [state.playhead, state.playing, viewportWidth, followPlayhead, zoom]);

  /* ── Imperative tick handle (RAF, no setState) ─────────────────────────── */
  // pps changes only when zoom changes — capture it in a ref so the tick
  // closure below always uses the current value without being recreated.
  const ppsRef = useRef(calcPixelsPerSecond(zoom));
  ppsRef.current = calcPixelsPerSecond(zoom);

  // Last t value passed to the tick — skip needle + follow when unchanged.
  // While paused the clock never advances, so this eliminates ~60 redundant
  // DOM assertions per second and prevents any scroll snap-back while the
  // user is panning.
  const lastTickTRef = useRef<number | null>(null);

  useEffect(() => {
    if (!tickRef) return;
    (tickRef as React.MutableRefObject<TimelineTickHandle | null>).current = {
      tick(t: number) {
        // Skip all work if the clock hasn't moved since the last frame.
        // This is the common case while paused — the playback engine still
        // runs its RAF loop (for video/audio sync), but the timeline needs
        // to do nothing.
        if (t === lastTickTRef.current) return;
        lastTickTRef.current = t;

        // Move needle
        if (playheadElRef.current) {
          playheadElRef.current.style.left = `${t * ppsRef.current}px`;
        }
        // Scroll to follow playhead — use the live playing state from the ref
        // so paused framing (centre) vs playing framing (left-pin) is correct.
        if (!userScrolledRef.current) {
          followPlayhead(t, playingRef.current, viewportWidth);
        }
      },
    };
    return () => {
      (tickRef as React.MutableRefObject<TimelineTickHandle | null>).current = null;
    };
  });

  /* ── Non-passive wheel ─────────────────────────────────────────────────── */
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => scroller.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  /* ── Scroll sync ───────────────────────────────────────────────────────── */
  const handleScroll = useCallback(() => {
    const sl = scrollerRef.current?.scrollLeft ?? 0;
    setScrollLeft(sl);
    setTooltip(null);
    // Any manual scroll — whether playing or paused — is intentional.
    // Set the flag unconditionally so the follow logic stays out of the way.
    userScrolledRef.current = true;
  }, []);

  /* ── Content rect ──────────────────────────────────────────────────────── */
  const [contentRect, setContentRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const ro = new ResizeObserver(() => {
      setContentRect(content.getBoundingClientRect());
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  /* ── Canvas hooks ──────────────────────────────────────────────────────── */
  useFilmstripCanvas({
    canvasRef: filmRef as React.RefObject<HTMLCanvasElement | null>,
    videoSegments: state.videoSegments,
    items: state.items,
    pixelsPerSecond: pps,
    scrollLeft,
    viewportWidth,
  });

  useWaveformCanvas({
    canvasRef: waveRef as React.RefObject<HTMLCanvasElement | null>,
    audioSegments: state.audioSegments,
    items: state.items,
    primaryId: primaryItem?.id ?? "",
    pixelsPerSecond: pps,
    scrollLeft,
    viewportWidth,
  });

  /* ── State mutation helpers ─────────────────────────────────────────────── */
  const updateSegment = useCallback(
    (lane: TrackName, id: string, patch: Partial<TrackSegment>) => {
      const key = lane === "video" ? "videoSegments" : "audioSegments";
      update({
        [key]: sortSegments(
          (state[key] as TrackSegment[]).map((s) =>
            s.id === id ? { ...s, ...patch } : s
          )
        ),
      });
    },
    [state, update]
  );

  const updateSpan = useCallback(
    (id: string, patch: Partial<FlaggedSpan>) => {
      update({
        spans: state.spans.map((s) => (s.id === id ? { ...s, ...patch } : s)),
      });
    },
    [state.spans, update]
  );

  /* ── Drag engine ───────────────────────────────────────────────────────── */
  const { dragRef, ptrTime, onPointerMove, onPointerUp } = useDragEngine({
    pixelsPerSecond: pps,
    contentRect,
    scrollLeft,
    snapEnabled,
    videoSegments: state.videoSegments,
    audioSegments: state.audioSegments,
    spans: state.spans,
    onUpdateSegment: updateSegment,
    onUpdateSpan: updateSpan,
    onSetSnapTime: setSnapTime,
    onEdgeAutoScroll: edgeAutoScroll,
    getMediaDuration: (id) => getMediaDuration(state.items, id),
  });

  /* ── Ruler ticks ───────────────────────────────────────────────────────── */
  const { labelInterval, tickInterval } = useMemo(
    () => calcRulerTicks(pps),
    [pps]
  );

  // Ruler extends over the full content area (including the padding past the
  // last clip), so there is always empty space to scroll into after the video.
  const firstTickIdx = Math.max(
    0,
    Math.floor(((scrollLeft - 100) / pps) / tickInterval)
  );
  const lastTickIdx = Math.ceil(
    Math.min(contentDuration, (scrollLeft + viewportWidth + 100) / pps) /
      tickInterval
  );

  const ticks: { time: number; isMajor: boolean }[] = [];
  for (let i = firstTickIdx; i <= lastTickIdx; i++) {
    const time = i * tickInterval;
    if (time > contentDuration) break;
    const isMajor =
      Math.abs(Math.round(time / labelInterval) - time / labelInterval) < 1e-6;
    ticks.push({ time, isMajor });
  }

  /* ── Audio flag region blocks ──────────────────────────────────────────── */
  interface RegionBlock {
    span: FlaggedSpan;
    left: number;
    width: number;
    startEdge: boolean;
    endEdge: boolean;
    first: boolean;
    segSrcStart: number;
    segSrcEnd: number;
  }

  const regionBlocks = useMemo<RegionBlock[]>(() => {
    const blocks: RegionBlock[] = [];
    const sortedSegs = sortSegments(state.audioSegments);
    for (const seg of sortedSegs) {
      const spansForSeg = state.spans.filter(
        (sp) => sp.mediaId === seg.mediaId
      );
      for (const span of spansForSeg) {
        const s = Math.max(span.start, seg.srcStart);
        const e = Math.min(span.end, seg.srcEnd);
        if (e - s < 0.01) continue;
        const left = (seg.timelineStart + (s - seg.srcStart)) * pps;
        const width = Math.max(4, (e - s) * pps);
        const startEdge = s <= span.start + 1e-6;
        const endEdge = e >= span.end - 1e-6;
        const first = !blocks.find((b) => b.span.id === span.id);
        blocks.push({
          span, left, width, startEdge, endEdge, first,
          segSrcStart: seg.srcStart,
          segSrcEnd: seg.srcEnd,
        });
      }
    }
    return blocks;
  }, [state.spans, state.audioSegments, pps]);

  /* ── Visual flag blocks (on video track) ───────────────────────────────── */
  interface VisualBlock {
    span: FlaggedVisualSpan;
    left: number;
    width: number;
    first: boolean;
  }

  const visualBlocks = useMemo<VisualBlock[]>(() => {
    const blocks: VisualBlock[] = [];
    const sortedSegs = sortSegments(state.videoSegments);
    for (const seg of sortedSegs) {
      const spansForSeg = state.visualSpans.filter(
        (sp) => sp.mediaId === seg.mediaId
      );
      for (const span of spansForSeg) {
        const s = Math.max(span.start, seg.srcStart);
        const e = Math.min(span.end, seg.srcEnd);
        if (e - s < 0.01) continue;
        const left = (seg.timelineStart + (s - seg.srcStart)) * pps;
        const width = Math.max(4, (e - s) * pps);
        const first = !blocks.find((b) => b.span.id === span.id);
        blocks.push({ span, left, width, first });
      }
    }
    return blocks;
  }, [state.visualSpans, state.videoSegments, pps]);

  /* ── Scrubbing ─────────────────────────────────────────────────────────── */
  const handleRulerPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      setScrubbing(true);
      update({ selectedSpanId: null, selectedClip: null });
      const t = ptrTime(e.clientX);
      handleSeek(Math.max(0, Math.min(contentDuration, t)));
    },
    [ptrTime, contentDuration, handleSeek, update]
  );

  const handleRulerPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!scrubbing) return;
      edgeAutoScroll(e.clientX);
      const t = ptrTime(e.clientX);
      handleSeek(Math.max(0, Math.min(contentDuration, t)));
    },
    [scrubbing, ptrTime, contentDuration, handleSeek, edgeAutoScroll]
  );

  const handleRulerPointerUp = useCallback(() => {
    setScrubbing(false);
  }, []);

  /* ── Track background pointer ───────────────────────────────────────────── */
  const handleTrackPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      update({ selectedSpanId: null, selectedClip: null });
      setScrubbing(true);
      e.currentTarget.setPointerCapture(e.pointerId);
      const t = ptrTime(e.clientX);
      handleSeek(Math.max(0, Math.min(contentDuration, t)));
    },
    [ptrTime, contentDuration, handleSeek, update]
  );

  /* ── Tooltip hit-testing on audio track ────────────────────────────────── */
  const handleAudioTrackPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (scrubbing || dragRef.current) { setTooltip(null); return; }
      const t = ptrTime(e.clientX);
      const pxT = t * pps;
      const hit = regionBlocks.find(
        (b) => pxT >= b.left && pxT <= b.left + b.width
      );
      if (!hit) { setTooltip(null); return; }
      const rect = scrollerRef.current?.getBoundingClientRect();
      const audioTop = rect ? rect.top + RULER_HEIGHT + TRACK_HEIGHT : e.clientY;
      setTooltip({
        span: hit.span,
        blockLeft: hit.left - scrollLeft,
        blockWidth: hit.width,
        clientX: e.clientX,
        audioTrackTop: audioTop,
        pixelsPerSecond: pps,
        scrollLeft,
      });
    },
    [scrubbing, dragRef, ptrTime, pps, regionBlocks, scrollLeft]
  );

  /* ── Context menus ──────────────────────────────────────────────────────── */
  const openContextMenu = useCallback(
    (e: React.MouseEvent, kind: ContextMenuState["kind"], extra?: Partial<ContextMenuState>) => {
      e.preventDefault();
      setTooltip(null);
      setContextMenu({
        kind, x: e.clientX, y: e.clientY,
        clickTime: ptrTime(e.clientX),
        ...extra,
      });
    },
    [ptrTime]
  );

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  useEffect(() => {
    const handler = () => closeContextMenu();
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, [closeContextMenu]);

  /* ── Keyboard dismiss context menu ─────────────────────────────────────── */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeContextMenu();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [closeContextMenu]);

  /* ── Cut both lanes ─────────────────────────────────────────────────────── */
  const cutBothLanes = useCallback(() => {
    const t = state.playhead;
    const snap = takeSnapshot(state);
    let pushed = false;
    let newVideo = state.videoSegments;
    let newAudio = state.audioSegments;

    function planCut(segs: TrackSegment[]) {
      const seg = segs.find(
        (s) =>
          t > s.timelineStart + 0.1 &&
          t < segmentEnd(s) - 0.1
      );
      if (!seg) return null;
      const srcMid = seg.srcStart + (t - seg.timelineStart);
      if (Math.abs(srcMid - seg.srcStart) < 0.1 || Math.abs(srcMid - seg.srcEnd) < 0.1) return null;
      return { seg, srcMid };
    }

    const vPlan = planCut(state.videoSegments);
    const aPlan = planCut(state.audioSegments);
    if (!vPlan && !aPlan) return;

    function applyCut(segs: TrackSegment[], plan: { seg: TrackSegment; srcMid: number }) {
      const { seg, srcMid } = plan;
      const left = { ...seg, id: `${seg.id}_L${Date.now()}`, srcEnd: srcMid };
      const right = {
        ...seg,
        id: `${seg.id}_R${Date.now()}`,
        srcStart: srcMid,
        timelineStart: seg.timelineStart + (srcMid - seg.srcStart),
      };
      return sortSegments(segs.filter((s) => s.id !== seg.id).concat(left, right));
    }

    update({
      ...pushUndo(state, snap),
      videoSegments: vPlan ? applyCut(state.videoSegments, vPlan) : newVideo,
      audioSegments: aPlan ? applyCut(state.audioSegments, aPlan) : newAudio,
    });
  }, [state, update]);

  /* ── Toggle span ────────────────────────────────────────────────────────── */
  const toggleSpan = useCallback((spanId: string) => {
    const snap = takeSnapshot(state);
    update({
      ...pushUndo(state, snap),
      spans: state.spans.map((s) => s.id === spanId ? { ...s, enabled: !s.enabled } : s),
    });
  }, [state, update]);

  /* ── Delete span ────────────────────────────────────────────────────────── */
  const deleteSpan = useCallback((spanId: string) => {
    const snap = takeSnapshot(state);
    update({
      ...pushUndo(state, snap),
      spans: state.spans.filter((s) => s.id !== spanId),
      selectedSpanId: state.selectedSpanId === spanId ? null : state.selectedSpanId,
    });
  }, [state, update]);

  /* ── Toggle clip ────────────────────────────────────────────────────────── */
  const toggleClip = useCallback((lane: TrackName, id: string) => {
    const snap = takeSnapshot(state);
    const key = lane === "video" ? "videoSegments" : "audioSegments";
    update({
      ...pushUndo(state, snap),
      [key]: (state[key] as TrackSegment[]).map((s) =>
        s.id === id ? { ...s, enabled: !s.enabled } : s
      ),
    });
  }, [state, update]);

  /* ── Delete clip ────────────────────────────────────────────────────────── */
  const deleteClip = useCallback((lane: TrackName, id: string) => {
    const snap = takeSnapshot(state);
    const key = lane === "video" ? "videoSegments" : "audioSegments";
    const remaining = (state[key] as TrackSegment[]).filter((s) => s.id !== id);
    const otherKey = lane === "video" ? "audioSegments" : "videoSegments";
    if (remaining.length === 0 && (state[otherKey] as TrackSegment[]).length === 0) return;
    update({
      ...pushUndo(state, snap),
      [key]: remaining,
      selectedClip: state.selectedClip?.id === id ? null : state.selectedClip,
    });
  }, [state, update]);

  /* ── Close gap ──────────────────────────────────────────────────────────── */
  const closeGap = useCallback((lane: TrackName, id: string) => {
    const snap = takeSnapshot(state);
    const key = lane === "video" ? "videoSegments" : "audioSegments";
    const segs = state[key] as TrackSegment[];
    const idx = segs.findIndex((s) => s.id === id);
    if (idx < 0) return;
    const prevEnd = idx > 0 ? segmentEnd(segs[idx - 1]) : 0;
    update({
      ...pushUndo(state, snap),
      [key]: segs.map((s) => s.id === id ? { ...s, timelineStart: prevEnd } : s),
    });
  }, [state, update]);

  /* ── Add region at time ─────────────────────────────────────────────────── */
  const addRegionAt = useCallback((srcTime: number, mediaId: string) => {
    if (!primaryItem) return;
    const snap = takeSnapshot(state);
    const dur = primaryItem.duration;
    const start = Math.max(0, Math.min(srcTime, dur - 2));
    const end = Math.min(dur, start + 2);
    const id = `r${Date.now()}`;
    const span: FlaggedSpan = {
      id, mediaId, start, end,
      title: "Manual region", artists: "", album: "",
      confidence: 0, enabled: true, manual: true,
    };
    update({
      ...pushUndo(state, snap),
      spans: [...state.spans, span].sort((a, b) => a.start - b.start),
      selectedSpanId: id,
    });
  }, [state, update, primaryItem]);

  /* ── Clear all spans ────────────────────────────────────────────────────── */
  const clearAllSpans = useCallback(() => {
    if (state.spans.length === 0) return;
    const snap = takeSnapshot(state);
    update({ ...pushUndo(state, snap), spans: [], selectedSpanId: null });
  }, [state, update]);

  /* ── Split span at playhead ─────────────────────────────────────────────── */
  const splitSpanAtPlayhead = useCallback(() => {
    const t = state.playhead;
    const result = resolveSourceAt(state.audioSegments, t);
    if (!result) return;
    const srcTime = result.sourceTime;
    const span = state.spans.find(
      (s) => srcTime - s.start > 0.2 && s.end - srcTime > 0.2
    );
    if (!span) return;
    const snap = takeSnapshot(state);
    let c = 0;
    const newId = () => `r${Date.now()}_${++c}`;
    const left: FlaggedSpan = { ...span, id: newId(), end: srcTime };
    const right: FlaggedSpan = { ...span, id: newId(), start: srcTime };
    update({
      ...pushUndo(state, snap),
      spans: state.spans.filter((s) => s.id !== span.id).concat(left, right).sort((a, b) => a.start - b.start),
      selectedSpanId: right.id,
    });
  }, [state, update]);

  /* ── Undo / Redo ────────────────────────────────────────────────────────── */
  const handleUndo = useCallback(() => {
    const patch = applyUndo(state);
    if (patch) update(patch as Partial<WorkspaceState>);
  }, [state, update]);

  const handleRedo = useCallback(() => {
    const patch = applyRedo(state);
    if (patch) update(patch as Partial<WorkspaceState>);
  }, [state, update]);

  /* ── Render ─────────────────────────────────────────────────────────────── */
  return (
    <div style={{ position: "relative", userSelect: "none" }}>
      {/* ── Toolbar ───────────────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 10,
          marginBottom: 8,
        }}
      >
        {/* Left cluster */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {/* Play/Pause */}
          <button
            className="button button--toolbar"
            onClick={() => update({ playing: !state.playing })}
            title="Play / pause (Space)"
            aria-label={state.playing ? "Pause" : "Play"}
          >
            {state.playing ? "⏸" : "▶"}
          </button>

          {/* Cut */}
          <button
            className="button button--toolbar"
            onClick={cutBothLanes}
            disabled={timelineDuration === 0}
            title="Cut both video and audio at the playhead (C)"
            aria-label="Cut both lanes at the playhead"
          >
            ✂ Cut
          </button>

          {/* Add media */}
          <button
            className="button button--toolbar"
            onClick={onOpenImport}
            title="Add another video or sound to the timeline"
            aria-label="Add media"
          >
            + Add media
          </button>

          {/* Zoom out */}
          <button
            className="button button--toolbar"
            onClick={zoomOut}
            title="Zoom out"
            aria-label="Zoom out"
          >
            −
          </button>

          {/* Zoom in */}
          <button
            className="button button--toolbar"
            onClick={zoomIn}
            title="Zoom in"
            aria-label="Zoom in"
          >
            +
          </button>

          {/* Fit */}
          <button
            className="button button--toolbar"
            onClick={fit}
            title="Fit the whole timeline"
            aria-label="Fit the whole timeline"
          >
            Fit
          </button>

          {/* Snap toggle */}
          <button
            className={`button button--toolbar${snapEnabled ? " button--active" : ""}`}
            onClick={() => setSnapEnabled((v) => !v)}
            title="Toggle snapping to the playhead and clip/region edges"
            aria-label="Snapping"
            aria-pressed={snapEnabled}
          >
            Snap
          </button>

          {/* Undo */}
          <button
            className="button button--toolbar"
            onClick={handleUndo}
            disabled={state.undoStack.length === 0}
            title="Undo (Ctrl+Z)"
            aria-label="Undo"
          >
            ↶
          </button>

          {/* Redo */}
          <button
            className="button button--toolbar"
            onClick={handleRedo}
            disabled={state.redoStack.length === 0}
            title="Redo (Ctrl+Shift+Z)"
            aria-label="Redo"
          >
            ↷
          </button>

          {/* Shortcuts toggle */}
          <button
            className={`button button--toolbar${showShortcuts ? " button--active" : ""}`}
            onClick={() => setShowShortcuts((v) => !v)}
            title="Show keyboard shortcuts"
            aria-label="Keyboard shortcuts"
            aria-pressed={showShortcuts}
          >
            ⌨ Shortcuts
          </button>
        </div>

        {/* Right cluster */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }} title="Preview volume (doesn't change the export)">
          {/* Mute button */}
          <button
            className="button button--toolbar"
            onClick={() => update({ muted: !state.muted })}
            title="Mute the preview"
            aria-label={state.muted ? "Unmute preview" : "Mute preview"}
            aria-pressed={state.muted}
          >
            {state.muted || state.previewVolume === 0 ? "🔇" : "🔊"}
          </button>

          {/* Volume slider */}
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(state.previewVolume * 100)}
              style={{ width: 90, accentColor: "#C65D3B" }}
              aria-label="Preview volume"
              onChange={(e) =>
                update({ previewVolume: Number(e.target.value) / 100 })
              }
            />
          </label>

          {/* Time display */}
          <span
            style={{
              fontFamily: 'var(--font-courier),"Courier Prime",monospace',
              fontSize: 12.5,
              fontVariantNumeric: "tabular-nums",
              color: "var(--muted)",
              whiteSpace: "nowrap",
            }}
          >
            {formatClock(state.playhead)} / {formatClock(timelineDuration)}
          </span>
        </div>
      </div>

      {/* ── Shortcuts panel ────────────────────────────────────────────────── */}
      {showShortcuts && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "6px 18px",
            background: "#EFEBE1",
            border: "1px solid #D1D1C9",
            borderRadius: 8,
            padding: "10px 14px",
            marginBottom: 8,
            fontFamily: 'var(--font-courier),"Courier Prime",monospace',
            fontSize: 11.5,
            color: "var(--muted)",
          }}
        >
          {[
            { keys: ["Space"], desc: " play / pause" },
            { keys: ["C"], desc: " cut both lanes at playhead" },
            { keys: ["←", "→"], desc: " step 0.1 s", extra: [" (", "Shift", " = 1 s)"] },
            { keys: ["S"], desc: " split flag region at playhead" },
            { keys: ["M"], desc: " toggle region on/off" },
            { keys: ["Del"], desc: " delete selected region or clip" },
            { keys: ["Ctrl", "Z"], desc: " undo · ", extraKeys: ["Ctrl", "Shift", "Z"], extraDesc: " redo" },
          ].map((item, i) => (
            <span key={i} style={{ whiteSpace: "nowrap" }}>
              {item.keys.map((k) => (
                <kbd key={k} className="kbd" style={{ marginRight: 2 }}>{k}</kbd>
              ))}
              {item.desc}
              {item.extra?.map((ex, j) =>
                ex === "Shift" ? <kbd key={j} className="kbd" style={{ margin: "0 2px" }}>{ex}</kbd> : <span key={j}>{ex}</span>
              )}
              {item.extraKeys?.map((k) => (
                <kbd key={k} className="kbd" style={{ margin: "0 2px" }}>{k}</kbd>
              ))}
              {item.extraDesc}
            </span>
          ))}
          <span style={{ whiteSpace: "nowrap" }}>
            <kbd className="kbd">Ctrl</kbd>+scroll zoom timeline
          </span>
          <span>drag clips anywhere (gaps = black/silence) · drag clip edges to trim</span>
        </div>
      )}

      {/* ── Timeline body ────────────────────────────────────────────────────── */}
      <div className="timeline-body">
        {/* Track headers */}
        <div className="timeline-headers">
          <div className="timeline-header-spacer" />
          {/* Video header */}
          <div className="timeline-header-row">
            <span className="track-badge track-badge--video">V1</span>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Video</span>
            {state.visualSpans.length > 0 && (
              <span
                style={{ fontSize: 9.5, color: "#7c5cd8", whiteSpace: "nowrap", marginLeft: 4 }}
                title="Visual copyright flags detected"
              >
                ◈ {state.visualSpans.length}
              </span>
            )}
          </div>
          {/* Audio header */}
          <div className="timeline-header-row">
            <span className="track-badge track-badge--audio">A1</span>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Audio</span>
            <button
              className={`header-mute-btn${state.muted ? " header-mute-btn--active" : ""}`}
              onClick={() => update({ muted: !state.muted })}
              title="Mute the preview audio"
              aria-label={state.muted ? "Unmute preview audio" : "Mute preview audio"}
              aria-pressed={state.muted}
            >
              M
            </button>
          </div>
        </div>

        {/* Scroller — keyboard-focusable so users can drive the playhead with arrow keys */}
        <div
          ref={scrollerRef}
          className="timeline-scroller"
          tabIndex={0}
          role="region"
          aria-label="Timeline"
          onScroll={handleScroll}
          onPointerUp={() => { onPointerUp(); setScrubbing(false); }}
          onPointerMove={(e) => { onPointerMove(e); }}
          onKeyDown={(e) => {
            // Arrow-key playhead stepping when the scroller has focus
            const tag = (document.activeElement as HTMLElement)?.tagName?.toLowerCase();
            if (tag === "input" || tag === "select" || tag === "textarea") return;
            if (e.key === "ArrowLeft") {
              e.preventDefault();
              handleSeek(Math.max(0, state.playhead - (e.shiftKey ? 1 : 0.1)));
            } else if (e.key === "ArrowRight") {
              e.preventDefault();
              handleSeek(Math.min(timelineDuration, state.playhead + (e.shiftKey ? 1 : 0.1)));
            }
          }}
        >
          {/* Content */}
          <div
            ref={contentRef}
            className="timeline-content"
            style={{ width: contentWidth }}
            onContextMenu={(e) => {
              // Only open empty-area menu if not caught by clip/region
              openContextMenu(e, "empty");
            }}
          >
            {/* ── Ruler ───────────────────────────────────────────────── */}
            <div
              className="timeline-ruler"
              onPointerDown={handleRulerPointerDown}
              onPointerMove={handleRulerPointerMove}
              onPointerUp={handleRulerPointerUp}
              onPointerCancel={handleRulerPointerUp}
            >
              {ticks.map(({ time, isMajor }) => {
                const x = time * pps;
                return (
                  <React.Fragment key={time}>
                    <div
                      style={{
                        position: "absolute",
                        bottom: 0,
                        left: x,
                        width: 1,
                        height: isMajor ? 10 : 6,
                        background: isMajor
                          ? "rgba(31,31,31,0.45)"
                          : "rgba(31,31,31,0.22)",
                        pointerEvents: "none",
                      }}
                    />
                    {isMajor && (
                      <div
                        style={{
                          position: "absolute",
                          bottom: 10,
                          left: x + 3,
                          fontFamily: 'var(--font-courier),"Courier Prime",monospace',
                          fontSize: 9.5,
                          color: "var(--muted)",
                          whiteSpace: "nowrap",
                          pointerEvents: "none",
                        }}
                      >
                        {formatRulerLabel(time, labelInterval)}
                      </div>
                    )}
                  </React.Fragment>
                );
              })}
            </div>

            {/* ── Grid lines ─────────────────────────────────────────── */}
            {ticks.filter((t) => t.isMajor && t.time > 0).map(({ time }) => (
              <div
                key={`grid-${time}`}
                style={{
                  position: "absolute",
                  top: 26,
                  bottom: 0,
                  left: time * pps,
                  width: 1,
                  background: "rgba(31,31,31,0.05)",
                  pointerEvents: "none",
                }}
              />
            ))}

            {/* ── Video track ─────────────────────────────────────────── */}
            <div
              className="video-track"
              onPointerDown={handleTrackPointerDown}
              onPointerMove={(e) => { if (scrubbing) { edgeAutoScroll(e.clientX); handleSeek(Math.max(0, Math.min(contentDuration, ptrTime(e.clientX)))); } }}
              onPointerUp={() => setScrubbing(false)}
            >
              {/* Filmstrip canvas — positioned at scrollLeft, sized to viewport only */}
              <canvas
                ref={filmRef}
                style={{ position: "absolute", top: 0, left: scrollLeft, pointerEvents: "none" }}
              />

              {/* Video clips */}
              {state.videoSegments.map((seg) => {
                const left = seg.timelineStart * pps;
                const width = Math.max(4, (seg.srcEnd - seg.srcStart) * pps);
                const selected = state.selectedClip?.lane === "video" && state.selectedClip.id === seg.id;
                const isNonPrimary = seg.mediaId !== primaryItem?.id;
                const item = state.items.find((i) => i.id === seg.mediaId);

                return (
                  <div
                    key={seg.id}
                    className={`timeline-clip${!seg.enabled ? " timeline-clip--disabled" : ""}${selected ? " timeline-clip--selected" : ""}`}
                    style={{ left, width }}
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      e.stopPropagation();
                      e.currentTarget.setPointerCapture(e.pointerId);
                      const snap = takeSnapshot(state);
                      update({ ...pushUndo(state, snap), selectedClip: { lane: "video", id: seg.id }, selectedSpanId: null });
                      dragRef.current = { mode: "move", lane: "video", clipId: seg.id, grabOffset: ptrTime(e.clientX) - seg.timelineStart };
                    }}
                    onContextMenu={(e) => {
                      e.stopPropagation();
                      openContextMenu(e, "clip", { clipId: seg.id, lane: "video" });
                    }}
                  >
                    {isNonPrimary && (
                      <div className="clip-name-chip">{item?.name ?? "media"}</div>
                    )}
                    {!seg.enabled && (
                      <div className="clip-disabled-label">🚫 blacked out</div>
                    )}
                    {/* Trim handles */}
                    <div
                      className="trim-handle trim-handle--left"
                      title="Drag to trim the clip's beginning"
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        e.currentTarget.setPointerCapture(e.pointerId);
                        const prev = state.videoSegments.filter((s) => segmentEnd(s) <= seg.timelineStart).reduce((m, s) => Math.max(m, segmentEnd(s)), 0);
                        const snap = takeSnapshot(state);
                        update(pushUndo(state, snap));
                        dragRef.current = { mode: "start", lane: "video", clipId: seg.id, prevEnd: prev };
                      }}
                    />
                    <div
                      className="trim-handle trim-handle--right"
                      title="Drag to trim the clip's end"
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        e.currentTarget.setPointerCapture(e.pointerId);
                        const next = state.videoSegments.filter((s) => s.timelineStart >= segmentEnd(seg)).reduce((m, s) => Math.min(m, s.timelineStart), Infinity);
                        const snap = takeSnapshot(state);
                        update(pushUndo(state, snap));
                        dragRef.current = { mode: "end", lane: "video", clipId: seg.id, nextStart: next };
                      }}
                    />
                  </div>
                );
              })}
              {/* Visual flag overlays — sit on top of video clips */}
              {visualBlocks.map((block, i) => {
                const { span, left, width, first } = block;
                const spared = !span.enabled;
                return (
                  <div
                    key={`${span.id}-${i}`}
                    style={{
                      position: "absolute",
                      top: 0,
                      left,
                      width,
                      height: "100%",
                      background: spared
                        ? "rgba(124,92,216,0.12)"
                        : "rgba(124,92,216,0.28)",
                      borderLeft: spared ? "2px solid rgba(124,92,216,0.35)" : "2px solid #7c5cd8",
                      borderRight: spared ? "2px solid rgba(124,92,216,0.35)" : "2px solid #7c5cd8",
                      boxSizing: "border-box",
                      zIndex: 4,
                      pointerEvents: "auto",
                      cursor: "pointer",
                    }}
                    title={`${VISUAL_CATEGORY_LABELS[span.label] ?? span.label}${span.signals.length ? ` · ${span.signals[0]}` : ""}${spared ? " (spared)" : ""}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      const snap = takeSnapshot(state);
                      update({
                        ...pushUndo(state, snap),
                        visualSpans: state.visualSpans.map((s) =>
                          s.id === span.id ? { ...s, enabled: !s.enabled } : s
                        ),
                      });
                    }}
                  >
                    {first && (
                      <div
                        style={{
                          position: "absolute",
                          bottom: "100%",
                          left: 0,
                          whiteSpace: "nowrap",
                          maxWidth: width > 0 ? width : undefined,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          fontSize: 9.5,
                          fontWeight: 600,
                          color: "#7c5cd8",
                          lineHeight: "14px",
                          pointerEvents: "none",
                          padding: "0 2px",
                        }}
                      >
                        ◈ {VISUAL_CATEGORY_LABELS[span.label] ?? span.label}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* ── Audio track ─────────────────────────────────────────── */}
            <div
              className="audio-track"
              onPointerDown={handleTrackPointerDown}
              onPointerMove={(e) => {
                if (scrubbing) { edgeAutoScroll(e.clientX); handleSeek(Math.max(0, Math.min(contentDuration, ptrTime(e.clientX)))); }
                handleAudioTrackPointerMove(e);
              }}
              onPointerUp={() => setScrubbing(false)}
              onPointerLeave={() => setTooltip(null)}
            >
              {/* Waveform canvas — starts at 20px (3px gap + 17px label row) */}
              <canvas
                ref={waveRef}
                style={{ position: "absolute", top: 20, left: scrollLeft, pointerEvents: "none", zIndex: 2 }}
              />

              {/* Audio clips */}
              {state.audioSegments.map((seg) => {
                const left = seg.timelineStart * pps;
                const width = Math.max(4, (seg.srcEnd - seg.srcStart) * pps);
                const selected = state.selectedClip?.lane === "audio" && state.selectedClip.id === seg.id;
                const isNonPrimary = seg.mediaId !== primaryItem?.id;
                const item = state.items.find((i) => i.id === seg.mediaId);
                const gainDiffers = Math.abs((seg.gain ?? 1) - 1) > 0.01;

                return (
                  <div
                    key={seg.id}
                    className={`timeline-clip${!seg.enabled ? " timeline-clip--disabled" : ""}${selected ? " timeline-clip--selected" : ""}`}
                    style={{ left, width }}
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      e.stopPropagation();
                      e.currentTarget.setPointerCapture(e.pointerId);
                      const snap = takeSnapshot(state);
                      update({ ...pushUndo(state, snap), selectedClip: { lane: "audio", id: seg.id }, selectedSpanId: null });
                      dragRef.current = { mode: "move", lane: "audio", clipId: seg.id, grabOffset: ptrTime(e.clientX) - seg.timelineStart };
                    }}
                    onContextMenu={(e) => {
                      e.stopPropagation();
                      openContextMenu(e, "clip", { clipId: seg.id, lane: "audio" });
                    }}
                  >
                    {isNonPrimary && (
                      <div className="clip-name-chip">{item?.name ?? "media"}</div>
                    )}
                    {!seg.enabled && (
                      <div className="clip-disabled-label">🔇 silenced</div>
                    )}
                    {seg.enabled && gainDiffers && (
                      <div className="clip-gain-chip">
                        {Math.round((seg.gain ?? 1) * 100)}%
                      </div>
                    )}
                    <div
                      className="trim-handle trim-handle--left"
                      title="Drag to trim the clip's beginning"
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        e.currentTarget.setPointerCapture(e.pointerId);
                        const prev = state.audioSegments.filter((s) => segmentEnd(s) <= seg.timelineStart).reduce((m, s) => Math.max(m, segmentEnd(s)), 0);
                        const snap = takeSnapshot(state);
                        update(pushUndo(state, snap));
                        dragRef.current = { mode: "start", lane: "audio", clipId: seg.id, prevEnd: prev };
                      }}
                    />
                    <div
                      className="trim-handle trim-handle--right"
                      title="Drag to trim the clip's end"
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        e.currentTarget.setPointerCapture(e.pointerId);
                        const next = state.audioSegments.filter((s) => s.timelineStart >= segmentEnd(seg)).reduce((m, s) => Math.min(m, s.timelineStart), Infinity);
                        const snap = takeSnapshot(state);
                        update(pushUndo(state, snap));
                        dragRef.current = { mode: "end", lane: "audio", clipId: seg.id, nextStart: next };
                      }}
                    />
                  </div>
                );
              })}
              {/* ── Flag regions — inside audio-track so waveform canvas (z-index 2) ── */}
              {/* paints above the region fill (z-index 1). Label strip uses             */}
              {/* bottom:100% to float above the track without touching the waveform.    */}
              {regionBlocks.map((block, i) => {
                const { span, left, width, startEdge, endEdge, first } = block;
                const selected = state.selectedSpanId === span.id;
                const spared = !span.enabled;

                return (
                  <div
                    key={`${span.id}-${i}`}
                    className={`flag-region${spared ? " flag-region--spared" : ""}${selected ? " flag-region--selected" : ""}`}
                    style={{ left, width }}
                  >
                    {/* Label strip */}
                    <div
                      className={`region-label-strip${spared ? " region-label-strip--spared" : ""}`}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        update({ selectedSpanId: span.id, selectedClip: null });
                      }}
                      onPointerEnter={() => {
                        const rect = scrollerRef.current?.getBoundingClientRect();
                        const audioTop = rect ? rect.top + RULER_HEIGHT + TRACK_HEIGHT : 0;
                        setTooltip({
                          span,
                          blockLeft: left - scrollLeft,
                          blockWidth: width,
                          clientX: left - scrollLeft + width / 2 + (rect?.left ?? 0),
                          audioTrackTop: audioTop,
                          pixelsPerSecond: pps,
                          scrollLeft,
                        });
                      }}
                      onPointerLeave={() => setTooltip(null)}
                      onContextMenu={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        openContextMenu(e, "region", { spanId: span.id });
                      }}
                    >
                      <div className="region-label-text">
                        {first
                          ? span.title + (span.artists ? ` · ${span.artists}` : "")
                          : "⋯"}
                      </div>
                    </div>

                    {/* Start edge handle */}
                    {startEdge && span.start - block.segSrcStart > 0.01 && (
                      <div
                        className={`region-edge-handle region-edge-handle--left${spared ? " region-edge-handle--spared" : ""}`}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          e.currentTarget.setPointerCapture(e.pointerId);
                          setTooltip(null);
                          update({ selectedSpanId: span.id });
                          const snap = takeSnapshot(state);
                          update(pushUndo(state, snap));
                          dragRef.current = { mode: "region-start", spanId: span.id };
                        }}
                      />
                    )}

                    {/* End edge handle */}
                    {endEdge && block.segSrcEnd - span.end > 0.01 && (
                      <div
                        className={`region-edge-handle region-edge-handle--right${spared ? " region-edge-handle--spared" : ""}`}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          e.currentTarget.setPointerCapture(e.pointerId);
                          setTooltip(null);
                          update({ selectedSpanId: span.id });
                          const snap = takeSnapshot(state);
                          update(pushUndo(state, snap));
                          dragRef.current = { mode: "region-end", spanId: span.id };
                        }}
                      />
                    )}
                  </div>
                );
              })}
            </div>

            {/* ── Snap indicator ──────────────────────────────────────── */}
            {snapTime !== null && (
              <div
                className="snap-indicator"
                style={{ left: snapTime * pps }}
              />
            )}

            {/* ── Playhead ────────────────────────────────────────────── */}
            {timelineDuration > 0 && (
              <div
                ref={playheadElRef}
                className="timeline-playhead"
                style={{ left: state.playhead * pps }}
              />
            )}
          </div>
        </div>
      </div>

      {/* ── Tooltip ────────────────────────────────────────────────────────── */}
      {tooltip && !contextMenu && (
        <RegionTooltip data={tooltip} />
      )}

      {/* ── Context menus ──────────────────────────────────────────────────── */}
      {contextMenu?.kind === "region" && (() => {
        const span = state.spans.find((s) => s.id === contextMenu.spanId);
        if (!span) return null;
        return (
          <RegionContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            span={span}
            onClose={closeContextMenu}
            onSplitAtPlayhead={() => { splitSpanAtPlayhead(); closeContextMenu(); }}
            onToggleSpare={() => { toggleSpan(span.id); closeContextMenu(); }}
            onDelete={() => { deleteSpan(span.id); closeContextMenu(); }}
          />
        );
      })()}

      {contextMenu?.kind === "clip" && (() => {
        const lane = contextMenu.lane ?? "video";
        const segs = lane === "video" ? state.videoSegments : state.audioSegments;
        const clip = segs.find((s) => s.id === contextMenu.clipId);
        if (!clip) return null;
        const sortedSegs = sortSegments(segs);
        const idx = sortedSegs.findIndex((s) => s.id === clip.id);
        const hasPrevGap = idx === 0
          ? clip.timelineStart > 0.01
          : clip.timelineStart - segmentEnd(sortedSegs[idx - 1]) > 0.01;
        return (
          <ClipContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            lane={lane}
            clip={clip}
            hasPrevGap={hasPrevGap}
            onClose={closeContextMenu}
            onCutThisLane={() => {
              const t = state.playhead;
              const plan = (() => {
                const seg = segs.find((s) => t > s.timelineStart + 0.1 && t < segmentEnd(s) - 0.1);
                if (!seg) return null;
                const srcMid = seg.srcStart + (t - seg.timelineStart);
                return { seg, srcMid };
              })();
              if (!plan) return;
              const snap = takeSnapshot(state);
              const key = lane === "video" ? "videoSegments" : "audioSegments";
              const { seg, srcMid } = plan;
              const left = { ...seg, id: `${seg.id}_L${Date.now()}`, srcEnd: srcMid };
              const right = { ...seg, id: `${seg.id}_R${Date.now()}`, srcStart: srcMid, timelineStart: seg.timelineStart + (srcMid - seg.srcStart) };
              update({ ...pushUndo(state, snap), [key]: sortSegments(segs.filter((s) => s.id !== seg.id).concat(left, right)) });
            }}
            onCutBothLanes={cutBothLanes}
            onCloseGap={() => closeGap(lane, clip.id)}
            onToggle={() => toggleClip(lane, clip.id)}
            onDelete={() => deleteClip(lane, clip.id)}
            onGainChange={(g) => updateSegment("audio", clip.id, { gain: Math.max(0, Math.min(2, g)) })}
            onGainDragStart={() => {
              const snap = takeSnapshot(state);
              update(pushUndo(state, snap));
            }}
          />
        );
      })()}

      {contextMenu?.kind === "empty" && (() => {
        const clickTime = contextMenu.clickTime ?? 0;
        const result = resolveSourceAt(state.audioSegments, clickTime);
        const canSplit = result
          ? state.spans.some((sp) => {
              return sp.mediaId === (state.audioSegments[result.index]?.mediaId ?? "") &&
                result.sourceTime - sp.start > 0.2 &&
                sp.end - result.sourceTime > 0.2;
            })
          : false;
        return (
          <EmptyAreaContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            clickTime={clickTime}
            hasSpans={state.spans.length > 0}
            canSplit={canSplit}
            onClose={closeContextMenu}
            onAddRegion={() => {
              if (result) addRegionAt(result.sourceTime, state.audioSegments[result.index].mediaId);
            }}
            onSplitAtPlayhead={splitSpanAtPlayhead}
            onSeekHere={() => handleSeek(clickTime)}
            onClearAll={clearAllSpans}
          />
        );
      })()}
    </div>
  );
}
