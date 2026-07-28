"use client";

import React, {
  useState,
  useCallback,
  useRef,
  useEffect,
} from "react";

import { ServicesProvider, useServices } from "@/lib/services/provider";
import { ToastStack } from "@/components/primitives/Toast";
import { IntroSplash, introHasPlayed } from "@/components/IntroSplash";
import { LaunchScreen } from "@/components/launch/LaunchScreen";
import { ScanOverlay } from "@/components/scan/ScanOverlay";
import { WorkspacePanel } from "@/components/workspace/WorkspacePanel";
import { FlaggedSectionsPanel } from "@/components/workspace/FlaggedSectionsPanel";
import { ResultPanel } from "@/components/workspace/ResultPanel";
import {
  INITIAL_STATE,
  takeSnapshot,
  pushUndo,
  type WorkspaceState,
} from "@/lib/workspace-state";
import { useGlobalKeyboard } from "@/hooks/useGlobalKeyboard";
import { classifyFile } from "@/hooks/useFileIntake";
import type { FlaggedSpan, TrackSegment, MediaItem } from "@/lib/types";
import { trackEnd, resolveSourceAt } from "@/lib/types";
import { nextId } from "@/lib/mock/scan-service";
import { formatClock } from "@/lib/formatters";
import { mergeRanges } from "@/lib/intervals";
import { clipsEdited } from "@/lib/clips-edited";

/* ─── Extra scan-UI state ────────────────────────────────────────────────── */
interface ScanMeta {
  startMs: number | null;
  failureMessage: string | null;
}

