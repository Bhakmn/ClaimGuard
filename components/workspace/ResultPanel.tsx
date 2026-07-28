"use client";

import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
} from "react";
import type { PublishService } from "@/lib/mock/publish-service";
import type { ExportStrategy } from "@/lib/types";
import { ApiError } from "@/lib/api/client";

/* ─── Types ──────────────────────────────────────────────────────────────── */

/** Only the fields ResultPanel and SharePanel actually need. */
export interface ExportResultSlice {
  url: string;
  filename: string;
}

interface ShareState {
  title: string;
  ytBusy: boolean;
  ytLink: string | null;
  ttConnected: boolean;
  ttConfigured: boolean;
  ttConnecting: boolean; // handshake window open
  ttBusy: boolean;
  ttSent: boolean;
}

export interface ResultPanelProps {
  result: ExportResultSlice;
  strategy: ExportStrategy;
  clipsWereEdited: boolean;
  publish: PublishService;
  pushToast: (message: string, kind: "ok" | "err" | "info") => void;
  /** Incremented every time a new export finishes — used to reset share state */
  exportGeneration: number;
}

/* ─── Helpers ────────────────────────────────────────────────────────────── */

function stripExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

/* ─── Share sub-panel ────────────────────────────────────────────────────── */

function SharePanel({
  result,
  publish,
  pushToast,
  exportGeneration,
}: {
  result: ExportResultSlice;
  publish: PublishService;
  pushToast: (message: string, kind: "ok" | "err" | "info") => void;
  exportGeneration: number;
}) {
  const defaultTitle = stripExtension(result.filename);

  const [share, setShare] = useState<ShareState>({
    title: defaultTitle,
    ytBusy: false,
    ytLink: null,
    ttConnected: false,
    ttConfigured: true,
    ttConnecting: false,
    ttBusy: false,
    ttSent: false,
  });

  // Reset share state on every new export generation (new result)
  const prevGen = useRef(exportGeneration);
  useEffect(() => {
    if (exportGeneration !== prevGen.current) {
      prevGen.current = exportGeneration;
      setShare((prev) => ({
        title: defaultTitle,
        ytBusy: false,
        ytLink: null,
        ttConnected: false,
        ttConfigured: prev.ttConfigured, // preserve configured state
        ttConnecting: false,
        ttBusy: false,
        ttSent: false,
      }));
    }
  }, [exportGeneration, defaultTitle]);

  // Check TikTok connection on mount (once per panel mount / result change)
  useEffect(() => {
    let cancelled = false;
    publish.getConnection("tiktok").then(({ connected }) => {
      if (!cancelled) {
        // isConfigured() is synchronous — read it alongside the connection probe
        const configured = publish.isConfigured("tiktok");
        setShare((prev) => ({ ...prev, ttConnected: connected, ttConfigured: configured }));
      }
    }).catch(() => {
      // Swallow — leave defaults (connected: false, configured: true)
    });
    return () => {
      cancelled = true;
    };
  }, [publish, exportGeneration]);

  // ── TikTok popup window ref ────────────────────────────────────────────
  const ttWindowRef = useRef<Window | null>(null);

  useEffect(() => {
    function onMessage(evt: MessageEvent) {
      // Accept only same-origin messages
      if (evt.origin !== window.location.origin) return;
      // Backend success page sends { type: "tiktok-connected" }
      // (legacy mock sent the bare string "tiktok-connected" — accept both)
      const isConnected =
        evt.data === "tiktok-connected" ||
        (evt.data != null &&
          typeof evt.data === "object" &&
          evt.data.type === "tiktok-connected");
      if (isConnected) {
        ttWindowRef.current?.close();
        ttWindowRef.current = null;
        setShare((prev) => ({ ...prev, ttConnected: true, ttConnecting: false }));
        pushToast(
          "TikTok connected. Hit Share to TikTok again to send the video.",
          "ok"
        );
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [pushToast]);

  // ── YouTube ────────────────────────────────────────────────────────────
  const handleYouTube = useCallback(async () => {
    if (share.ytBusy) return;
    if (!publish.isConfigured("youtube")) {
      pushToast("YouTube sharing isn't set up yet.", "err");
      return;
    }
    setShare((prev) => ({ ...prev, ytBusy: true }));
    try {
      const { link } = await publish.publish({
        target: "youtube",
        url: result.url,
        filename: result.filename,
        title: share.title || "ClaimGuard export",
      });
      setShare((prev) => ({ ...prev, ytBusy: false, ytLink: link ?? null }));
      pushToast(
        "Uploaded to YouTube as a private video. Open it to review and publish.",
        "ok"
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Upload failed.";
      setShare((prev) => ({ ...prev, ytBusy: false }));
      pushToast(`YouTube: ${msg}`, "err");
    }
  }, [share.ytBusy, share.title, publish, result, pushToast]);

  // ── TikTok ─────────────────────────────────────────────────────────────
  const handleTikTok = useCallback(async () => {
    if (share.ttBusy || share.ttConnecting) return;

    if (!share.ttConnected) {
      // Open handshake popup — the real service navigates to /api/tiktok/auth;
      // the mock service opens a blank window and drives the handshake itself.
      setShare((prev) => ({ ...prev, ttConnecting: true }));

      try {
        await publish.connect("tiktok");
        // When the popup completes (mock path), mark connected.
        // On the real path, the postMessage listener above handles this.
        setShare((prev) => ({ ...prev, ttConnected: true, ttConnecting: false }));
        pushToast(
          "TikTok connected. Hit Share to TikTok again to send the video.",
          "ok"
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Connection failed.";
        setShare((prev) => ({ ...prev, ttConnecting: false }));
        // Only show if it wasn't a popup-blocked error (the service already
        // threw a readable message)
        if (msg.includes("Popup blocked")) {
          pushToast(msg, "err");
        } else {
          pushToast(`TikTok: ${msg}`, "err");
        }
      }
      return;
    }

    // Connected — publish
    setShare((prev) => ({ ...prev, ttBusy: true }));
    try {
      await publish.publish({
        target: "tiktok",
        url: result.url,
        filename: result.filename,
        title: share.title || "ClaimGuard export",
      });
      setShare((prev) => ({ ...prev, ttBusy: false, ttSent: true }));
      pushToast(
        "Sent to TikTok. Open the TikTok app's inbox/drafts to caption and post it.",
        "ok"
      );
    } catch (err) {
      const is401 = err instanceof ApiError && err.status === 401;
      const msg = err instanceof Error ? err.message : "Send failed.";
      // Session expired → fall back to Connect state
      if (is401 || msg.includes("session expired") || msg.includes("Connect again")) {
        setShare((prev) => ({ ...prev, ttBusy: false, ttConnected: false }));
        pushToast("TikTok: TikTok session expired. Connect again.", "err");
      } else {
        setShare((prev) => ({ ...prev, ttBusy: false }));
        pushToast(`TikTok: ${msg}`, "err");
      }
    }
  }, [share, publish, result, pushToast]);

  // ── Instagram ──────────────────────────────────────────────────────────
  const handleInstagram = useCallback(() => {
    // Trigger download
    const a = document.createElement("a");
    a.href = result.url;
    a.download = result.filename;
    a.click();
    // Open Instagram
    window.open("https://www.instagram.com/", "_blank", "noreferrer");
    pushToast("Video downloaded. Instagram just opened in a new tab.", "info");
  }, [result, pushToast]);

  // ── TikTok button label ────────────────────────────────────────────────
  let ttLabel = "Connect TikTok";
  if (share.ttConnecting) ttLabel = "Connect TikTok";
  else if (share.ttBusy) ttLabel = "Sending to TikTok…";
  else if (share.ttSent) ttLabel = "Sent · send again";
  else if (share.ttConnected) ttLabel = "Share to TikTok";

  return (
    <div className="share-panel">
      {/* Title row */}
      <div className="share-title-row">
        <h3 className="share-panel-h3">Share it</h3>
        <input
          type="text"
          className="share-title-field"
          value={share.title}
          onChange={(e) =>
            setShare((prev) => ({ ...prev, title: e.target.value }))
          }
          placeholder="Video title"
          title="Used as the title/caption on YouTube and TikTok"
          aria-label="Video title"
          maxLength={100}
        />
      </div>

      {/* Button row */}
      <div className="share-button-row">
        {/* YouTube */}
        <button
          type="button"
          className="share-btn"
          onClick={handleYouTube}
          disabled={share.ytBusy}
          aria-label={share.ytBusy ? "Uploading to YouTube…" : "Share to YouTube"}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/Youtube_logo.png" width={16} height={16} alt="" />
          {share.ytBusy ? "Uploading to YouTube…" : "Share to YouTube"}
        </button>

        {/* TikTok */}
        <button
          type="button"
          className="share-btn"
          onClick={handleTikTok}
          disabled={share.ttBusy}
          aria-label={ttLabel}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/tiktok_logo.png" width={16} height={16} alt="" />
          {ttLabel}
        </button>

        {/* Instagram */}
        <button
          type="button"
          className="share-btn"
          onClick={handleInstagram}
          aria-label="Share to Instagram"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/insta_logo.jpg" width={16} height={16} alt="" />
          Share to Instagram
        </button>

        {/* Open on YouTube link — appears once upload succeeds */}
        {share.ytLink && (
          <a
            href={share.ytLink}
            target="_blank"
            rel="noreferrer"
            className="youtube-open-link"
          >
            Open on YouTube ↗
          </a>
        )}
      </div>

      {/* Hint */}
      <p className="share-hint">
        YouTube uploads arrive as <strong>private</strong> videos you publish
        from YouTube Studio. TikTok receives the video in your in-app{" "}
        <strong>inbox/drafts</strong>. Instagram has no upload API, so we
        download the video and open Instagram for you.
      </p>
    </div>
  );
}

/* ─── Result panel (exported) ────────────────────────────────────────────── */

export function ResultPanel({
  result,
  strategy,
  clipsWereEdited,
  publish,
  pushToast,
  exportGeneration,
}: ResultPanelProps) {
  const actionWord = strategy === "mute" ? "muted" : "cut out";
  const editSuffix = clipsWereEdited ? " and your clip edits were applied" : "";
  const noticeText = `Flagged sections were ${actionWord}${editSuffix}. Re-scan the result if you want to double-check it.`;

  return (
    <div className="panel">
      {/* Header row */}
      <div className="result-header-row">
        <h2 className="result-panel-h2">Cleaned video</h2>
        <a
          href={result.url}
          download={result.filename}
          className="download-link"
        >
          Download {result.filename}
        </a>
      </div>

      {/* Notice */}
      <div className="result-notice">{noticeText}</div>

      {/* Native-controls player */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        className="result-player"
        src={result.url}
        controls
        playsInline
      />

      {/* Share panel */}
      <SharePanel
        result={result}
        publish={publish}
        pushToast={pushToast}
        exportGeneration={exportGeneration}
      />
    </div>
  );
}
