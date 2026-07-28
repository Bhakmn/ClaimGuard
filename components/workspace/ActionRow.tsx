"use client";

import React from "react";

interface ActionRowProps {
  /* Scan */
  scanning: boolean;
  scanned: boolean;
  scanProgress: number; // 0–100
  sourceDuration: number;
  /* Export */
  exporting: boolean;
  /* Queue */
  queueLength: number;
  /* Callbacks */
  onScan: () => void;
  onAddRegion: () => void;
  onSplitRegion: () => void;
  onTrimRegion: () => void;
  onNextOrChoose: () => void;
  hasSpans: boolean;
  /** Forwarded to the scan button for focus restoration after the overlay closes. */
  scanTriggerRef?: React.RefObject<HTMLElement | null>;
}

export function ActionRow({
  scanning,
  scanned,
  scanProgress,
  sourceDuration,
  exporting,
  queueLength,
  onScan,
  onAddRegion,
  onSplitRegion,
  onTrimRegion,
  onNextOrChoose,
  hasSpans,
  scanTriggerRef,
}: ActionRowProps) {
  const busy = scanning || exporting;
  const noDuration = sourceDuration === 0;

  const scanLabel = scanning
    ? "Scanning…"
    : scanned
    ? "Re-scan"
    : "Scan for copyrighted audio";

  const nextLabel =
    queueLength > 0
      ? `Next video (${queueLength} queued)`
      : "Choose another video";

  const btnBase: React.CSSProperties = {
    fontFamily: 'var(--font-courier),"Courier Prime",monospace',
    fontSize: 13,
    color: "var(--text)",
    background: "var(--panel)",
    border: "1px solid rgba(31,31,31,0.35)",
    borderRadius: 7,
    padding: "8px 15px",
    cursor: "pointer",
    transition: "background 150ms, border-color 150ms, color 150ms",
    whiteSpace: "nowrap",
  };
  const btnDisabled: React.CSSProperties = {
    opacity: 0.4,
    cursor: "not-allowed",
  };
  const btnPrimary: React.CSSProperties = {
    background: "#C65D3B",
    borderColor: "#C65D3B",
    color: "#F4F1EA",
    fontWeight: 700,
  };

  function makeHover(el: HTMLButtonElement, primary: boolean) {
    if (primary) {
      el.style.background = "#B04E30";
    } else {
      el.style.borderColor = "#C65D3B";
      el.style.color = "#C65D3B";
    }
  }
  function clearHover(el: HTMLButtonElement, primary: boolean) {
    if (primary) {
      el.style.background = "#C65D3B";
    } else {
      el.style.borderColor = "rgba(31,31,31,0.35)";
      el.style.color = "var(--text)";
    }
  }

  return (
    <div className="action-row">
      <div className="action-buttons">
        {/* Scan */}
        <button
          ref={scanTriggerRef as React.RefObject<HTMLButtonElement> | undefined}
          style={{
            ...btnBase,
            ...btnPrimary,
            ...(busy || noDuration ? btnDisabled : {}),
          }}
          disabled={busy || noDuration}
          onClick={onScan}
          onMouseEnter={(e) =>
            !busy && !noDuration && makeHover(e.currentTarget, true)
          }
          onMouseLeave={(e) =>
            !busy && !noDuration && clearHover(e.currentTarget, true)
          }
        >
          {scanLabel}
        </button>

        {/* Add region */}
        <button
          style={{
            ...btnBase,
            ...(busy || noDuration ? btnDisabled : {}),
          }}
          disabled={busy || noDuration}
          onClick={onAddRegion}
          onMouseEnter={(e) =>
            !busy && !noDuration && makeHover(e.currentTarget, false)
          }
          onMouseLeave={(e) =>
            !busy && !noDuration && clearHover(e.currentTarget, false)
          }
        >
          + Add region at playhead
        </button>

        {/* Split region */}
        <button
          style={{
            ...btnBase,
            ...(busy || noDuration || !hasSpans ? btnDisabled : {}),
          }}
          disabled={busy || noDuration || !hasSpans}
          onClick={onSplitRegion}
          title="Split the flag region under the playhead in two (S). Use ✂ Cut in the timeline toolbar to cut the video itself"
          onMouseEnter={(e) =>
            !busy && !noDuration && hasSpans && makeHover(e.currentTarget, false)
          }
          onMouseLeave={(e) =>
            !busy && !noDuration && hasSpans && clearHover(e.currentTarget, false)
          }
        >
          Split region at playhead
        </button>

        {/* Trim region */}
        <button
          style={{
            ...btnBase,
            ...(busy || noDuration || !hasSpans ? btnDisabled : {}),
          }}
          disabled={busy || noDuration || !hasSpans}
          onClick={onTrimRegion}
          title="Snap the nearest edge of the flag region under the playhead to the playhead — park it exactly where you hear the music stop, then click"
          onMouseEnter={(e) =>
            !busy && !noDuration && hasSpans && makeHover(e.currentTarget, false)
          }
          onMouseLeave={(e) =>
            !busy && !noDuration && hasSpans && clearHover(e.currentTarget, false)
          }
        >
          ⇥ Trim region to playhead
        </button>

        {/* Next / Choose */}
        <button
          style={{
            ...btnBase,
            ...(busy ? btnDisabled : {}),
          }}
          disabled={busy}
          onClick={onNextOrChoose}
          title="Discards the current edit and loads the next video"
          onMouseEnter={(e) =>
            !busy && makeHover(e.currentTarget, false)
          }
          onMouseLeave={(e) =>
            !busy && clearHover(e.currentTarget, false)
          }
        >
          {nextLabel}
        </button>
      </div>

      {/* Scan inline progress — shown only during scanning */}
      {scanning && (
        <div
          className="scan-inline-bar-track"
          role="progressbar"
          aria-label="Scan progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={scanProgress}
        >
          <div
            className="scan-inline-bar-fill"
            style={{ width: `${scanProgress}%` }}
          />
        </div>
      )}
    </div>
  );
}
