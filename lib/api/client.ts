import { apiUrl } from "./config";

/* ─── Error type ────────────────────────────────────────────────────────── */

/** Error carrying the backend's machine code alongside the message the UI shows. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string = "unknown",
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type ErrorBody = { error?: string; code?: string; requestId?: string };

const NETWORK_MESSAGE =
  "Could not reach the ClaimGuard server. Check your connection and try again.";

/* ─── Core fetch wrapper ────────────────────────────────────────────────── */

/**
 * One request. Always sends cookies. Always returns parsed JSON, or throws an
 * ApiError whose `message` is the sentence the backend wrote for the creator.
 */
export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path), { ...init, credentials: "include" });
  } catch {
    throw new ApiError(NETWORK_MESSAGE, 0, "network_error");
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    const err = (body ?? {}) as ErrorBody;
    throw new ApiError(
      err.error || `Request failed (${res.status}).`,
      res.status,
      err.code || "unknown",
      err.requestId,
    );
  }

  // The identify endpoint may report business failures with 200 + { error }.
  const maybe = (body ?? {}) as ErrorBody;
  if (maybe.error) {
    throw new ApiError(
      maybe.error,
      res.status,
      maybe.code || "unknown",
      maybe.requestId,
    );
  }

  return body as T;
}
