"use client";

import React, { useMemo, useEffect, useRef, useState } from "react";
import type { StageDef } from "@/lib/stages";

/* ─── Types ──────────────────────────────────────────────────────────────── */

export type CardStatus = "pending" | "running" | "done" | "failed";

interface StageCardProps {
  def: StageDef;
  status: CardStatus;
  /**
   * True while this card is the front card and should be animating.
   * The card starts its own internal 0→100 % fill from the exact frame
   * this prop first becomes true — completely local, no shared clock.
   */
  isActive?: boolean;
  /**
   * Real backend fraction (0–1) for this card's stage.  When provided the
   * bar tracks it directly — no ceiling.  Falls back to the cosmetic ramp
   * when zero or absent.
   */
  realFraction?: number;
  /** Whether to show indeterminate bar (legacy, kept for API compat). */
  indeterminate?: boolean;
  /** The live status line from the scan service. */
  liveStatus?: string;
  /** Failure message to display instead of description. */
  failureMessage?: string;
  onRetry?: () => void;
  onContinue?: () => void;
  /**
   * Fired once when this card's local fill animation reaches 100 %.
   * The wheel engine uses this to unblock the sweep for this card.
   */
  onFillComplete?: (cardIndex: number) => void;
  prefersReducedMotion?: boolean;
  /** Refs for focus-trap management in the scan overlay */
  retryBtnRef?: React.RefObject<HTMLButtonElement>;
  continueBtnRef?: React.RefObject<HTMLButtonElement>;
}

/* ─── Per-card animation hook ────────────────────────────────────────────── */

const FILL_MIN_MS = 1100;

/**
 * Local fill animation: starts from 0 % the instant isActive flips true,
 * advances toward max(cosmetic_ramp, realFraction), eases out near 100 %.
 * The clock is local to this component instance — it never starts before
 * isActive=true, regardless of when the component was mounted.
 */
function useLocalFill(
  isActive: boolean,
  cardIndex: number,
  realFraction: number,
  prefersReducedMotion: boolean,
  onFillComplete: ((cardIndex: number) => void) | undefined,
): number {
  const [fill, setFill] = useState(0);

  const rafRef    = useRef<number | null>(null);
  const startRef  = useRef<number | null>(null);
  // posRef holds the continuous animation position (0.0–1.0).
  // fillRef holds the last integer (0–100) passed to setFill.
  // They are SEPARATE so the lerp never reads back a quantised value.
  const posRef    = useRef(0);
  const fillRef   = useRef(0);
  // Always-current ref so the rAF closure reads the latest real fraction
  // without needing the effect to re-run.
  const fracRef   = useRef(realFraction);
  fracRef.current = realFraction;
  const onFillCompleteRef  = useRef(onFillComplete);
  onFillCompleteRef.current = onFillComplete;

  useEffect(() => {
    if (!isActive) {
      // Card stepped down from active — cancel and reset so next activation
      // always starts clean from 0.
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      startRef.current = null;
      posRef.current   = 0;
      fillRef.current  = 0;
      setFill(0);
      return;
    }

    // Reduced-motion: no tween, just snap to 100 immediately.
    if (prefersReducedMotion) {
      posRef.current  = 1;
      fillRef.current = 100;
      setFill(100);
      onFillCompleteRef.current?.(cardIndex);
      return;
    }

    // Guard: only start one loop per activation.
    if (rafRef.current !== null) return;

    function tick(now: number) {
      // startRef is null on the very first frame — set it now.
      // This means elapsed=0 on frame 1, so the bar starts at exactly 0 %,
      // anchored to the real paint time, not to any earlier state-update.
      if (startRef.current === null) startRef.current = now;
      const elapsed = now - startRef.current;

      // Cosmetic ramp: 0 → 1 over FILL_MIN_MS.
      // Used as a FALLBACK only — when no real signal exists (fracRef = 0)
      // it guarantees the bar fills visibly in bounded time.  It must not
      // override a genuine progress value, because doing so would race the
      // bar to full regardless of what the real work reports.
      const cosmeticTarget = Math.min(elapsed / FILL_MIN_MS, 1);

      // Target: real fraction when a genuine signal is present; cosmetic
      // ramp when there is none.  A real signal is defined as fracRef > 0
      // (stages that report no progress leave it at 0 the whole time).
      const target = fracRef.current > 0 ? fracRef.current : cosmeticTarget;

      // Ease-out lerp — operates on posRef (continuous float 0–1), NEVER on
      // the rounded integer.  Rounding only happens when writing to the DOM.
      const nextPos = posRef.current + (target - posRef.current) * 0.12;

      // Done when the bar is visually within one display unit of the target.
      // For card 3 the target grows continuously through both phases (0→0.5
      // during audio, 0.5→1.0 during visual), so the lerp can never reach
      // 0.995 until the target itself has reached 1.0.  For cards 0–2 the
      // target is the cosmetic ramp which reaches 1.0 after FILL_MIN_MS.
      // In both cases done fires in bounded time once the real work finishes.
      const done = nextPos >= 0.995;
      posRef.current = done ? 1 : nextPos;

      const nextInt = done ? 100 : Math.round(posRef.current * 100);
      if (nextInt !== fillRef.current) {
        fillRef.current = nextInt;
        setFill(nextInt);
      }

      if (!done) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
        // Notify the wheel engine that this card's fill animation is done.
        // For card 3 the wheel additionally waits on visualScanning; this
        // signal only unblocks Gate 2 — Gate 3 is the wheel's own concern.
        onFillCompleteRef.current?.(cardIndex);
      }
    }

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  // Restart only when activation state or motion pref changes.
  // realFraction is fed via ref so the loop stays alive without restarting.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, prefersReducedMotion]);

  return fill;
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
  isActive = false,
  realFraction = 0,
  onFillComplete,
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

  // Local fill animation — starts from 0 the moment this card becomes active.
  const localFill = useLocalFill(
    isActive,
    def.index,
    realFraction,
    prefersReducedMotion ?? false,
    onFillComplete,
  );

  // barPercent: single source of truth for both the percentage label and the
  // bar width — they always read the same value so they can never mismatch.
  //   • done    → 100 (card has been swept; bar is full)
  //   • running → localFill (live animated value 0–100, shown regardless of
  //               isActive so the label appears even on the first frame)
  //   • pending → 0
  const barPercent =
    status === "done"
      ? 100
      : status === "running"
      ? localFill
      : 0;

  const showBar = status !== "failed";
  // isIndeterminate: legacy API compat — only fires if caller explicitly sets
  // indeterminate=true while running and the bar hasn't started yet (0 %).
  const isIndeterminate = status === "running" && !!indeterminate && localFill === 0;

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
                {status !== "pending" && (
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
                aria-valuenow={barPercent}
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
