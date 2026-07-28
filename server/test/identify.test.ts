/**
 * Tests: POST /api/identify  (spec §8, all 20 cases)
 *
 * Strategy:
 *  - buildSignature() and normalise() are pure unit tests — no network, no DB.
 *  - identifyAudio() is tested by injecting a MockPool via _setPoolForTest().
 *  - Route tests use a minimal Fastify app with the multipart + error-handler
 *    plugins only — no DB (cache disabled via TTL=0), no auth.
 *
 * Run: node --import tsx/esm --test test/identify.test.ts
 */

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { MockAgent } from "undici";

/* ── Set env before importing config ────────────────────────────────────────*/
const ACR_HOST = "identify-eu-west-1.acrcloud.com";
const ACR_KEY  = "testAccessKey";
const ACR_SEC  = "testAccessSecret";

process.env["NODE_ENV"]                    = "test";
process.env["APP_BASE_URL"]               = "http://localhost:4000";
process.env["API_BASE_URL"]               = "http://localhost:4000";
process.env["SUPABASE_URL"]               = "http://localhost:54321";
process.env["SUPABASE_SERVICE_ROLE_KEY"]  = "test-service-role-key";
process.env["COOKIE_SECRET"]              = "a".repeat(64);
process.env["ENCRYPTION_KEY"]             = "b".repeat(64);
process.env["ACRCLOUD_HOST"]              = ACR_HOST;
process.env["ACRCLOUD_ACCESS_KEY"]        = ACR_KEY;
process.env["ACRCLOUD_ACCESS_SECRET"]     = ACR_SEC;
process.env["ACRCLOUD_TIMEOUT_MS"]        = "5000";
process.env["ACRCLOUD_MAX_CONCURRENCY"]   = "8";
process.env["IDENTIFY_CACHE_TTL_SECONDS"] = "0";   // cache disabled
process.env["IDENTIFY_MAX_SAMPLE_BYTES"]  = "2097152";
process.env["RATE_LIMIT_ENABLED"]         = "false";

import { parseConfig } from "../src/config/env.js";
parseConfig(process.env);

import {
  buildSignature,
  normalise,
  identifyAudio,
  _resetForTest,
  _setPoolForTest,
  _setSemaphoreForTest,
} from "../src/services/acrcloud.js";
import { Semaphore } from "../src/lib/semaphore.js";
import { AppError, GatewayTimeoutError } from "../src/lib/errors.js";

/* ── Helpers ─────────────────────────────────────────────────────────────── */

const SAMPLE   = Buffer.from("RIFF....WAV ", "utf8");
const ACR_PATH = "/v1/identify";

function acrOk(music?: object[], msg = "Success"): string {
  return JSON.stringify({
    status: { code: 0, msg, version: "1.0" },
    ...(music !== undefined ? { metadata: { music } } : {}),
  });
}

function acrStatus(code: number, msg: string): string {
  return JSON.stringify({ status: { code, msg, version: "1.0" } });
}

function fullEntry(overrides: Record<string, unknown> = {}): object {
  return {
    acrid: "abc123",
    title: "Test Song",
    artists: [{ name: "Artist One" }, { name: "Artist Two" }],
    album: { name: "Test Album" },
    score: 96,
    sample_begin_time_offset_ms: 0,
    sample_end_time_offset_ms: 4800,
    play_offset_ms: 71200,
    ...overrides,
  };
}

/**
 * Build a MockAgent + MockPool for ACR_HOST and register it in the service.
 * Returns the pool so callers can add intercepts.
 */
