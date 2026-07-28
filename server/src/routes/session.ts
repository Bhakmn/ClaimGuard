/**
 * Route: GET /api/session
 *
 * Returns whether auth is enabled and, when signed in, the current user's
 * profile. Never returns 401 — a missing/invalid session is a 200 with
 * user: null.
 */

import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { getConfig } from "../config/env.js";
import { getDb } from "../db/client.js";
import { findUserById } from "../db/queries/users.js";
import { applyRateLimit } from "../plugins/rate-limit.js";

const sessionRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/api/session",
    {
      preHandler: [
        applyRateLimit({ bucket: "session", max: 120, windowSeconds: 60 }),
      ],
    },
    async (request, reply) => {
      const cfg = getConfig();
      const { principal } = request;

      if (!principal.isAuthenticated || !principal.userId) {
        return reply.send({ authEnabled: cfg.authEnabled, user: null });
      }

      const user = await findUserById(getDb(), principal.userId);

      if (!user) {
        return reply.send({ authEnabled: cfg.authEnabled, user: null });
      }

      // Build user object — omit optional fields rather than sending null
      const userOut: Record<string, unknown> = { id: user.id };
      if (user.name) userOut["name"] = user.name;
      if (user.email) userOut["email"] = user.email;
      if (user.picture) userOut["picture"] = user.picture;

      return reply.send({ authEnabled: cfg.authEnabled, user: userOut });
    }
  );
};

export default fp(sessionRoute, { name: "route-session", fastify: "5.x" });
