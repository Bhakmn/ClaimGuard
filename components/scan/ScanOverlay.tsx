"use client";

import React, {
  useRef,
  useEffect,
  useMemo,
  useCallback,
} from "react";
import { STAGES } from "@/lib/stages";
import { NoiseOverlay } from "@/components/primitives/NoiseOverlay";
import { ScanSidebar } from "./ScanSidebar";
import { StageCard, type CardStatus } from "./StageCard";
import { useWheelEngine, cardRimPosition } from "@/hooks/useWheelEngine";
import type { FlaggedSpan } from "@/lib/types";

/* ─── Types ──────────────────────────────────────────────────────────────── */

export interface ScanOverlayProps {
  /** True while the audio scan is running. */
  scanning: boolean;
  /** True while the visual scan is running. Wheel holds card 3 until false. */
  visualScanning: boolean;
  scanFailed: boolean;
  failureMessage: string | null;
  /**
   * Effective stage index for the wheel (0–3 while audio runs, stays at 3
   * while visual runs, advances to 4 only when both are done).
   */
  scanStage: number;
  /**
   * Combined progress fraction (0–1) for the front card's bar.
   * Caller derives: audio fraction while audio runs, visual fraction after.
   */
  scanFraction: number;
  /** Live status line for the front card. */
  scanStatus: string;
  scanStartMs: number | null;
  primaryFileName: string;
  onRetry: () => void;
  onContinue: () => void;
  onClose: () => void;
}

const RADIUS = 600;

/* ─── Component ──────────────────────────────────────────────────────────── */

