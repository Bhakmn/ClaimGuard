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
  /**
   * Cards whose local fill animation has reached 100 %.
   * The drain will not sweep a card until its index appears here.
   */
  fillDoneSet: Set<number>;
}

export interface WheelActions {
  /** Called each time the scan's active stage advances. */
  onStageAdvance: (activeIndex: number, scanDone: boolean, failed: boolean) => void;
  /**
   * Called by a StageCard the first time its local fill animation hits 100 %.
   * This unblocks the sweep for that card if the dwell time has also elapsed.
   */
  onFillComplete: (cardIndex: number) => void;
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

/**
 * Safety net: if a card's fill-completion signal never arrives while the tab
 * is visible and no visual work is outstanding, this watchdog forces the card
 * through so the wheel never parks permanently.
 *
 * It is deliberately long (10 s) so it never fires during healthy operation
 * (a fill animation completes in ~1–2 s).  It re-arms itself if visual work
 * is still genuinely in progress — in that case the wait is expected and
 * should not be treated as an anomaly.  It only forces completion and logs a
 * warning when there is no legitimate reason for the fill to be absent.
 */
const FILL_WATCHDOG_MS = 10_000;

const IS_DEV = process.env.NODE_ENV !== "production";

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
  | { type: "SET_CLOSE_TIMER"; timer: ReturnType<typeof setTimeout> | null }
  | { type: "FILL_COMPLETE"; cardIndex: number };

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
    fillDoneSet: new Set(),
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

    case "FILL_COMPLETE": {
      const newFillDone = new Set(state.fillDoneSet);
      newFillDone.add(action.cardIndex);
      return { ...state, fillDoneSet: newFillDone };
    }

    default:
      return state;
  }
}

/* ─── Hook ───────────────────────────────────────────────────────────────── */

interface UseWheelOptions {
  scanning: boolean;
  /** True while the visual scan is running. Wheel holds card 3 until this is false. */
  visualScanning: boolean;
  scanStage: number;
  scanFailed: boolean;
  onClose: () => void;
  prefersReducedMotion: boolean;
}

