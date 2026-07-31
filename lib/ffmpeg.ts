/**
 * Thin ffmpeg.wasm wrapper (single-threaded core — no SharedArrayBuffer needed).
 *
 * Public exports
 *   getFFmpeg()           — lazy singleton
 *   loadInput()           — write a File into the ffmpeg FS
 *   exportCutVideo()      — lossless stream-copy or precise re-encode cut
 *   exportMutedVideo()    — mute flagged ranges, stream-copy video
 *   exportLanes()         — multi-clip / multi-item lane render
 */

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL, fetchFile } from "@ffmpeg/util";
import { complementRanges } from "./intervals";
import type { TimeRange, TrackSegment } from "./types";
import { sortSegments, trackEnd, segmentDuration } from "./types";

const CORE_URL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd";

/* ─── Singleton ─────────────────────────────────────────────────────────── */

let instance: FFmpeg | null = null;

export async function getFFmpeg(): Promise<FFmpeg> {
  if (instance && instance.loaded) return instance;

  const ffmpeg = new FFmpeg();
  await ffmpeg.load({
    coreURL: await toBlobURL(`${CORE_URL}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${CORE_URL}/ffmpeg-core.wasm`, "application/wasm"),
  });
  instance = ffmpeg;
  return ffmpeg;
}

/* ─── Input loader ──────────────────────────────────────────────────────── */

const ALLOWED_EXTS = new Set(["mp4", "mov", "m4v", "webm", "mkv", "avi"]);

export async function loadInput(
  ffmpeg: FFmpeg,
  file: File,
  base = "input"
): Promise<string> {
  const rawExt = file.name.split(".").pop()?.toLowerCase() ?? "";
  const ext = ALLOWED_EXTS.has(rawExt) ? rawExt : "mp4";
  const fsName = `${base}.${ext}`;
  await ffmpeg.writeFile(fsName, await fetchFile(file));
  return fsName;
}

/* ─── Helpers ───────────────────────────────────────────────────────────── */

function mimeForExt(ext: string): string {
  if (ext === "webm") return "video/webm";
  if (ext === "mkv") return "video/x-matroska";
  return "video/mp4";
}

/** Read a file from the ffmpeg FS and return it as a Blob. */
async function readBlob(ffmpeg: FFmpeg, name: string, mime: string): Promise<Blob> {
  const data = await ffmpeg.readFile(name);
  // readFile returns Uint8Array | string; we always write binary, so cast safely.
  // Copy into a fresh Uint8Array<ArrayBuffer> so Blob constructor is happy with
  // strict TS libs that reject Uint8Array<ArrayBufferLike>.
  let src: Uint8Array;
  if (typeof data === "string") {
    src = new TextEncoder().encode(data);
  } else {
    src = data as Uint8Array;
  }
  const safe = new Uint8Array(src.length);
  safe.set(src);
  return new Blob([safe], { type: mime });
}

/** Delete files from the ffmpeg FS, ignoring errors for files that don't exist. */
async function cleanUp(ffmpeg: FFmpeg, ...names: string[]): Promise<void> {
  await Promise.allSettled(names.map((n) => ffmpeg.deleteFile(n)));
}

/** Throw on non-zero exec return code. */
function assertExec(code: number, msg: string): void {
  if (code !== 0) throw new Error(msg);
}

/* ─── exportCutVideo ────────────────────────────────────────────────────── */

