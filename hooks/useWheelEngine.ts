"use client";

import {
  useRef,
  useEffect,
  useReducer,
  useCallback,
} from "react";

/* ─── Types ──────────────────────────────────────────────────────────────── */

export interface WheelState {
  /** Degrees the wheel pivot is rotated. 0 = card-0 at left. */
  wheelAngle: number;
  /** Index currently in the front (left) position. */
  frontIndex: number;
  /** Cards that have been swept and hidden. */
  hiddenSet: Set<number>;
  /** Whether a sweep animation is in flight. */
  sweeping: boolean;
  /** Queue of stage indices waiting to be swept out. */
  sweepQueue: number[];
  /** Timestamp (ms) when the current front card entered the front position. */
  standStart: number;
  /** Highest stage index that has been enqueued so far. */
  highestQueued: number;
  /** Pending close grace timer id. */
  closeTimer: ReturnType<typeof setTimeout> | null;
}

export interface WheelActions {
  /** Called each time the scan's active stage advances. */
  onStageAdvance: (activeIndex: number, scanDone: boolean, failed: boolean) => void;
  /** Trigger a full reset — call when a new scan starts. */
  reset: () => void;
}

/* ─── Geometry helpers ───────────────────────────────────────────────────── */

const RADIUS = 600; // px
const BASE_ANGLES = [180, 90, 0, 270]; // degrees; 180 = left (on screen)
const MIN_STAND_MS = 3000;
const SWEEP_DURATION_MS = 700;
const WHEEL_ROTATION_MS = 600;
const CLOSE_GRACE_MS = 450;

/** Convert degrees to radians. */
function deg2rad(d: number) {
  return (d * Math.PI) / 180;
}

/** Position of card `i` on the wheel rim relative to the pivot. */
export function cardRimPosition(
  cardIndex: number
): { x: number; y: number } {
  const angle = deg2rad(BASE_ANGLES[cardIndex]);
  return {
    x: RADIUS * Math.cos(angle),
    y: RADIUS * Math.sin(angle),
  };
}

/* ─── Reducer ────────────────────────────────────────────────────────────── */

type Action =
  | { type: "RESET" }
  | { type: "ENQUEUE"; index: number }
  | { type: "BEGIN_SWEEP" }
  | { type: "FINISH_SWEEP"; sweptIndex: number }
  | { type: "SET_CLOSE_TIMER"; timer: ReturnType<typeof setTimeout> | null };

function initialWheelState(): WheelState {
  return {
    wheelAngle: 0,
    frontIndex: 0,
    hiddenSet: new Set(),
    sweeping: false,
    sweepQueue: [],
    standStart: Date.now(),
    highestQueued: 0,
    closeTimer: null,
  };
}

function wheelReducer(state: WheelState, action: Action): WheelState {
  switch (action.type) {
    case "RESET":
      return initialWheelState();

    case "ENQUEUE":
      return {
        ...state,
        sweepQueue: [...state.sweepQueue, action.index],
        highestQueued: Math.max(state.highestQueued, action.index + 1),
      };

    case "BEGIN_SWEEP":
      return { ...state, sweeping: true };

    case "FINISH_SWEEP": {
      const swept = action.sweptIndex;
      const newHidden = new Set(state.hiddenSet);
      newHidden.add(swept);
      // next front is the first non-hidden card after swept
      let nextFront = state.frontIndex;
      for (let i = 0; i < 4; i++) {
        if (!newHidden.has(i)) { nextFront = i; break; }
      }
      // wheel angle: 90° per completed card, capped at 3×90=270
      const newAngle = 90 * Math.min(swept + 1, 3);
      return {
        ...state,
        sweeping: false,
        hiddenSet: newHidden,
        frontIndex: nextFront,
        wheelAngle: newAngle,
        sweepQueue: state.sweepQueue.slice(1),
        standStart: Date.now(),
      };
    }

    case "SET_CLOSE_TIMER":
      return { ...state, closeTimer: action.timer };

    default:
      return state;
  }
}

