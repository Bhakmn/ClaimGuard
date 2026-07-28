"use client";

import React, { useRef, useCallback, useState } from "react";
import type { MediaItem, TrackSegment, FlaggedSpan } from "@/lib/types";
import type { WorkspaceState } from "@/lib/workspace-state";
import { usePlaybackEngine } from "@/hooks/usePlaybackEngine";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { Player } from "./Player";
import { ActionRow } from "./ActionRow";
import { Timeline, type TimelineTickHandle } from "@/components/timeline/Timeline";
import { EditorErrorBoundary } from "./EditorErrorBoundary";
import { takeSnapshot, pushUndo } from "@/lib/workspace-state";
import { nextId } from "@/lib/mock/scan-service";
import { trackEnd, resolveSourceAt } from "@/lib/types";

/* ─── Props ──────────────────────────────────────────────────────────────── */

interface WorkspacePanelProps {
  state: WorkspaceState;
  update: (patch: Partial<WorkspaceState>) => void;
  onScan: () => void;
  onImportFile: (file: File) => void;
  onNextOrChoose: () => void;
  /** Ref to the hidden import <input> that lives on the workspace. */
  importInputRef: React.RefObject<HTMLInputElement | null>;
  /** Ref forwarded to the scan button so the overlay can restore focus on close. */
  scanTriggerRef?: React.RefObject<HTMLElement | null>;
}

/* ─── Component ──────────────────────────────────────────────────────────── */