export async function exportCutVideo(
  ffmpeg: FFmpeg,
  inputName: string,
  removeRanges: TimeRange[],
  duration: number,
  mode: "lossless" | "precise",
  onStatus: (line: string) => void
): Promise<Blob> {
  const keep = complementRanges(removeRanges, duration);
  if (keep.length === 0) {
    throw new Error("Nothing left to keep: the flagged regions cover the whole video.");
  }

  const ext = inputName.split(".").pop()! as string;
  const outExt = mode === "lossless" ? ext : "mp4";
  const segNames: string[] = [];

  for (let i = 0; i < keep.length; i++) {
    onStatus(`Cutting segment ${i + 1}/${keep.length}…`);
    const { start, end } = keep[i];
    const len = end - start;
    const segName = `seg${i}.${outExt}`;
    segNames.push(segName);

    let args: string[];
    if (mode === "lossless") {
      args = [
        "-y", "-ss", start.toFixed(6), "-i", inputName,
        "-t", len.toFixed(6),
        "-c", "copy",
        "-avoid_negative_ts", "make_zero",
        segName,
      ];
    } else {
      args = [
        "-y", "-ss", start.toFixed(6), "-i", inputName,
        "-t", len.toFixed(6),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k",
        segName,
      ];
    }

    const ret = await ffmpeg.exec(args);
    assertExec(ret, `ffmpeg failed while cutting segment ${i + 1}`);
  }

  onStatus("Joining segments…");

  let outputName: string;
  if (segNames.length === 1) {
    outputName = segNames[0];
  } else {
    // Write concat list
    const listLines = segNames.map((n) => `file '${n}'`).join("\n");
    await ffmpeg.writeFile("list.txt", listLines);
    outputName = `output.${outExt}`;
    const ret = await ffmpeg.exec([
      "-y", "-f", "concat", "-safe", "0", "-i", "list.txt",
      "-c", "copy",
      outputName,
    ]);
    assertExec(ret, "ffmpeg failed while joining segments");
  }

  const mime = mimeForExt(outExt);
  const blob = await readBlob(ffmpeg, outputName, mime);

  await cleanUp(ffmpeg, ...segNames, "list.txt", outputName !== segNames[0] ? outputName : "");
  return blob;
}

/* ─── exportMutedVideo ──────────────────────────────────────────────────── */

export async function exportMutedVideo(
  ffmpeg: FFmpeg,
  inputName: string,
  removeRanges: TimeRange[],
  onStatus: (line: string) => void
): Promise<Blob> {
  if (removeRanges.length === 0) {
    throw new Error("No flagged regions to mute.");
  }

  onStatus("Muting flagged regions…");

  // Build volume enable expression: between(t,a1,b1)+between(t,a2,b2)+…
  const enableExpr = removeRanges
    .map((r) => `between(t,${r.start.toFixed(3)},${r.end.toFixed(3)})`)
    .join("+");

  const outputName = "output-muted.mp4";
  const ret = await ffmpeg.exec([
    "-y", "-i", inputName,
    "-c:v", "copy",
    "-af", `volume=enable='${enableExpr}':volume=0`,
    "-c:a", "aac", "-b:a", "160k",
    outputName,
  ]);
  assertExec(ret, "ffmpeg failed while muting flagged regions");

  const blob = await readBlob(ffmpeg, outputName, "video/mp4");
  await cleanUp(ffmpeg, outputName);
  return blob;
}

/* ─── exportLanes ───────────────────────────────────────────────────────── */

export interface LanePiece {
  start: number;       // source start (seconds into inputName)
  end: number;         // source end
  enabled: boolean;
  inputName?: string;
  mutes: TimeRange[];  // piece-local mute ranges
  volume?: number;
}

interface Dims { width: number; height: number; }

