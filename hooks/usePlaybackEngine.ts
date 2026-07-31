"use client";

import { useEffect, useRef, useCallback } from "react";
import type { MediaItem, TrackSegment } from "@/lib/types";

/* ─── Types ──────────────────────────────────────────────────────────────── */

export interface ElementPool {
  getVideo(id: string): HTMLVideoElement | undefined;
  getAudio(id: string): HTMLAudioElement | undefined;
  setVideo(id: string, el: HTMLVideoElement | null): void;
  setAudio(id: string, el: HTMLAudioElement | null): void;
}

export interface PlaybackEngineOptions {
  items: MediaItem[];
  videoSegments: TrackSegment[];
  audioSegments: TrackSegment[];
  playing: boolean;
  muted: boolean;
  previewVolume: number;
  /** Timeline duration (seconds) */
  timelineDuration: number;
  /**
   * Called once per RAF tick with the current clock position and active video
   * id.  Runs outside React — do NOT call setState here.  Use it to move DOM
   * nodes (playhead needle, scroll position) imperatively.
   */
  onTick: (t: number, activeVideoId: string | null) => void;
  /**
   * Called only on explicit seek or play-end — safe to write to React state.
   * NOT called on every animation frame.
   */
  onTimeUpdate: (t: number) => void;
  onPlayEnd: () => void;
}

/* ─── Helpers ────────────────────────────────────────────────────────────── */

function findCovering(
  segments: TrackSegment[],
  t: number
): TrackSegment | null {
  for (const seg of segments) {
    const end = seg.timelineStart + (seg.srcEnd - seg.srcStart);
    if (t >= seg.timelineStart - 1e-6 && t <= end + 1e-6) return seg;
  }
  return null;
}

function segmentSourceTime(seg: TrackSegment, t: number): number {
  return seg.srcStart + (t - seg.timelineStart);
}

/* ─── Hook ───────────────────────────────────────────────────────────────── */

