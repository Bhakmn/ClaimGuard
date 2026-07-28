/**
 * Plugin: request-id
 *
 * Reads X-Request-Id from the incoming request header.
 * Accepts it when it matches ^[A-Za-z0-9._-]{1,128}$.
 * Generates a UUID v4 when absent or invalid.
 * Binds the id to `request.id` (Fastify's built-in field).
 * Sets X-Request-Id on every response, including error responses.
 */

import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import crypto from "node:crypto";

const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

const requestIdPlugin: FastifyPluginAsync = async (fastify) => {
  // Override Fastify's built-in request ID generation to prefer the header.
  // Fastify calls genReqId once per request, before any hook runs.
  fastify.addHook("onRequest", async (request, reply) => {
    const inbound = request.headers["x-request-id"];
    const raw = Array.isArray(inbound) ? inbound[0] : inbound;

    if (raw && SAFE_ID_RE.test(raw)) {
      // request.id is set by genReqId before hooks run; if genReqId already
      // picked up the header (matching SAFE_ID_RE), the value is already correct
      // and this branch is a no-op.  We leave it here for clarity.
      (request as unknown as { id: string }).id = raw;
    }
    // If absent / invalid, Fastify already set request.id from genReqId below.

    reply.header("x-request-id", request.id);
  });

  // Echo the id on all responses, including those cut short by later hooks.
  fastify.addHook("onSend", async (_request, reply) => {
    if (!reply.hasHeader("x-request-id")) {
      reply.header("x-request-id", _request.id);
    }
  });
};

export default fp(requestIdPlugin, {
  name: "request-id",
  fastify: "5.x",
});

/**
 * genReqId function to pass to Fastify's constructor options.
 * Generates a UUID v4 when there is no acceptable header value.
 * Fastify calls this before any hook, so the header check in the hook above
 * can then override it for accepted inbound IDs.
 */
export function genReqId(_req: { headers: Record<string, unknown> }): string {
  const inbound = _req.headers["x-request-id"];
  const raw = Array.isArray(inbound) ? inbound[0] : inbound;
  if (typeof raw === "string" && SAFE_ID_RE.test(raw)) return raw;
  return crypto.randomUUID();
}
