/**
 * Plugin: security-headers
 *
 * Sets conservative security headers on every response.
 *
 * Special cases:
 *  - /api/tiktok/auth and /api/tiktok/callback use COOP: unsafe-none so the
 *    OAuth popup can reach window.opener.
 *  - /health and /health/live use Cache-Control: no-cache instead of no-store.
 *  - All other /api/** and /auth/** routes use Cache-Control: no-store.
 */

import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";

// Routes where the popup must access window.opener — relax COOP.
const POPUP_PATHS = new Set(["/api/tiktok/auth", "/api/tiktok/callback"]);

// Health routes that should use no-cache (probe results can be cached briefly).
const HEALTH_PATHS = new Set(["/health", "/health/live"]);

const securityHeadersPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("onSend", async (request, reply) => {
    const path = request.routeOptions?.url ?? request.url.split("?")[0] ?? "";

    // Always set these
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("cross-origin-resource-policy", "same-origin");

    // Cross-Origin-Opener-Policy
    if (POPUP_PATHS.has(path)) {
      // Popup routes must reach window.opener
      reply.header("cross-origin-opener-policy", "unsafe-none");
    } else {
      reply.header("cross-origin-opener-policy", "same-origin");
    }

    // Cache-Control
    if (HEALTH_PATHS.has(path)) {
      reply.header("cache-control", "no-cache");
    } else if (
      path.startsWith("/api/") ||
      path.startsWith("/auth/")
    ) {
      reply.header("cache-control", "no-store");
    }
    // Static assets / other routes: no Cache-Control override from this plugin.
  });
};

export default fp(securityHeadersPlugin, {
  name: "security-headers",
  fastify: "5.x",
});