/* ─── Hook ───────────────────────────────────────────────────────────────── */

interface UseWheelOptions {
  scanning: boolean;
  scanStage: number;
  scanFailed: boolean;
  onClose: () => void;
  prefersReducedMotion: boolean;
}

export function useWheelEngine({
  scanning,
  scanStage,
  scanFailed,
  onClose,
  prefersReducedMotion,
}: UseWheelOptions): [WheelState, WheelActions] {
  const [state, dispatch] = useReducer(wheelReducer, undefined, initialWheelState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const drainTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sweepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  /* ── Drain ── */
  const drain = useCallback(() => {
    const s = stateRef.current;

    // Do nothing if a sweep is already in flight
    if (s.sweeping) return;

    const queue = s.sweepQueue;

    // Nothing to sweep — check if we should close
    if (queue.length === 0) {
      if (!scanning && !scanFailed) {
        // Schedule close
        if (!s.closeTimer) {
          const t = setTimeout(() => {
            dispatch({ type: "SET_CLOSE_TIMER", timer: null });
            onCloseRef.current();
          }, CLOSE_GRACE_MS);
          dispatch({ type: "SET_CLOSE_TIMER", timer: t });
        }
      }
      return;
    }

    // Check minimum stand time
    const elapsed = Date.now() - s.standStart;
    const remaining = (prefersReducedMotion ? 800 : MIN_STAND_MS) - elapsed;

    if (remaining > 0) {
      if (drainTimerRef.current) clearTimeout(drainTimerRef.current);
      drainTimerRef.current = setTimeout(() => drainRef.current(), remaining);
      return;
    }

    // Begin sweep
    const sweptIndex = queue[0];
    dispatch({ type: "BEGIN_SWEEP" });

    const duration = prefersReducedMotion ? 200 : SWEEP_DURATION_MS;
    sweepTimerRef.current = setTimeout(() => {
      dispatch({ type: "FINISH_SWEEP", sweptIndex });
      // After wheel rotation settles, drain again — use ref so the latest
      // closure (with up-to-date `scanning` / `scanFailed`) is called.
      setTimeout(() => drainRef.current(), prefersReducedMotion ? 50 : WHEEL_ROTATION_MS);
    }, duration);
  }, [scanning, scanFailed, prefersReducedMotion]);

  const drainRef = useRef(drain);
  drainRef.current = drain;

  /* ── Advance stages into the queue ── */
  useEffect(() => {
    if (scanFailed) return; // hold on failure
    // Active index: scanStage while running, 4 when done
    const activeIdx = scanning ? scanStage : 4;
    const s = stateRef.current;
    for (let i = s.highestQueued; i < activeIdx; i++) {
      dispatch({ type: "ENQUEUE", index: i });
    }
    // Kick drain on next tick
    setTimeout(() => drainRef.current(), 0);
  }, [scanning, scanStage, scanFailed]);

  /* ── Reset action ── */
  const reset = useCallback(() => {
    if (drainTimerRef.current) clearTimeout(drainTimerRef.current);
    if (sweepTimerRef.current) clearTimeout(sweepTimerRef.current);
    const s = stateRef.current;
    if (s.closeTimer) clearTimeout(s.closeTimer);
    dispatch({ type: "RESET" });
  }, []);

  /* ── Cleanup ── */
  useEffect(() => {
    return () => {
      if (drainTimerRef.current) clearTimeout(drainTimerRef.current);
      if (sweepTimerRef.current) clearTimeout(sweepTimerRef.current);
    };
  }, []);

  const onStageAdvance = useCallback(
    (_activeIndex: number, _scanDone: boolean, _failed: boolean) => {
      // The drain is already driven by the useEffect above reacting to
      // scanning/scanStage/scanFailed prop changes — this is a no-op stub
      // kept for the public interface.
    },
    []
  );

  return [state, { onStageAdvance, reset }];
}
