/**
 * Minimal outbound HTTP client built on undici.
 *
 * Wraps undici's `request()` with:
 *  - Per-call timeout (signal-based)
 *  - Structured error wrapping (UpstreamError / GatewayTimeoutError)
 *  - Consistent log field extraction (durationMs, statusCode)
 *
 * Usage:
 *
 *   const res = await httpRequest({
 *     url: "https://api.example.com/v1/thing",
 *     method: "POST",
 *     headers: { "Content-Type": "application/json" },
 *     body: JSON.stringify(payload),
 *     timeoutMs: 15_000,
 *   });
 *   const data = await res.body.json();
 */

import { request, type Dispatcher } from "undici";
import { GatewayTimeoutError, UpstreamError } from "./errors.js";

export interface HttpRequestOptions {
  url: string;
  method: Dispatcher.HttpMethod;
  headers?: Record<string, string>;
  body?: Buffer | string | null;
  timeoutMs: number;
}

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  /** undici ResponseData body — consume exactly once. */
  body: Dispatcher.ResponseData["body"];
  /** Wall-clock duration of the call in ms. */
  durationMs: number;
}

/**
 * Make a single outbound HTTP request.
 *
 * Throws `GatewayTimeoutError` when the timeout fires.
 * Throws `UpstreamError` on network errors.
 * Does NOT throw on 4xx/5xx — the caller inspects `statusCode`.
 */
export async function httpRequest(opts: HttpRequestOptions): Promise<HttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const start = Date.now();

  try {
    const res = await request(opts.url, {
      method: opts.method,
      ...(opts.headers !== undefined ? { headers: opts.headers } : {}),
      ...(opts.body != null ? { body: opts.body } : {}),
      signal: controller.signal,
    });

    return {
      statusCode: res.statusCode,
      headers: res.headers as Record<string, string | string[] | undefined>,
      body: res.body,
      durationMs: Date.now() - start,
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;

    if (
      err instanceof Error &&
      (err.name === "AbortError" ||
        (err as NodeJS.ErrnoException).code === "UND_ERR_CONNECT_TIMEOUT")
    ) {
      throw new GatewayTimeoutError(
        `Upstream request timed out after ${opts.timeoutMs} ms.`,
        { cause: err }
      );
    }

    throw new UpstreamError(
      `Upstream request failed after ${durationMs} ms.`,
      { cause: err }
    );
  } finally {
    clearTimeout(timer);
  }
}
