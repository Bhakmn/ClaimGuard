"use client";

import React, { useRef, useState } from "react";

interface CardFrontProps {
  step: "drop" | "queue";
  dropError: string | null;
  onEnqueueFiles: (files: FileList | File[]) => void;
  onClearError: () => void;
}

export function CardFront({
  step,
  dropError,
  onEnqueueFiles,
  onClearError,
}: CardFrontProps) {
  const [draggingOver, setDraggingOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isFront = step === "drop";

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    setDraggingOver(true);
    onClearError();
  }

  function handleDragLeave(e: React.DragEvent) {
    // Only clear if leaving the zone entirely (not its children)
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDraggingOver(false);
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDraggingOver(false);
    if (e.dataTransfer.files.length) {
      onEnqueueFiles(e.dataTransfer.files);
    }
  }

  function handleZoneClick() {
    fileInputRef.current?.click();
  }

  return (
    <div
      className={[
        "launch-card-front card-in paper-texture",
        isFront
          ? "launch-card-front--drop"
          : "launch-card-front--queue",
      ].join(" ")}
    >
      {/* Notch */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: "50%",
          transform: "translateX(-50%)",
          width: 128,
          height: 48,
          background: "#F4F1EA",
          borderBottomLeftRadius: 9999,
          borderBottomRightRadius: 9999,
          zIndex: 40,
        }}
        aria-hidden="true"
      />

      {/* Body */}
      <div
        style={{
          padding: "32px",
          display: "flex",
          flexDirection: "column",
          height: "100%",
          position: "relative",
          pointerEvents: isFront ? undefined : "none",
        }}
      >
        {/* Heading */}
        <div
          className="font-serif-display"
          style={{ marginTop: 32, fontSize: 48, lineHeight: 1, color: "#1F1F1F" }}
        >
          <div style={{ letterSpacing: "-0.02em" }}>Clean</div>
          <div style={{ fontStyle: "italic", paddingLeft: 16 }}>your video</div>
        </div>

        {/* Drop zone */}
        <div style={{ flex: 1, marginTop: 32, display: "flex", flexDirection: "column", gap: 16 }}>
          <div
            role="button"
            tabIndex={0}
            className={[
              "launch-drop-zone",
              draggingOver ? "launch-drop-zone--over" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            onClick={handleZoneClick}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") handleZoneClick();
            }}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            aria-label="Drop video here or click to choose a file"
          >
            <div
              className="font-serif-display"
              style={{
                fontSize: 36,
                marginBottom: 8,
                color: "#1F1F1F",
              }}
            >
              ↑
            </div>
            <div
              style={{
                fontFamily:
                  'var(--font-courier),"Courier Prime",monospace',
                fontSize: 12,
                textTransform: "uppercase",
                letterSpacing: "0.2em",
                marginBottom: 4,
                color: "#1F1F1F",
              }}
            >
              Drop video here
            </div>
            <div
              style={{
                fontFamily:
                  'var(--font-courier),"Courier Prime",monospace',
                fontSize: 10,
                color: "rgba(31,31,31,0.5)",
              }}
            >
              mp4 · mov · webm · mkv
            </div>
          </div>

          {/* Inline error */}
          {dropError && (
            <p
              style={{
                fontFamily:
                  'var(--font-courier),"Courier Prime",monospace',
                fontSize: 11,
                color: "#7A2A1C",
                textAlign: "center",
              }}
            >
              {dropError}
            </p>
          )}

          {/* Footnote */}
          <p
            style={{
              marginTop: 16,
              fontFamily:
                'var(--font-courier),"Courier Prime",monospace',
              fontSize: 10,
              color: "rgba(31,31,31,0.4)",
              lineHeight: 1.625,
            }}
          >
            Nothing is uploaded; only tiny audio
            <br />
            samples are sent for matching.
          </p>
        </div>

        {/* Hidden input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*,.mp4,.mov,.m4v,.webm,.mkv,.avi"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            if (e.target.files?.length) onEnqueueFiles(e.target.files);
            e.target.value = "";
          }}
        />

        {/* Choose-file control */}
        <div
          style={{
            position: "absolute",
            bottom: 40,
            right: 40,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
          }}
        >
          <button
            aria-label="Choose a video file"
            onClick={handleZoneClick}
            style={{
              width: 56,
              height: 56,
              borderRadius: "50%",
              background: "#1F1F1F",
              color: "#FFC233",
              border: "none",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow:
                "0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)",
              transition: "transform 150ms",
            }}
            onMouseEnter={(e) => {
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
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
          <span
            style={{
              fontFamily:
                'var(--font-courier),"Courier Prime",monospace',
              fontSize: 8,
              textTransform: "uppercase",
              letterSpacing: "0.2em",
              color: "rgba(31,31,31,0.7)",
              whiteSpace: "nowrap",
            }}
          >
            Choose file
          </span>
        </div>
      </div>
    </div>
  );
}