export function useWheelEngine({
  scanning,
  visualScanning,
  scanStage,
  scanFailed,
  onClose,
  prefersReducedMotion,
}: UseWheelOptions): [WheelState, WheelActions] {
  const [state, dispatch] = useReducer(wheelReducer, undefined, initialWheelState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const drainTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sweepTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fillWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Authoritative fill-done set for Gate 2.
   *
   * We maintain this as a plain ref rather than reading from stateRef because
   * React's reducer dispatch is asynchronous: when onFillComplete fires and
   * immediately kicks drain via setTimeout, stateRef.current still holds the
   * pre-dispatch snapshot and Gate 2 would spuriously fail.  This ref is
   * updated synchronously inside onFillComplete so drain always sees the
   * truth regardless of when the reducer commit lands.
   */
  const fillDoneRef = useRef<Set<number>>(new Set());

  /** Wall-clock time (ms) at which the current dwell period started. */
  const standStartWallRef = useRef<number>(Date.now());
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Keep a ref to the latest visualScanning value so the watchdog callback
  // (a closure) can read the current value without stale-closure issues.
  const visualScanningRef = useRef(visualScanning);
  visualScanningRef.current = visualScanning;

  /* ── Drain ── */
  const drain = useCallback(() => {
    const s = stateRef.current;

    // Do nothing if a sweep is already in flight
    if (s.sweeping) return;

    const queue = s.sweepQueue;

    // Nothing to sweep — check if we should close
    if (queue.length === 0) {
      if (!scanning && !visualScanning && !scanFailed) {
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

    const sweptIndex = queue[0];

    // Gate 1: minimum dwell time has elapsed.
    const elapsed = Date.now() - standStartWallRef.current;
    const remaining = (prefersReducedMotion ? 800 : MIN_STAND_MS) - elapsed;
    if (remaining > 0) {
      if (drainTimerRef.current) clearTimeout(drainTimerRef.current);
      drainTimerRef.current = setTimeout(() => drainRef.current(), remaining);
      if (IS_DEV) {
        console.debug(
          `[wheel] parked @ Gate 1 — card ${sweptIndex}, dwell remaining ${remaining.toFixed(0)} ms` +
          ` | queue=${JSON.stringify(queue)} fillDone=${JSON.stringify([...fillDoneRef.current])}` +
          ` scanning=${scanning} visualScanning=${visualScanning}`
        );
      }
      return;
    }

    // Gate 2: the front card's local fill animation has completed.
    // Read from fillDoneRef (updated synchronously in onFillComplete) rather
    // than stateRef so we never see a stale pre-dispatch snapshot.
    if (!fillDoneRef.current.has(sweptIndex)) {
      // Arm the watchdog so the wheel always makes forward progress if the
      // fill signal is genuinely absent.  The watchdog distinguishes "waiting
      // on real visual work" from "stuck" — it re-arms without logging in the
      // former case and forces+warns only in the latter.
      if (!fillWatchdogRef.current) {
        fillWatchdogRef.current = setTimeout(() => {
          fillWatchdogRef.current = null;
          if (!fillDoneRef.current.has(sweptIndex)) {
            if (visualScanningRef.current) {
              // Visual work is still genuinely in progress. This is an expected
              // wait, not a stuck fill.  Re-arm and check again.
              if (IS_DEV) {
                console.debug(
                  `[wheel] watchdog: card ${sweptIndex} fill still pending, ` +
                  `but visualScanning=true — re-arming (legitimate wait)`
                );
              }
              drainRef.current(); // will re-arm the watchdog
            } else {
              // No visual work outstanding. The fill signal is genuinely absent.
              console.warn(
                `[wheel] fill-watchdog forced card ${sweptIndex} — ` +
                "fill signal never arrived (tab backgrounded or rAF froze?). Treating as complete."
              );
              fillDoneRef.current.add(sweptIndex);
              dispatch({ type: "FILL_COMPLETE", cardIndex: sweptIndex });
              drainRef.current();
            }
          } else {
            // Signal arrived before watchdog fired — nothing to do.
            drainRef.current();
          }
        }, FILL_WATCHDOG_MS);
      }
      if (IS_DEV) {
        console.debug(
          `[wheel] parked @ Gate 2 — card ${sweptIndex} fill not done` +
          ` | queue=${JSON.stringify(queue)} fillDone=${JSON.stringify([...fillDoneRef.current])}` +
          ` scanning=${scanning} visualScanning=${visualScanning}`
        );
      }
      return;
    }

    // Fill gate passed — cancel the watchdog.
    if (fillWatchdogRef.current) {
      clearTimeout(fillWatchdogRef.current);
      fillWatchdogRef.current = null;
    }

    // Gate 3 (card 3 only): hold the sweep while the visual scan is still
    // running.  When visualScanning flips false the useEffect below re-kicks
    // drain and the sweep proceeds immediately.
    if (sweptIndex === 3 && visualScanning) {
      if (IS_DEV) {
        console.debug(
          `[wheel] parked @ Gate 3 — card 3 fill done but visualScanning=true` +
          ` | queue=${JSON.stringify(queue)} fillDone=${JSON.stringify([...fillDoneRef.current])}`
        );
      }
      return;
    }

    // All gates passed — begin sweep.
    dispatch({ type: "BEGIN_SWEEP" });

    const duration = prefersReducedMotion ? 200 : SWEEP_DURATION_MS;
    sweepTimerRef.current = setTimeout(() => {
      dispatch({ type: "FINISH_SWEEP", sweptIndex });
      setTimeout(() => drainRef.current(), prefersReducedMotion ? 50 : WHEEL_ROTATION_MS);
    }, duration);
  }, [scanning, visualScanning, scanFailed, prefersReducedMotion]);

  const drainRef = useRef(drain);
  drainRef.current = drain;

  /* ── Advance stages into the queue ── */
  useEffect(() => {
    if (scanFailed) return; // hold on failure
    // Enqueue all stages that the backend has advanced past.
    // While audio is running: activeIdx = scanStage (enqueues completed stages).
    // Once audio finishes: activeIdx = 4 (enqueues card 3 and allows the wheel
    // to eventually close after Gate 3 clears).
    const activeIdx = scanning ? scanStage : 4;
    const s = stateRef.current;
    for (let i = s.highestQueued; i < activeIdx; i++) {
      dispatch({ type: "ENQUEUE", index: i });
    }
    setTimeout(() => drainRef.current(), 0);
  }, [scanning, visualScanning, scanStage, scanFailed]);

  /* ── Reset action ── */
  const reset = useCallback(() => {
    if (drainTimerRef.current)   clearTimeout(drainTimerRef.current);
    if (sweepTimerRef.current)   clearTimeout(sweepTimerRef.current);
    if (fillWatchdogRef.current) clearTimeout(fillWatchdogRef.current);
    fillWatchdogRef.current = null;
    fillDoneRef.current = new Set();
    standStartWallRef.current = Date.now();
    const s = stateRef.current;
    if (s.closeTimer) clearTimeout(s.closeTimer);
    dispatch({ type: "RESET" });
  }, []);

  /* ── Pause the wheel while the document is hidden ── */
  // When the tab is backgrounded rAF stops, so fill animations freeze and
  // onFillComplete will not fire until the tab is visible again.  The dwell
  // timer would otherwise keep counting against a paused animation.
  //
  // On hide: cancel the dwell timer and the fill watchdog.
  // On show: advance standStartWallRef by the hidden duration so the
  //          remaining dwell is still owed, then re-kick drain.
  useEffect(() => {
    let hiddenAt: number | null = null;

    function onVisibilityChange() {
      if (document.hidden) {
        hiddenAt = Date.now();
        if (drainTimerRef.current) {
          clearTimeout(drainTimerRef.current);
          drainTimerRef.current = null;
        }
        // Cancel the watchdog while hidden — rAF is paused so the fill
        // signal cannot arrive. It will be re-armed by drain() on wake.
        if (fillWatchdogRef.current) {
          clearTimeout(fillWatchdogRef.current);
          fillWatchdogRef.current = null;
        }
      } else {
        if (hiddenAt !== null) {
          const hiddenDuration = Date.now() - hiddenAt;
          standStartWallRef.current += hiddenDuration;
          hiddenAt = null;
        }
        setTimeout(() => drainRef.current(), 0);
      }
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  /* ── Cleanup ── */
  useEffect(() => {
    return () => {
      if (drainTimerRef.current)   clearTimeout(drainTimerRef.current);
      if (sweepTimerRef.current)   clearTimeout(sweepTimerRef.current);
      if (fillWatchdogRef.current) clearTimeout(fillWatchdogRef.current);
    };
  }, []);

  /* ── Sync standStartWallRef whenever state.standStart changes ── */
  useEffect(() => {
    standStartWallRef.current = state.standStart;
  }, [state.standStart]);

  const onStageAdvance = useCallback(
    (_activeIndex: number, _scanDone: boolean, _failed: boolean) => {
      // The drain is already driven by the useEffect above reacting to
      // scanning/scanStage/scanFailed prop changes — this is a no-op stub
      // kept for the public interface.
    },
    []
  );

  /* ── Fill-complete callback ── */
  const onFillComplete = useCallback((cardIndex: number) => {
    // Update fillDoneRef synchronously BEFORE kicking drain, so Gate 2 sees
    // the completed card even when drain runs before React commits the reducer
    // state update (dispatch is async; stateRef would be stale otherwise).
    fillDoneRef.current.add(cardIndex);
    dispatch({ type: "FILL_COMPLETE", cardIndex });
    // Cancel the watchdog — the real signal arrived.
    if (fillWatchdogRef.current) {
      clearTimeout(fillWatchdogRef.current);
      fillWatchdogRef.current = null;
    }
    setTimeout(() => drainRef.current(), 0);
  }, []);

  return [state, { onStageAdvance, onFillComplete, reset }];
}
