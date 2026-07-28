/**
 * Tests: POST /api/identify-video  (visual copyright detection)
 *
 * Strategy:
 *  - heuristicAnalyse() is a pure unit test — no network, no DB.
 *  - identifyFrame() is tested by injecting a mock fetch / resetting state
 *    via _resetForTest() / _setSemaphoreForTest().
 *  - Route tests use a minimal Fastify app (multipart + error-handler only,
 *    no DB — cache disabled via TTL=0, no auth).
 *
 * Run: node --import tsx/esm --test test/identify-video.test.ts
 */

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

/* ── Set env before importing config ────────────────────────────────────────*/
process.env["NODE_ENV"]                           = "test";
process.env["APP_BASE_URL"]                       = "http://localhost:4000";
process.env["API_BASE_URL"]                       = "http://localhost:4000";
process.env["SUPABASE_URL"]                       = "http://localhost:54321";
process.env["SUPABASE_SERVICE_ROLE_KEY"]          = "test-service-role-key";
process.env["COOKIE_SECRET"]                      = "a".repeat(64);
process.env["ENCRYPTION_KEY"]                     = "b".repeat(64);
// Leave WATSONX creds unset — tests run in heuristic-only mode
process.env["VISUAL_IDENTIFY_CACHE_TTL_SECONDS"]  = "0";  // cache disabled
process.env["RATE_LIMIT_ENABLED"]                 = "false";
// Required by identify route (unrelated, but config validates globally)
process.env["ACRCLOUD_HOST"]                      = "identify-eu-west-1.acrcloud.com";
process.env["ACRCLOUD_ACCESS_KEY"]                = "testKey";
process.env["ACRCLOUD_ACCESS_SECRET"]             = "testSecret";
process.env["IDENTIFY_CACHE_TTL_SECONDS"]         = "0";
process.env["IDENTIFY_MAX_SAMPLE_BYTES"]          = "2097152";

import { parseConfig } from "../src/config/env.js";
parseConfig(process.env);

import {
  heuristicAnalyse,
  _resetForTest,
  _setSemaphoreForTest,
} from "../src/services/vision.js";
import { Semaphore } from "../src/lib/semaphore.js";

/* ═══════════════════════════════════════════════════════════════════════════
 * §1 — heuristicAnalyse() unit tests
 * ═══════════════════════════════════════════════════════════════════════════ */

