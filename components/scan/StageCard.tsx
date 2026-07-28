"use client";

import React, { useMemo } from "react";
import type { StageDef } from "@/lib/stages";

/* ─── Types ──────────────────────────────────────────────────────────────── */

export type CardStatus = "pending" | "running" | "done" | "failed";

interface StageCardProps {
  def: StageDef;
  status: CardStatus;
  /** 0–100 for stage 3 while running; undefined otherwise. */
  percentage?: number;
  /** Whether to show indeterminate bar (running, not stage 3). */
  indeterminate?: boolean;
  /** The live status line from the scan service. */
  liveStatus?: string;
  /** Failure message to display instead of description. */
  failureMessage?: string;
  onRetry?: () => void;
  onContinue?: () => void;
  prefersReducedMotion?: boolean;
  /** Refs for focus-trap management in the scan overlay */
  retryBtnRef?: React.RefObject<HTMLButtonElement>;
  continueBtnRef?: React.RefObject<HTMLButtonElement>;
}

/* ─── Helpers ────────────────────────────────────────────────────────────── */

function splitLabel(label: string): { first: string; rest: string } {
  const idx = label.indexOf(" ");
  if (idx < 0) return { first: label, rest: "" };
  return { first: label.slice(0, idx), rest: label.slice(idx + 1) };
}

function cardColors(
  status: CardStatus,
  def: StageDef
): { bg: string; text: string; shadow: string; scale: number; opacity: number } {
  switch (status) {
    case "pending":
      return {
        bg: "#ECEAE2",
        text: "#1F1F1F",
        shadow: "0 4px 14px rgba(0,0,0,0.08)",
        scale: 1,
        opacity: 0.55,
      };
    case "running":
      return {
        bg: def.cardBg,
        text: def.cardText,
        shadow: "0 28px 70px rgba(0,0,0,0.26)",
        scale: 1.03,
        opacity: 1,
      };
    case "done":
      return {
        bg: def.cardBg,
        text: def.cardText,
        shadow: "0 10px 30px rgba(0,0,0,0.13)",
        scale: 1,
        opacity: 1,
      };
    case "failed":
      return {
        bg: "#C65D3B",
        text: "#F4F1EA",
        shadow: "0 28px 70px rgba(0,0,0,0.26)",
        scale: 1.03,
        opacity: 1,
      };
  }
}

function statusWord(status: CardStatus): string {
  switch (status) {
    case "pending": return "Pending";
    case "running": return "Running";
    case "done":    return "Done";
    case "failed":  return "Failed";
  }
}

/* ─── Component ──────────────────────────────────────────────────────────── */

