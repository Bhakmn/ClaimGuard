/**
 * Plugin: fixed-window rate limiter backed by PostgreSQL.
 *
 * Counters are keyed as "<bucket>:<principal.rateKey>".
 * When a counter exceeds its limit the request short-circuits with 429 and
 * a Retry-After header.
 *
 * Master switch: RATE_LIMIT_ENABLED=false disables all limits (tests only).
 *
 * Each route registers its own limit by calling applyRateLimit() inside a
 * preHandler hook:
 *
 *   fastify.post("/api/identify", {
 *     preHandler: [applyRateLimit({ bucket: "identify", max: 20, windowSeconds: 60 })],
 *     handler: ...
 *   });
 */

import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { getDb } from "../db/client.js";
import { getConfig } from "../config/env.js";
import { RateLimitError } from "../lib/errors.js";
import {
  incrementRateLimit,
  currentWindowStart,
} from "../db/queries/rate-limit.js";
import { rateLimitRejectionsTotal } from "../lib/metrics.js";

export interface RateLimitOptions {
  /** Logical bucket name combined with the principal key to form the counter key. */
  bucket: string;
  /** Maximum requests allowed in the window. */
  max: number;
  /** Window length in seconds. */
  windowSeconds: number;
}

const rateLimitPlugin: FastifyPluginAsync = async (_fastify) => {
  // No global hook needed — rate limits are applied per-route via applyRateLimit().
};

export default fp(rateLimitPlugin, {
  name: "rate-limit",
  fastify: "5.x",
  dependencies: ["principal"],
});

/**
 * Returns a preHandler that enforces a fixed-window rate limit.
 * Inject into route options: `preHandler: [applyRateLimit({ ... })]`.
 */
export function applyRateLimit(opts: RateLimitOptions) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const cfg = getConfig();
    if (!cfg.RATE_LIMIT_ENABLED) return;

    const subject = request.principal.rateKey;
    const windowStart = currentWindowStart(opts.windowSeconds);

    let hits: number;
    try {
      hits = await incrementRateLimit(getDb(), opts.bucket, subject, windowStart);
    } catch (err) {
      // On DB error, fail open — do not block the user.
      request.log.warn(
        { err, bucket: opts.bucket, subject },
        "rate_limit: DB error, failing open"
      );
      return;
    }

    if (hits > opts.max) {
      // Compute precise seconds until the current window closes (floored at 1).
      const windowMs   = opts.windowSeconds * 1_000;
      const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
      const windowEnd   = windowStart + windowMs;
      const retryAfter  = Math.max(1, Math.ceil((windowEnd - Date.now()) / 1_000));

      reply.header("retry-after", String(retryAfter));
      rateLimitRejectionsTotal.inc({ bucket: opts.bucket });
      throw new RateLimitError(
        "Too many requests. Wait a moment and try again.",
        retryAfter
      );
    }
  };
}
