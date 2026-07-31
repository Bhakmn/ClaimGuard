/**
 * Plugin: cookies
 *
 * Registers @fastify/cookie with HMAC-signed cookies.
 *
 * Default cookie attributes applied by all cookie-writing routes:
 *   HttpOnly: true
 *   SameSite: "lax"
 *   Path: "/"
 *   Secure: from COOKIE_SECURE config
 *
 * Routes call reply.setCookie(name, value, { ...defaultCookieOpts() }) so the
 * default attributes are always applied; they only override what they need to.
 */

import fp from "fastify-plugin";
import fastifyCookie from "@fastify/cookie";
import type { FastifyPluginAsync } from "fastify";
import type { CookieSerializeOptions } from "@fastify/cookie";
import { getConfig } from "../config/env.js";

const cookiesPlugin: FastifyPluginAsync = async (fastify) => {
  const cfg = getConfig();

  await fastify.register(fastifyCookie, {
    secret: cfg.COOKIE_SECRET,
    parseOptions: {},
  });
};

export default fp(cookiesPlugin, {
  name: "cookies",
  fastify: "5.x",
});

/** Return the default cookie options to apply on every session cookie write. */
export function defaultCookieOpts(): CookieSerializeOptions {
  const cfg = getConfig();
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: cfg.COOKIE_SECURE,
    signed: true,
  };
}
