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

/* ─── Thumbnail build — one concurrent build per item ID ────────────────── */

// Tracks the cancellation signal for any in-flight thumbnail build.
// Key = item.id. Value = a flag object; setting cancelled=true causes the
// running build to abandon its seek loop and resolve with whatever frames it
// has collected so far (typically none — we discard partial results).
const activeThumbnailBuilds = new Map<string, { cancelled: boolean }>();

/* ─── Mock implementation ────────────────────────────────────────────────── */

export const mockMediaService: MediaService = {
  probe(url, kind) {
    return new Promise((resolve, reject) => {
      const el = document.createElement(kind === "video" ? "video" : "audio");
      el.preload = "metadata";
      el.src = url;

      let settled = false;

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        el.removeAttribute("src");
        el.load();
        reject(new Error("Could not read the media file."));
      }, 10_000);

      el.addEventListener("loadedmetadata", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        const duration = el.duration;
        const width = kind === "video" ? (el as HTMLVideoElement).videoWidth : 0;
        const height =
          kind === "video" ? (el as HTMLVideoElement).videoHeight : 0;
        el.removeAttribute("src");
        el.load();
        resolve({ duration, width, height });
      });

      el.addEventListener("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        el.removeAttribute("src");
        el.load();
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

    const breathTimes = [
      item.duration * 0.25,
      item.duration * 0.5,
      item.duration * 0.75,
    ];
    const BREATH_HALF = 0.2;

    for (let i = 0; i < sampleCount; i++) {
      const t = i / RATE;
      const noise = rand();

      const inBreath = breathTimes.some(
        (bt) => Math.abs(t - bt) <= BREATH_HALF
      );
      if (inBreath) {
        peaks[i] = 0.05;
        continue;
      }

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

    // Cancel any in-flight build for this item before starting a new one.
    // This prevents two concurrent seek loops loading the same blob URL,
    // which causes Safari to hit its media decoder limit and crash the tab.
    const prev = activeThumbnailBuilds.get(item.id);
    if (prev) {
      prev!.cancelled = true;
    }
    const signal = { cancelled: false };
    activeThumbnailBuilds.set(item.id, signal);

    const FRAME_H = 112;
    const aspect = item.width && item.height ? item.width / item.height : 16 / 9;
    const frameW = Math.max(1, Math.round(FRAME_H * aspect));
    // 12 frames is enough for the filmstrip; each ImageBitmap is GPU memory.
    // We generate them exactly once per item load and never regenerate.
    const FRAME_COUNT = 12;

    const frames: { time: number; bitmap: ImageBitmap }[] = [];

    // Give the scraper its own independent blob URL so it never shares a media
    // pipeline with the player's <video> element.  Clearing or aborting the
    // scraper's URL cannot stall or MEDIA_ERR_DECODE the player that way.
    const scraperUrl = URL.createObjectURL(item.file);

    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.playsInline = true;
    video.style.cssText =
      "position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;pointer-events:none;opacity:0";
    document.body.appendChild(video);

    try {
      video.src = scraperUrl;
      video.load();

      // Wait for enough data to seek reliably.
      // Treat error the same as a timeout — attempt seeks anyway rather than
      // aborting the whole build on a transient decode hiccup.
      await new Promise<void>((resolve) => {
        const tid = setTimeout(resolve, 8_000);
        const onReady = () => { clearTimeout(tid); resolve(); };
        video.addEventListener("loadeddata", onReady, { once: true });
        video.addEventListener("error", onReady, { once: true });
      });

      for (let i = 0; i < FRAME_COUNT; i++) {
        // Check cancellation before every seek — a new file may have been
        // loaded while we were waiting for the previous seek to complete.
        if (signal.cancelled) break;

        const time = ((i + 0.5) / FRAME_COUNT) * item.duration;

        await new Promise<void>((resolve) => {
          const tid = setTimeout(resolve, 3_000);
          const onSeeked = () => { clearTimeout(tid); resolve(); };
          const onError = () => { clearTimeout(tid); resolve(); }; // treat error as timeout
          video.addEventListener("seeked", onSeeked, { once: true });
          video.addEventListener("error", onError, { once: true });
          video.currentTime = time;
        });

        if (signal.cancelled) break;

        try {
          const canvas = new OffscreenCanvas(frameW, FRAME_H);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ctx = canvas.getContext("2d") as any;
          if (ctx != null) {
            ctx.drawImage(video, 0, 0, frameW, FRAME_H);
            const bmp = await createImageBitmap(canvas);
            frames.push({ time, bitmap: bmp });
          }
        } catch {
          // drawImage / createImageBitmap can fail if the video is in an error
          // state — skip this frame rather than aborting the whole build.
        }
      }
    } finally {
      // Always clean up the scraper element and revoke its private URL.
      // This never touches item.url so the player element is unaffected.
      video.removeAttribute("src");
      video.load(); // abort any pending network activity on the scraper URL
      if (video.parentNode != null) (video.parentNode as Element).removeChild(video);
      URL.revokeObjectURL(scraperUrl);
      // Remove from the active-builds map only if we are still the current build.
      if (activeThumbnailBuilds.get(item.id) === signal) {
        activeThumbnailBuilds.delete(item.id);
      }
    }

    // If we were cancelled, return null — the caller should ignore this result.
    if (signal.cancelled) return null;

    return frames.length > 0 ? { frames, aspect } : null;
  },
};