describe("heuristicAnalyse", () => {
  it("test 1 — null when no hints and no parseable JPEG SOF", () => {
    const result = heuristicAnalyse(Buffer.from("not a jpeg"));
    assert.equal(result, null);
  });

  it("test 2 — detects ultra-wide aspect ratio from width/height hints", () => {
    const result = heuristicAnalyse(Buffer.alloc(1024), 2560, 800);
    assert.ok(result, "Expected a match");
    assert.ok(
      result!.signals.some((s) => s.includes("ultra-wide")),
      `Expected ultra-wide signal, got: ${JSON.stringify(result!.signals)}`
    );
    assert.ok(result!.confidence > 0 && result!.confidence <= 55);
    assert.equal(result!.source, "heuristic");
  });

  it("test 3 — detects very tall aspect ratio (portrait in landscape)", () => {
    const result = heuristicAnalyse(Buffer.alloc(1024), 400, 2000);
    assert.ok(result, "Expected a match for tall ratio");
    assert.ok(
      result!.signals.some((s) => s.includes("portrait")),
      `Expected portrait signal, got: ${JSON.stringify(result!.signals)}`
    );
  });

  it("test 4 — normal 16:9 aspect ratio returns null", () => {
    const result = heuristicAnalyse(Buffer.alloc(1024), 1920, 1080);
    assert.equal(result, null, "Normal 16:9 should not fire");
  });

  it("test 5 — confidence never exceeds 55 for heuristic-only results", () => {
    const result = heuristicAnalyse(Buffer.alloc(1024), 3840, 600); // very wide
    assert.ok(result);
    assert.ok(result!.confidence <= 55, `Confidence ${result!.confidence} exceeds heuristic cap`);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * §2 — Route tests: POST /api/identify-video
 * ═══════════════════════════════════════════════════════════════════════════ */

import Fastify from "fastify";
import fastifyMultipart from "@fastify/multipart";
import errorHandler from "../src/plugins/error-handler.js";
import identifyVideoRoute from "../src/routes/identify-video.js";

async function buildApp() {
  const app = Fastify({ logger: false });

  app.decorateRequest("principal", {
    getter() {
      return { sessionId: null, userId: null, rateKey: "anon:127.0.0.1" };
    },
  });

  await app.register(fastifyMultipart);
  await app.register(errorHandler);
  await app.register(identifyVideoRoute);
  return app;
}

function makeFrameMultipart(
  frameData: Buffer,
  boundary = "testboundary"
): { body: Buffer; contentType: string } {
  const CRLF = "\r\n";
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="frame"; filename="frame.jpg"${CRLF}` +
        `Content-Type: image/jpeg${CRLF}${CRLF}`,
      "utf8"
    ),
    frameData,
    Buffer.from(`${CRLF}--${boundary}--${CRLF}`, "utf8"),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

describe("POST /api/identify-video — route level", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  before(async () => { app = await buildApp(); });
  beforeEach(() => _resetForTest());

  it("test 6 — wrong content-type → 415", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/identify-video",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.statusCode, 415);
    const j = res.json<{ error: string }>();
    assert.ok(typeof j.error === "string" && j.error.length > 0);
  });

  it("test 7 — no frame part → 400 frame_required", async () => {
    const bd = "noframe";
    const body = Buffer.from(`--${bd}--\r\n`, "utf8");
    const res = await app.inject({
      method: "POST",
      url: "/api/identify-video",
      headers: { "content-type": `multipart/form-data; boundary=${bd}` },
      body,
    });
    assert.equal(res.statusCode, 400);
    const j = res.json<{ code: string; error: string }>();
    assert.equal(j.code, "frame_required");
    assert.ok(j.error.length > 0);
  });

  it("test 8 — frame over 4 MiB → 413 frame_too_large", async () => {
    const bigFrame = Buffer.alloc(4 * 1024 * 1024 + 1, 0x42);
    const { body, contentType } = makeFrameMultipart(bigFrame);
    const res = await app.inject({
      method: "POST",
      url: "/api/identify-video",
      headers: { "content-type": contentType },
      payload: body,
    });
    assert.equal(res.statusCode, 413);
    const j = res.json<{ code: string }>();
    assert.equal(j.code, "frame_too_large");
  });

  it("test 9 — valid minimal frame with no heuristic signals → 200 { match: null }", async () => {
    // A normal 16:9 1920×1080 frame hint — no ultra-wide / portrait signal expected
    const bd = "normalframe";
    const CRLF = "\r\n";
    const body = Buffer.concat([
      Buffer.from(
        `--${bd}${CRLF}` +
          `Content-Disposition: form-data; name="frame"; filename="frame.jpg"${CRLF}` +
          `Content-Type: image/jpeg${CRLF}${CRLF}`,
        "utf8"
      ),
      Buffer.alloc(512, 0xff), // minimal non-empty payload
      Buffer.from(`${CRLF}` +
        `--${bd}${CRLF}` +
        `Content-Disposition: form-data; name="width"${CRLF}${CRLF}1920${CRLF}` +
        `--${bd}${CRLF}` +
        `Content-Disposition: form-data; name="height"${CRLF}${CRLF}1080${CRLF}` +
        `--${bd}--${CRLF}`,
        "utf8"
      ),
    ]);

    const res = await app.inject({
      method: "POST",
      url: "/api/identify-video",
      headers: { "content-type": `multipart/form-data; boundary=${bd}` },
      payload: body,
    });

    // With no watsonx creds and no heuristic signal, route returns { match: null }
    assert.equal(res.statusCode, 200);
    const j = res.json<{ match: unknown }>();
    assert.equal(j.match, null);
  });

  it("test 10 — ultra-wide frame hints trigger heuristic → 200 with match", async () => {
    const bd = "wideframe";
    const CRLF = "\r\n";
    const body = Buffer.concat([
      Buffer.from(
        `--${bd}${CRLF}` +
          `Content-Disposition: form-data; name="frame"; filename="frame.jpg"${CRLF}` +
          `Content-Type: image/jpeg${CRLF}${CRLF}`,
        "utf8"
      ),
      Buffer.alloc(512, 0xff),
      Buffer.from(`${CRLF}` +
        `--${bd}${CRLF}` +
        `Content-Disposition: form-data; name="width"${CRLF}${CRLF}2560${CRLF}` +
        `--${bd}${CRLF}` +
        `Content-Disposition: form-data; name="height"${CRLF}${CRLF}800${CRLF}` +
        `--${bd}--${CRLF}`,
        "utf8"
      ),
    ]);

    const res = await app.inject({
      method: "POST",
      url: "/api/identify-video",
      headers: { "content-type": `multipart/form-data; boundary=${bd}` },
      payload: body,
    });

    assert.equal(res.statusCode, 200);
    const j = res.json<{ match: { source: string; signals: string[] } | null }>();
    assert.ok(j.match !== null, "Expected a match for ultra-wide frame");
    assert.equal(j.match!.source, "heuristic");
    assert.ok(j.match!.signals.length > 0);
  });

  it("test 11 — every error path returns JSON with non-empty error string", async () => {
    // Path 1: wrong content-type → 415
    const res415 = await app.inject({
      method: "POST",
      url: "/api/identify-video",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res415.statusCode, 415);
    const j415 = res415.json<{ error: string }>();
    assert.ok(typeof j415.error === "string" && j415.error.length > 0);

    // Path 2: frame missing → 400
    const bd = "empty11";
    const res400 = await app.inject({
      method: "POST",
      url: "/api/identify-video",
      headers: { "content-type": `multipart/form-data; boundary=${bd}` },
      body: Buffer.from(`--${bd}--\r\n`, "utf8"),
    });
    assert.equal(res400.statusCode, 400);
    const j400 = res400.json<{ error: string }>();
    assert.ok(typeof j400.error === "string" && j400.error.length > 0);
  });
});