export function WorkspacePanel({
  state,
  update,
  onScan,
  onImportFile,
  onNextOrChoose,
  importInputRef,
  scanTriggerRef,
}: WorkspacePanelProps) {
  const online = useOnlineStatus();

  // Active video id is driven imperatively from onTick — never written to
  // React state during playback so the component tree does not re-render
  // on every animation frame.
  const [activeVideoMediaId, setActiveVideoMediaId] = useState<string | null>(null);
  const activeVideoMediaIdRef = useRef<string | null>(null);

  const primaryItem = state.items[0] ?? null;
  const timelineDuration = Math.max(
    trackEnd(state.videoSegments),
    trackEnd(state.audioSegments)
  );

  // Imperative handle populated by Timeline — used in onTick to move the
  // playhead needle and scroll without touching React state.
  const timelineTickRef = useRef<TimelineTickHandle | null>(null);

  // Pool refs for Player visibility — driven imperatively from onTick.
  const videoElsRef = useRef<Map<string, HTMLVideoElement>>(new Map());

  /* ── Playback engine ───────────────────────────────────────────────────── */
  const handleTick = useCallback(
    (t: number, newActiveId: string | null) => {
      // Move playhead needle + scroll — pure DOM, no setState.
      timelineTickRef.current?.tick(t);

      // Update video element visibility imperatively.
      if (newActiveId !== activeVideoMediaIdRef.current) {
        activeVideoMediaIdRef.current = newActiveId;
        videoElsRef.current.forEach((el, id) => {
          el.style.display = id === newActiveId ? "block" : "none";
        });
        // Sync React state once on change so Player's initial render is correct
        // and error banners (which depend on items, not activeVideoMediaId) still work.
        setActiveVideoMediaId(newActiveId);
      }
    },
    []
  );

  const handlePlayEnd = useCallback(
    () => update({ playing: false }),
    [update]
  );

  const { pool, play, pause, seek, seekDelta } = usePlaybackEngine({
    items: state.items,
    videoSegments: state.videoSegments,
    audioSegments: state.audioSegments,
    playing: state.playing,
    muted: state.muted,
    previewVolume: state.previewVolume,
    timelineDuration,
    onTick: handleTick,
    onTimeUpdate: useCallback((t: number) => update({ playhead: t }), [update]),
    onPlayEnd: handlePlayEnd,
  });

  const handleTogglePlay = useCallback(() => {
    if (state.playing) {
      pause();
      update({ playing: false });
    } else {
      play();
      update({ playing: true });
    }
  }, [state.playing, play, pause, update]);

  /* ── Add region at playhead ────────────────────────────────────────────── */
  const handleAddRegion = useCallback(() => {
    if (!primaryItem) return;
    const t = state.playhead;
    const result = resolveSourceAt(state.audioSegments, t);
    if (!result) return;
    const covering = state.audioSegments[result.index];
    if (covering.mediaId !== primaryItem.id) return;

    const dur = primaryItem.duration;
    const snap = takeSnapshot(state);
    const start = Math.max(0, Math.min(result.sourceTime, dur - 2));
    const end = Math.min(dur, start + 2);
    const id = nextId();
    const span: FlaggedSpan = {
      id,
      mediaId: covering.mediaId,
      start,
      end,
      title: "Manual region",
      artists: "",
      album: "",
      confidence: 0,
      enabled: true,
      manual: true,
    };
    const spans = [...state.spans, span].sort((a, b) => a.start - b.start);
    update({
      ...pushUndo(state, snap),
      spans,
      selectedSpanId: id,
    });
  }, [state, primaryItem, update]);

  /* ── Split region at playhead ──────────────────────────────────────────── */
  const handleSplitRegion = useCallback(() => {
    if (!primaryItem) return;
    const t = state.playhead;
    const result = resolveSourceAt(state.audioSegments, t);
    if (!result) return;
    const srcTime = result.sourceTime;

    function isSplittable(s: FlaggedSpan) {
      return s.mediaId === primaryItem!.id &&
        srcTime - s.start > 0.2 &&
        s.end - srcTime > 0.2;
    }

    const selected = state.spans.find((s) => s.id === state.selectedSpanId);
    const target =
      selected && isSplittable(selected)
        ? selected
        : state.spans.find(isSplittable);
    if (!target) return;

    const snap = takeSnapshot(state);
    let c = 0;
    const newId = () => `r${Date.now()}_split${++c}`;
    const left: FlaggedSpan = { ...target, id: newId(), end: srcTime };
    const right: FlaggedSpan = { ...target, id: newId(), start: srcTime };
    const spans = state.spans
      .filter((s) => s.id !== target.id)
      .concat(left, right)
      .sort((a, b) => a.start - b.start);
    update({ ...pushUndo(state, snap), spans, selectedSpanId: right.id });
  }, [state, primaryItem, update]);

  /* ── Trim region to playhead ───────────────────────────────────────────── */
  const handleTrimRegion = useCallback(() => {
    if (!primaryItem) return;
    const t = state.playhead;
    const result = resolveSourceAt(state.audioSegments, t);
    if (!result) return;
    const srcTime = result.sourceTime;
    const covering = state.audioSegments[result.index];

    function isTrimmable(s: FlaggedSpan) {
      return s.mediaId === covering.mediaId &&
        srcTime - s.start > 0.2 &&
        s.end - srcTime > 0.2;
    }

    const selected = state.spans.find((s) => s.id === state.selectedSpanId);
    const target =
      selected && isTrimmable(selected)
        ? selected
        : state.spans.find(isTrimmable);
    if (!target) return;

    const snap = takeSnapshot(state);
    const trimEnd = srcTime - target.start > target.end - srcTime;
    const trimmed: FlaggedSpan = trimEnd
      ? { ...target, end: srcTime }
      : { ...target, start: srcTime };
    const spans = state.spans.map((s) => (s.id === target.id ? trimmed : s));
    update({ ...pushUndo(state, snap), spans, selectedSpanId: trimmed.id });
  }, [state, primaryItem, update]);

  /* ── Render ────────────────────────────────────────────────────────────── */
  return (
    <div className="panel">
      {/* Offline banner */}
      {!online && (
        <div className="offline-banner" role="status">
          You&rsquo;re offline. Scanning and publishing need a connection —
          editing and export still work.
        </div>
      )}

      {/* Player */}
      <Player
        items={state.items}
        activeVideoMediaId={activeVideoMediaId}
        pool={pool}
        onTogglePlay={handleTogglePlay}
        videoElsRef={videoElsRef}
        playhead={state.playhead}
        spans={state.spans}
        visualSpans={state.visualSpans}
        primaryMediaId={state.items[0]?.id}
      />

      {/* Timeline */}
      <div style={{ marginTop: 12 }}>
        <EditorErrorBoundary label="Timeline">
          <Timeline
            state={state}
            update={update}
            onSeek={(t) => { seek(t); }}
            onOpenImport={() => importInputRef.current?.click()}
            tickRef={timelineTickRef}
          />
        </EditorErrorBoundary>
      </div>

      {/* Action row */}
      <ActionRow
        scanning={state.scanning}
        scanned={state.scanned}
        scanProgress={state.scanProgress}
        sourceDuration={primaryItem?.duration ?? 0}
        exporting={state.exporting}
        queueLength={state.queue.length}
        onScan={onScan}
        onAddRegion={handleAddRegion}
        onSplitRegion={handleSplitRegion}
        onTrimRegion={handleTrimRegion}
        onNextOrChoose={onNextOrChoose}
        hasSpans={state.spans.length > 0}
        scanTriggerRef={scanTriggerRef}
      />

      {/* Status line — always rendered so aria-live is registered from the start */}
      <p
        aria-live="polite"
        aria-atomic="true"
        style={{
          marginTop: state.statusLine ? 10 : 0,
          fontFamily: 'var(--font-courier),"Courier Prime",monospace',
          fontSize: 12.5,
          color: "var(--muted)",
          minHeight: state.statusLine ? undefined : 0,
        }}
      >
        {state.statusLine}
      </p>

      {/* Error box */}
      {state.errorMessage && (
        <div
          role="alert"
          className="error-box"
        >
          {state.errorMessage}
        </div>
      )}
    </div>
  );
}
