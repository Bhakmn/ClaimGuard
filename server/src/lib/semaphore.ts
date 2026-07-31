/**
 * Counted semaphore with an acquisition timeout.
 *
 * Used to cap simultaneous outbound ACRCloud calls at ACRCLOUD_MAX_CONCURRENCY.
 * Callers acquire a slot, do their work, then release it.  If no slot becomes
 * available within `timeoutMs` the acquisition rejects — the caller should
 * surface a 503.
 *
 * Waiters are served FIFO — first in, first out — so a burst does not starve
 * the earliest request.
 *
 * Usage:
 *
 *   const sem = new Semaphore(8);
 *   const release = await sem.acquire(20_000);
 *   try {
 *     await callAcrCloud();
 *   } finally {
 *     release();
 *   }
 */

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
}

export class Semaphore {
  private _available: number;
  private readonly _waiters: Waiter[] = [];

  constructor(private readonly _capacity: number) {
    if (_capacity < 1) throw new RangeError("Semaphore capacity must be >= 1");
    this._available = _capacity;
  }

  /** Current number of slots in use. */
  get inFlight(): number {
    return this._capacity - this._available;
  }

  /** Current number of callers waiting for a slot. */
  get queueDepth(): number {
    return this._waiters.length;
  }

  /**
   * Acquire one slot.  Resolves with a zero-argument release function once a
   * slot is available, or rejects with a timeout error after `timeoutMs` ms.
   *
   * Waiters are served FIFO.
   */
  acquire(timeoutMs: number): Promise<() => void> {
    if (this._available > 0) {
      this._available--;
      return Promise.resolve(() => this._release());
    }

    return new Promise<() => void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this._waiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) this._waiters.splice(idx, 1);
        reject(
          Object.assign(
            new Error(`Semaphore acquisition timed out after ${timeoutMs} ms`),
            { code: "SEMAPHORE_TIMEOUT", timeoutMs }
          )
        );
      }, timeoutMs);

      // Push to the end — FIFO order.
      this._waiters.push({
        resolve: (release) => {
          clearTimeout(timer);
          resolve(release);
        },
        reject,
      });
    });
  }

  private _release(): void {
    const next = this._waiters.shift(); // FIFO: take from front
    if (next) {
      // Hand the slot directly to the next waiter — count stays the same.
      next.resolve(() => this._release());
    } else {
      this._available++;
    }
  }
}
