import type {
  FlaggedSpan,
  FlaggedVisualSpan,
  TrackSegment,
  TrackName,
  ExportStrategy,
  VisualExportStrategy,
  MediaItem,
} from "@/lib/types";
import type { ToastMessage } from "@/components/primitives/Toast";
import type { ScanStageIndex } from "@/lib/mock/scan-service";

/* ─── Undo / redo snapshot ────────────────────────────────────────────────── */
export interface Snapshot {
  spans: FlaggedSpan[];
  visualSpans: FlaggedVisualSpan[];
  videoSegments: TrackSegment[];
  audioSegments: TrackSegment[];
}

/* ─── Full workspace state shape ─────────────────────────────────────────── */
export interface WorkspaceState {
  /* Media */
  items: MediaItem[];
  queue: File[];

  /* Launch */
  launchStep: "drop" | "queue";

  /* Playback */
  playhead: number;
  playing: boolean;
  muted: boolean;
  previewVolume: number;

  /* Editor */
  spans: FlaggedSpan[];
  visualSpans: FlaggedVisualSpan[];
  videoSegments: TrackSegment[];
  audioSegments: TrackSegment[];
  selectedSpanId: string | null;
  selectedClip: { lane: TrackName; id: string } | null;
  activeVideoMediaId: string | null;

  /* Visual scan */
  visualScanning: boolean;
  visualScanProgress: number;
  visualScanStatus: string;
  visualScanned: boolean;

  /* Scan */
  scanning: boolean;
  scanProgress: number;
  scanStage: ScanStageIndex;
  scanned: boolean;
  scanStatus: string;
  scanOverlayOpen: boolean;

  /* Export */
  exportStrategy: ExportStrategy;
  /** How to handle enabled visual flags on export. Never "mute". */
  visualExportStrategy: VisualExportStrategy;
  exporting: boolean;
  exportResult: { url: string; filename: string } | null;

  /* UI */
  statusLine: string;
  errorMessage: string | null;
  toasts: ToastMessage[];

  /* Undo / redo */
  undoStack: Snapshot[];
  redoStack: Snapshot[];
}

export const INITIAL_STATE: WorkspaceState = {
  items: [],
  queue: [],
  launchStep: "drop",
  playhead: 0,
  playing: false,
  muted: false,
  previewVolume: 1,
  spans: [],
  visualSpans: [],
  videoSegments: [],
  audioSegments: [],
  selectedSpanId: null,
  selectedClip: null,
  activeVideoMediaId: null,
  visualScanning: false,
  visualScanProgress: 0,
  visualScanStatus: "",
  visualScanned: false,
  scanning: false,
  scanProgress: 0,
  scanStage: 0,
  scanned: false,
  scanStatus: "",
  scanOverlayOpen: false,
  exportStrategy: "lossless",
  visualExportStrategy: "cut_lossless",
  exporting: false,
  exportResult: null,
  statusLine: "",
  errorMessage: null,
  toasts: [],
  undoStack: [],
  redoStack: [],
};

/* ─── Snapshot helpers ────────────────────────────────────────────────────── */

export function takeSnapshot(s: WorkspaceState): Snapshot {
  return {
    spans: s.spans,
    visualSpans: s.visualSpans,
    videoSegments: s.videoSegments,
    audioSegments: s.audioSegments,
  };
}

const UNDO_CAP = 100;

export function pushUndo(
  s: WorkspaceState,
  snapshot: Snapshot
): Pick<WorkspaceState, "undoStack" | "redoStack"> {
  const next = [...s.undoStack, snapshot];
  if (next.length > UNDO_CAP) next.shift();
  return { undoStack: next, redoStack: [] };
}

export function applyUndo(
  s: WorkspaceState
): Partial<WorkspaceState> | null {
  if (s.undoStack.length === 0) return null;
  const snapshot = s.undoStack[s.undoStack.length - 1];
  const newUndo = s.undoStack.slice(0, -1);
  const currentSnap = takeSnapshot(s);
  return {
    ...snapshot,
    undoStack: newUndo,
    redoStack: [...s.redoStack, currentSnap],
    selectedSpanId: null,
    selectedClip: null,
  };
}

export function applyRedo(
  s: WorkspaceState
): Partial<WorkspaceState> | null {
  if (s.redoStack.length === 0) return null;
  const snapshot = s.redoStack[s.redoStack.length - 1];
  const newRedo = s.redoStack.slice(0, -1);
  const currentSnap = takeSnapshot(s);
  return {
    ...snapshot,
    redoStack: newRedo,
    undoStack: [...s.undoStack, currentSnap],
    selectedSpanId: null,
    selectedClip: null,
  };
}
