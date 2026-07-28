/**
 * Real PublishService implementation.
 *
 * TikTok: OAuth popup → upload to TikTok inbox.
 * YouTube: handled directly in the browser by the SharePanel (Google Identity
 *          Services + resumable upload to googleapis.com) — not routed here.
 * Instagram: download + open tab — not routed here.
 *
 * isConfigured() for TikTok is resolved from the status endpoint — the backend
 * knows whether TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET are set.
 */

import type { PublishService, PublishTarget } from "@/lib/mock/publish-service";
import {
  getTikTokStatus,
  uploadToTikTok,
  tiktokAuthUrl,
} from "@/lib/api/tiktok";
import { ApiError } from "@/lib/api/client";

/* ─── Cached configuration ───────────────────────────────────────────────── */

// We probe once and cache — configuration doesn't change at runtime.
let _tiktokConfigured: boolean | null = null;

async function isTikTokConfigured(): Promise<boolean> {
  if (_tiktokConfigured !== null) return _tiktokConfigured;
  try {
    const s = await getTikTokStatus();
    _tiktokConfigured = s.configured;
    return s.configured;
  } catch {
    _tiktokConfigured = false;
    return false;
  }
}

/* ─── Popup-based OAuth flow ─────────────────────────────────────────────── */

/**
 * Open the TikTok OAuth popup and wait for the postMessage handshake.
 *
 * The backend's success page posts `{ type: "tiktok-connected" }` to
 * APP_BASE_URL with Cross-Origin-Opener-Policy: unsafe-none.
 * The listener rejects any message from a different origin, so same-origin
 * deployment is required.
 */
async function connectViaPopup(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const popup = window.open(
      tiktokAuthUrl(),
      "tiktok-connect",
      "width=520,height=720,menubar=no,toolbar=no",
    );

    if (!popup) {
      reject(new Error("Popup blocked. Allow popups for this site to connect TikTok."));
      return;
    }

    // Poll for popup closure (user closed without completing)
    const closedTimer = setInterval(() => {
      if ((popup as Window).closed) {
        clearInterval(closedTimer);
        window.removeEventListener("message", onMessage);
        reject(new Error("The TikTok connection window was closed. Try connecting again."));
      }
    }, 500);

    function onMessage(evt: MessageEvent) {
      // Discard messages from other origins
      if (evt.origin !== window.location.origin) return;

      // Backend success page sends { type: "tiktok-connected" }
      if (
        evt.data != null &&
        typeof evt.data === "object" &&
        (evt.data as { type?: string }).type === "tiktok-connected"
      ) {
        clearInterval(closedTimer);
        window.removeEventListener("message", onMessage);
        (popup as Window).close();
        resolve();
      }
    }

    window.addEventListener("message", onMessage);
  });
}

/* ─── PublishService ─────────────────────────────────────────────────────── */

export const realPublishService: PublishService = {
  isConfigured(target: PublishTarget): boolean {
    if (target === "tiktok") {
      // Synchronous — return cached value; starts as true until proven otherwise
      return _tiktokConfigured !== false;
    }
    // YouTube and Instagram are always "configured" from the frontend's perspective
    return true;
  },

  async getConnection(target: PublishTarget): Promise<{ connected: boolean }> {
    if (target !== "tiktok") {
      return { connected: false };
    }
    try {
      const s = await getTikTokStatus();
      _tiktokConfigured = s.configured;
      return { connected: s.connected };
    } catch {
      return { connected: false };
    }
  },

  async connect(target: PublishTarget): Promise<void> {
    if (target !== "tiktok") return;
    await connectViaPopup();
  },

  async publish(input: {
    target: PublishTarget;
    url: string;
    filename: string;
    title: string;
  }): Promise<{ link?: string }> {
    if (input.target !== "tiktok") {
      // YouTube and Instagram are handled by the SharePanel directly.
      return {};
    }

    // Fetch the blob from the object URL
    let blob: Blob;
    try {
      const resp = await fetch(input.url);
      blob = await resp.blob();
      // Force video/mp4 when the blob reports an empty type
      if (!blob.type || blob.type === "application/octet-stream") {
        blob = blob.slice(0, blob.size, "video/mp4");
      }
    } catch {
      throw new Error("Could not read the video file. Try exporting again.");
    }

    try {
      await uploadToTikTok(blob, input.filename, input.title);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        throw new Error("Your session expired. Connect again.");
      }
      throw err;
    }

    return {};
  },
};
