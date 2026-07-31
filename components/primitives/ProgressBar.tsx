import React from "react";

interface ProgressBarProps {
  /** 0–100. Omit for indeterminate. */
  value?: number;
  /** Stage-card tall variant. */
  tall?: boolean;
  /** For stage cards — colour of the fill. Defaults to var(--accent). */
  fillColor?: string;
  className?: string;
}

export function ProgressBar({ value, tall, fillColor, className }: ProgressBarProps) {
  const indeterminate = value === undefined;
  const trackClass = [
    "progress-track",
    tall ? "progress-track--tall" : null,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const fillClass = [
    "progress-fill",
    tall ? "progress-fill--stage" : null,
    indeterminate ? "progress-fill--indeterminate" : null,
  ]
    .filter(Boolean)
    .join(" ");

  const fillStyle: React.CSSProperties = {
    ...(fillColor ? { background: fillColor } : {}),
    ...(!indeterminate ? { width: `${Math.max(0, Math.min(100, value ?? 0))}%` } : {}),
  };

  return (
    <div
      className={trackClass}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      {...(!indeterminate ? { "aria-valuenow": value } : {})}
    >
      <div className={fillClass} style={fillStyle} />
    </div>
  );
}
