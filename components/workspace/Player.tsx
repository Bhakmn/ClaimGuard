"use client";

import React, { useRef, useEffect, useCallback } from "react";
import type { MediaItem, TrackSegment } from "@/lib/types";
import type { ElementPool } from "@/hooks/usePlaybackEngine";

interface PlayerProps {
  items: MediaItem[];
  videoSegments: TrackSegment[];
  activeVideoMediaId: string | null;
  pool: ElementPool;
  onTogglePlay: () => void;
}

export function Player({
  items,
  videoSegments,
  activeVideoMediaId,
  pool,
  onTogglePlay,
}: PlayerProps) {
  const showGap = activeVideoMediaId === null;

  return (
    <button
      className="player-wrapper"
      onClick={onTogglePlay}
      aria-label="Play or pause the preview"
      title="Click to play / pause (Space)"
      type="button"
    >
      {/* Element pool — all elements always mounted, visibility controlled */}
      {items.map((item) => (
        <React.Fragment key={item.id}>
          {item.kind === "video" && (
            <video
              ref={(el) => pool.setVideo(item.id, el)}
              src={item.url}
              className="player"
              muted
              playsInline
              preload="auto"
              style={{
                display:
                  activeVideoMediaId === item.id ? "block" : "none",
              }}
            />
          )}
          {/* Audio element — always hidden */}
          <audio
            ref={(el) => pool.setAudio(item.id, el)}
            src={item.url}
            preload="auto"
            style={{ display: "none" }}
          />
        </React.Fragment>
      ))}

      {/* Gap state */}
      {showGap && (
        <div className="player-gap">
          🚫 no video here (black in the export)
        </div>
      )}
    </button>
  );
}
