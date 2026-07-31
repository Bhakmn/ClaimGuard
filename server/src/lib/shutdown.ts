/**
 * Process shutdown flag.
 *
 * A single in-process boolean that is set to true when the server receives
 * SIGTERM or SIGINT.  Routes that start long-running operations (video upload)
 * check this flag before consuming the request body, so a publish started
 * during a shutdown window fails fast with 503 rather than running for
 * minutes and then dying mid-stream.
 *
 * The flag is intentionally simple — no atomics, no locking — because Node.js
 * runs a single event-loop thread and a boolean write is atomic in that model.
 */

let _shuttingDown = false;

/** Returns true once a shutdown signal has been received. */
export function isShuttingDown(): boolean {
  return _shuttingDown;
}

/** Called from index.ts when the first shutdown signal arrives. */
export function setShuttingDown(): void {
  _shuttingDown = true;
}
