/**
 * Fastify application factory.
 *
 * buildApp() creates a configured Fastify instance with all plugins registered
 * in the documented order and all routes attached. Returns the instance without
 * starting to listen — the caller (index.ts) calls fastify.listen().
 *
 * Plugin registration order (must be preserved):
 *  1. request-id     — assigns request.id
 *  2. security-headers
 *  3. cors
 *  4. cookies        — must precede principal
 *  5. principal      — must precede rate-limit
 *  6. rate-limit
 *  7. compress
 *  8. multipart      — registered globally; limits enforced per-route
 *  9. Routes
 * 10. error-handler  — must be last
 */

import Fastify from "fastify";
import fastifyCompress from "@fastify/compress";
import fastifyMultipart from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import { getConfig } from "./config/env.js";
import { genReqId } from "./plugins/request-id.js";
import requestIdPlugin from "./plugins/request-id.js";
import securityHeadersPlugin from "./plugins/security-headers.js";
import corsPlugin from "./plugins/cors.js";
import cookiesPlugin from "./plugins/cookies.js";
import principalPlugin from "./plugins/principal.js";
import rateLimitPlugin from "./plugins/rate-limit.js";
import errorHandlerPlugin from "./plugins/error-handler.js";
import healthRoutes from "./routes/health.js";
import sessionRoute from "./routes/session.js";
import authRoutes from "./routes/auth.js";
import identifyRoute from "./routes/identify.js";
import identifyVideoRoute from "./routes/identify-video.js";
import tiktokRoutes from "./routes/tiktok.js";
import metricsRoute from "./routes/metrics.js";
import { applyRateLimit } from "./plugins/rate-limit.js";
import {
  SERVER_REQUEST_TIMEOUT_MS,
  SERVER_KEEP_ALIVE_TIMEOUT_MS,
  SERVER_CONNECTION_TIMEOUT_MS,
  GLOBAL_JSON_BODY_LIMIT,
  MAX_PARAM_LENGTH,
} from "./config/constants.js";

export async function buildApp(): Promise<FastifyInstance> {
  const cfg = getConfig();

  const fastify = Fastify({
    // Use our genReqId so inbound X-Request-Id is respected
    genReqId,

    // Pino logger — Fastify's built-in
    logger: {
      level: cfg.LOG_LEVEL,
      ...(cfg.LOG_PRETTY
        ? {
            transport: {
              target: "pino-pretty",
              options: { colorize: true, translateTime: "HH:MM:ss.l" },
            },
          }
        : {}),
      // Base fields on every log line
      base: {
        service: "claimguard-server",
        env: cfg.NODE_ENV,
        pid: process.pid,
      },
      // Redact sensitive paths
      redact: {
        paths: [
          "req.headers.cookie",
          "req.headers.authorization",
          "req.headers['x-forwarded-for']",
          "*.access_token",
          "*.refresh_token",
          "*.client_secret",
          "*.code_verifier",
          "*.signature",
          "*.access_secret",
        ],
        censor: "[REDACTED]",
      },
      serializers: {
        req(req) {
          const url: string =
            (req as { routeOptions?: { url?: string } }).routeOptions?.url
            ?? req.url?.split("?")[0]
            ?? req.url
            ?? "";
          return {
            method: req.method,
            url,
            requestId: req.id,
          };
        },
        res(res) {
          return { statusCode: res.statusCode };
        },
      },
    },

    // Timeout settings
    requestTimeout: SERVER_REQUEST_TIMEOUT_MS,
    keepAliveTimeout: SERVER_KEEP_ALIVE_TIMEOUT_MS,
    connectionTimeout: SERVER_CONNECTION_TIMEOUT_MS,

    // Body limit for JSON routes; multipart routes set their own
    bodyLimit: GLOBAL_JSON_BODY_LIMIT,
    maxParamLength: MAX_PARAM_LENGTH,

    // Trust proxy
    trustProxy: cfg.TRUST_PROXY as boolean | number | string,
  });

  // ── 1. Request ID ──────────────────────────────────────────────────────────
  await fastify.register(requestIdPlugin);

  // ── 2. Security headers ────────────────────────────────────────────────────
  await fastify.register(securityHeadersPlugin);

  // ── 3. CORS ────────────────────────────────────────────────────────────────
  await fastify.register(corsPlugin);

  // ── 4. Cookies ─────────────────────────────────────────────────────────────
  await fastify.register(cookiesPlugin);

  // ── 5. Principal ───────────────────────────────────────────────────────────
  await fastify.register(principalPlugin);

  // ── 6. Rate limiting ───────────────────────────────────────────────────────
  await fastify.register(rateLimitPlugin);

  // ── 6a. Global rate limit — 600 req / 60 s per IP, skip /health* and /metrics ─
  const globalRateLimit = applyRateLimit({ bucket: "global", max: 600, windowSeconds: 60 });
  fastify.addHook("preHandler", async (request, reply) => {
    const url = request.url ?? "";
    if (url.startsWith("/health") || url.startsWith("/metrics")) return;
    return globalRateLimit(request, reply);
  });

  // ── 7. Compression ─────────────────────────────────────────────────────────
  await fastify.register(fastifyCompress, {
    encodings: ["br", "gzip", "deflate"],
    threshold: 1024,
    // Only compress JSON and HTML
    customTypes: /^(application\/json|text\/html)($|;)/,
  });

  // ── 8. Multipart (global registration; per-route limits apply) ─────────────
  await fastify.register(fastifyMultipart, {
    // Multipart is registered globally but individual routes control whether
    // they parse it by calling request.parts() / request.file().
    // attachFieldsToBody is off so routes that do not expect multipart are not
    // affected.
    attachFieldsToBody: false,
  });

  // ── 9. Routes ──────────────────────────────────────────────────────────────
  await fastify.register(healthRoutes);
  await fastify.register(sessionRoute);
  await fastify.register(authRoutes);
  await fastify.register(identifyRoute);
  await fastify.register(identifyVideoRoute);
  await fastify.register(tiktokRoutes);
  await fastify.register(metricsRoute);

  // ── 10. Error handler (must be registered last) ────────────────────────────
  await fastify.register(errorHandlerPlugin);

  return fastify;
}