export function usePlaybackEngine(options: PlaybackEngineOptions) {
  const opts = useRef(options);
  opts.current = options;

  /* ── Element pool ────────────────────────────────────────────────────── */
  const videoMap = useRef(new Map<string, HTMLVideoElement>());
  const audioMap = useRef(new Map<string, HTMLAudioElement>());

  // Stable object reference — must not be recreated on each render, otherwise
  // React re-runs all ref callbacks (setVideo/setAudio) every render, which
  // briefly removes then re-adds elements from the map during the null→el cycle.
  const pool = useRef<ElementPool>({
    getVideo: (id) => videoMap.current.get(id),
    getAudio: (id) => audioMap.current.get(id),
    setVideo: (id, el) => {
      if (el) videoMap.current.set(id, el);
      else videoMap.current.delete(id);
    },
    setAudio: (id, el) => {
      if (el) audioMap.current.set(id, el);
      else audioMap.current.delete(id);
    },
  }).current;

  /* ── Master clock ────────────────────────────────────────────────────── */
  const clockRef = useRef(0);
  const lastFrameRef = useRef<number | null>(null);
  const prevVideoSegRef = useRef<TrackSegment | null>(null);
  const prevAudioSegRef = useRef<TrackSegment | null>(null);
  const rafRef = useRef<number | null>(null);

  /* ── RAF loop ────────────────────────────────────────────────────────── */
  const tick = useCallback((ts: number) => {
    rafRef.current = requestAnimationFrame(tick);
    const o = opts.current;

    // dt
    const prev = lastFrameRef.current;
    lastFrameRef.current = ts;
    const dt = prev !== null ? Math.min((ts - prev) / 1000, 0.1) : 0;

    if (o.playing) {
      clockRef.current = Math.min(
        clockRef.current + dt,
        o.timelineDuration
      );
      if (clockRef.current >= o.timelineDuration && o.timelineDuration > 0) {
        clockRef.current = o.timelineDuration;
        o.onPlayEnd();
      }
    }

    const t = clockRef.current;

    // ── Video lane sync ─────────────────────────────────────────────── //
    const videoSeg = findCovering(o.videoSegments, t);
    const segChanged = videoSeg?.id !== prevVideoSegRef.current?.id;
    prevVideoSegRef.current = videoSeg;

    let activeVideoId: string | null = null;

    for (const item of o.items) {
      const el = videoMap.current.get(item.id);
      if (!el) continue;
      el.muted = true;

      if (videoSeg && videoSeg.mediaId === item.id && videoSeg.enabled) {
        activeVideoId = item.id;
        const target = segmentSourceTime(videoSeg, t);
        const drift = Math.abs(el.currentTime - target);
        const threshold = !o.playing ? 0.05 : segChanged ? 0.08 : 0.25;
        if (drift > threshold && !el.seeking) {
          el.currentTime = target;
        }
        if (o.playing && el.paused) {
          el.play().catch(() => undefined);
        } else if (!o.playing && !el.paused) {
          el.pause();
        }
      } else {
        if (!el.paused) el.pause();
      }
    }

    // ── Audio lane sync ─────────────────────────────────────────────── //
    const audioSeg = findCovering(o.audioSegments, t);
    const audioSegChanged = audioSeg?.id !== prevAudioSegRef.current?.id;
    prevAudioSegRef.current = audioSeg;

    for (const item of o.items) {
      const el = audioMap.current.get(item.id);
      if (!el) continue;

      if (audioSeg && audioSeg.mediaId === item.id) {
        const target = segmentSourceTime(audioSeg, t);
        const drift = Math.abs(el.currentTime - target);
        const threshold = !o.playing ? 0.05 : audioSegChanged ? 0.08 : 1.0;
        if (drift > threshold && !el.seeking) {
          el.currentTime = target;
        }
        const segDisabled = !audioSeg.enabled;
        el.muted = o.muted || segDisabled;
        el.volume = Math.max(0, Math.min(1, o.previewVolume * (audioSeg.gain ?? 1)));

        if (o.playing && el.paused && !segDisabled) {
          el.play().catch(() => undefined);
        } else if ((!o.playing || segDisabled) && !el.paused) {
          el.pause();
        }
      } else {
        if (!el.paused) el.pause();
      }
    }

    // ── Clock authority — pull from audio element ────────────────────── //
    if (o.playing && audioSeg) {
      const ael = audioMap.current.get(audioSeg.mediaId);
      if (ael && !ael.paused && !ael.seeking) {
        clockRef.current =
          audioSeg.timelineStart + (ael.currentTime - audioSeg.srcStart);
      }
    }

    // ── Imperative tick — no setState, moves DOM directly ───────────── //
    o.onTick(clockRef.current, activeVideoId);
  }, []);

  // Start/stop RAF
  useEffect(() => {
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [tick]);

  /* ── Play / pause / seek API ─────────────────────────────────────────── */

  const play = useCallback(() => {
    const o = opts.current;
    if (o.timelineDuration === 0) return;
    if (clockRef.current >= o.timelineDuration - 0.02) {
      clockRef.current = 0;
    }
    lastFrameRef.current = null;
    // Start elements immediately inside the gesture so the browser's
    // autoplay policy treats this as a user-initiated play.
    const t = clockRef.current;
    const videoSeg = findCovering(o.videoSegments, t);
    const audioSeg = findCovering(o.audioSegments, t);
    if (videoSeg) {
      const vel = videoMap.current.get(videoSeg.mediaId);
      if (vel) {
        vel.currentTime = segmentSourceTime(videoSeg, t);
        vel.play().catch(() => undefined);
      }
    }
    if (audioSeg && audioSeg.enabled) {
      const ael = audioMap.current.get(audioSeg.mediaId);
      if (ael) {
        ael.currentTime = segmentSourceTime(audioSeg, t);
        ael.muted = o.muted || !audioSeg.enabled;
        ael.volume = Math.max(0, Math.min(1, o.previewVolume * (audioSeg.gain ?? 1)));
        ael.play().catch((err) => {
          // Log autoplay rejections so they're visible in devtools
          console.warn("[playback] audio.play() rejected:", err);
        });
      }
    }
  }, []);

  const pause = useCallback(() => {
    videoMap.current.forEach((el) => { if (!el.paused) el.pause(); });
    audioMap.current.forEach((el) => { if (!el.paused) el.pause(); });
  }, []);

  const seek = useCallback((t: number) => {
    const dur = opts.current.timelineDuration;
    const clamped = Math.max(0, Math.min(dur, t));
    clockRef.current = clamped;
    opts.current.onTimeUpdate(clamped);
  }, []);

  const seekDelta = useCallback((delta: number) => {
    const dur = opts.current.timelineDuration;
    seek(Math.max(0, Math.min(dur, clockRef.current + delta)));
  }, [seek]);

  return { pool, play, pause, seek, seekDelta, clockRef };
}
