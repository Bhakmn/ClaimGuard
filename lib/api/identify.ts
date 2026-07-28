import { apiFetch } from "./client";

/**
 * The shape of a match as returned by POST /api/identify.
 * Null means no music was detected in this sample.
 */
export type IdentifyMatch = {
  acrid: string;
  title: string;
  artists: string;
  album: string;
  score: number;
  sampleBeginMs?: number;
  sampleEndMs?: number;
  playOffsetMs?: number;
} | null;

/**
 * Ask the server what music is in one audio sample.
 * Null means nothing matched — not an error.
 *
 * The sample must be appended as a file part named "sample" with file name
 * "sample.wav" so the backend's multipart parser finds it on the right field.
 *
 * Do NOT set Content-Type — the browser sets the multipart boundary itself,
 * and an explicit header breaks the upload.
 */
export async function identifySample(sample: Blob): Promise<IdentifyMatch> {
  const form = new FormData();
  form.append("sample", sample, "sample.wav");
  const data = await apiFetch<{ match?: IdentifyMatch }>("/api/identify", {
    method: "POST",
    body: form,
  });
  return data.match ?? null;
}
