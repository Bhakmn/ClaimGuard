import type { TrackSegment, ExportStrategy, MediaItem, TimeRange, FlaggedVisualSpan } from "../types";
import { complementRanges } from "../intervals";
import { trackEnd, segmentDuration } from "../types";
import { delay, getControls } from "./delay";

export interface ExportRequest {
  strategy: ExportStrategy;
  items: MediaItem[];
  videoSegments: TrackSegment[];
  audioSegments: TrackSegment[];
  removals: TimeRange[];
  /** Visual flagged spans — used when strategy includes video-region handling. */
  visualRemovals?: TimeRange[];
  primaryId: string;
}

export interface ExportResult {
  url: string;
  filename: string;
  mimeType: string;
}

export interface ExportService {
  render(
    request: ExportRequest,
    onStatus: (line: string) => void
  ): Promise<ExportResult>;
}

function isSimplePath(req: ExportRequest): boolean {
  const { videoSegments: vs, audioSegments: as_ } = req;
  if (vs.length !== 1 || as_.length !== 1) return false;
  const v = vs[0];
  const a = as_[0];
  const pri = req.items.find((i) => i.id === req.primaryId);
  if (!pri) return false;
  const dur = pri.duration;
  return (
    v.enabled &&
    a.enabled &&
    v.timelineStart === 0 &&
    a.timelineStart === 0 &&
    Math.abs(segmentDuration(v) - dur) < 0.05 &&
    Math.abs(segmentDuration(a) - dur) < 0.05 &&
    (a.gain === undefined || Math.abs((a.gain ?? 1) - 1) < 0.01)
  );
}

export const mockExportService: ExportService = {
  async render(request, onStatus) {
    const controls = getControls();

    const primaryItem = request.items.find((i) => i.id === request.primaryId);
    if (!primaryItem) {
      throw new Error("Nothing to export: the whole timeline was removed.");
    }

    const timelineDuration = Math.max(
      trackEnd(request.videoSegments),
      trackEnd(request.audioSegments)
    );

    if (timelineDuration <= 0) {
      throw new Error("Nothing to export: the whole timeline was removed.");
    }

    const surviving = complementRanges(request.removals, timelineDuration);

    if (surviving.length === 0) {
      throw new Error(
        "Nothing left over: the flagged regions cover the whole timeline."
      );
    }

    const simple = isSimplePath(request);
    let lineIdx = 0;

    const emit = async (line: string) => {
      lineIdx++;
      onStatus(line);

      // export-error at third status line
      if (controls.exportFails && lineIdx >= 3) {
        await delay(700);
        throw new Error(
          "Rendering failed partway through. Try the precise strategy, or export a shorter range."
        );
      }

      await delay(700);
    };

    if (simple) {
      if (request.strategy === "mute") {
        await emit("Muting flagged regions…");
        await emit("Export finished. Preview below or download.");
      } else {
        const n = surviving.length;
        for (let i = 0; i < n; i++) {
          await emit(`Cutting segment ${i + 1}/${n}…`);
        }
        await emit("Joining segments…");
        await emit("Export finished. Preview below or download.");
      }
    } else {
      // multi-segment path
      let effectiveStrategy = request.strategy;
      if (effectiveStrategy === "lossless") {
        await emit(
          "Clip edits need re-encoding; exporting in precise mode…"
        );
        effectiveStrategy = "precise";
      }

      await emit("Preparing media files…");

      // Piece counts: split each lane across surviving intervals
      const videoPieces = surviving.length * request.videoSegments.length;
      const audioPieces = surviving.length * request.audioSegments.length;

      for (let i = 0; i < videoPieces; i++) {
        await emit(`Rendering video part ${i + 1}/${videoPieces}…`);
      }
      for (let i = 0; i < audioPieces; i++) {
        await emit(`Rendering audio part ${i + 1}/${audioPieces}…`);
      }

      await emit("Joining tracks…");
      await emit("Combining video and audio…");
      await emit("Export finished. Preview below or download.");
    }

    // Build filename: strip extension, append -clean.mp4
    const base = primaryItem.name.replace(/\.[^.]+$/, "");
    const filename = `${base}-clean.mp4`;

    return {
      url: primaryItem.url,
      filename,
      mimeType: "video/mp4",
    };
  },
};