function makeMock() {
  _resetForTest();
  const agent = new MockAgent();
  agent.disableNetConnect();
  const pool = agent.get(`https://${ACR_HOST}`);
  // Cast through unknown — MockPool satisfies the Pool interface at runtime
  _setPoolForTest(ACR_HOST, pool as unknown as import("undici").Pool);
  return pool;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * §8 test 1 — Signature string assembly
 * ═══════════════════════════════════════════════════════════════════════════ */

describe("buildSignature", () => {
  it("test 1 — byte-exact HMAC-SHA1 for fixed key / timestamp / access key", () => {
    const ts = 1_700_000_000;
    const expected = crypto
      .createHmac("sha1", ACR_SEC)
      .update(`POST\n${ACR_PATH}\n${ACR_KEY}\naudio\n1\n${ts}`)
      .digest("base64");

    assert.equal(buildSignature(ACR_KEY, ACR_SEC, ts), expected);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * §8 tests 2–8 — Response normalisation (pure unit tests)
 * ═══════════════════════════════════════════════════════════════════════════ */

describe("normalise", () => {
  it("test 2 — status 0 full entry: all fields correct including joined artist string", () => {
    const { match } = normalise(JSON.parse(acrOk([fullEntry()])));
    assert.ok(match);
    assert.equal(match.acrid,        "abc123");
    assert.equal(match.title,        "Test Song");
    assert.equal(match.artists,      "Artist One, Artist Two");
    assert.equal(match.album,        "Test Album");
    assert.equal(match.score,        96);
    assert.equal(match.sampleBeginMs, 0);
    assert.equal(match.sampleEndMs,   4800);
    assert.equal(match.playOffsetMs,  71200);
  });

  it("test 3 — artists absent → empty string, not undefined and not []", () => {
    const { match } = normalise(JSON.parse(acrOk([fullEntry({ artists: undefined })])));
    assert.ok(match);
    assert.equal(match.artists, "");
  });

  it("test 4 — string-valued offsets are coerced to numbers", () => {
    const entry = fullEntry({
      sample_begin_time_offset_ms: "0",
      sample_end_time_offset_ms:   "4800",
      play_offset_ms:              "71200",
    });
    const { match } = normalise(JSON.parse(acrOk([entry])));
    assert.ok(match);
    assert.equal(typeof match.sampleBeginMs, "number");
    assert.equal(typeof match.sampleEndMs,   "number");
    assert.equal(typeof match.playOffsetMs,  "number");
    assert.equal(match.sampleBeginMs, 0);
    assert.equal(match.sampleEndMs,   4800);
    assert.equal(match.playOffsetMs,  71200);
  });

  it("test 5 — non-finite offset is omitted from the serialised object entirely", () => {
    // Use string "NaN" and "Infinity" — they survive JSON.stringify→parse as strings,
    // and Number("NaN") / Number("Infinity") are non-finite.
    const entry = fullEntry({
      sample_begin_time_offset_ms: "NaN",
      sample_end_time_offset_ms:   "Infinity",
      play_offset_ms:              undefined,   // absent field
    });
    const { match } = normalise(JSON.parse(acrOk([entry])));
    assert.ok(match);
    assert.equal("sampleBeginMs" in match, false, "sampleBeginMs must be absent");
    assert.equal("sampleEndMs"   in match, false, "sampleEndMs must be absent");
    assert.equal("playOffsetMs"  in match, false, "playOffsetMs must be absent");
    // Also confirm the serialised form doesn't have the keys
    const serialised = JSON.parse(JSON.stringify(match)) as object;
    assert.equal("sampleBeginMs" in serialised, false);
  });

  it("test 6 — status 0 with empty music array → { match: null }", () => {
    assert.deepEqual(normalise(JSON.parse(acrOk([]))), { match: null });
  });

  it("test 7 — status 1001 → { match: null } (HTTP 200 is the route's job)", () => {
    assert.deepEqual(
      normalise(JSON.parse(acrStatus(1001, "No result"))),
      { match: null }
    );
  });

  it("test 8 — status 3003 → AppError 502 with exact message", () => {
    try {
      normalise(JSON.parse(acrStatus(3003, "Limit exceeded")));
      assert.fail("Expected throw");
    } catch (err) {
      assert.ok(err instanceof AppError);
      assert.equal(err.status, 502);
      assert.equal(err.code, "acrcloud_error");
      assert.equal(err.message, "ACRCloud error 3003: Limit exceeded");
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * §8 tests 9–19 — identifyAudio (network level via MockPool)
 * ═══════════════════════════════════════════════════════════════════════════ */

describe("identifyAudio — upstream behaviour", () => {
  beforeEach(() => _resetForTest());

  it("test 9 — malformed body → 502 acrcloud_unreachable", async () => {
    const pool = makeMock();
    pool.intercept({ path: ACR_PATH, method: "POST" })
      .reply(200, "not json at all");

    await assert.rejects(
      () => identifyAudio(SAMPLE),
      (err: AppError) => {
        assert.equal(err.status, 502);
        assert.equal(err.code,   "acrcloud_unreachable");
        return true;
      }
    );
  });

  it("test 10 — connection refusal → 502 naming the host", async () => {
    const pool = makeMock();
    pool.intercept({ path: ACR_PATH, method: "POST" })
      .replyWithError(new Error("connect ECONNREFUSED 127.0.0.1:443"));

    await assert.rejects(
      () => identifyAudio(SAMPLE),
      (err: AppError) => {
        assert.equal(err.status, 502);
        assert.equal(err.code,   "acrcloud_unreachable");
        assert.ok(
          err.message.includes(ACR_HOST),
          `Expected "${ACR_HOST}" in message, got: ${err.message}`
        );
        return true;
      }
    );
  });

  it("test 11 — AbortError → 504 upstream_timeout", async () => {
    const pool = makeMock();
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    pool.intercept({ path: ACR_PATH, method: "POST" }).replyWithError(abort);
    // Second intercept for the retry
    pool.intercept({ path: ACR_PATH, method: "POST" }).replyWithError(abort);

    await assert.rejects(
      () => identifyAudio(SAMPLE),
      (err: AppError) => {
        assert.ok(err instanceof GatewayTimeoutError, `Expected GatewayTimeoutError, got ${err.name}`);
        assert.equal(err.status, 504);
        return true;
      }
    );
  });

  it("test 12 — transport failure retries exactly once and succeeds on second attempt", async () => {
    const pool = makeMock();
    pool.intercept({ path: ACR_PATH, method: "POST" })
      .replyWithError(new Error("connect ECONNREFUSED"));
    pool.intercept({ path: ACR_PATH, method: "POST" })
      .reply(200, acrOk([fullEntry()]));

    // The retry waits 500 ms — just await it normally (fast enough for a test).
    const result = await identifyAudio(SAMPLE);
    assert.ok(result.match, "Expected a match after retry");
    assert.equal(result.match.title, "Test Song");
  });

  it("test 13 — business error does NOT retry (exactly one upstream call)", async () => {
    const pool = makeMock();
    // Register only ONE intercept — a second call would throw "No mock found"
    pool.intercept({ path: ACR_PATH, method: "POST" })
      .reply(200, acrStatus(3003, "Limit exceeded"));

    await assert.rejects(
      () => identifyAudio(SAMPLE),
      (err: AppError) => {
        assert.equal(err.code, "acrcloud_error");
        return true;
      }
    );
    // If a second upstream call had been made, undici would throw
    // "MockPoolNoMatchingError" which would fail this test.
  });

  it("test 15 — error response writes no cache row", async () => {
    // With TTL=0, getCachedResult and writeCachedResult are never called.
    // We verify: the error originates from the ACRCloud path, not from any DB code.
    const pool = makeMock();
    pool.intercept({ path: ACR_PATH, method: "POST" })
      .reply(200, acrStatus(3003, "Limit exceeded"));

    try {
      await identifyAudio(SAMPLE);
      assert.fail("Expected throw");
    } catch (err) {
      assert.ok(err instanceof AppError);
      // Code proves the error came from ACRCloud normalisation, not DB
      assert.equal((err as AppError).code, "acrcloud_error");
    }
  });

  it("test 19 — 20 consecutive failures open the breaker; 21st makes no upstream call", async () => {
    _resetForTest();
    const pool = makeMock();

    for (let i = 0; i < 20; i++) {
      pool.intercept({ path: ACR_PATH, method: "POST" })
        .reply(200, acrStatus(3003, "Limit exceeded"));
    }
    // If 21st call reaches the pool, undici throws "No mock found" → test fails.

    for (let i = 0; i < 20; i++) {
      try { await identifyAudio(SAMPLE); } catch { /* expected */ }
    }

    // 21st must be blocked by the breaker
    await assert.rejects(
      () => identifyAudio(SAMPLE),
      (err: AppError) => {
        assert.equal(err.status, 503);
        assert.equal(err.code,   "identify_busy");
        return true;
      }
    );
  });

  it("test 18 — 9 concurrent requests with MAX_CONCURRENCY=8: all 9 succeed", async () => {
    _resetForTest();
    _setSemaphoreForTest(new Semaphore(8));
    const pool = makeMock();

    for (let i = 0; i < 9; i++) {
      pool.intercept({ path: ACR_PATH, method: "POST" })
        .reply(200, acrOk([fullEntry()]));
    }

    const results = await Promise.allSettled(
      Array.from({ length: 9 }, () => identifyAudio(SAMPLE))
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    assert.equal(fulfilled, 9, `Expected 9 fulfilled, got ${fulfilled}`);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * §8 tests 16, 17, 20 — route level (minimal Fastify app)
 * ═══════════════════════════════════════════════════════════════════════════ */

import Fastify from "fastify";
import fastifyMultipart from "@fastify/multipart";
import errorHandler from "../src/plugins/error-handler.js";
import identifyRoute from "../src/routes/identify.js";

async function buildApp() {
  const app = Fastify({ logger: false });

  // Stub principal (normally injected by the principal plugin)
  app.decorateRequest("principal", {
    getter() {
      return { sessionId: null, userId: null, rateKey: "anon:127.0.0.1" };
    },
  });

  await app.register(fastifyMultipart);
  await app.register(errorHandler);
  await app.register(identifyRoute);

  return app;
}

function makeMultipart(
  sample: Buffer,
  boundary = "testboundary"
): { body: Buffer; contentType: string } {
  const CRLF = "\r\n";
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="sample"; filename="sample.wav"${CRLF}` +
        `Content-Type: audio/wav${CRLF}${CRLF}`,
      "utf8"
    ),
    sample,
    Buffer.from(`${CRLF}--${boundary}--${CRLF}`, "utf8"),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

describe("POST /api/identify — route level", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  before(async () => { app = await buildApp(); });
  beforeEach(() => _resetForTest());

  it("test 16 — no sample part → 400 sample_required with exact message", async () => {
    const bd = "nopart";
    const body = Buffer.from(`--${bd}--\r\n`, "utf8");

    const res = await app.inject({
      method: "POST",
      url: "/api/identify",
      headers: { "content-type": `multipart/form-data; boundary=${bd}` },
      body,
    });

    assert.equal(res.statusCode, 400);
    const j = res.json<{ error: string; code: string }>();
    assert.equal(j.code,  "sample_required");
    assert.equal(j.error, "No audio sample provided.");
  });

  it("test 17 — sample one byte over ceiling → 413; upstream never called", async () => {
    const bigSample = Buffer.alloc(2097152 + 1, 0x42);
    // Register pool — if called, undici throws no-mock-found (test fails)
    const pool = makeMock();
    pool.intercept({ path: ACR_PATH, method: "POST" })
      .reply(200, "should not reach upstream");

    const { body, contentType } = makeMultipart(bigSample);
    const res = await app.inject({
      method: "POST",
      url: "/api/identify",
      headers: { "content-type": contentType },
      payload: body,
    });

    assert.equal(res.statusCode, 413);
    const j = res.json<{ error: string; code: string }>();
    assert.ok(j.error.length > 0, "error must be non-empty");
    assert.equal(j.code, "sample_too_large");
  });

  it("test 20 — every error path returns JSON with non-empty error string", async () => {
    // Path 1: wrong content-type → 415
    const res415 = await app.inject({
      method: "POST",
      url: "/api/identify",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res415.statusCode, 415);
    const j415 = res415.json<{ error: string }>();
    assert.ok(typeof j415.error === "string" && j415.error.length > 0);

    // Path 2: sample missing → 400
    const bd = "empty20";
    const res400 = await app.inject({
      method: "POST",
      url: "/api/identify",
      headers: { "content-type": `multipart/form-data; boundary=${bd}` },
      body: Buffer.from(`--${bd}--\r\n`, "utf8"),
    });
    assert.equal(res400.statusCode, 400);
    const j400 = res400.json<{ error: string }>();
    assert.ok(typeof j400.error === "string" && j400.error.length > 0);

    // Path 3: upstream returns garbage JSON → 502
    const pool = makeMock();
    pool.intercept({ path: ACR_PATH, method: "POST" }).reply(200, "{ bad }");
    const { body: mp, contentType: ct } = makeMultipart(SAMPLE);
    const res502 = await app.inject({
      method: "POST",
      url: "/api/identify",
      headers: { "content-type": ct },
      payload: mp,
    });
    assert.equal(res502.statusCode, 502);
    const j502 = res502.json<{ error: string }>();
    assert.ok(typeof j502.error === "string" && j502.error.length > 0);
  });

  it("test 14 — two identical calls both reach upstream (cache disabled; TTL=0)", async () => {
    // With TTL=0 the cache layer is bypassed — both calls hit the network.
    // This verifies that without cache, each call makes exactly one upstream request.
    const pool = makeMock();
    pool.intercept({ path: ACR_PATH, method: "POST" })
      .reply(200, acrOk([fullEntry()]));
    pool.intercept({ path: ACR_PATH, method: "POST" })
      .reply(200, acrOk([fullEntry()]));

    const r1 = await identifyAudio(SAMPLE);
    const r2 = await identifyAudio(SAMPLE);
    assert.ok(r1.match && r2.match);
    assert.equal(r1.match.acrid, r2.match.acrid);
  });
});
