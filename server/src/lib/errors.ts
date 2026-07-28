/**
 * Application error hierarchy.
 *
 * Every AppError carries:
 *  - status   HTTP status code
 *  - code     Machine-readable snake_case identifier
 *  - message  User-facing sentence (rendered verbatim by the frontend)
 *
 * Never put internal details, SQL text, stack traces or secret values in
 * `message`.  Use the `cause` option for the underlying error — it is logged
 * but never serialised into a response.
 */

export interface AppErrorOptions {
  /** Extra data included in a 400 response as `details`. Never contains raw user values. */
  details?: Record<string, unknown>;
  /** Mirrors the Retry-After header on 429 responses. */
  retryAfterSeconds?: number;
  /** When false the message is replaced with a generic one in the response. Default: true. */
  expose?: boolean;
  /** The underlying cause — logged but never sent to the client. */
  cause?: unknown;
}

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly retryAfterSeconds?: number;
  readonly expose: boolean;
  override readonly cause?: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    options?: AppErrorOptions
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.expose = options?.expose ?? true;
    if (options?.details !== undefined) this.details = options.details;
    if (options?.retryAfterSeconds !== undefined)
      this.retryAfterSeconds = options.retryAfterSeconds;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/* ── Concrete subclasses ──────────────────────────────────────────────────── */

export class BadRequestError extends AppError {
  constructor(message: string, options?: AppErrorOptions) {
    super(400, options?.details ? "bad_request" : "bad_request", message, options);
    this.name = "BadRequestError";
  }
}