export async function exportLanes(
  ffmpeg: FFmpeg,
  videoPieces: LanePiece[],
  audioPieces: LanePiece[],
  dims: Dims,
  onStatus: (line: string) => void
): Promise<Blob> {
  // Round dims down to even numbers, minimum 2
  const w = Math.max(2, dims.width % 2 === 0 ? dims.width : dims.width - 1);
  const h = Math.max(2, dims.height % 2 === 0 ? dims.height : dims.height - 1);

  const totalV = videoPieces.reduce((s, p) => s + (p.end - p.start), 0);
  const totalA = audioPieces.reduce((s, p) => s + (p.end - p.start), 0);
  const total = Math.max(totalV, totalA);
  if (total <= 0.05) {
    throw new Error("Nothing to export: the whole timeline was removed.");
  }

  const vPartNames: string[] = [];
  const aPartNames: string[] = [];

  // ── Video pieces ──────────────────────────────────────────────────────────
  for (let i = 0; i < videoPieces.length; i++) {
    onStatus(`Rendering video part ${i + 1}/${videoPieces.length}…`);
    const p = videoPieces[i];
    const len = p.end - p.start;
    const partName = `vpart${i}.mp4`;
    vPartNames.push(partName);

    let args: string[];
    if (p.enabled && p.inputName) {
      args = [
        "-y", "-ss", p.start.toFixed(6), "-i", p.inputName,
        "-t", len.toFixed(6),
        "-an",
        "-vf", `scale=${w}:${h}`, "-r", "30",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
        partName,
      ];
    } else {
      args = [
        "-y",
        "-f", "lavfi", "-i", `color=c=black:s=${w}x${h}:r=30`,
        "-t", len.toFixed(6),
        "-an",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
        partName,
      ];
    }

    const ret = await ffmpeg.exec(args);
    assertExec(ret, `ffmpeg failed while rendering video part ${i + 1}`);
  }

  // ── Audio pieces ──────────────────────────────────────────────────────────
  for (let i = 0; i < audioPieces.length; i++) {
    onStatus(`Rendering audio part ${i + 1}/${audioPieces.length}…`);
    const p = audioPieces[i];
    const len = p.end - p.start;
    const partName = `apart${i}.mp4`;
    aPartNames.push(partName);

    // Build audio filter chain
    const filters: string[] = [];
    if (p.mutes.length > 0) {
      const muteExpr = p.mutes
        .map((r) => `between(t,${r.start.toFixed(3)},${r.end.toFixed(3)})`)
        .join("+");
      filters.push(`volume=enable='${muteExpr}':volume=0`);
    }
    if (p.volume !== undefined && Math.abs(p.volume - 1) > 0.001) {
      filters.push(`volume=${p.volume}`);
    }

    let args: string[];
    if (p.enabled && p.inputName) {
      args = [
        "-y", "-ss", p.start.toFixed(6), "-i", p.inputName,
        "-t", len.toFixed(6),
        "-vn",
        ...(filters.length > 0 ? ["-af", filters.join(",")] : []),
        "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-ac", "2",
        partName,
      ];
    } else {
      args = [
        "-y",
        "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
        "-t", len.toFixed(6),
        "-vn",
        "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-ac", "2",
        partName,
      ];
    }

    const ret = await ffmpeg.exec(args);
    assertExec(ret, `ffmpeg failed while rendering audio part ${i + 1}`);
  }

  // ── Concat each lane ──────────────────────────────────────────────────────
  onStatus("Joining tracks…");

  const concatAndCheck = async (parts: string[], out: string) => {
    if (parts.length === 1) {
      // rename by reading+writing rather than rename (not available in all builds)
      const data = await ffmpeg.readFile(parts[0]);
      await ffmpeg.writeFile(out, data);
    } else {
      const listContent = parts.map((n) => `file '${n}'`).join("\n");
      await ffmpeg.writeFile(`list_${out}.txt`, listContent);
      const ret = await ffmpeg.exec([
        "-y", "-f", "concat", "-safe", "0", "-i", `list_${out}.txt`,
        "-c", "copy",
        out,
      ]);
      assertExec(ret, `ffmpeg failed while joining ${out}`);
      await cleanUp(ffmpeg, `list_${out}.txt`);
    }
  };

  await concatAndCheck(vPartNames, "track_v.mp4");
  await concatAndCheck(aPartNames, "track_a.mp4");

  // ── Mux video + audio ─────────────────────────────────────────────────────
  onStatus("Combining video and audio…");
  const editedName = "edited.mp4";
  const ret = await ffmpeg.exec([
    "-y",
    "-i", "track_v.mp4",
    "-i", "track_a.mp4",
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c", "copy",
    editedName,
  ]);
  assertExec(ret, "ffmpeg failed while combining video and audio");

  const blob = await readBlob(ffmpeg, editedName, "video/mp4");

  // Clean up all temp files
  await cleanUp(ffmpeg, ...vPartNames, ...aPartNames, "track_v.mp4", "track_a.mp4", editedName);
  return blob;
}
