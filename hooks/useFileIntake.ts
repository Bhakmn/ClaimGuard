import { useCallback, useRef } from "react";
import type { MediaItem } from "@/lib/types";
import type { MediaService } from "@/lib/mock/media-service";
import { nextId } from "@/lib/mock/scan-service";

/* ─── Classification ──────────────────────────────────────────────────────── */

const VIDEO_EXTS = [".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"];
const AUDIO_EXTS = [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"];

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

export function classifyFile(file: File): "video" | "audio" | "other" {
  const ext = extOf(file.name);
  const isVideo = file.type.startsWith("video/") || VIDEO_EXTS.includes(ext);
  const isAudio = file.type.startsWith("audio/") || AUDIO_EXTS.includes(ext);
  // If both match, video wins
  if (isVideo) return "video";
  if (isAudio) return "audio";
  return "other";
}

/* ─── Intake hook ─────────────────────────────────────────────────────────── */

export interface FileIntakeCallbacks {
  mediaService: MediaService;
  queue: File[];
  onEnqueue: (files: File[]) => void;
  onError: (msg: string) => void;
  onMediaReady: (item: MediaItem) => void;
  /** Called while the probe is running so the Start button dims. */
  onLoadStart: () => void;
  onLoadEnd: () => void;
}

export function useFileIntake({
  mediaService,
  queue,
  onEnqueue,
  onError,
  onMediaReady,
  onLoadStart,
  onLoadEnd,
}: FileIntakeCallbacks) {
  const loadingRef = useRef(false);

  /** Handle files from drop or input — video only on the launch screen. */
  const enqueue = useCallback(
    (files: FileList | File[]) => {
      const arr = Array.from(files);
      const videos = arr.filter((f) => classifyFile(f) === "video");
      if (videos.length === 0) {
        onError("Please choose a video file.");
        return;
      }
      onEnqueue(videos);
    },
    [onEnqueue, onError]
  );

  /** Pop the front of the queue, probe, and call onMediaReady. */
  const loadHead = useCallback(
    async (headFile: File) => {
      if (loadingRef.current) return;
      if (classifyFile(headFile) !== "video") {
        onError("Please choose a video file.");
        return;
      }
      loadingRef.current = true;
      onLoadStart();
      const url = URL.createObjectURL(headFile);
      try {
        const { duration, width, height } = await mediaService.probe(
          url,
          "video"
        );
        const item: MediaItem = {
          id: nextId(),
          file: headFile,
          url,
          name: headFile.name,
          kind: "video",
          duration,
          width,
          height,
          waveform: null,
          thumbnails: null,
        };
        onMediaReady(item);
      } catch {
        URL.revokeObjectURL(url);
        onError("Could not read the media file.");
      } finally {
        loadingRef.current = false;
        onLoadEnd();
      }
    },
    [mediaService, onMediaReady, onError, onLoadStart, onLoadEnd]
  );

  return { enqueue, loadHead };
}
