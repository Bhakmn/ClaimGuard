/**
 * UTC / ISO 8601 timestamp helpers.
 *
 * All timestamps stored or emitted are UTC.
 * All timestamps in JSON responses are ISO 8601 strings ending with "Z".
 */

/**
 * Return the current wall-clock time as an ISO 8601 UTC string with a Z suffix.
 *
 *   e.g. "2026-03-04T09:12:44.108Z"
 */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Return a future date offset by `seconds` from now as an ISO 8601 UTC string.
 */
export function futureIso(seconds: number): string {
  return new Date(Date.now() + seconds * 1_000).toISOString();
}

/**
 * Return a future Date object offset by `seconds` from now.
 * Useful for database writes that expect a Date rather than a string.
 */
export function futureDate(seconds: number): Date {
  return new Date(Date.now() + seconds * 1_000);
}

/**
 * Convert a Date (or epoch ms number) to an ISO 8601 UTC string with a Z suffix.
 * Ensures the suffix is always present even if `toISOString()` were to omit it
 * in some edge runtime (it should not, but we enforce it explicitly).
 */
export function toIso(date: Date | number): string {
  const str = new Date(date).toISOString();
  return str.endsWith("Z") ? str : str + "Z";
}

/**
 * Return the elapsed milliseconds since `startMs` (from Date.now()).
 */
export function elapsedMs(startMs: number): number {
  return Date.now() - startMs;
}

/**
 * Return the number of whole seconds remaining until `expiresAt`.
 * Returns 0 when the date is in the past.
 */
export function secondsUntil(expiresAt: Date | string): number {
  const ms = new Date(expiresAt).getTime() - Date.now();
  return Math.max(0, Math.floor(ms / 1_000));
}

/**
 * Return true when `expiresAt` is within `marginSeconds` of now.
 */
export function isExpiringSoon(
  expiresAt: Date | string,
  marginSeconds: number
): boolean {
  return secondsUntil(expiresAt) <= marginSeconds;
}
