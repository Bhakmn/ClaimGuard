/**
 * Health routes
 *
 * GET /health/live — liveness probe; no dependency checks.
 * GET /health      — readiness probe; checks DB, reports event-loop delay,
 *                    heap usage, and feature configuration flags.
 *
 * Both routes:
 *  - Exempt from rate limiting.
 *  - Use Cache-Control: no-cache (set by security-headers plugin).
 *  - Log at DEBUG, not INFO, so probes do not flood the stream.
 */

import type { FastifyPluginAsync } from "fastify";
import { probeDatabase } from "../db/client.js";
import { getConfig } from "../config/env.js";
import { nowIso } from "../lib/time.js";
import { HEALTH_DB_TIMEOUT_MS, HEALTH_EL_DEGRADED_MS } from "../config/constants.js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isShuttingDown } from "../lib/shutdown.js";

/* ── Package version ─────────────────────────────────────────────────────── */

function readVersion(): string {
  try {
    const __dir = dirname(fileURLToPath(import.meta.url));
    const pkgPath = resolve(__dir, "../../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const VERSION = readVersion();
const START_MS = Date.now();

/* ── Route plugin ────────────────────────────────────────────────────────── */

const healthRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /health/live
   * Liveness only — 200 while running, 503 after shutdown begins.
   */
  fastify.get(
    "/health/live",
    {
      config: { skipRateLimit: true },
      logLevel: "warn", // suppress per-request info lines for probes
    },
    async (_request, reply) => {
      reply.log.debug("health/live");
      if (isShuttingDown()) {
        return reply.status(503).send({ status: "shutting_down" });
      }
      return reply.status(200).send({ status: "ok" });
    }
  );

  /**
   * GET /health
   * Readiness — database check + event-loop stats + feature flags.
   */
  fastify.get(
    "/health",
    {
      config: { skipRateLimit: true },
      logLevel: "warn",
    },
    async (_request, reply) => {
      reply.log.debug("health");
      const cfg = getConfig();

      // ── Database check ────────────────────────────────────────────────────
      let dbStatus: "ok" | "failed" | "unconfigured" = cfg.dbEnabled ? "ok" : "unconfigured";
      let dbLatencyMs = 0;
      let dbReason: string | undefined;

      if (cfg.dbEnabled) {
        try {
          dbLatencyMs = await probeDatabase(HEALTH_DB_TIMEOUT_MS);
        } catch (err) {
          dbStatus = "failed";
          dbReason = err instanceof Error ? err.message : "unknown";
          dbLatencyMs = HEALTH_DB_TIMEOUT_MS;
        }
      }

      // ── Event-loop delay (approximate via timer drift) ────────────────────
      const elDelay = await measureEventLoopDelay();

      // ── Heap usage ────────────────────────────────────────────────────────
      const { heapUsed: heapUsedBytes } = process.memoryUsage();

      // ── Overall status ────────────────────────────────────────────────────
      // DB "unconfigured" is not a failure — the server runs intentionally without it.
      const degraded =
        dbStatus === "failed" || elDelay >= HEALTH_EL_DEGRADED_MS;

      const status = degraded ? "degraded" : "ok";
      const httpStatus = degraded ? 503 : 200;

      const body = {
        status,
        version: VERSION,
        uptimeSeconds: Math.floor((Date.now() - START_MS) / 1_000),
        timestamp: nowIso(),
        checks: {
          database:
            dbStatus === "ok"
              ? { status: "ok", latencyMs: dbLatencyMs }
              : dbStatus === "unconfigured"
              ? { status: "unconfigured" }
              : { status: "failed", latencyMs: dbLatencyMs, reason: dbReason },
          eventLoopDelayMs: elDelay,
          heapUsedBytes,
          acrcloud: { configured: cfg.acrcloudEnabled },
          tiktok: { configured: cfg.tiktokEnabled },
          auth0: { configured: cfg.authEnabled },
        },
      };

      return reply.status(httpStatus).send(body);
    }
  );
};

export default healthRoutes;

/* ── Event-loop delay helper ─────────────────────────────────────────────── */

/** Measure approximate event-loop delay via a zero-timeout timer drift. */
function measureEventLoopDelay(): Promise<number> {
  return new Promise((resolve) => {
    const before = Date.now();
    setImmediate(() => {
      resolve(Date.now() - before);
    });
  });
}
