/**
 * Real ExportService — runs entirely in the browser via ffmpeg.wasm.
 *
 * No backend involvement. Compatible with both the mock and real service
 * branches because export does not depend on any server endpoint.
 *
 * Visual removals are applied based on `visualStrategy`:
 *  - "cut_lossless" / "cut_precise": merged into the combined removal list,
 *    which removes both video and audio for those ranges.
 *  - "warn_only": logged but footage is left intact.
 */

import type { TrackSegment, MediaItem, TimeRange } from "@/lib/types";
import {
  sortSegments,
  trackEnd,
  segmentDuration,
  segmentEnd,
} from "@/lib/types";
import { complementRanges, mergeRanges } from "@/lib/intervals";
import {
  getFFmpeg,
  loadInput,
  exportCutVideo,
  exportMutedVideo,
  exportLanes,
  type LanePiece,
} from "@/lib/ffmpeg";
import type { ExportService, ExportRequest, ExportResult } from "@/lib/mock/export-service";

/* ─── Re-export the interface so callers can import from here ────────────── */
export type { ExportService, ExportRequest, ExportResult };

/* ─── isSimplePath — identical logic to mock ────────────────────────────── */

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

/* ─── FS name cache — avoid re-uploading the same file ──────────────────── */

const fsNameCache = new Map<string, string>();

async function ensureLoaded(
  ffmpeg: Awaited<ReturnType<typeof getFFmpeg>>,
  item: MediaItem
): Promise<string> {
  const cached = fsNameCache.get(item.id);
  if (cached) return cached;
  const name = await loadInput(ffmpeg, item.file, `item_${item.id}`);
  fsNameCache.set(item.id, name);
  return name;
}

/* ─── Lane builder helpers ───────────────────────────────────────────────── */

/**
 * Build LanePiece[] for one lane by intersecting `keepIntervals` (timeline
 * time) with `segments` (also timeline time).
 *
 * For each kept interval, walk the sorted segments to find overlaps and emit
 * disabled (black/silence) pieces for any gap, then a piece for the overlap.
 * `mutes` on each piece are piece-LOCAL times (relative to piece.start=0
 * because -ss resets the clock inside ffmpeg).
 */
function buildLanePieces(
  keepIntervals: TimeRange[],
  segments: TrackSegment[],
  muteRangesTimeline: TimeRange[],  // timeline-time mutes (only for "mute" strategy)
  itemForSeg: (seg: TrackSegment) => MediaItem | undefined,
  fsName: (item: MediaItem) => string
): LanePiece[] {
  const sorted = sortSegments(segments);
  const pieces: LanePiece[] = [];

  for (const interval of keepIntervals) {
    let cursor = interval.start;

    for (const seg of sorted) {
      const segTlEnd = segmentEnd(seg);

      // Segment ends before our interval starts → skip
      if (segTlEnd <= interval.start) continue;
      // Segment starts after our interval ends → stop
      if (seg.timelineStart >= interval.end) break;

      // Gap before this segment within the interval → silent/black piece
      const overlapStart = Math.max(cursor, interval.start);
      if (seg.timelineStart > overlapStart) {
        const gapLen = Math.min(seg.timelineStart, interval.end) - overlapStart;
        if (gapLen > 0.01) {
          pieces.push({
            start: 0, end: gapLen, enabled: false,
            inputName: undefined, mutes: [], volume: undefined,
          });
        }
        cursor = seg.timelineStart;
      }

      // Overlap between segment and keep interval
      const clipTlStart = Math.max(cursor, seg.timelineStart, interval.start);
      const clipTlEnd = Math.min(segTlEnd, interval.end);
      if (clipTlEnd <= clipTlStart) continue;

      const srcOffset = clipTlStart - seg.timelineStart;
      const srcStart = seg.srcStart + srcOffset;
      const srcEnd = srcStart + (clipTlEnd - clipTlStart);

      // Build piece-local mute ranges (offset by srcStart so t=0 at piece start)
      const pieceMutes: TimeRange[] = [];
      for (const mr of muteRangesTimeline) {
        const mOverlapStart = Math.max(mr.start, clipTlStart);
        const mOverlapEnd = Math.min(mr.end, clipTlEnd);
        if (mOverlapEnd > mOverlapStart) {
          // Convert from timeline time to piece-local time
          pieceMutes.push({
            start: mOverlapStart - clipTlStart,
            end: mOverlapEnd - clipTlStart,
          });
        }
      }

      const item = itemForSeg(seg);
      pieces.push({
        start: srcStart,
        end: srcEnd,
        enabled: seg.enabled,
        inputName: item ? fsName(item) : undefined,
        mutes: pieceMutes,
        volume: seg.gain,
      });

      cursor = clipTlEnd;
    }

    // Trailing gap after all segments but still inside the interval
    if (cursor < interval.end) {
      const gapLen = interval.end - cursor;
      if (gapLen > 0.01) {
        pieces.push({
          start: 0, end: gapLen, enabled: false,
          inputName: undefined, mutes: [], volume: undefined,
        });
      }
    }
  }

  return pieces;
}

/* ─── Ext/mime helpers ───────────────────────────────────────────────────── */

