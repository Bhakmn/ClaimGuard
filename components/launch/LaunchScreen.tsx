"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import type { MediaItem, AccountProfile } from "@/lib/types";
import { useServices } from "@/lib/services/provider";
import { NoiseOverlay } from "@/components/primitives/NoiseOverlay";
import { AccountControls } from "./AccountControls";
import { CardBack } from "./CardBack";
import { CardMiddle } from "./CardMiddle";
import { CardFront } from "./CardFront";
import { useFileIntake } from "@/hooks/useFileIntake";
import { nextId } from "@/lib/mock/scan-service";

interface LaunchScreenProps {
  queue: File[];
  launchStep: "drop" | "queue";
  onQueueChange: (q: File[]) => void;
  onStepChange: (s: "drop" | "queue") => void;
  onMediaReady: (item: MediaItem) => void;
  onDropError: (msg: string) => void;
}

const HOW_ITEMS = [
  {
    fill: "#1F1F1F",
    glyphColor: "white",
    glyph: "↑",
    title: "Upload",
    body: "Drag & drop your video onto the card.",
    delay: "0.5s",
  },
  {
    fill: "#C65D3B",
    glyphColor: "white",
    glyph: "◉",
    title: "Scan",
    body: "AI flags copyrighted music on the timeline.",
    delay: "0.6s",
  },
  {
    fill: "#FFC233",
    glyphColor: "#1F1F1F",
    glyph: "✂",
    title: "Edit & Export",
    body: "Cut, mute or replace it, then download clean.",
    delay: "0.7s",
  },
];

export function LaunchScreen({
  queue,
  launchStep,
  onQueueChange,
  onStepChange,
  onMediaReady,
  onDropError,
}: LaunchScreenProps) {
  const services = useServices();
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [dropError, setDropError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const offline = services.controls.offline;

  // Load account profile once on mount
  useEffect(() => {
    services.account.getProfile().then((p) => {
      setProfile(p);
      setProfileLoading(false);
    });
  }, [services.account]);

  // File intake
  const { enqueue, loadHead } = useFileIntake({
    mediaService: services.media,
    queue,
    onEnqueue: (files) => {
      setDropError(null);
      const next = [...queue, ...files];
      onQueueChange(next);
      onStepChange("queue");
    },
    onError: (msg) => {
      setDropError(msg);
      onDropError(msg);
    },
    onMediaReady,
    onLoadStart: () => setLoading(true),
    onLoadEnd: () => setLoading(false),
  });

  const handleStart = useCallback(async () => {
    if (queue.length === 0) return;
    const [head, ...rest] = queue;
    onQueueChange(rest);
    await loadHead(head);
  }, [queue, onQueueChange, loadHead]);

  const handleRemove = useCallback(
    (index: number) => {
      const next = queue.filter((_, i) => i !== index);
      onQueueChange(next);
      if (next.length === 0) onStepChange("drop");
    },
    [queue, onQueueChange, onStepChange]
  );

  return (
    <div className="launch-screen launch-screen">
      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <aside className="launch-sidebar">
        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          {/* Brand row */}
          <div className="brand-mark">
            <div className="brand-badge brand-badge--lg">
              <svg
                width="28"
                height="28"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                aria-hidden="true"
              >
                <path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z" />
                <path d="M9.5 12l1.8 1.8L15 10" />
              </svg>
            </div>
            <span className="brand-wordmark">ClaimGuard</span>
          </div>

          {/* Headline */}
          <h1
            className="font-serif-display"
            style={{
              marginTop: 8,
              fontWeight: 300,
              lineHeight: 0.9,
              fontSize: "clamp(2.5rem, 6vw, 3.75rem)",
              color: "#1F1F1F",
            }}
          >
            <div>Copyright</div>
            <div style={{ fontStyle: "italic", marginLeft: 24 }}>Safe</div>
            <div style={{ marginLeft: 48 }}>Videos</div>
          </h1>

          {/* Lead paragraph */}
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <p
              className="font-serif-display"
              style={{
                fontSize: 18,
                lineHeight: 1.625,
                color: "rgba(31,31,31,0.8)",
              }}
            >
              Find the copyrighted music hiding in your video, then cut, mute
              or replace it right in your browser.
            </p>
          </div>

          {/* How it works list */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 24,
              marginTop: 8,
              opacity: 0.75,
            }}
          >
            {HOW_ITEMS.map((item) => (
              <div
                key={item.title}
                className="how-item info-item"
                style={{ animationDelay: item.delay }}
              >
                {/* Glyph circle */}
                <div
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: "50%",
                    background: item.fill,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <span
                    className="font-serif-display"
                    style={{
                      fontSize: 20,
                      fontStyle: "italic",
                      color: item.glyphColor,
                    }}
                  >
                    {item.glyph}
                  </span>
                </div>
                {/* Text */}
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 2,
                  }}
                >
                  <div
                    className="font-serif-display"
                    style={{ fontSize: 18 }}
                  >
                    {item.title}
                  </div>
                  <div
                    style={{
                      fontFamily:
                        'var(--font-courier),"Courier Prime",monospace',
                      fontSize: 12,
                      lineHeight: 1.625,
                      opacity: 0.8,
                    }}
                  >
                    {item.body}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </aside>

      {/* ── Main column ─────────────────────────────────────────────────── */}
      <main className="launch-main">
        {/* Account controls */}
        <div className="launch-account">
          <AccountControls
            accountService={services.account}
            offline={offline}
            profile={profile}
            loading={profileLoading}
            onProfileChange={setProfile}
          />
        </div>

        {/* Card-stack container */}
        <div className="launch-card-container">
          <div className="launch-card-stack">
            {/* Card 1: back (warm gray) */}
            <CardBack />

            {/* Card 2: middle (terracotta) */}
            <CardMiddle
              step={launchStep}
              queue={queue}
              onEnqueueFiles={enqueue}
              onRemove={handleRemove}
              onBack={() => onStepChange("drop")}
              onStart={handleStart}
              loading={loading}
            />

            {/* Card 3: front (mustard) */}
            <CardFront
              step={launchStep}
              dropError={dropError}
              onEnqueueFiles={enqueue}
              onClearError={() => setDropError(null)}
            />
          </div>
        </div>
      </main>

      {/* Grain overlay */}
      <NoiseOverlay />
    </div>
  );
}
