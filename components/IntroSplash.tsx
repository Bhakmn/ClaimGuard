"use client";

import React, { useEffect, useRef, useState } from "react";

/* ─── Module-scope flag — never replay the intro on reset ─────────────────── */
let introHasPlayed = false;

/* ─── Timing constants ───────────────────────────────────────────────────── */
const EXIT_START_MS = 2400;
const UNMOUNT_MS = 3800;

interface IntroSplashProps {
  onDone: () => void;
}

export function IntroSplash({ onDone }: IntroSplashProps) {
  const [phase, setPhase] = useState<"enter" | "exit">("enter");
  const prefersReduced =
    typeof window !== "undefined"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false;

  useEffect(() => {
    if (prefersReduced) {
      const t = setTimeout(() => {
        introHasPlayed = true;
        onDone();
      }, 900);
      return () => clearTimeout(t);
    }

    const exitTimer = setTimeout(() => setPhase("exit"), EXIT_START_MS);
    const doneTimer = setTimeout(() => {
      introHasPlayed = true;
      onDone();
    }, UNMOUNT_MS);

    return () => {
      clearTimeout(exitTimer);
      clearTimeout(doneTimer);
    };
  }, [onDone, prefersReduced]);

  const stripes = Array.from({ length: 8 });

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 999,
        pointerEvents: "none",
        overflow: "hidden",
      }}
      aria-hidden="true"
    >
      {/* ── Stripes ────────────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          height: "100%",
          width: "100%",
        }}
      >
        {stripes.map((_, i) => {
          const isEven = i % 2 === 0;
          const isLast = i === 7;

          const enterStyle: React.CSSProperties = prefersReduced
            ? {}
            : {};

          const exitStyle: React.CSSProperties =
            phase === "exit" && !prefersReduced
              ? {
                  animation: `intro-stripe-exit 0.85s cubic-bezier(0.77,0,0.18,1) forwards`,
                  animationDelay: `${i * 65}ms`,
                }
              : {};

          return (
            <div
              key={i}
              style={{
                flex: 1,
                background: isEven ? "#F4F1EA" : "#EDE9E0",
                borderRight: isLast ? undefined : "1px solid rgba(0,0,0,0.04)",
                ...enterStyle,
                ...exitStyle,
              }}
            />
          );
        })}
      </div>

      {/* ── Centre content ─────────────────────────────────────────────── */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1rem",
          pointerEvents: "none",
        }}
      >
        {/* Wordmark */}
        <div style={{ overflow: "hidden" }}>
          <h1
            style={{
              fontFamily: 'var(--font-cormorant), "Cormorant Garamond", serif',
              fontSize: "clamp(4rem, 14vw, 11rem)",
              fontWeight: 300,
              fontStyle: "italic",
              color: "#1F1F1F",
              lineHeight: 1,
              letterSpacing: "-0.02em",
              ...(prefersReduced
                ? { opacity: 1 }
                : phase === "exit"
                ? {
                    animation:
                      "intro-text-exit 0.35s ease forwards",
                    animationDelay: "0s",
                  }
                : {
                    animation:
                      "intro-reveal 0.9s cubic-bezier(0.77,0,0.18,1) forwards",
                    animationDelay: "0.2s",
                    clipPath: "inset(100% 0 0 0)",
                  }),
            }}
          >
            ClaimGuard
          </h1>
        </div>

        {/* Tagline */}
        <p
          style={{
            fontFamily: 'var(--font-courier), "Courier Prime", monospace',
            fontSize: "0.7rem",
            letterSpacing: "0.35em",
            textTransform: "uppercase",
            color: "#C65D3B",
            ...(prefersReduced
              ? { opacity: 1 }
              : phase === "exit"
              ? {
                  animation: "intro-text-exit 0.35s ease forwards",
                  animationDelay: "0.05s",
                }
              : {
                  animation: "intro-sub-reveal 0.6s ease forwards",
                  animationDelay: "1s",
                  opacity: 0,
                }),
          }}
        >
          Copyright Cleaner
        </p>
      </div>

      {/* ── Corner labels ──────────────────────────────────────────────── */}
      <div
        style={{
          position: "absolute",
          bottom: "2.5rem",
          left: 0,
          right: 0,
          padding: "0 2.5rem",
          display: "flex",
          justifyContent: "space-between",
          pointerEvents: "none",
        }}
      >
        {(["Scan", "Clean"] as const).map((label, i) => (
          <span
            key={label}
            style={{
              fontFamily:
                'var(--font-courier), "Courier Prime", monospace',
              fontSize: "0.6rem",
              letterSpacing: "0.2em",
              textTransform: "uppercase",
              color: "#1F1F1F",
              ...(prefersReduced
                ? { opacity: 1 }
                : phase === "exit"
                ? {
                    animation: "intro-text-exit 0.35s ease forwards",
                    animationDelay: "0s",
                  }
                : {
                    animation: "intro-sub-reveal 0.6s ease forwards",
                    animationDelay: i === 0 ? "1.2s" : "1.4s",
                    opacity: 0,
                  }),
            }}
          >
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

export { introHasPlayed };
