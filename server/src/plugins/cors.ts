/**
 * Plugin: CORS
 *
 * Allowlist from CORS_ALLOWED_ORIGINS (comma-separated exact origins).
 * When the list is empty, no CORS headers are added — same-origin deployments
 * need none.
 *
 * Access-Control-Allow-Credentials: true
 * Allowed methods: GET, POST, DELETE, OPTIONS
 * Allowed request headers: Content-Type, X-Request-Id
 * Exposed response headers: X-Request-Id, Retry-After
 * Preflight max age: 600 s
 * Preflight answers 204 with no body.
 * An origin not on the list receives no CORS headers at all.
 */

import fp from "fastify-plugin";
import fastifyCors from "@fastify/cors";
import type { FastifyPluginAsync } from "fastify";
import { getConfig } from "../config/env.js";

const corsPlugin: FastifyPluginAsync = async (fastify) => {
  const { CORS_ALLOWED_ORIGINS } = getConfig();

  if (CORS_ALLOWED_ORIGINS.length === 0) {
    // No cross-origin access permitted — skip registering CORS headers.
    return;
  }

  const allowedSet = new Set(CORS_ALLOWED_ORIGINS);

  await fastify.register(fastifyCors, {
    origin: (origin, cb) => {
      // Allow requests with no origin (same-origin, curl, server-to-server).
      if (!origin) return cb(null, true);
      if (allowedSet.has(origin)) return cb(null, true);
      // Origin not on the list — respond with no CORS headers.
      return cb(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Request-Id"],
    exposedHeaders: ["X-Request-Id", "Retry-After"],
    maxAge: 600,
    // Preflight: 204 No Content with no body.
    preflightContinue: false,
    optionsSuccessStatus: 204,
  });
};

export default fp(corsPlugin, {
  name: "cors",
  fastify: "5.x",
});
