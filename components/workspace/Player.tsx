"use client";

import React, { useRef, useEffect, useCallback, useState } from "react";
import type { MediaItem } from "@/lib/types";
import type { ElementPool } from "@/hooks/usePlaybackEngine";

interface PlayerProps {
  items: MediaItem[];
  activeVideoMediaId: string | null;
  pool: ElementPool;
  onTogglePlay: () => void;
  /** Map populated by WorkspacePanel for imperative display toggling from onTick. */
  videoElsRef?: React.RefObject<Map<string, HTMLVideoElement>>;
}

/* ── Human-readable MediaError codes ──────────────────────────────────────── */
function mediaErrorMessage(err: MediaError | null): string {
  if (!err) return "Unknown media error.";
  switch (err.code) {
    case MediaError.MEDIA_ERR_ABORTED:
      return "Playback was aborted by the browser.";
    case MediaError.MEDIA_ERR_NETWORK:
      return "A network error interrupted the media.";
    case MediaError.MEDIA_ERR_DECODE:
      return "The browser could not decode the media (MEDIA_ERR_DECODE). This can happen when the browser loads the same file in two contexts simultaneously — it has now been cleared.";
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return "The media source is no longer supported in this context (MEDIA_ERR_SRC_NOT_SUPPORTED).";
    default:
      return `Media error code ${err.code}.`;
  }
}

export function Player({
  items,
  activeVideoMediaId,
  pool,
  onTogglePlay,
  videoElsRef,
}: PlayerProps) {
  const showGap = activeVideoMediaId === null;
  // Track which item ids we've already wired up (diagnostic + pool + videoElsRef).
  // Using a ref means the setup runs only once per item id, not on every render.
  const wiredRef = useRef<Set<string>>(new Set());

  /* ── Per-item error state ─────────────────────────────────────────────── */
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Track which items we've already attached error listeners to.
  const listenedRef = useRef<Set<string>>(new Set());
  // Whether this component is still mounted — stops stale timers from firing.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  /* ── Attach error listeners whenever the item list changes ───────────── */
  useEffect(() => {
    const attachToEl = (item: MediaItem, el: HTMLVideoElement | HTMLAudioElement) => {
      el.addEventListener("error", () => {
        const msg = mediaErrorMessage(el.error);
        console.error(`[player] media error on ${item.name}:`, el.error);
        if (mountedRef.current) {
          setErrors((prev) => ({ ...prev, [item.id]: msg }));
        }
      });
    };

    for (const item of items) {
      if (listenedRef.current.has(item.id)) continue;
      listenedRef.current.add(item.id);

      // Elements are registered via ref callbacks synchronously during this
      // render cycle. Try once immediately, then once after a single 50 ms
      // tick (covers the case where the ref callback fires after the effect).
      // We do NOT loop indefinitely — if the element never appears, we simply
      // won't have an error listener for it (not a functional problem).
      const tryAttach = () => {
        if (!mountedRef.current) return;
        const vel = pool.getVideo(item.id);
        const ael = pool.getAudio(item.id);
        if (vel) attachToEl(item, vel);
        if (ael) attachToEl(item, ael);
      };
      tryAttach();
      // One deferred attempt in case the ref callback hasn't fired yet.
      const tid = setTimeout(() => {
        if (!listenedRef.current.has(item.id)) return; // already removed
        tryAttach();
      }, 50);
      // Store the timer so it can be cancelled on unmount if needed.
      // (The mountedRef guard inside tryAttach is sufficient, but
      //  clearing the timer avoids a harmless no-op call.)
      void tid; // timer is intentionally fire-and-forget after the 50 ms guard
    }
  }, [items, pool]);

  /* ── Reload a specific item's media elements ─────────────────────────── */
  const handleReload = useCallback(
    (item: MediaItem) => {
      const reload = (el: HTMLVideoElement | HTMLAudioElement | undefined) => {
        if (!el) return;
        // Resetting src clears the error state so the element becomes usable again.
        el.src = "";
        el.load();
        el.src = item.url;
        el.load();
      };
      reload(pool.getVideo(item.id));
      reload(pool.getAudio(item.id));
      // Remove the error banner for this item
      setErrors((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
    },
    [pool]
  );

  return (
    <div className="player-wrapper-outer">
      {/* Error banners — one per affected item */}
      {items
        .filter((item) => errors[item.id])
        .map((item) => (
          <div key={item.id} className="player-media-error" role="alert">
            <span className="player-media-error__msg">
              ⚠ Media error — {errors[item.id]}
            </span>
            <button
              className="player-media-error__reload"
              type="button"
              onClick={() => handleReload(item)}
            >
              Reload media
            </button>
          </div>
        ))}

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
                ref={(el) => {
                  // RENDER-PATH: runs on every render with the same el reference
                  // after mount.  Pool and videoElsRef are always up to date.
                  pool.setVideo(item.id, el);
                  if (videoElsRef?.current && el) videoElsRef.current.set(item.id, el);
                  else if (videoElsRef?.current && !el) videoElsRef.current.delete(item.id);

                  // MOUNT-PATH: one-time setup per item id.
                  if (!el || wiredRef.current.has(item.id)) return;
                  wiredRef.current.add(item.id);

                  // ── DIAGNOSTIC (mount only) ──────────────────────────────
                  const report = (label: string) => {
                    console.log(
                      `[player-diag] ${label} | item=${item.id}` +
                      ` src="${el.src.slice(0, 60)}"` +
                      ` srcLive=${el.src.startsWith("blob:")}` +
                      ` readyState=${el.readyState}` +
                      ` networkState=${el.networkState}` +
                      ` videoW=${el.videoWidth}` +
                      ` videoH=${el.videoHeight}` +
                      ` error=${el.error ? `code${el.error.code}:"${el.error.message}"` : "none"}`
                    );
                  };
                  console.log(`[player-diag] MOUNT item=${item.id}`);
                  el.addEventListener("loadedmetadata", () => report("loadedmetadata"), { once: true });
                  el.addEventListener("loadeddata",     () => report("loadeddata"),     { once: true });
                  el.addEventListener("canplay",        () => report("canplay"),        { once: true });
                  el.addEventListener("error",          () => report("error"),          { once: true });
                  // ────────────────────────────────────────────────────────
                }}
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
    </div>
  );
}
