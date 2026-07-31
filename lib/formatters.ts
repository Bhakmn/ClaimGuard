/* ─── Time & size formatters ─────────────────────────────────────────────── */

/**
 * "0:00.0" style. Minutes unpadded, seconds zero-padded to two digits with
 * one decimal place.
 *   formatClock(7.42)    -> "0:07.4"
 *   formatClock(63.05)   -> "1:03.1"
 *   formatClock(NaN)     -> "0:00.0"
 *   formatClock(Infinity)-> "0:00.0"
 */
export function formatClock(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const mins = Math.floor(seconds / 60);
  const secs = seconds - mins * 60;
  const secsWhole = Math.floor(secs);
  const tenths = Math.floor((secs - secsWhole) * 10);
  return `${mins}:${String(secsWhole).padStart(2, "0")}.${tenths}`;
}

/**
 * Ruler tick labels. Intervals ≥ 1 s drop the decimal; below 1 s use
 * formatClock without the tenths truncation.
 *   formatRulerLabel(90, 30)    -> "1:30"
 *   formatRulerLabel(0.4, 0.2)  -> "0:00.4"
 */
export function formatRulerLabel(seconds: number, interval: number): string {
  if (interval >= 1) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.round(seconds - mins * 60);
    return `${mins}:${String(secs).padStart(2, "0")}`;
  }
  return formatClock(seconds);
}

/**
 * Byte counts for the upload queue.
 *   512     -> "512 B"
 *   20480   -> "20.0 KB"
 *   8400000 -> "8.4 MB"
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1_000_000) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/**
 * Elapsed scan time.
 *   8000  -> "8s"
 *   95000 -> "1m 35s"
 */
export function formatStopwatch(ms: number): string {
  const totalSecs = Math.max(0, Math.round(ms / 1000));
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs - mins * 60;
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}
