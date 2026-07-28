"use client";

import React, { useRef } from "react";
import { formatSize } from "@/lib/formatters";

interface CardMiddleProps {
  step: "drop" | "queue";
  queue: File[];
  onEnqueueFiles: (files: FileList | File[]) => void;
  onRemove: (index: number) => void;
  onBack: () => void;
  onStart: () => void;
  loading: boolean;
}

export function CardMiddle({
  step,
  queue,
  onEnqueueFiles,
  onRemove,
  onBack,
  onStart,
  loading,
}: CardMiddleProps) {
  const addInputRef = useRef<HTMLInputElement>(null);
  const isFront = step === "queue";

  const queueLabel =
    queue.length === 0
      ? "No videos yet"
      : queue.length === 1
      ? "1 video queued"
      : `${queue.length} videos queued`;

  return (
    <div
      className={[
        "launch-card-middle card-in paper-texture",
        isFront
          ? "launch-card-middle--queue"
          : "launch-card-middle--drop",
      ].join(" ")}
    >
      <div
        style={{
          padding: 32,
          display: "flex",
          flexDirection: "column",
          height: "100%",
          position: "relative",
          overflow: "hidden",
          pointerEvents: isFront ? undefined : "none",
        }}
      >
        {/* Heading */}
        <div
          className="font-serif-display"
          style={{ marginTop: 24, fontSize: 36, lineHeight: 1, color: "#F4F1EA" }}
        >
          <div style={{ letterSpacing: "-0.02em" }}>Ready to</div>
          <div style={{ fontStyle: "italic", paddingLeft: 16 }}>scan</div>
        </div>

        {/* Queue header row */}
        <div
          style={{
            marginTop: 16,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
          }}
        >
          <span
            style={{
              fontFamily:
                'var(--font-courier),"Courier Prime",monospace',
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: "0.2em",
              opacity: 0.6,
              color: "#F4F1EA",
            }}
          >
            {queueLabel}
          </span>
          <button
            onClick={() => addInputRef.current?.click()}
            style={{
              fontFamily:
                'var(--font-courier),"Courier Prime",monospace',
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: "0.2em",
              border: "1px solid rgba(244,241,234,0.4)",
              padding: "6px 12px",
              borderRadius: 4,
              background: "transparent",
              color: "#F4F1EA",
              cursor: "pointer",
              transition: "background-color 150ms",
              flexShrink: 0,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "rgba(244,241,234,0.1)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
            }}
          >
            + Add another
          </button>
          <input
            ref={addInputRef}
            type="file"
            accept="video/*,.mp4,.mov,.m4v,.webm,.mkv,.avi"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              if (e.target.files?.length) onEnqueueFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>

        {/* Queue list */}
        <div
          style={{
            flex: 1,
            marginTop: 16,
            overflowY: "auto",
            paddingRight: 4,
            paddingBottom: 80,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {queue.length === 0 ? (
            <p
              style={{
                fontFamily:
                  'var(--font-courier),"Courier Prime",monospace',
                fontSize: 12,
                lineHeight: 1.625,
                opacity: 0.5,
                color: "#F4F1EA",
              }}
            >
              Drop a video on the yellow card to add it here.
            </p>
          ) : (
            queue.map((file, i) => (
              <div
                key={`${file.name}-${file.size}-${i}`}
                className="queue-row"
              >
                {/* Index */}
                <span
                  style={{
                    fontFamily:
                      'var(--font-courier),"Courier Prime",monospace',
                    fontSize: 10,
                    opacity: 0.5,
                    color: "#F4F1EA",
                    flexShrink: 0,
                  }}
                >
                  {String(i + 1).padStart(2, "0")}
                </span>

                {/* Detail */}
                <div
                  style={{
                    minWidth: 0,
                    flex: 1,
                  }}
                >
                  <div
                    style={{
                      fontFamily:
                        'var(--font-courier),"Courier Prime",monospace',
                      fontSize: 12,
                      color: "#F4F1EA",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {file.name}
                  </div>
                  <div
                    style={{
                      fontFamily:
                        'var(--font-courier),"Courier Prime",monospace',
                      fontSize: 10,
                      opacity: 0.5,
                      color: "#F4F1EA",
                    }}
                  >
                    {formatSize(file.size)}
                  </div>
                </div>

                {/* Remove */}
                <button
                  aria-label={`Remove ${file.name}`}
                  onClick={() => onRemove(i)}
                  style={{
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    fontFamily:
                      'var(--font-courier),"Courier Prime",monospace',
                    fontSize: 12,
                    color: "#F4F1EA",
                    opacity: 0.6,
                    flexShrink: 0,
                    transition: "opacity 150ms",
                    padding: "0 2px",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.opacity = "1";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.opacity = "0.6";
                  }}
                >
                  ✕
                </button>
              </div>
            ))
          )}
        </div>

        {/* Back control */}
        <button
          onClick={onBack}
          style={{
            position: "absolute",
            bottom: 40,
            left: 32,
            background: "none",
            border: "none",
            cursor: "pointer",
            fontFamily:
              'var(--font-courier),"Courier Prime",monospace',
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.2em",
            color: "#F4F1EA",
            opacity: 0.6,
            transition: "opacity 150ms",
            padding: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.opacity = "1";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.opacity = "0.6";
          }}
        >
          ← Back
        </button>

        {/* Start control */}
        <div
          style={{
            position: "absolute",
            bottom: 40,
            right: 32,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
          }}
        >
          <button
            aria-label="Start scanning the first queued video"
            onClick={queue.length > 0 && !loading ? onStart : undefined}
            disabled={queue.length === 0 || loading}
            style={{
              width: 56,
              height: 56,
              borderRadius: "50%",
              background: "#F4F1EA",
              color: "#C65D3B",
              border: "none",
              cursor:
                queue.length === 0 || loading ? "not-allowed" : "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow:
                "0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)",
              transition: "transform 150ms",
              opacity: queue.length === 0 || loading ? 0.4 : 1,
            }}
            onMouseEnter={(e) => {
              if (queue.length > 0 && !loading)
                e.currentTarget.style.transform = "scale(1.1)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = "scale(1)";
            }}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </button>
          <span
            style={{
              fontFamily:
                'var(--font-courier),"Courier Prime",monospace',
              fontSize: 8,
              textTransform: "uppercase",
              letterSpacing: "0.2em",
              opacity: 0.7,
              color: "#F4F1EA",
              whiteSpace: "nowrap",
            }}
          >
            Start
          </span>
        </div>
      </div>
    </div>
  );
}
