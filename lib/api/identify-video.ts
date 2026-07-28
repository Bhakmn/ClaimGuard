import { apiFetch } from "./client";

/**
 * The shape of a visual match as returned by POST /api/identify-video.
 * Null means no copyright signal was detected in this frame.
 */
export type VisualMatch = {
  label: string;
  signals: string[];
  reasoning: string;
  confidence: number;
  source: "heuristic" | "granite_vision";
} | null;

/**
 * Ask the server whether a video frame contains third-party footage signals.
 * Null return means nothing matched — not an error.
 *
 * The frame must be appended as a file part named "frame".
 * Optional width/height integer fields help the heuristic analyser.
 *
 * Do NOT set Content-Type — the browser sets the multipart boundary itself.
 */
export async function identifyFrame(
  frame: Blob,
  width?: number,
  height?: number,
  signal?: AbortSignal
): Promise<VisualMatch> {
  const form = new FormData();
  form.append("frame", frame, "frame.jpg");
  if (width !== undefined) form.append("width", String(Math.round(width)));
  if (height !== undefined) form.append("height", String(Math.round(height)));

  const data = await apiFetch<{ match?: VisualMatch }>("/api/identify-video", {
    method: "POST",
    body: form,
    signal,
  });
  return data.match ?? null;
}
