/**
 * Route: GET /metrics
 *
 * Prometheus text-format exposition endpoint.
 *
 * Protection:
 *  - When METRICS_TOKEN is set, the request must supply it as a Bearer token
 *    in Authorization, or as the `token` query parameter.
 *    Returns 401 (JSON) if the token is wrong or absent.
 *  - When METRICS_TOKEN is not set, the endpoint returns 404 (JSON) so it is
 *    not discoverable on public deployments.
 *
 * This route is NOT on the /api/* prefix — it lives at the root so it is easy
 * to protect at the network layer (internal interface only, not proxied).
 *
 * Also exports `updateLiveGauges()` which refreshes volatile gauge values
 * (in-flight ACRCloud slots, circuit-breaker state) from live process state.
 */

import crypto from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { getConfig } from "../config/env.js";
import {
  registry,
  identifyInFlight,
  identifyQueueDepth,
  identifyCircuitBreakerOpen,
} from "../lib/metrics.js";
import { getIdentifyGauges } from "../services/acrcloud.js";

/* ── Live gauge refresh ──────────────────────────────────────────────────── */

/**
 * Refresh all gauges that reflect live in-process state rather than
 * accumulated counters.  Called just before rendering the metrics page.
 */
export function updateLiveGauges(): void {
  try {
    const g = getIdentifyGauges();
    identifyInFlight.set({}, g.inFlight);
    identifyQueueDepth.set({}, g.queueDepth);
    identifyCircuitBreakerOpen.set({}, g.circuitBreakerOpen ? 1 : 0);
  } catch {
    // acrcloud not configured — leave gauges at 0
  }
}

/* ── Route plugin ────────────────────────────────────────────────────────── */

const metricsRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/metrics",
    {
      config: { skipRateLimit: true },
      logLevel: "warn",
    },
    async (request, reply) => {
      const cfg = getConfig();

      // When METRICS_TOKEN is not configured, the endpoint is disabled.
      if (!cfg.METRICS_TOKEN) {
        return reply
          .status(404)
          .type("application/json")
          .send({ error: "Metrics endpoint is not enabled.", code: "not_found", requestId: request.id });
      }

      // Extract token from Bearer header or ?token= query param
      let providedToken: string | null = null;

      const authHeader = request.headers["authorization"] ?? "";
      if (authHeader.toLowerCase().startsWith("bearer ")) {
        providedToken = authHeader.slice(7).trim();
      } else {
        const qs = request.query as Record<string, string | undefined>;
        providedToken = qs["token"] ?? null;
      }

      if (!providedToken) {
        return reply
          .status(401)
          .type("application/json")
          .send({ error: "Missing metrics token.", code: "unauthorized", requestId: request.id });
      }

      // Constant-time comparison to prevent timing attacks on the token
      const expectedBuf = Buffer.from(cfg.METRICS_TOKEN, "utf8");
      const providedBuf = Buffer.from(providedToken, "utf8");
      const valid =
        expectedBuf.length === providedBuf.length &&
        crypto.timingSafeEqual(expectedBuf, providedBuf);

      if (!valid) {
        return reply
          .status(401)
          .type("application/json")
          .send({ error: "Invalid metrics token.", code: "unauthorized", requestId: request.id });
      }

      // Refresh live gauges immediately before rendering
      updateLiveGauges();

      const body = registry.render();
      return reply
        .status(200)
        .header("content-type", "text/plain; version=0.0.4; charset=utf-8")
        .header("cache-control", "no-store")
        .send(body);
    }
  );
};

export default metricsRoute;
