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
  scanning: boolean;
  scanFailed: boolean;
  failureMessage: string | null;
  scanStage: number;
  scanFraction: number;
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
        // Escape does nothing while scanning; on failure card it continues
        if (scanFailed) onContinue();
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
  }, [scanFailed, onContinue]);

  // Wheel engine
  const [wheelState, { reset }] = useWheelEngine({
    scanning,
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

  // Determine per-card status
  function getStatus(cardIndex: number): CardStatus {
    const { frontIndex, hiddenSet, sweeping, sweepQueue } = wheelState;
    if (scanFailed && cardIndex === frontIndex) return "failed";
    if (hiddenSet.has(cardIndex)) return "done";
    // sweeping-out card
    if (sweeping && sweepQueue[0] === cardIndex) return "done";
    if (cardIndex === frontIndex) {
      return scanning || sweeping ? "running" : "done";
    }
    if (cardIndex < frontIndex) return "done";
    return "pending";
  }

  // Derived: active stage index for sidebar (4 when scan finished)
  const activeStageSidebar = scanning ? scanStage : 4;

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
        scanning={scanning}
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
                    percentage={
                      def.index === 3 && status === "running"
                        ? Math.round(scanFraction * 100)
                        : undefined
                    }
                    indeterminate={status === "running" && def.index !== 3}
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
                        percentage={
                          def.index === 3 && status === "running"
                            ? Math.round(scanFraction * 100)
                            : undefined
                        }
                        indeterminate={
                          status === "running" && def.index !== 3
                        }
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
