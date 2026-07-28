import type { MediaItem, WaveformData, ThumbnailStrip } from "../types";
import { delay, getControls } from "./delay";

export interface MediaService {
  probe(
    url: string,
    kind: "video" | "audio"
  ): Promise<{ duration: number; width: number; height: number }>;

  loadWaveform(item: MediaItem): Promise<WaveformData | null>;

  buildThumbnails(item: MediaItem): Promise<ThumbnailStrip | null>;
}

/* ─── Pseudo-random helper seeded from file name + size ─────────────────── */

function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function seedFromItem(item: MediaItem): number {
  let h = item.file.size;
  for (let i = 0; i < item.name.length; i++) {
    h = (Math.imul(31, h) + item.name.charCodeAt(i)) >>> 0;
  }
  return h;
}

/* ─── Flag window fractions (mirrored from ScanService fixture data) ─────── */

const FLAG_WINDOWS = [
  { from: 0.08, to: 0.27 },
  { from: 0.41, to: 0.55 },
  { from: 0.78, to: 0.93 },
];

function inFlagWindow(t: number, duration: number): boolean {
  const f = t / duration;
  return FLAG_WINDOWS.some((w) => f >= w.from && f <= w.to);
}

/* ─── Mock implementation ────────────────────────────────────────────────── */

export const mockMediaService: MediaService = {
  probe(url, kind) {
    return new Promise((resolve, reject) => {
      const el = document.createElement(kind === "video" ? "video" : "audio");
      el.preload = "metadata";
      el.src = url;

      const timeout = setTimeout(() => {
        el.src = "";
        reject(new Error("Could not read the media file."));
      }, 10_000);

      el.addEventListener("loadedmetadata", () => {
        clearTimeout(timeout);
        const duration = el.duration;
        const width = kind === "video" ? (el as HTMLVideoElement).videoWidth : 0;
        const height =
          kind === "video" ? (el as HTMLVideoElement).videoHeight : 0;
        el.src = "";
        resolve({ duration, width, height });
      });

      el.addEventListener("error", () => {
        clearTimeout(timeout);
        el.src = "";
        reject(new Error("Could not read the media file."));
      });
    });
  },

  async loadWaveform(item) {
    const controls = getControls();
    if (controls.stallMedia) return new Promise(() => undefined);
    if (controls.offline) return null;

    await delay(900);

    const RATE = 8000;
    const sampleCount = Math.ceil(item.duration * RATE);
    const peaks = new Float32Array(sampleCount);
    const rand = makePrng(seedFromItem(item));

    // Determine breath positions (3 evenly spaced dips)
    const breathTimes = [
      item.duration * 0.25,
      item.duration * 0.5,
      item.duration * 0.75,
    ];
    const BREATH_HALF = 0.2; // half-width of each dip

    for (let i = 0; i < sampleCount; i++) {
      const t = i / RATE;
      const noise = rand();

      // Breath dip?
      const inBreath = breathTimes.some(
        (bt) => Math.abs(t - bt) <= BREATH_HALF
      );
      if (inBreath) {
        peaks[i] = 0.05;
        continue;
      }

      // Inside a flag window?
      const wIdx = FLAG_WINDOWS.findIndex((w) => {
        const f = t / item.duration;
        return f >= w.from && f <= w.to;
      });

      if (wIdx >= 0) {
        const w = FLAG_WINDOWS[wIdx];
        const wStart = w.from * item.duration;
        const wEnd = w.to * item.duration;
        const RAMP = 0.35;
        let scale = 1;
        if (t < wStart + RAMP) scale = (t - wStart) / RAMP;
        else if (t > wEnd - RAMP) scale = (wEnd - t) / RAMP;
        scale = Math.max(0, Math.min(1, scale));
        peaks[i] = (0.55 + noise * 0.4) * scale + (0.08 + noise * 0.12) * (1 - scale);
      } else {
        peaks[i] = 0.08 + noise * 0.12;
      }
    }

    let globalMax = 0;
    for (let i = 0; i < sampleCount; i++) {
      if (peaks[i] > globalMax) globalMax = peaks[i];
    }
    if (globalMax < 0.0001) globalMax = 0.0001;

    return { peaks, sampleRate: RATE, globalMax };
  },

  async buildThumbnails(item) {
    const controls = getControls();
    if (item.kind === "audio") return null;
    if (controls.stallMedia) return new Promise(() => undefined);
    if (controls.offline) return null;

    const FRAME_H = 112;
    const aspect = item.width && item.height ? item.width / item.height : 16 / 9;
    const frameW = Math.round(FRAME_H * aspect);
    const frameCount = Math.max(8, Math.min(40, Math.floor(item.duration / 2)));

    const frames: { time: number; bitmap: ImageBitmap }[] = [];

    // Use a hidden <video> element to seek-and-capture each frame.
    // Must be in the DOM and use preload="auto" so the browser actually buffers
    // frame data (not just metadata), making seeks reliable.
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.playsInline = true;
    video.crossOrigin = "anonymous";
    video.style.cssText =
      "position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;pointer-events:none;opacity:0";
    document.body.appendChild(video);

    try {
      // Set src and explicitly call load() — required for preload="auto" to start.
      video.src = item.url;
      video.load();

      // Wait until the browser has buffered enough to seek anywhere (loadeddata
      // fires after the first frame is decoded; for short files that's enough,
      // and for long files the seeks below have individual timeouts as fallback).
      await new Promise<void>((resolve, reject) => {
        const tid = setTimeout(resolve, 8_000); // timeout → try seeking anyway
        const onReady = () => { clearTimeout(tid); resolve(); };
        const onError = () => { clearTimeout(tid); reject(new Error("video load error")); };
        video.addEventListener("loadeddata", onReady, { once: true });
        video.addEventListener("error", onError, { once: true });
      });

      for (let i = 0; i < frameCount; i++) {
        const time = ((i + 0.5) / frameCount) * item.duration;

        // Seek to the target time; fall through on timeout rather than rejecting.
        await new Promise<void>((resolve) => {
          const tid = setTimeout(resolve, 4_000);
          video.addEventListener("seeked", () => { clearTimeout(tid); resolve(); }, { once: true });
          video.currentTime = time;
        });

        // Capture frame — if the seek timed out the browser will draw whatever
        // it has, which is still better than a blank tile.
        const canvas = new OffscreenCanvas(frameW, FRAME_H);
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        ctx.drawImage(video, 0, 0, frameW, FRAME_H);
        frames.push({ time, bitmap: await createImageBitmap(canvas) });
      }
    } finally {
      video.src = "";
      document.body.removeChild(video);
    }

    return frames.length > 0 ? { frames, aspect } : null;
  },
};
