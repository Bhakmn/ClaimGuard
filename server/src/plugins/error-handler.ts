/**
 * Plugin: error handler
 *
 * Converts every thrown value into the canonical JSON envelope:
 *
 *   { "error": "…", "code": "…", "requestId": "…" }
 *
 * Rules:
 *  - AppError → its own status, code, message (when expose=true).
 *  - Zod validation failures → 400, code "bad_request", first-issue message,
 *    plus details.issues list.
 *  - FST_ERR_CTP_BODY_TOO_LARGE and multipart RequestFileTooLargeError → 413.
 *  - Unrecognised Content-Type → 415.
 *  - Anything else → 500, fixed message "Something went wrong. Try again."
 *    Original error is logged at `error` level; never serialised.
 *
 * OAuth popup routes (/api/tiktok/callback, /api/auth/callback) render HTML
 * on error; they handle errors inside their own route handlers and never
 * reach this handler with unhandled errors.
 */

import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyError } from "fastify";
import { ZodError } from "zod";
import { AppError } from "../lib/errors.js";

const GENERIC_500_MESSAGE = "Something went wrong. Try again.";

const errorHandlerPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.setErrorHandler((error, request, reply) => {
    const requestId = String(request.id);

    // ── AppError (our own hierarchy) ────────────────────────────────────────
    if (error instanceof AppError) {
      const status = error.status;
      const expose = error.expose ?? true;

      if (status >= 500) {
        request.log.error({ err: error, requestId }, error.message);
      } else {
        request.log.warn({ code: error.code, requestId }, error.message);
      }

      const body: Record<string, unknown> = {
        error: expose ? error.message : GENERIC_500_MESSAGE,
        code: error.code,
        requestId,
      };

      if (error.retryAfterSeconds !== undefined) {
        body["retryAfterSeconds"] = error.retryAfterSeconds;
        reply.header("retry-after", String(error.retryAfterSeconds));
      }

      if (error.details !== undefined) {
        body["details"] = error.details;
      }

      return reply
        .status(status)
        .header("content-type", "application/json; charset=utf-8")
        .send(body);
    }

    // ── Zod validation errors ───────────────────────────────────────────────
    if (error instanceof ZodError) {
      const firstIssue = error.issues[0];
      const fieldPath =
        firstIssue?.path?.join(".") ?? "input";
      const reason = firstIssue?.message ?? "Invalid value.";
      const message = `${fieldPath}: ${reason}`;

      request.log.warn({ code: "bad_request", requestId }, message);

      return reply
        .status(400)
        .header("content-type", "application/json; charset=utf-8")
        .send({
          error: message,
          code: "bad_request",
          requestId,
          details: {
            issues: error.issues.map((i) => ({
              field: i.path.join("."),
              reason: i.message,
            })),
          },
        });
    }

    // ── Fastify framework errors ────────────────────────────────────────────
    const fastifyError = error as FastifyError;
    const errCode = fastifyError.code ?? "";

    // Body too large (JSON global limit)
    if (
      errCode === "FST_ERR_CTP_BODY_TOO_LARGE" ||
      fastifyError.statusCode === 413
    ) {
      return reply
        .status(413)
        .header("content-type", "application/json; charset=utf-8")
        .send({
          error: "The request body is too large.",
          code: "payload_too_large",
          requestId,
        });
    }

    // Multipart file too large
    if (
      errCode === "FST_ERR_CTP_INVALID_CONTENT_LENGTH" ||
      fastifyError.message?.includes("Request file too large") ||
      fastifyError.statusCode === 413
    ) {
      return reply
        .status(413)
        .header("content-type", "application/json; charset=utf-8")
        .send({
          error: "The uploaded file is too large.",
          code: "payload_too_large",
          requestId,
        });
    }

    // Unsupported Content-Type
    if (
      errCode === "FST_ERR_CTP_INVALID_MEDIA_TYPE" ||
      fastifyError.statusCode === 415
    ) {
      return reply
        .status(415)
        .header("content-type", "application/json; charset=utf-8")
        .send({
          error: "The request Content-Type is not supported.",
          code: "unsupported_media_type",
          requestId,
        });
    }

    // Route not found (caught by not-found handler, but as a fallback)
    if (fastifyError.statusCode === 404) {
      return reply
        .status(404)
        .header("content-type", "application/json; charset=utf-8")
        .send({
          error: "Not found.",
          code: "not_found",
          requestId,
        });
    }

    // Method not allowed
    if (fastifyError.statusCode === 405) {
      return reply
        .status(405)
        .header("content-type", "application/json; charset=utf-8")
        .send({
          error: "Method not allowed.",
          code: "method_not_allowed",
          requestId,
        });
    }

    // ── Unknown / unhandled ─────────────────────────────────────────────────
    request.log.error({ err: error, requestId }, "Unhandled error");

    return reply
      .status(500)
      .header("content-type", "application/json; charset=utf-8")
      .send({
        error: GENERIC_500_MESSAGE,
        code: "internal_error",
        requestId,
      });
  });

  // Not-found handler
  fastify.setNotFoundHandler((request, reply) => {
    return reply
      .status(404)
      .header("content-type", "application/json; charset=utf-8")
      .send({
        error: "Not found.",
        code: "not_found",
        requestId: String(request.id),
      });
  });
};

export default fp(errorHandlerPlugin, {
  name: "error-handler",
  fastify: "5.x",
});
