/**
 * Process-wide publish concurrency cap.
 *
 * Limits the number of simultaneous video uploads to PUBLISH_MAX_CONCURRENT_JOBS
 * (default 4).  Unlike the ACRCloud semaphore, this one uses tryAcquire — a
 * fifth caller is rejected immediately with 503 rather than queued.  Queueing
 * an upload while the creator is staring at the button is worse than an honest
 * "server busy" that lets them try again when capacity is free.
 *
 * Usage:
 *
 *   const release = publishSemaphore.tryAcquire();
 *   if (!release) {
 *     throw new AppError(503, "service_unavailable",
 *       "The server is busy sending other uploads. Try again in a minute.");
 *   }
 *   try {
 *     await runUpload(...);
 *   } finally {
 *     release();
 *   }
 */

import { PUBLISH_MAX_CONCURRENT_JOBS } from "../config/constants.js";

/* ── Semaphore with try-acquire ──────────────────────────────────────────── */

class TrySemaphore {
  private _available: number;

  constructor(private readonly _capacity: number) {
    if (_capacity < 1) throw new RangeError("TrySemaphore capacity must be >= 1");
    this._available = _capacity;
  }

  /** Current number of slots in use. */
  get inFlight(): number {
    return this._capacity - this._available;
  }

  /**
   * Non-blocking acquire.
   * Returns a release function when a slot is available, or null when full.
   */
  tryAcquire(): (() => void) | null {
    if (this._available <= 0) return null;
    this._available--;
    return () => {
      this._available++;
    };
  }
}

/* ── Singleton ───────────────────────────────────────────────────────────── */

export const publishSemaphore = new TrySemaphore(PUBLISH_MAX_CONCURRENT_JOBS);

/** Exported for test injection only. */
export { TrySemaphore };
