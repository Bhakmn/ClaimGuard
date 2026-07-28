import type { MediaItem, FlaggedVisualSpan, VisualCategory } from "../types";
import { delay, getControls } from "./delay";

/* ─── Types ──────────────────────────────────────────────────────────────── */

export interface VisualScanProgress {
  fraction: number;
  status: string;
  found: FlaggedVisualSpan[];
}

export interface VisualScanRequest {
  items: MediaItem[];
}

export interface VisualScanService {
  scan(
    request: VisualScanRequest,
    onProgress: (p: VisualScanProgress) => void
  ): Promise<FlaggedVisualSpan[]>;
}

/* ─── Fixture flags ──────────────────────────────────────────────────────── */

interface VisualFixture {
  from: number;
  to: number;
  label: VisualCategory;
  signals: string[];
  reasoning: string;
  confidence: number;
  source: FlaggedVisualSpan["source"];
}

const VISUAL_FIXTURES: VisualFixture[] = [
  {
    from: 0.10,
    to: 0.28,
    label: "film_or_tv" as VisualCategory,
    signals: [
      "letterbox bars detected (2.39:1 aspect ratio)",
      "cinematic colour grading",
      "film grain inconsistent with rest of video",
    ],
    reasoning:
      "The frame shows classic 2.39:1 letterboxing with pronounced film grain, strongly suggesting a theatrical film excerpt.",
    confidence: 81,
    source: "granite_vision",
  },
  {
    from: 0.52,
    to: 0.67,
    label: "screen_recording" as VisualCategory,
    signals: [
      "phone chrome / status bar visible",
      "OS UI elements in top-left corner",
    ],
    reasoning:
      "A phone status bar with carrier and battery indicators is visible at the top of the frame, indicating screen-recorded content.",
    confidence: 74,
    source: "granite_vision",
  },
];

/* ─── Monotonic ID counter ───────────────────────────────────────────────── */

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `v${idCounter}`;
}

/* ─── Mock implementation ────────────────────────────────────────────────── */

export const mockVisualScanService: VisualScanService = {
  async scan(request, onProgress) {
    const controls = getControls();
    const found: FlaggedVisualSpan[] = [];

    if (controls.offline) {
      await delay(200);
      throw new Error("No connection. Reconnect, then start the visual scan again.");
    }

    const emit = (fraction: number, status: string) =>
      onProgress({ fraction, status, found: [...found] });

    emit(0, "Initialising visual scanner…");
    await delay(600);

    for (let itemIdx = 0; itemIdx < request.items.length; itemIdx++) {
      const item = request.items[itemIdx];
      const fixtures = itemIdx === 0 ? VISUAL_FIXTURES : [];

      // Simulate scanning 1 frame per second of content
      const frameCount = Math.max(1, Math.ceil(item.duration));

      for (let i = 0; i < frameCount; i++) {
        if (controls.scanFails && i > Math.floor(frameCount * 0.5)) {
          throw new Error("The visual recognition service didn't respond. Try again.");
        }

        const fraction = (i + 1) / frameCount;
        const timeSec = i;

        const hitting = fixtures.find(
          (f) =>
            timeSec >= f.from * item.duration - 1 &&
            timeSec < f.to * item.duration
        );

        if (hitting) {
          // Open a new span or extend the existing one
          const existing = found.find(
            (s) => s.label === hitting.label && s.mediaId === item.id && s.end >= timeSec - 1.5
          );
          if (existing) {
            existing.end = Math.min(hitting.to * item.duration, timeSec + 1);
          } else {
            found.push({
              id: nextId(),
              mediaId: item.id,
              start: Math.max(0, hitting.from * item.duration),
              end: Math.min(item.duration, hitting.to * item.duration),
              label: hitting.label,
              signals: hitting.signals,
              reasoning: hitting.reasoning,
              confidence: hitting.confidence,
              enabled: true,
              manual: false,
              source: hitting.source,
            });
            emit(fraction, `Visual signal detected — "${hitting.label}" around ${Math.round(timeSec)}s…`);
          }
        }

        emit(fraction, `Scanning frame ${i + 1}/${frameCount} of ${item.name}…`);
        await delay(40); // fast mock — 40 ms per frame
      }
    }

    onProgress({ fraction: 1, status: "Visual scan complete.", found });
    return found;
  },
};