/* ─── Root client component ──────────────────────────────────────────────── */
function WorkspaceInner() {
  const services = useServices();
  const [showIntro, setShowIntro] = useState(!introHasPlayed);
  const [state, setStateRaw] = useState<WorkspaceState>(INITIAL_STATE);
  const [scanMeta, setScanMeta] = useState<ScanMeta>({
    startMs: null,
    failureMessage: null,
  });
  // Incremented each time a new export completes — used to reset share state
  const [exportGeneration, setExportGeneration] = useState(0);

  const stateRef = useRef(state);
  stateRef.current = state;

  const autoScanPending = useRef(false);
  const scanTriggerRef = useRef<HTMLElement | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  /* ─── Stable updater ─────────────────────────────────────────────────── */
  const update = useCallback((patch: Partial<WorkspaceState>) => {
    setStateRaw((prev) => ({ ...prev, ...patch }));
  }, []);

  /* ─── Derived ────────────────────────────────────────────────────────── */
  const inWorkspace = state.items.length > 0;
  const primaryItem = state.items[0] ?? null;

  /* ─── Toasts ─────────────────────────────────────────────────────────── */
  const toastCounter = useRef(0);
  const pushToast = useCallback(
    (message: string, kind: "ok" | "err" | "info" = "ok") => {
      toastCounter.current += 1;
      const id = toastCounter.current;
      setStateRaw((prev) => ({
        ...prev,
        toasts: [...prev.toasts, { id, message, kind }],
      }));
    },
    []
  );

  const dismissToast = useCallback((id: number) => {
    setStateRaw((prev) => ({
      ...prev,
      toasts: prev.toasts.filter((t) => t.id !== id),
    }));
  }, []);

  /* ─── Scan orchestration ─────────────────────────────────────────────── */
  const runScan = useCallback(
    async (
      mode: "replace" | "append",
      itemsOverride?: MediaItem[]
    ) => {
      const items = itemsOverride ?? stateRef.current.items;
      if (items.length === 0) return;
      const openOverlay = mode === "replace";

      setScanMeta({ startMs: Date.now(), failureMessage: null });
      setStateRaw((prev) => ({
        ...prev,
        scanning: true,
        scanned: false,
        scanProgress: 0,
        scanStage: 0,
        scanStatus: "",
        scanOverlayOpen: openOverlay,
        errorMessage: null,
        ...(mode === "replace" && prev.spans.length > 0
          ? pushUndo(prev, takeSnapshot(prev))
          : {}),
        ...(mode === "replace" ? { spans: [] } : {}),
      }));

      try {
        const found = await services.scan.scan(
          { items, mode },
          (progress) => {
            setStateRaw((prev) => ({
              ...prev,
              scanStage: progress.stage,
              scanProgress: Math.round(progress.fraction * 100),
              scanStatus: progress.status,
              spans:
                mode === "replace"
                  ? progress.found
                  : [
                      ...prev.spans.filter(
                        (s) => !progress.found.find((f) => f.id === s.id)
                      ),
                      ...progress.found,
                    ],
            }));
          }
        );

        const n = found.length;
        const statusLine =
          n === 0
            ? "Scan complete — no copyrighted music detected."
            : n === 1
            ? "Scan complete — 1 copyrighted section flagged on the audio track. Hover a red section to see why it was flagged; adjust the regions, then export."
            : `Scan complete — ${n} copyrighted sections flagged on the audio track. Hover a red section to see why it was flagged; adjust the regions, then export.`;

        setStateRaw((prev) => ({
          ...prev,
          scanning: false,
          scanned: true,
          spans: found,
          statusLine,
        }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Scan failed.";
        setScanMeta((prev) => ({ ...prev, failureMessage: msg }));
        setStateRaw((prev) => ({
          ...prev,
          scanning: false,
          errorMessage: msg,
        }));
      }
    },
    [services.scan]
  );

  /* ─── Auto-scan trigger ──────────────────────────────────────────────── */
  useEffect(() => {
    if (!autoScanPending.current) return;
    if (state.items.length === 0) return;
    autoScanPending.current = false;
    runScan("replace");
  }, [state.items, runScan]);

  /* ─── Manual scan ────────────────────────────────────────────────────── */
  const handleScan = useCallback(() => {
    if (state.scanning || state.exporting || !primaryItem) return;
    setScanMeta({ startMs: Date.now(), failureMessage: null });
    runScan("replace");
  }, [state.scanning, state.exporting, primaryItem, runScan]);

  /* ─── Overlay handlers ───────────────────────────────────────────────── */
  const handleOverlayClose = useCallback(() => {
    setStateRaw((prev) => ({ ...prev, scanOverlayOpen: false }));
    requestAnimationFrame(() => scanTriggerRef.current?.focus());
  }, []);

  const handleRetry = useCallback(() => {
    setScanMeta({ startMs: Date.now(), failureMessage: null });
    runScan("replace");
  }, [runScan]);

  const handleContinue = useCallback(() => {
    setStateRaw((prev) => ({
      ...prev,
      scanOverlayOpen: false,
      scanning: false,
    }));
  }, []);

  /* ─── Media ready (launch screen "Start") ────────────────────────────── */
  const handleMediaReady = useCallback(
    (item: MediaItem, autoScan: boolean) => {
      const videoSeg: TrackSegment = {
        id: nextId(),
        mediaId: item.id,
        srcStart: 0,
        srcEnd: item.duration,
        timelineStart: 0,
        enabled: true,
      };
      const audioSeg: TrackSegment = {
        id: nextId(),
        mediaId: item.id,
        srcStart: 0,
        srcEnd: item.duration,
        timelineStart: 0,
        enabled: true,
        gain: 1,
      };
      autoScanPending.current = autoScan;
      setStateRaw({
        ...INITIAL_STATE,
        items: [item],
        videoSegments: [videoSeg],
        audioSegments: [audioSeg],
      });
      services.media.loadWaveform(item).then((waveform) => {
        setStateRaw((prev) => ({
          ...prev,
          items: prev.items.map((it) =>
            it.id === item.id ? { ...it, waveform } : it
          ),
        }));
      });
      services.media.buildThumbnails(item).then((thumbnails) => {
        setStateRaw((prev) => ({
          ...prev,
          items: prev.items.map((it) =>
            it.id === item.id ? { ...it, thumbnails } : it
          ),
        }));
      });
    },
    [services.media]
  );

  /* ─── Import media ───────────────────────────────────────────────────── */
  const handleImportFile = useCallback(
    async (file: File) => {
      if (!primaryItem) return;
      if (state.scanning) {
        pushToast(
          "Wait for the current scan to finish before adding more media.",
          "info"
        );
        return;
      }
      const kind = classifyFile(file);
      if (kind === "other") {
        setStateRaw((prev) => ({
          ...prev,
          errorMessage: "Please choose a video or audio file.",
        }));
        return;
      }

      const url = URL.createObjectURL(file);
      let probeResult: { duration: number; width: number; height: number };
      try {
        probeResult = await services.media.probe(url, kind);
      } catch {
        URL.revokeObjectURL(url);
        setStateRaw((prev) => ({
          ...prev,
          errorMessage: "Could not read the media file.",
        }));
        return;
      }

      const item: MediaItem = {
        id: nextId(),
        file,
        url,
        name: file.name,
        kind,
        duration: probeResult.duration,
        width: probeResult.width,
        height: probeResult.height,
        waveform: null,
        thumbnails: null,
      };

      // Background waveform + thumbnails
      services.media.loadWaveform(item).then((waveform) => {
        setStateRaw((prev) => ({
          ...prev,
          items: prev.items.map((it) =>
            it.id === item.id ? { ...it, waveform } : it
          ),
        }));
      });
      if (kind === "video") {
        services.media.buildThumbnails(item).then((thumbnails) => {
          setStateRaw((prev) => ({
            ...prev,
            items: prev.items.map((it) =>
              it.id === item.id ? { ...it, thumbnails } : it
            ),
          }));
        });
      }

      // Drop position = current timeline end
      const currentEnd = Math.max(
        trackEnd(stateRef.current.videoSegments),
        trackEnd(stateRef.current.audioSegments)
      );

      const audioSeg: TrackSegment = {
        id: nextId(),
        mediaId: item.id,
        srcStart: 0,
        srcEnd: item.duration,
        timelineStart: currentEnd,
        enabled: true,
        gain: 1,
      };

      const videoSegToAdd: TrackSegment | null =
        kind === "video"
          ? {
              id: nextId(),
              mediaId: item.id,
              srcStart: 0,
              srcEnd: item.duration,
              timelineStart: currentEnd,
              enabled: true,
            }
          : null;

      const snap = takeSnapshot(stateRef.current);

      setStateRaw((prev) => ({
        ...prev,
        ...pushUndo(prev, snap),
        items: [...prev.items, item],
        videoSegments: videoSegToAdd
          ? [...prev.videoSegments, videoSegToAdd]
          : prev.videoSegments,
        audioSegments: [...prev.audioSegments, audioSeg],
      }));

      // Append scan (no overlay)
      const newItems = [...stateRef.current.items, item];
      const found = await runScan("append", [item]).then(
        () => {
          // status line written inside runScan — build import-specific one
          const spans = stateRef.current.spans.filter(
            (s) => s.mediaId === item.id
          );
          const n = spans.length;
          const dropPos = formatClock(currentEnd);
          const statusLine =
            n === 0
              ? `Added ${item.name} at ${dropPos} — drag its ${kind === "video" ? "clips" : "clip"} anywhere.`
              : n === 1
              ? `Added ${item.name} at ${dropPos} — 1 copyrighted section flagged on it.`
              : `Added ${item.name} at ${dropPos} — ${n} copyrighted sections flagged on it.`;
          setStateRaw((prev) => ({ ...prev, statusLine }));
        }
      );
    },
    [
      primaryItem,
      state.scanning,
      services.media,
      runScan,
      pushToast,
    ]
  );

  /* ─── Next / Choose another ──────────────────────────────────────────── */
  const handleNextOrChoose = useCallback(() => {
    if (state.scanning || state.exporting) return;
    if (state.queue.length > 0) {
      const [head, ...rest] = state.queue;
      // Reset, pop queue head, load it
      setStateRaw((prev) => ({ ...prev, queue: rest }));
      // Simulate the launch-screen load path
      const url = URL.createObjectURL(head);
      services.media
        .probe(url, classifyFile(head) === "audio" ? "audio" : "video")
        .then(({ duration, width, height }) => {
          const item: MediaItem = {
            id: nextId(),
            file: head,
            url,
            name: head.name,
            kind: "video",
            duration,
            width,
            height,
            waveform: null,
            thumbnails: null,
          };
          handleMediaReady(item, true);
        })
        .catch(() => {
          URL.revokeObjectURL(url);
          setStateRaw((prev) => ({
            ...prev,
            errorMessage: "Could not read the media file.",
          }));
        });
    } else {
      // Full reset → launch screen
      for (const item of state.items) URL.revokeObjectURL(item.url);
      if (state.exportResult) URL.revokeObjectURL(state.exportResult.url);
      setStateRaw(INITIAL_STATE);
    }
  }, [
    state.scanning,
    state.exporting,
    state.queue,
    state.items,
    state.exportResult,
    services.media,
    handleMediaReady,
  ]);

  /* ─── Edit operations (for keyboard handler) ─────────────────────────── */
  const deleteSelected = useCallback(() => {
    setStateRaw((prev) => {
      if (prev.selectedSpanId) {
        const snap = takeSnapshot(prev);
        return {
          ...prev,
          ...pushUndo(prev, snap),
          spans: prev.spans.filter((s) => s.id !== prev.selectedSpanId),
          selectedSpanId: null,
        };
      }
      if (prev.selectedClip) {
        const snap = takeSnapshot(prev);
        const { lane, id } = prev.selectedClip;
        const key = lane === "video" ? "videoSegments" : "audioSegments";
        return {
          ...prev,
          ...pushUndo(prev, snap),
          [key]: (prev[key] as TrackSegment[]).filter((s) => s.id !== id),
          selectedClip: null,
        };
      }
      return prev;
    });
  }, []);

  const splitRegion = useCallback(() => {
    setStateRaw((prev) => {
      const t = prev.playhead;
      const span = prev.spans.find((s) => t > s.start && t < s.end);
      if (!span) return prev;
      const snap = takeSnapshot(prev);
      let c = 0;
      const newId = () => `r${Date.now()}_${++c}`;
      const a: FlaggedSpan = { ...span, id: newId(), end: t };
      const b: FlaggedSpan = { ...span, id: newId(), start: t };
      return {
        ...prev,
        ...pushUndo(prev, snap),
        spans: prev.spans
          .filter((s) => s.id !== span.id)
          .concat(a, b)
          .sort((x, y) => x.start - y.start),
        selectedSpanId: null,
      };
    });
  }, []);

  const cutAtPlayhead = useCallback(() => {
    setStateRaw((prev) => {
      const t = prev.playhead;
      const snap = takeSnapshot(prev);
      let c = 0;
      const newId = () => `r${Date.now()}_cut${++c}`;
      function cutLane(segs: TrackSegment[]): TrackSegment[] {
        return segs.flatMap((seg) => {
          const end = seg.timelineStart + (seg.srcEnd - seg.srcStart);
          if (t <= seg.timelineStart || t >= end) return [seg];
          const srcMid = seg.srcStart + (t - seg.timelineStart);
          return [
            { ...seg, id: newId(), srcEnd: srcMid },
            { ...seg, id: newId(), srcStart: srcMid, timelineStart: t },
          ];
        });
      }
      return {
        ...prev,
        ...pushUndo(prev, snap),
        videoSegments: cutLane(prev.videoSegments),
        audioSegments: cutLane(prev.audioSegments),
      };
    });
  }, []);

  const toggleSelectedRegion = useCallback(() => {
    setStateRaw((prev) => {
      if (!prev.selectedSpanId) return prev;
      const snap = takeSnapshot(prev);
      return {
        ...prev,
        ...pushUndo(prev, snap),
        spans: prev.spans.map((s) =>
          s.id === prev.selectedSpanId ? { ...s, enabled: !s.enabled } : s
        ),
      };
    });
  }, []);

  const seek = useCallback((delta: number) => {
    setStateRaw((prev) => {
      const dur = Math.max(
        trackEnd(prev.videoSegments),
        trackEnd(prev.audioSegments)
      );
      return {
        ...prev,
        playhead: Math.max(0, Math.min(dur, prev.playhead + delta)),
      };
    });
  }, []);

  const togglePlay = useCallback(() => {
    setStateRaw((prev) => ({ ...prev, playing: !prev.playing }));
  }, []);

  const closeMenu = useCallback(() => {}, []);

  /* ─── Global keyboard ────────────────────────────────────────────────── */
  useGlobalKeyboard({
    state,
    update,
    seek,
    togglePlay,
    deleteSelected,
    splitRegion,
    cutAtPlayhead,
    toggleSelectedRegion,
    closeMenu,
    inWorkspace,
  });

  /* ─── Export ─────────────────────────────────────────────────────────── */
  const handleExport = useCallback(async () => {
    const currentState = stateRef.current;
    const primary = currentState.items[0] ?? null;
    if (!primary || primary.duration <= 0) return;

    // Compute active removals from enabled spans
    const activeRemovals = mergeRanges(
      currentState.spans
        .filter((s) => s.enabled)
        .map((s) => ({ start: s.start, end: s.end })),
      primary.duration
    );

    // Detect untouched timeline
    const edited = clipsEdited(
      currentState.items,
      currentState.videoSegments,
      currentState.audioSegments,
      primary.duration
    );

    if (!edited && activeRemovals.length === 0) {
      setStateRaw((prev) => ({
        ...prev,
        errorMessage: "Nothing to change. Flag regions or edit the clips first.",
      }));
      return;
    }

    // Revoke any previous export result URL (the mock shares the source URL,
    // so only revoke if it differs from the primary item URL)
    const prevResult = stateRef.current.exportResult;
    if (prevResult && prevResult.url !== primary.url) {
      URL.revokeObjectURL(prevResult.url);
    }

    setStateRaw((prev) => ({
      ...prev,
      exporting: true,
      errorMessage: null,
      exportResult: null,
    }));

    try {
      const result = await services.export.render(
        {
          strategy: currentState.exportStrategy,
          items: currentState.items,
          videoSegments: currentState.videoSegments,
          audioSegments: currentState.audioSegments,
          removals: activeRemovals,
          primaryId: primary.id,
        },
        (line) => {
          setStateRaw((prev) => ({ ...prev, statusLine: line }));
        }
      );

      setStateRaw((prev) => ({
        ...prev,
        exporting: false,
        exportResult: { url: result.url, filename: result.filename },
        statusLine: "Export finished. Preview below or download.",
      }));
      setExportGeneration((g) => g + 1);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Export failed.";
      setStateRaw((prev) => ({
        ...prev,
        exporting: false,
        exportResult: null,
        errorMessage: msg,
        statusLine: "",
      }));
    }
  }, [services.export]);

  /* ─── Render ─────────────────────────────────────────────────────────── */
  return (
    <>
      {/* 1. Intro splash */}
      {showIntro && <IntroSplash onDone={() => setShowIntro(false)} />}

      {/* 2. Mode content */}
      {inWorkspace ? (
        <div
          style={{ maxWidth: 1060, margin: "0 auto", padding: "28px 20px 80px" }}
        >
          {/* Header */}
          <header className="workspace-header">
            <h1 id="workspace-heading" className="workspace-h1">
              <span style={{ color: "#1F1F1F" }}>Claim</span>
              <span style={{ color: "#C65D3B", fontStyle: "italic" }}>
                Guard
              </span>
            </h1>
          </header>

          {/* Tagline */}
          <p className="workspace-tagline">
            scan · edit · export · everything stays in your browser
          </p>

          {/* Panel 1 — Preview, timeline, actions */}
          <section aria-labelledby="panel1-heading">
            <h2 id="panel1-heading" className="sr-only">Preview and timeline</h2>
            <WorkspacePanel
              state={state}
              update={update}
              onScan={handleScan}
              onImportFile={handleImportFile}
              onNextOrChoose={handleNextOrChoose}
              importInputRef={importInputRef}
              scanTriggerRef={scanTriggerRef}
            />
          </section>

          {/* Hidden import input */}
          <input
            ref={importInputRef}
            type="file"
            accept="video/*,audio/*,.mp4,.mov,.m4v,.webm,.mkv,.avi,.mp3,.wav,.m4a,.aac,.ogg,.flac"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleImportFile(file);
              e.target.value = "";
            }}
          />

          {/* Panel 2 — Flagged sections */}
          <section aria-labelledby="panel2-heading">
            <h2 id="panel2-heading" className="sr-only">Flagged sections and export</h2>
            <FlaggedSectionsPanel
              state={state}
              update={update}
              onExport={handleExport}
            />
          </section>

          {/* Panel 3 — Export result + share */}
          {state.exportResult && (
            <section aria-labelledby="panel3-heading">
              <h2 id="panel3-heading" className="sr-only">Cleaned video and share</h2>
              <ResultPanel
                result={state.exportResult}
                strategy={state.exportStrategy}
                clipsWereEdited={clipsEdited(
                  state.items,
                  state.videoSegments,
                  state.audioSegments,
                  state.items[0]?.duration ?? 0
                )}
                publish={services.publish}
                pushToast={pushToast}
                exportGeneration={exportGeneration}
              />
            </section>
          )}
        </div>
      ) : (
        <LaunchScreen
          queue={state.queue}
          launchStep={state.launchStep}
          onQueueChange={(q) => setStateRaw((p) => ({ ...p, queue: q }))}
          onStepChange={(s) =>
            setStateRaw((p) => ({ ...p, launchStep: s }))
          }
          onMediaReady={handleMediaReady}
          onDropError={(msg) => pushToast(msg, "err")}
        />
      )}

      {/* 3. Scan overlay */}
      {state.scanOverlayOpen && (
        <ScanOverlay
          scanning={state.scanning}
          scanFailed={!!scanMeta.failureMessage}
          failureMessage={scanMeta.failureMessage}
          scanStage={state.scanStage}
          scanFraction={state.scanProgress / 100}
          scanStatus={state.scanStatus}
          scanStartMs={scanMeta.startMs}
          primaryFileName={primaryItem?.name ?? ""}
          onRetry={handleRetry}
          onContinue={handleContinue}
          onClose={handleOverlayClose}
        />
      )}

      {/* 4. Toast stack */}
      <ToastStack toasts={state.toasts} onDismiss={dismissToast} />
    </>
  );
}

/* ─── Root page export ───────────────────────────────────────────────────── */
export default function WorkspacePage() {
  return (
    <ServicesProvider>
      <WorkspaceInner />
    </ServicesProvider>
  );
}
