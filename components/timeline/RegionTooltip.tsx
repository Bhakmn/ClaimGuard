"use client";

import React from "react";
import type { FlaggedSpan } from "@/lib/types";
import { formatClock } from "@/lib/formatters";

export interface TooltipData {
  span: FlaggedSpan;
  blockLeft: number;    // timeline px
  blockWidth: number;   // timeline px
  clientX: number;
  audioTrackTop: number; // client Y of audio track top
  pixelsPerSecond: number;
  scrollLeft: number;
}

interface RegionTooltipProps {
  data: TooltipData;
}

export function RegionTooltip({ data }: RegionTooltipProps) {
  const { span, blockLeft, blockWidth, clientX, audioTrackTop, pixelsPerSecond, scrollLeft } = data;

  // Timeline positions of this block
  const blockStartTime = (blockLeft + scrollLeft) / pixelsPerSecond;
  const blockEndTime = blockStartTime + blockWidth / pixelsPerSecond;
  const lengthSec = blockEndTime - blockStartTime;

  const x = Math.max(154, Math.min(window.innerWidth - 154, clientX));
  const y = audioTrackTop + 2;

  return (
    <div
      className="region-tooltip"
      style={{ left: x, top: y }}
      role="tooltip"
    >
      {/* Heading */}
      <div style={{ color: "#FFC233", fontSize: 10.5, fontWeight: 700, letterSpacing: "0.03em", marginBottom: 6 }}>
        ⚠ Possible copyright · {formatClock(blockStartTime)}–{formatClock(blockEndTime)} · {lengthSec.toFixed(1)}s
      </div>

      {/* Cause row */}
      {span.manual ? (
        <div style={{ display: "flex", gap: 7, alignItems: "flex-start", margin: "3px 0" }}>
          <span style={{ flexShrink: 0, fontSize: 11.5, lineHeight: 1.35 }}>✎</span>
          <div>
            <div style={{ fontSize: 11.5, lineHeight: 1.35 }}>Marked by hand</div>
            <div style={{ fontSize: 10, color: "#B8B3A6", marginTop: 1 }}>
              You added this region yourself, no automatic match behind it.
            </div>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 7, alignItems: "flex-start", margin: "3px 0" }}>
          <span style={{ flexShrink: 0, fontSize: 11.5, lineHeight: 1.35 }}>♪</span>
          <div>
            <div style={{ fontSize: 11.5, lineHeight: 1.35 }}>
              Music: {span.title}
              {span.artists ? ` · ${span.artists}` : ""}
            </div>
            <div style={{ fontSize: 10, color: "#B8B3A6", marginTop: 1 }}>
              {[
                span.album ? `album "${span.album}"` : null,
                span.confidence > 0 ? `${span.confidence}% match` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
          </div>
        </div>
      )}

      {/* Spared state line */}
      {!span.enabled && (
        <div style={{ marginTop: 5, fontSize: 10, color: "#FFC233" }}>
          Marked &ldquo;spare&rdquo;: this section stays in the export.
        </div>
      )}

      {/* Footnote */}
      <div
        style={{
          marginTop: 7,
          paddingTop: 5,
          borderTop: "1px solid rgba(244,241,234,0.18)",
          fontSize: 9.5,
          color: "#9B968A",
        }}
      >
        Only music detection runs for now; other sources (movies, clips…) aren&rsquo;t scanned yet.
      </div>
    </div>
  );
}