export function ScanOverlay({
  scanning,
  scanFailed,
  failureMessage,
  scanStage,
  scanFraction,
  scanStatus,
  scanStartMs,
  primaryFileName,
  visualScanning,
  onRetry,
  onContinue,
  onClose,
}: ScanOverlayProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const retryBtnRef = useRef<HTMLButtonElement>(null);
  const continueBtnRef = useRef<HTMLButtonElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const prefersReducedMotion =
    typeof window !== "undefined"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false;

  // Move focus to the heading when the overlay opens
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  // ── Focus trap ─────────────────────────────────────────────────────────
  useEffect(() => {
    function getFocusable(): HTMLElement[] {
      const els: HTMLElement[] = [];
      if (headingRef.current) els.push(headingRef.current);
      if (scanFailed) {
        if (retryBtnRef.current) els.push(retryBtnRef.current);
        if (continueBtnRef.current) els.push(continueBtnRef.current);
      }
      return els;
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        // Escape is always an exit hatch.
        //
        // While scanning: calling onContinue dismisses the overlay and leaves
        // the workspace in its pre-scan state.  The scan is already running
        // server-side and cannot be cancelled from here; "dismiss" and
        // "continue without scan results" are therefore equivalent — onContinue
        // is the right call because it closes the overlay cleanly without
        // marking the scan as failed, so the user lands back in the editor.
        //
        // On failure card: same behaviour — dismiss without retrying.
        onContinue();
        return;
      }
      if (e.key !== "Tab") return;
      const focusable = getFocusable();
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement;
      if (e.shiftKey) {
        if (active === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onContinue]);

  // Wheel engine
  const [wheelState, { reset, onFillComplete }] = useWheelEngine({
    scanning,
    visualScanning,
    scanStage,
    scanFailed,
    onClose,
    prefersReducedMotion,
  });

  // Re-initialise engine whenever a new scan starts
  const prevScanning = useRef(false);
  useEffect(() => {
    if (scanning && !prevScanning.current) {
      reset();
    }
    prevScanning.current = scanning;
  }, [scanning, reset]);

  // Determine per-card status.
  // A card at the front is always "running" — the wheel (not the backend
  // scanning flag) is the authority on when it finishes.  The sweep
  // transitions it to "done" only after its fill has completed.
  function getStatus(cardIndex: number): CardStatus {
    const { frontIndex, hiddenSet, sweeping, sweepQueue } = wheelState;
    if (scanFailed && cardIndex === frontIndex) return "failed";
    if (hiddenSet.has(cardIndex)) return "done";
    // sweeping-out card
    if (sweeping && sweepQueue[0] === cardIndex) return "done";
    if (cardIndex === frontIndex) return "running";
    if (cardIndex < frontIndex) return "done";
    return "pending";
  }

  // Derived: active stage index for sidebar.
  // A card is visually "done" the moment its sweep animation starts (getStatus
  // returns "done" for the sweeping card too).  We count both hidden cards AND
  // the currently-sweeping card so the sidebar checkmark fires in exact sync
  // with the card on screen — not one full wheel-rotation later.
  const activeStageSidebar =
    wheelState.hiddenSet.size +
    (wheelState.sweeping && wheelState.sweepQueue.length > 0 ? 1 : 0);

  return (
    <div
      ref={overlayRef}
      className="scan-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="scan-overlay-heading"
    >
      {/* ── Sidebar ────────────────────────────────────────────────────── */}
      <ScanSidebar
        stages={STAGES}
        activeStage={activeStageSidebar}
        failed={scanFailed}
        scanning={scanning || visualScanning}
        scanStartMs={scanStartMs}
        fileName={primaryFileName}
        headingRef={headingRef as React.RefObject<HTMLHeadingElement>}
        headingId="scan-overlay-heading"
      />

      {/* ── Wheel stage ────────────────────────────────────────────────── */}
      <main className="scan-wheel-stage" aria-label="Scan stage cards">
        {prefersReducedMotion ? (
          /* ── Reduced-motion: single centred card, cross-fade ─────────── */
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {STAGES.map((def) => {
              const status = getStatus(def.index);
              const hidden = wheelState.hiddenSet.has(def.index);
              if (hidden) return null;
              const isFront = def.index === wheelState.frontIndex;
              return (
                <div
                  key={def.index}
                  style={{
                    position: "absolute",
                    opacity: isFront ? 1 : 0,
                    transition: "opacity 200ms",
                    pointerEvents: isFront ? undefined : "none",
                  }}
                >
                  <StageCard
                    def={def}
                    status={status}
                    isActive={status === "running" && def.index === wheelState.frontIndex && !wheelState.sweeping}
                    realFraction={def.index === 3 ? scanFraction : 0}
                    onFillComplete={onFillComplete}
                    indeterminate={false}
                    liveStatus={scanStatus}
                    failureMessage={failureMessage ?? undefined}
                    onRetry={onRetry}
                    onContinue={onContinue}
                    prefersReducedMotion
                    retryBtnRef={status === "failed" ? retryBtnRef as React.RefObject<HTMLButtonElement> : undefined}
                    continueBtnRef={status === "failed" ? continueBtnRef as React.RefObject<HTMLButtonElement> : undefined}
                  />
                </div>
              );
            })}
          </div>
        ) : (
          /* ── Full wheel ───────────────────────────────────────────────── */
          <div
            style={{
              position: "absolute",
              left: "calc(50% + 600px)",
              top: "50%",
              width: 0,
              height: 0,
              transform: `rotate(${wheelState.wheelAngle}deg)`,
              transition: `transform 600ms cubic-bezier(0.4, 0, 0.2, 1)`,
            }}
          >
            {STAGES.map((def) => {
              if (wheelState.hiddenSet.has(def.index)) return null;

              const { x, y } = cardRimPosition(def.index);
              const status = getStatus(def.index);

              // Counter-rotation keeps card upright
              const isSweeping =
                wheelState.sweeping &&
                wheelState.sweepQueue[0] === def.index;
              const counterRot =
                -wheelState.wheelAngle + (isSweeping ? -90 : 0);
              const counterDuration = isSweeping ? 700 : 600;

              return (
                <div
                  key={def.index}
                  style={{
                    position: "absolute",
                    left: x,
                    top: y,
                  }}
                >
                  {/* Sweep wrapper */}
                  <div
                    style={{
                      transformOrigin: `${-x}px ${-y}px`,
                      transform: isSweeping ? "rotate(90deg)" : "rotate(0deg)",
                      transition: isSweeping
                        ? `transform 700ms cubic-bezier(0.4, 0, 0.2, 1)`
                        : undefined,
                    }}
                  >
                    {/* Counter-rotation */}
                    <div
                      style={{
                        transform: `translate(-50%, -50%) rotate(${counterRot}deg)`,
                        transition: `transform ${counterDuration}ms cubic-bezier(0.4, 0, 0.2, 1)`,
                      }}
                    >
                      <StageCard
                        def={def}
                        status={status}
                        isActive={status === "running" && def.index === wheelState.frontIndex && !wheelState.sweeping}
                        realFraction={def.index === 3 ? scanFraction : 0}
                        onFillComplete={onFillComplete}
                        indeterminate={false}
                        liveStatus={scanStatus}
                        failureMessage={failureMessage ?? undefined}
                        onRetry={onRetry}
                        onContinue={onContinue}
                        retryBtnRef={status === "failed" ? retryBtnRef as React.RefObject<HTMLButtonElement> : undefined}
                        continueBtnRef={status === "failed" ? continueBtnRef as React.RefObject<HTMLButtonElement> : undefined}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>

      {/* Grain overlay */}
      <NoiseOverlay />
    </div>
  );
}
