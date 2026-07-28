/**
 * Route: POST /api/identify
 *
 * Accepts one multipart audio sample, checks the cache, calls ACRCloud,
 * caches the result, and returns a normalised match.
 *
 * Order of operations (§2.1):
 *  1. Configuration gate — fail before consuming bytes.
 *  2. Content-type gate  — must be multipart/form-data.
 *  3. Stream multipart with hard byte ceiling.
 *  4. Presence and size checks.
 *  5. SHA-256 digest.
 *  6. Cache read.
 *  7. Upstream call (semaphore + circuit breaker live inside identifyAudio).
 *  8. Cache write (fire-and-forget).
 *  9. Respond 200 { match }.
 */

import crypto from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { getConfig } from "../config/env.js";
import { getDb } from "../db/client.js";
import {
  getCachedResult,
  writeCachedResult,
  type IdentifyMatch,
} from "../db/queries/identify-cache.js";
import { identifyAudio } from "../services/acrcloud.js";
import { applyRateLimit } from "../plugins/rate-limit.js";
import {
  ValidationError,
  AppError,
  ConfigurationError,
  UnsupportedMediaTypeError,
} from "../lib/errors.js";
import { DIGEST_LOG_PREFIX_LENGTH } from "../config/constants.js";
import {
  identifyRequestsTotal,
  identifyCacheHitsTotal,
  identifyCacheMissesTotal,
  identifyUpstreamErrorsTotal,
} from "../lib/metrics.js";

const identifyRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    "/api/identify",
    {
      preHandler: [
        applyRateLimit({ bucket: "identify",       max: 180,  windowSeconds: 60 }),
        applyRateLimit({ bucket: "identify_daily", max: 3000, windowSeconds: 86_400 }),
      ],
    },
    async (request, reply) => {
      const cfg = getConfig();

      // ── 1. Configuration gate ────────────────────────────────────────────
      // Fail before reading the body — no point buffering bytes we cannot use.
      if (!cfg.acrcloudEnabled) {
        throw new ConfigurationError(
          "Audio identification is not configured on this server."
        );
      }

      // ── 2. Content-type gate ─────────────────────────────────────────────
      const contentType = request.headers["content-type"] ?? "";
      if (!contentType.toLowerCase().includes("multipart/form-data")) {
        throw new UnsupportedMediaTypeError(
          "Send the audio sample as multipart/form-data."
        );
      }

      // ── 3. Stream multipart ──────────────────────────────────────────────
      const maxBytes = cfg.IDENTIFY_MAX_SAMPLE_BYTES;
      const maxMb = Math.round(maxBytes / (1024 * 1024));

      let sampleBuffer: Buffer | null = null;
      let fileCount = 0;

      const mp = request.parts({
        limits: {
          fileSize: maxBytes + 1, // +1 so we detect the boundary crossing
          files: 2,               // allow 2 so we can detect "too many"
        },
      });

      for await (const part of mp) {
        if (part.type === "file") {
          fileCount++;

          if (fileCount > 1) {
            // Drain remaining stream then reject
            part.file.resume();
            throw new ValidationError(
              "too_many_parts",
              "Send exactly one audio sample per request."
            );
          }

          if (part.fieldname !== "sample") {
            // Unknown file field — drain and skip
            part.file.resume();
            continue;
          }

          const chunks: Buffer[] = [];
          let bytesRead = 0;
          let tooLarge = false;

          for await (const chunk of part.file) {
            bytesRead += (chunk as Buffer).length;
            if (bytesRead > maxBytes) {
              tooLarge = true;
              // Drain the rest of this part
              for await (const _ of part.file) { /* drain */ }
              break;
            }
            chunks.push(chunk as Buffer);
          }

          if (tooLarge) {
            throw new AppError(
              413,
              "sample_too_large",
              `Audio sample is too large. Send at most ${maxMb} MiB per sample.`
            );
          }

          sampleBuffer = Buffer.concat(chunks);
        }
        // Non-file fields are read and discarded automatically by the iterator.
      }

      // ── 4. Presence and size checks ──────────────────────────────────────
      if (sampleBuffer === null) {
        throw new ValidationError("sample_required", "No audio sample provided.");
      }
      if (sampleBuffer.length === 0) {
        throw new ValidationError("sample_empty", "The audio sample is empty.");
      }

      // ── 5. Digest ────────────────────────────────────────────────────────
      const digestBuffer = Buffer.from(
        crypto.createHash("sha256").update(sampleBuffer).digest()
      );
      const digestPrefix = digestBuffer.toString("hex").slice(0, DIGEST_LOG_PREFIX_LENGTH);

      // ── 6. Cache read ────────────────────────────────────────────────────
      if (cfg.IDENTIFY_CACHE_TTL_SECONDS > 0) {
        const cached = await getCachedResult(getDb(), digestBuffer);
        if (cached) {
          const ageSeconds = Math.floor(
            (Date.now() - new Date(cached.created_at).getTime()) / 1_000
          );
          request.log.debug(
            { requestId: request.id, digestPrefix, ageSeconds },
            "Identify cache hit"
          );
          identifyCacheHitsTotal.inc({});
          identifyRequestsTotal.inc({ outcome: "cache_hit" });
          return reply.send({ match: cached.match });
        }
      }

      identifyCacheMissesTotal.inc({});

      // ── 7. Upstream call ─────────────────────────────────────────────────
      // identifyAudio handles: semaphore acquisition, circuit breaker, retry.
      // On AppError 503 with retryAfterSeconds, we forward the Retry-After header.
      let result: Awaited<ReturnType<typeof identifyAudio>>;
      try {
        result = await identifyAudio(sampleBuffer, request.log);
      } catch (err) {
        // Forward Retry-After header on busy / rate-limited responses.
        if (err instanceof AppError && err.retryAfterSeconds !== undefined) {
          reply.header("retry-after", String(err.retryAfterSeconds));
        }
        const errCode = err instanceof AppError ? err.code : "unknown";
        identifyUpstreamErrorsTotal.inc({ code: errCode });
        identifyRequestsTotal.inc({ outcome: "upstream_error" });
        throw err;
      }

      // ── 8. Cache write (fire-and-forget) ─────────────────────────────────
      if (cfg.IDENTIFY_CACHE_TTL_SECONDS > 0) {
        writeCachedResult(getDb(), {
          digestBuffer,
          sampleBytes: sampleBuffer.length,
          acrStatusCode: result.match !== null ? 0 : 1001,
          match: result.match as IdentifyMatch | null,
          ttlSeconds: cfg.IDENTIFY_CACHE_TTL_SECONDS,
        }).catch((err) => {
          request.log.warn({ err }, "Failed to write identify cache");
        });
      }

      // ── 9. Respond ───────────────────────────────────────────────────────
      identifyRequestsTotal.inc({ outcome: result.match !== null ? "matched" : "no_match" });
      return reply.send({ match: result.match });
    }
  );
};

export default fp(identifyRoute, { name: "route-identify", fastify: "5.x" });
