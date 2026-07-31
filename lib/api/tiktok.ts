import { apiFetch } from "./client";
import { apiUrl } from "./config";

/* ─── Response types ────────────────────────────────────────────────────── */

export type TikTokStatus = {
  connected: boolean;
  configured: boolean;
  publish?: {
    status?:
      | "PROCESSING_UPLOAD"
      | "SEND_TO_USER_INBOX"
      | "PUBLISH_COMPLETE"
      | "FAILED";
    failReason?: string;
    progress: number;       // integer 0–100
    bytesSent: number;
    bytesTotal: number;
    jobStatus:
      | "initializing"
      | "uploading"
      | "uploaded"
      | "processing"
      | "complete"
      | "failed";
    updatedAt: string;      // ISO 8601 UTC
  };
};

export type TikTokUploadResult = {
  publishId: string;
  jobId: string;
  status: string;
  bytesSent: number;
  bytesTotal: number;
};

/* ─── API calls ─────────────────────────────────────────────────────────── */

/** Fetch connection state, and optionally the publish progress for a job. */
export function getTikTokStatus(publishId?: string): Promise<TikTokStatus> {
  const query = publishId
    ? `?publishId=${encodeURIComponent(publishId)}`
    : "";
  return apiFetch<TikTokStatus>(`/api/tiktok/status${query}`);
}

/**
 * Upload the exported video to the creator's TikTok inbox.
 * Responds after every chunk is acknowledged — the button stays "Sending…" for
 * exactly as long as this promise is pending.
 */
export function uploadToTikTok(
  video: Blob,
  fileName: string,
  title: string,
): Promise<TikTokUploadResult> {
  const form = new FormData();
  form.append("video", video, fileName);
  form.append("title", title);
  return apiFetch<TikTokUploadResult>("/api/tiktok/upload", {
    method: "POST",
    body: form,
  });
}

/** Revoke the TikTok connection for the current session. */
export function disconnectTikTok(): Promise<{ disconnected: boolean }> {
  return apiFetch<{ disconnected: boolean }>("/api/tiktok/connection", {
    method: "DELETE",
  });
}

/**
 * The OAuth popup URL.
 * Returned as a string so the caller opens the window and keeps the handle.
 */
export const tiktokAuthUrl = (): string => apiUrl("/api/tiktok/auth");
