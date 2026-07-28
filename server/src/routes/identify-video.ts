/**
 * Route: POST /api/identify-video
 *
 * Accepts one multipart JPEG/PNG video frame, checks the visual cache,
 * calls the vision service (heuristic + optional Granite Vision), caches
 * the result, and returns a normalised VisualMatch or null.
 *
 * Gate order mirrors /api/identify exactly (§2.1):
 *  1. Content-type gate  — must be multipart/form-data.
 *  2. Stream multipart with hard byte ceiling.
 *  3. Presence and size checks.
 *  4. SHA-256 digest.
 *  5. Cache read.
 *  6. Upstream call (semaphore + circuit breaker inside identifyFrame).
 *  7. Cache write (fire-and-forget).
 *  8. Respond 200 { match }.
 *
 * Note: there is no configuration gate on step 1 because the heuristic
 * pre-pass runs with zero credentials.  When neither heuristics nor the
 * model fire, { match: null } is returned — not an error.
 */

import crypto from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { getConfig } from "../config/env.js";
import { getDb } from "../db/client.js";
import {
  getVisualCachedResult,
  writeVisualCachedResult,
  type VisualMatch,
} from "../db/queries/visual-identify-cache.js";
import { identifyFrame } from "../services/vision.js";
import { applyRateLimit } from "../plugins/rate-limit.js";
import {
  ValidationError,
  AppError,
  UnsupportedMediaTypeError,
  ConfigurationError,
} from "../lib/errors.js";
import { DIGEST_LOG_PREFIX_LENGTH } from "../config/constants.js";
import {
  visualIdentifyRequestsTotal,
  visualIdentifyCacheHitsTotal,
  visualIdentifyCacheMissesTotal,
  visualIdentifyUpstreamErrorsTotal,
} from "../lib/metrics.js";

/** Max frame bytes accepted: 4 MiB (JPEG/PNG frames are typically 50–400 KiB) */
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

const identifyVideoRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    "/api/identify-video",
    {
      preHandler: [
        applyRateLimit({ bucket: "identify_video",       max: 300,   windowSeconds: 60 }),
        applyRateLimit({ bucket: "identify_video_daily", max: 10_000, windowSeconds: 86_400 }),
      ],
    },
    async (request, reply) => {
      const cfg = getConfig();

      // ── 1. Content-type gate ─────────────────────────────────────────────
      const contentType = request.headers["content-type"] ?? "";
      if (!contentType.toLowerCase().includes("multipart/form-data")) {
        throw new UnsupportedMediaTypeError(
          "Send the video frame as multipart/form-data."
        );
      }

      // ── 2. Stream multipart ──────────────────────────────────────────────
      const maxMb = Math.round(MAX_FRAME_BYTES / (1024 * 1024));
      let frameBuffer: Buffer | null = null;
      let fileCount = 0;
      let widthHint: number | undefined;
      let heightHint: number | undefined;

      const mp = request.parts({
        limits: {
          fileSize: MAX_FRAME_BYTES + 1,
          files: 2,
        },
      });

      for await (const part of mp) {
        if (part.type === "file") {
          fileCount++;

          if (fileCount > 1) {
            part.file.resume();
            throw new ValidationError(
              "too_many_parts",
              "Send exactly one frame per request."
            );
          }

          if (part.fieldname !== "frame") {
            part.file.resume();
            continue;
          }

          const chunks: Buffer[] = [];
          let bytesRead = 0;
          let tooLarge = false;

          for await (const chunk of part.file) {
            bytesRead += (chunk as Buffer).length;
            if (bytesRead > MAX_FRAME_BYTES) {
              tooLarge = true;
              for await (const _ of part.file) { /* drain */ }
              break;
            }
            chunks.push(chunk as Buffer);
          }

          if (tooLarge) {
            throw new AppError(
              413,
              "frame_too_large",
              `Frame is too large. Send at most ${maxMb} MiB per frame.`
            );
          }

          frameBuffer = Buffer.concat(chunks);
        } else {
          // Text fields: width / height hints from the client
          if (part.fieldname === "width") {
            const v = Number(await part.value);
            if (isFinite(v) && v > 0) widthHint = v;
          } else if (part.fieldname === "height") {
            const v = Number(await part.value);
            if (isFinite(v) && v > 0) heightHint = v;
          }
        }
      }

      // ── 3. Presence and size checks ──────────────────────────────────────
      if (frameBuffer === null) {
        throw new ValidationError("frame_required", "No video frame provided.");
      }
      if (frameBuffer.length === 0) {
        throw new ValidationError("frame_empty", "The video frame is empty.");
      }

      // ── 4. Digest ────────────────────────────────────────────────────────
      const digestBuffer = Buffer.from(
        crypto.createHash("sha256").update(frameBuffer).digest()
      );
      const digestPrefix = digestBuffer.toString("hex").slice(0, DIGEST_LOG_PREFIX_LENGTH);

      // ── 5. Cache read ────────────────────────────────────────────────────
      const cacheTtl = cfg.VISUAL_IDENTIFY_CACHE_TTL_SECONDS;
      if (cacheTtl > 0 && cfg.dbEnabled) {
        const cached = await getVisualCachedResult(getDb(), digestBuffer);
        if (cached) {
          const ageSeconds = Math.floor(
            (Date.now() - new Date(cached.created_at).getTime()) / 1_000
          );
          request.log.debug(
            { requestId: request.id, digestPrefix, ageSeconds },
            "Visual identify cache hit"
          );
          visualIdentifyCacheHitsTotal.inc({});
          visualIdentifyRequestsTotal.inc({ outcome: "cache_hit" });
          return reply.send({ match: cached.result });
        }
      }

      visualIdentifyCacheMissesTotal.inc({});

      // ── 6. Upstream call ─────────────────────────────────────────────────
      let result: Awaited<ReturnType<typeof identifyFrame>>;
      try {
        result = await identifyFrame(frameBuffer, widthHint, heightHint, request.log);
      } catch (err) {
        // ConfigurationError = no creds AND no heuristic fired — return null match
        if (err instanceof ConfigurationError) {
          visualIdentifyRequestsTotal.inc({ outcome: "no_config" });
          return reply.send({ match: null });
        }
        if (err instanceof AppError && err.retryAfterSeconds !== undefined) {
          reply.header("retry-after", String(err.retryAfterSeconds));
        }
        const errCode = err instanceof AppError ? err.code : "unknown";
        visualIdentifyUpstreamErrorsTotal.inc({ code: errCode });
        visualIdentifyRequestsTotal.inc({ outcome: "upstream_error" });
        throw err;
      }

      // ── 7. Cache write (fire-and-forget) ─────────────────────────────────
      if (cacheTtl > 0 && cfg.dbEnabled) {
        const source = result.match?.source ?? "heuristic";
        writeVisualCachedResult(getDb(), {
          digestBuffer,
          frameBytes: frameBuffer.length,
          source,
          result: result.match as VisualMatch | null,
          ttlSeconds: cacheTtl,
        }).catch((err) => {
          request.log.warn({ err }, "Failed to write visual identify cache");
        });
      }

      // ── 8. Respond ───────────────────────────────────────────────────────
      visualIdentifyRequestsTotal.inc({
        outcome: result.match !== null ? "matched" : "no_match",
      });
      return reply.send({ match: result.match });
    }
  );
};

export default fp(identifyVideoRoute, { name: "route-identify-video", fastify: "5.x" });
