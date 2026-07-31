/**
 * Process bootstrap.
 *
 * Sequence:
 *  1. Parse and validate configuration — exit 1 on failure.
 *  2. Probe the database — exit 1 if unreachable.
 *  3. Build the Fastify app and begin listening.
 *  4. Start the cleanup scheduler (first tick after 60 s).
 *  5. Register SIGTERM / SIGINT for graceful shutdown.
 *
 * Graceful shutdown sequence (spec §5):
 *  1. Set the shutting-down flag → /health/live starts returning 503.
 *  2. Stop the cleanup scheduler.
 *  3. Stop accepting new connections (fastify.close()).
 *  4. Wait up to 30 s for in-flight requests to finish.
 *  5. Exit 0 on clean close, exit 1 on timeout or error.
 *  6. A second signal during shutdown exits immediately with code 1.
 */

import { parseConfig } from "./config/env.js";
import { probeDatabase } from "./db/client.js";
import { buildApp } from "./app.js";
import { HEALTH_DB_TIMEOUT_MS } from "./config/constants.js";
import { setShuttingDown } from "./lib/shutdown.js";
import { startCleanupScheduler } from "./lib/cleanup.js";

/* ── 1. Configuration ─────────────────────────────────────────────────────── */

let cfg: ReturnType<typeof parseConfig>;

try {
  cfg = parseConfig();
} catch (err) {
  const e = err as Error & { failingVars?: string[] };
  process.stderr.write(
    `[claimguard-server] Configuration error: ${e.message}\n`
  );
  if (e.failingVars?.length) {
    process.stderr.write(
      `[claimguard-server] Failing variables: ${e.failingVars.join(", ")}\n`
    );
  }
  process.exit(1);
}

/* ── 2. Database probe ────────────────────────────────────────────────────── */

if (cfg.dbEnabled) {
  try {
    await probeDatabase(HEALTH_DB_TIMEOUT_MS);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[claimguard-server] Database unreachable at boot: ${msg}\n`
    );
    process.stderr.write(
      `[claimguard-server] Exiting — fix the database connection and restart.\n`
    );
    process.exit(1);
  }
} else {
  process.stderr.write(
    `[claimguard-server] No database configured — starting without DB (scan caching, sessions and publishing disabled).\n`
  );
}

/* ── 3. Build and listen ─────────────────────────────────────────────────── */

const app = await buildApp();

app.log.info(
  {
    port: cfg.PORT,
    authEnabled: cfg.authEnabled,
    acrcloudEnabled: cfg.acrcloudEnabled,
    tiktokEnabled: cfg.tiktokEnabled,
    nodeVersion: process.version,
  },
  "Starting server"
);

await app.listen({ port: cfg.PORT, host: cfg.HOST });

app.log.info(
  {
    port: cfg.PORT,
    host: cfg.HOST,
    authEnabled: cfg.authEnabled,
    acrcloudEnabled: cfg.acrcloudEnabled,
    tiktokEnabled: cfg.tiktokEnabled,
    nodeVersion: process.version,
  },
  "Server ready"
);

/* ── 4. Cleanup scheduler ────────────────────────────────────────────────── */

const stopCleanup = startCleanupScheduler(app.log);

/* ── 5. Graceful shutdown ────────────────────────────────────────────────── */

const GRACE_MS = 30_000;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    // Second signal during shutdown — exit immediately
    app.log.warn({ signal }, "Second shutdown signal — exiting immediately");
    process.exit(1);
  }
  shuttingDown = true;

  // Step 1: flip the shutdown flag (health/live → 503, upload → 503)
  setShuttingDown();
  app.log.info({ signal }, "Shutdown signal received — draining");

  // Step 2: stop the cleanup scheduler
  stopCleanup();

  // Steps 3-5: stop accepting new connections and wait for in-flight requests
  const gracePeriod = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), GRACE_MS)
  );

  const closeServer = app.close().then(() => "closed" as const);

  const outcome = await Promise.race([closeServer, gracePeriod]);

  if (outcome === "closed") {
    app.log.info("Server closed cleanly.");
    process.exit(0);
  } else {
    app.log.warn({ graceMs: GRACE_MS }, "Shutdown grace period expired with requests still in flight.");
    process.exit(1);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT",  () => void shutdown("SIGINT"));