function extFromMime(mime: string): string {
  if (mime === "video/webm") return "webm";
  if (mime === "video/x-matroska") return "mkv";
  return "mp4";
}

/* ─── Real implementation ────────────────────────────────────────────────── */

export const realExportService: ExportService = {
  async render(request: ExportRequest, onStatus: (line: string) => void): Promise<ExportResult> {
    const primaryItem = request.items.find((i) => i.id === request.primaryId);
    if (!primaryItem) {
      throw new Error("Nothing to export: the whole timeline was removed.");
    }

    // ── Merge visual removals into combined removal list ────────────────
    const visualStrategy = request.visualStrategy ?? "cut_lossless";
    const effectiveRemovals: TimeRange[] = [...request.removals];
    if (visualStrategy !== "warn_only" && request.visualRemovals?.length) {
      effectiveRemovals.push(...request.visualRemovals);
      onStatus(`Applying ${request.visualRemovals.length} visual flag(s) as cuts…`);
    } else if (visualStrategy === "warn_only" && request.visualRemovals?.length) {
      onStatus(
        `Warning: ${request.visualRemovals.length} visual flag(s) were left intact ` +
        `(visual strategy = warn only).`
      );
    }
    // Merge and de-duplicate the combined removals
    const mergedRemovals = mergeRanges(effectiveRemovals, primaryItem.duration);

    onStatus("Loading the export engine…");
    const ffmpeg = await getFFmpeg();

    const simple = isSimplePath(request);

    if (simple) {
      // ── Simple path: single clip, no edits ─────────────────────────────
      const inputName = await ensureLoaded(ffmpeg, primaryItem);

      let blob: Blob;
      if (request.strategy === "mute") {
        blob = await exportMutedVideo(ffmpeg, inputName, mergedRemovals, onStatus);
      } else {
        blob = await exportCutVideo(
          ffmpeg, inputName, mergedRemovals,
          primaryItem.duration, request.strategy, onStatus
        );
      }

      const ext = extFromMime(blob.type);
      const base = primaryItem.name.replace(/\.[^.]+$/, "");
      const filename = `${base}-clean.${ext}`;
      return { url: URL.createObjectURL(blob), filename, mimeType: blob.type };
    }

    // ── Complex path: timeline was edited ────────────────────────────────
    let effectiveStrategy = request.strategy;
    if (effectiveStrategy === "lossless") {
      onStatus("Clip edits need re-encoding; exporting in precise mode…");
      effectiveStrategy = "precise";
    }

    onStatus("Preparing media files…");

    // Load every referenced item into the ffmpeg FS
    const allSegments = [...request.videoSegments, ...request.audioSegments];
    const referencedIds = new Set(allSegments.map((s) => s.mediaId));
    const itemMap = new Map<string, MediaItem>();
    const fsNames = new Map<string, string>();

    for (const item of request.items) {
      if (referencedIds.has(item.id)) {
        const name = await ensureLoaded(ffmpeg, item);
        itemMap.set(item.id, item);
        fsNames.set(item.id, name);
      }
    }

    const itemForSeg = (seg: TrackSegment) => itemMap.get(seg.mediaId);
    const fsNameForItem = (item: MediaItem) => fsNames.get(item.id) ?? "";

    const totalV = trackEnd(request.videoSegments);
    const totalA = trackEnd(request.audioSegments);
    const total = Math.max(totalV, totalA);

    // Determine keep intervals and per-lane mute ranges
    let keepIntervals: TimeRange[];
    let muteRangesForAudio: TimeRange[];

    if (effectiveStrategy === "mute") {
      // Keep everything; apply audio removals as mutes on the audio lane.
      // Visual removals still cut (they are on-screen, muting doesn't help).
      const audioMutes = request.removals;
      keepIntervals = mergedRemovals.length > 0
        ? complementRanges(
            // Cut only the visual removals if present
            (visualStrategy !== "warn_only" && request.visualRemovals?.length)
              ? request.visualRemovals
              : [],
            total
          )
        : [{ start: 0, end: total }];
      muteRangesForAudio = audioMutes;
    } else {
      // Cut strategy: remove all flagged intervals from both lanes
      keepIntervals = complementRanges(mergedRemovals, total);
      if (keepIntervals.length === 0) {
        throw new Error("Nothing left to keep: the flagged regions cover the whole video.");
      }
      muteRangesForAudio = [];
    }

    const videoPieces = buildLanePieces(
      keepIntervals,
      request.videoSegments,
      [],                 // video lane never gets audio mutes
      itemForSeg,
      fsNameForItem
    );

    const audioPieces = buildLanePieces(
      keepIntervals,
      request.audioSegments,
      muteRangesForAudio,
      itemForSeg,
      fsNameForItem
    );

    const dims = {
      width: primaryItem.width || 1280,
      height: primaryItem.height || 720,
    };

    const blob = await exportLanes(ffmpeg, videoPieces, audioPieces, dims, onStatus);

    const ext = extFromMime(blob.type);
    const base = primaryItem.name.replace(/\.[^.]+$/, "");
    const filename = `${base}-clean.${ext}`;
    return { url: URL.createObjectURL(blob), filename, mimeType: blob.type };
  },
};
