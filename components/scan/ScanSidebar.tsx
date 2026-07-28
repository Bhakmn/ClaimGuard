"use client";

import React, { useRef, useEffect } from "react";
import type { StageDef } from "@/lib/stages";

/* ─── Sidebar types ──────────────────────────────────────────────────────── */

interface ScanSidebarProps {
  stages: StageDef[];
  activeStage: number;       // 0–3 while running, 4 when done
  failed: boolean;
  scanning: boolean;
  scanStartMs: number | null; // timestamp when scan began
  fileName: string;
  headingRef: React.RefObject<HTMLHeadingElement>;
  headingId?: string;
}

/* ─── Elapsed timer ──────────────────────────────────────────────────────── */

function useElapsed(
  scanStartMs: number | null,
  scanning: boolean
): string {
  const [elapsed, setElapsed] = React.useState("0s");

  useEffect(() => {
    if (!scanStartMs || !scanning) return;
    const id = setInterval(() => {
      const ms = Date.now() - scanStartMs;
      const secs = Math.max(0, Math.round(ms / 1000));
      const mins = Math.floor(secs / 60);
      const s = secs - mins * 60;
      setElapsed(mins > 0 ? `${mins}m ${s}s` : `${s}s`);
    }, 1000);
    return () => clearInterval(id);
  }, [scanStartMs, scanning]);

  return elapsed;
}

/* ─── Component ──────────────────────────────────────────────────────────── */

export function ScanSidebar({
  stages,
  activeStage,
  failed,
  scanning,
  scanStartMs,
  fileName,
  headingRef,
  headingId,
}: ScanSidebarProps) {
  const elapsed = useElapsed(scanStartMs, scanning);

  return (
    <aside className="scan-sidebar">
      <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
        {/* Brand row */}
        <div className="brand-mark">
          <div className="brand-badge brand-badge--lg">
            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z" />
              <path d="M9.5 12l1.8 1.8L15 10" />
            </svg>
          </div>
          <span className="brand-wordmark">ClaimGuard</span>
        </div>

        {/* Heading — h1 because the scan overlay is its own full-screen surface */}
        <h1
          ref={headingRef}
          id={headingId}
          tabIndex={-1}
          className="font-serif-display"
          style={{
            marginTop: 24,
            fontWeight: 300,
            lineHeight: 0.95,
            fontSize: "clamp(2.25rem, 5vw, 3rem)",
          }}
        >
          Scanning your
          <br />
          <em>video</em>
        </h1>

        {/* Rule */}
        <div
          style={{
            width: 40,
            height: 1,
            background: "rgba(31,31,31,0.2)",
            margin: "8px 0",
          }}
        />

        {/* Now scanning */}
        {fileName && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span
              style={{
                fontFamily:
                  'var(--font-courier),"Courier Prime",monospace',
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: "0.2em",
                opacity: 0.4,
              }}
            >
              Now scanning
            </span>
            <span
              className="font-serif-display"
              style={{
                fontSize: 16,
                lineHeight: 1.35,
                opacity: 0.8,
                wordBreak: "break-word",
              }}
            >
              {fileName}
            </span>
          </div>
        )}

        {/* Elapsed */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span
            style={{
              fontFamily:
                'var(--font-courier),"Courier Prime",monospace',
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: "0.2em",
              opacity: 0.4,
            }}
          >
            Elapsed
          </span>
          <span
            style={{
              fontFamily:
                'var(--font-courier),"Courier Prime",monospace',
              fontSize: 14,
              color: "#C65D3B",
            }}
          >
            {elapsed}
          </span>
        </div>

        {/* Stage checklist */}
        <div
          aria-live="polite"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 12,
            marginTop: 8,
          }}
        >
          {stages.map((stage, i) => {
            const isBefore = i < activeStage;
            const isActive = i === activeStage && !failed;
            const isAfter = i > activeStage;
            const isFailed = failed && i === activeStage;

            const dotBg = isFailed
              ? "#B3372B"
              : isBefore
              ? "#1F1F1F"
              : isActive
              ? "#C65D3B"
              : "#D1D1C9";

            const labelOpacity = isFailed
              ? 0.75
              : isAfter
              ? 0.25
              : 0.75;

            return (
              <div
                key={stage.index}
                style={{ display: "flex", alignItems: "center", gap: 12 }}
              >
                {/* Dot */}
                <div
                  className={isActive && !isFailed ? "dot-pulse" : undefined}
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: dotBg,
                    flexShrink: 0,
                    transition: "background-color 500ms",
                  }}
                />

                {/* Label */}
                <span
                  style={{
                    fontFamily:
                      'var(--font-courier),"Courier Prime",monospace',
                    fontSize: 12,
                    textTransform: "uppercase",
                    letterSpacing: "0.2em",
                    opacity: labelOpacity,
                    transition: "opacity 500ms",
                    flex: 1,
                  }}
                >
                  {String(i + 1).padStart(2, "0")} {stage.label}
                </span>

                {/* Tick — completed stages only */}
                {isBefore && (
                  <span
                    style={{
                      fontFamily:
                        'var(--font-courier),"Courier Prime",monospace',
                      fontSize: 9,
                      color: "#C65D3B",
                      opacity: 0.6,
                      marginLeft: "auto",
                    }}
                    aria-label="complete"
                  >
                    ✓
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
