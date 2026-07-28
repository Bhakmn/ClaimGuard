/**
 * Base URL for the ClaimGuard backend.
 *
 * Empty string means same-origin, which is the supported production shape and
 * the shape the TikTok OAuth popup requires: the popup posts a message to its
 * opener, and the opener discards messages whose origin differs from its own.
 *
 * Set NEXT_PUBLIC_API_BASE_URL only for a throwaway experiment against a remote
 * backend, and accept that TikTok connect will not complete in that configuration.
 */
export const API_BASE_URL: string = (
  process.env.NEXT_PUBLIC_API_BASE_URL ?? ""
).replace(/\/+$/, "");

export const apiUrl = (path: string): string => `${API_BASE_URL}${path}`;