export function StageCard({
  def,
  status,
  percentage,
  indeterminate,
  liveStatus,
  failureMessage,
  onRetry,
  onContinue,
  prefersReducedMotion,
  retryBtnRef,
  continueBtnRef,
}: StageCardProps) {
  const { first, rest } = useMemo(() => splitLabel(def.label), [def.label]);
  const colors = useMemo(() => cardColors(status, def), [status, def]);

  const barPercent =
    status === "done"
      ? 100
      : status === "pending"
      ? 0
      : percentage ?? undefined;

  const showBar = status !== "failed";
  const isIndeterminate = status === "running" && indeterminate && barPercent === undefined;

  const accentColor = status === "failed" ? "#F4F1EA" : def.accent;
  const descriptionText =
    status === "failed" && failureMessage ? failureMessage : def.description;

  return (
    <div
      className="stage-card paper-texture"
      style={{
        background: colors.bg,
        color: colors.text,
        boxShadow: colors.shadow,
        opacity: colors.opacity,
        transform: `scale(${colors.scale})`,
      }}
    >
      {/* Vertical rail */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          right: 16,
          top: 0,
          bottom: 0,
          display: "flex",
          alignItems: "center",
        }}
      >
        <span
          style={{
            writingMode: "vertical-rl",
            textOrientation: "mixed",
            fontFamily: 'var(--font-courier),"Courier Prime",monospace',
            fontSize: 11,
            letterSpacing: "0.25em",
            textTransform: "uppercase",
            opacity: 0.3,
            transform: "rotate(180deg)",
          }}
        >
          {def.label}
        </span>
      </div>

      {/* Body */}
      <div
        style={{
          padding: "40px 56px 40px 40px",
          display: "flex",
          flexDirection: "column",
          height: "100%",
        }}
      >
        {/* Step counter */}
        <div
          style={{
            fontFamily: 'var(--font-courier),"Courier Prime",monospace',
            fontSize: 14,
            textTransform: "uppercase",
            letterSpacing: "0.2em",
            opacity: 0.45,
          }}
        >
          Step {String(def.index + 1).padStart(2, "0")} / 4
        </div>

        {/* Title */}
        <div style={{ marginTop: 24 }}>
          <div
            className="font-serif-display"
            style={{
              fontWeight: 300,
              lineHeight: 1.25,
              fontSize: "clamp(2.25rem, 5vw, 3rem)",
              wordBreak: "break-word",
            }}
          >
            {first}
          </div>
          {rest && (
            <div
              className="font-serif-display"
              style={{
                fontWeight: 300,
                fontStyle: "italic",
                lineHeight: 1.25,
                fontSize: "clamp(2.25rem, 5vw, 3rem)",
                paddingLeft: 16,
                marginTop: 4,
                wordBreak: "break-word",
              }}
            >
              {rest}
            </div>
          )}
        </div>

        {/* Status row */}
        <div
          style={{
            marginTop: 32,
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          {status === "running" && !prefersReducedMotion && (
            <div
              className="dot-pulse"
              style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: accentColor,
                flexShrink: 0,
              }}
            />
          )}
          {status === "running" && prefersReducedMotion && (
            <div
              style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: accentColor,
                flexShrink: 0,
              }}
            />
          )}
          <span
            style={{
              fontFamily: 'var(--font-courier),"Courier Prime",monospace',
              fontSize: 14,
              textTransform: "uppercase",
              letterSpacing: "0.2em",
              opacity: 0.6,
            }}
          >
            {statusWord(status)}
          </span>
        </div>

        {/* Description / failure message */}
        <div
          style={{
            marginTop: 16,
            fontFamily: 'var(--font-courier),"Courier Prime",monospace',
            fontSize: 16,
            lineHeight: 1.625,
            opacity: 0.75,
          }}
        >
          {descriptionText}
        </div>

        {/* Live status line — stage 3 while running */}
        {status === "running" && def.index === 3 && liveStatus && (
          <div
            style={{
              marginTop: 12,
              fontFamily: 'var(--font-courier),"Courier Prime",monospace',
              fontSize: 12,
              lineHeight: 1.4,
              color: accentColor,
              wordBreak: "break-word",
            }}
          >
            {liveStatus}
          </div>
        )}

        {/* Footer */}
        <div style={{ marginTop: "auto", paddingTop: 32 }}>
          {status === "failed" ? (
            /* Failure buttons */
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <button ref={retryBtnRef} className="scan-btn-retry" onClick={onRetry} type="button">
                Try the scan again
              </button>
              <button ref={continueBtnRef} className="scan-btn-continue" onClick={onContinue} type="button">
                Continue without scanning
              </button>
            </div>
          ) : showBar ? (
            <>
              {/* Footer label row */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  marginBottom: 12,
                }}
              >
                <span
                  style={{
                    fontFamily:
                      'var(--font-courier),"Courier Prime",monospace',
                    fontSize: 12,
                    textTransform: "uppercase",
                    letterSpacing: "0.2em",
                    opacity: 0.45,
                  }}
                >
                  {status === "done"
                    ? "Complete"
                    : status === "pending"
                    ? "Waiting"
                    : "Working"}
                </span>
                {barPercent !== undefined && (
                  <span
                    style={{
                      fontFamily:
                        'var(--font-courier),"Courier Prime",monospace',
                      fontSize: 12,
                      opacity: 0.55,
                    }}
                  >
                    {barPercent}%
                  </span>
                )}
              </div>

              {/* Progress bar */}
              <div
                style={{
                  height: 10,
                  borderRadius: 9999,
                  overflow: "hidden",
                  background: "rgba(0,0,0,0.12)",
                  position: "relative",
                }}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                {...(barPercent !== undefined
                  ? { "aria-valuenow": barPercent }
                  : {})}
              >
                {status === "pending" ? (
                  <div
                    style={{
                      width: "100%",
                      height: "100%",
                      background: "rgba(0,0,0,0.15)",
                      opacity: 0.4,
                    }}
                  />
                ) : isIndeterminate && !prefersReducedMotion ? (
                  <div
                    style={{
                      width: "40%",
                      height: "100%",
                      background: accentColor,
                      opacity: 0.85,
                      animation:
                        "progress-indeterminate 1.3s ease-in-out infinite",
                    }}
                  />
                ) : isIndeterminate && prefersReducedMotion ? (
                  <div
                    style={{
                      width: "40%",
                      height: "100%",
                      background: accentColor,
                      opacity: 0.6,
                    }}
                  />
                ) : (
                  <div
                    style={{
                      width: `${barPercent ?? 0}%`,
                      height: "100%",
                      background: accentColor,
                      opacity: 0.9,
                      transition: "width 0.6s ease",
                    }}
                  />
                )}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