/** 400 with a specific field-level code. */
export class ValidationError extends AppError {
  constructor(code: string, message: string, options?: AppErrorOptions) {
    super(400, code, message, options);
    this.name = "ValidationError";
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string, options?: AppErrorOptions) {
    super(401, "unauthorized", message, options);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string, options?: AppErrorOptions) {
    super(403, "forbidden", message, options);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, options?: AppErrorOptions) {
    super(404, "not_found", message, options);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends AppError {
  constructor(message: string, options?: AppErrorOptions) {
    super(409, "conflict", message, options);
    this.name = "ConflictError";
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message: string, options?: AppErrorOptions) {
    super(413, "payload_too_large", message, options);
    this.name = "PayloadTooLargeError";
  }
}

export class UnsupportedMediaTypeError extends AppError {
  constructor(message: string, options?: AppErrorOptions) {
    super(415, "unsupported_media_type", message, options);
    this.name = "UnsupportedMediaTypeError";
  }
}

export class RateLimitError extends AppError {
  constructor(message: string, retryAfterSeconds: number, options?: Omit<AppErrorOptions, "retryAfterSeconds">) {
    super(429, "rate_limited", message, { ...options, retryAfterSeconds });
    this.name = "RateLimitError";
  }
}

export class ConfigurationError extends AppError {
  constructor(message: string, options?: AppErrorOptions) {
    super(500, "configuration_missing", message, options);
    this.name = "ConfigurationError";
  }
}

export class InternalError extends AppError {
  constructor(message: string, options?: AppErrorOptions) {
    super(500, "internal_error", message, { expose: false, ...options });
    this.name = "InternalError";
  }
}

export class UpstreamError extends AppError {
  constructor(message: string, options?: AppErrorOptions) {
    super(502, "upstream_failed", message, options);
    this.name = "UpstreamError";
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message: string, options?: AppErrorOptions) {
    super(503, "service_unavailable", message, options);
    this.name = "ServiceUnavailableError";
  }
}

export class GatewayTimeoutError extends AppError {
  constructor(message: string, options?: AppErrorOptions) {
    super(504, "upstream_timeout", message, options);
    this.name = "GatewayTimeoutError";
  }
}

/* ── Feature-specific factory functions ───────────────────────────────────── */
// These produce AppErrors with feature-level codes without creating an ever-
// growing class hierarchy.

export function sampleRequiredError(): ValidationError {
  return new ValidationError("sample_required", "No audio sample was received.");
}

export function sampleEmptyError(): ValidationError {
  return new ValidationError("sample_empty", "The audio sample is empty.");
}

export function sampleTooLargeError(maxBytes: number): ValidationError {
  const mb = (maxBytes / (1024 * 1024)).toFixed(0);
  return new ValidationError(
    "sample_too_large",
    `The audio sample exceeds the ${mb} MiB limit.`
  );
}

export function videoRequiredError(): ValidationError {
  return new ValidationError("video_required", "No video file was received.");
}

export function videoEmptyError(): ValidationError {
  return new ValidationError("video_empty", "The video file is empty.");
}

export function videoTooLargeError(maxBytes: number): ValidationError {
  const mb = Math.round(maxBytes / (1024 * 1024));
  return new ValidationError(
    "video_too_large",
    `The video file exceeds the ${mb} MiB limit.`
  );
}

export function unsupportedVideoTypeError(): UnsupportedMediaTypeError {
  return new UnsupportedMediaTypeError(
    "The uploaded file is not a recognised video type. Use MP4, MOV, WebM or MKV."
  );
}

export function titleTooLongError(max: number): ValidationError {
  return new ValidationError(
    "title_too_long",
    `Video title must be ${max} characters or fewer.`
  );
}

export function titleInvalidError(): ValidationError {
  return new ValidationError(
    "title_invalid",
    "Video title contains characters that are not allowed."
  );
}

export function publishIdInvalidError(): ValidationError {
  return new ValidationError(
    "publish_id_invalid",
    "The publish ID is not in a recognised format."
  );
}

export function tiktokNotConnectedError(): AppError {
  return new AppError(
    400,
    "tiktok_not_connected",
    "Connect your TikTok account first, then try again."
  );
}

export function tiktokSessionExpiredError(): AppError {
  return new AppError(
    401,
    "tiktok_session_expired",
    "Your TikTok connection has expired. Reconnect your account and try again."
  );
}

export function tiktokInitFailedError(cause?: unknown): AppError {
  return new AppError(
    502,
    "tiktok_init_failed",
    "Could not start the TikTok upload. Try again.",
    { cause }
  );
}

export function tiktokChunkRejectedError(cause?: unknown): AppError {
  return new AppError(
    502,
    "tiktok_chunk_rejected",
    "TikTok rejected part of the upload. Try again.",
    { cause }
  );
}

export function tiktokTimeoutError(): GatewayTimeoutError {
  return new GatewayTimeoutError(
    "TikTok did not respond in time. Try again.",
    { expose: true }
  );
}

export function uploadInProgressError(): ConflictError {
  return new ConflictError(
    "A publish is already in progress. Wait for it to finish."
  );
}

export function acrcloudError(cause?: unknown): UpstreamError {
  return new UpstreamError(
    "The music-recognition service returned an unexpected response. Try again.",
    { cause }
  );
}

export function acrcloudUnreachableError(cause?: unknown): GatewayTimeoutError {
  return new GatewayTimeoutError(
    "The music-recognition service did not respond. Try again.",
    { cause }
  );
}

export function identifyBusyError(waitedMs: number): AppError {
  return new AppError(
    503,
    "identify_busy",
    "Too many scans are running at once. Try again in a moment.",
    { retryAfterSeconds: Math.ceil(waitedMs / 1000) }
  );
}

export function stateMismatchError(): BadRequestError {
  return new BadRequestError("The OAuth state parameter did not match. Start the sign-in again.", {
    details: { code: "state_mismatch" },
  });
}

export function stateExpiredError(): BadRequestError {
  return new BadRequestError("The sign-in link has expired. Start the sign-in again.", {
    details: { code: "state_expired" },
  });
}

export function serverShutdownError(): ServiceUnavailableError {
  return new ServiceUnavailableError(
    "The server is restarting. Try again in a moment."
  );
}
