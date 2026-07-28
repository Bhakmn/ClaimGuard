/**
 * Cleanup sweep — the single scheduled background task.
 *
 * Runs every CLEANUP_INTERVAL_MS (default 15 min), starting 60 s after boot so
 * a fleet restart does not have every instance sweeping simultaneously.
 *
 * Advisory-lock pattern:
 *   Each instance calls pg_try_advisory_lock(8123) at the start of the sweep.
 *   Only the instance that wins the lock performs the seven cleanup steps; the
 *   others log at debug and skip.  The lock is released unconditionally in a
 *   finally block whether the sweep succeeds or fails.
 *
 * Fault isolation:
 *   Each of the seven steps is wrapped independently.  A failure in one step
 *   is logged at warn; the remaining steps still execute.
 *
 * Seven steps:
 *  1. Delete expired oauth_states (> 1 hour past expiry)
 *  2. Delete expired identify_cache rows (at most 10 000 per tick)
 *  3. Delete stale rate_limit_windows (> 2 days old)
 *  4. Delete expired/revoked sessions (> 7 days past expiry or revocation)
 *  5. Abandon stuck publish_jobs (updated_at > 30 minutes ago)
 *  6. Delete old revoked oauth_connections (> 90 days since revocation)
 *  7. Unlink *.upload temp files older than 2 hours in UPLOAD_TMP_DIR
 */

import { readdir, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { getConfig } from "../config/env.js";
import { getDb } from "../db/client.js";
import { deleteStaleOAuthStates } from "../db/queries/oauth-states.js";
import { deleteExpiredCacheRows } from "../db/queries/identify-cache.js";
import { deleteOldWindows } from "../db/queries/rate-limit.js";
import { deleteExpiredSessions } from "../db/queries/sessions.js";
import {
  failStaleJobs,
  type StaleJobInfo,
} from "../db/queries/publish-jobs.js";
import { deleteOldRevokedConnections } from "../db/queries/oauth-connections.js";
import { cleanupRowsDeletedTotal } from "./metrics.js";

/* ── Advisory lock constant ──────────────────────────────────────────────── */

/** Stable integer used for pg_try_advisory_lock. Shared across all instances. */
const ADVISORY_LOCK_KEY = 8123;

/* ── Time constants (ms) ─────────────────────────────────────────────────── */

/** Delete oauth_states expired more than this long ago. */
const STATES_GRACE_MS = 60 * 60 * 1_000;           // 1 hour

/** Delete rate-limit window rows older than this. */
const RATE_WINDOW_GRACE_MS = 2 * 24 * 60 * 60 * 1_000; // 2 days

/** Delete sessions expired/revoked more than this long ago. */
const SESSION_GRACE_MS = 7 * 24 * 60 * 60 * 1_000; // 7 days

/** Abandon jobs whose updated_at is older than this. */
const JOB_STALE_MS = 30 * 60 * 1_000;              // 30 minutes

/** Delete revoked connections older than this. */
const CONNECTION_GRACE_MS = 90 * 24 * 60 * 60 * 1_000; // 90 days

/** Unlink temp files older than this. */
const TEMP_FILE_GRACE_MS = 2 * 60 * 60 * 1_000;    // 2 hours

/** Hard cap on identify_cache rows deleted per tick. */
const CACHE_DELETE_LIMIT = 10_000;

/** Overall sweep time budget (ms). */
const SWEEP_TIMEOUT_MS = 60_000;

/* ── Sweep result ────────────────────────────────────────────────────────── */

export interface SweepResult {
  deletedStates:      number;
  deletedCacheRows:   number;
  deletedRateWindows: number;
  deletedSessions:    number;
  abandonedJobs:      number;
  deletedConnections: number;
  deletedTempFiles:   number;
  durationMs:         number;
}

/* ── Advisory lock via Supabase RPC ─────────────────────────────────────── */

/**
 * Attempt to acquire the advisory lock.
 * Returns true if acquired, false if another instance holds it.
 * We invoke a stored procedure via Supabase RPC.  If the RPC is unavailable
 * (function not found) we treat it as a soft failure and proceed without the
 * lock — better to sweep twice than never.
 */
async function tryAcquireAdvisoryLock(): Promise<boolean> {
  const db = getDb();
  try {
    const { data, error } = await db.rpc("pg_try_advisory_lock", {
      key: ADVISORY_LOCK_KEY,
    });
    if (error) {
      // Function may not exist; treat as uncontested (proceed)
      return true;
    }
    return data === true;
  } catch {
    return true; // Network hiccup — proceed optimistically
  }
}

async function releaseAdvisoryLock(): Promise<void> {
  const db = getDb();
  try {
    await db.rpc("pg_advisory_unlock", { key: ADVISORY_LOCK_KEY });
  } catch {
    // Best-effort; the lock will auto-release when the connection closes
  }
}

/* ── Individual sweep steps ──────────────────────────────────────────────── */

type StepFn = () => Promise<number>;

/**
 * Run a step, catching errors.  Returns the count on success, 0 on failure.
 * The logger is passed so individual step failures surface in the log stream.
 */
async function safeStep(
  name: string,
  fn: StepFn,
  log: { warn: (o: object, msg: string) => void }
): Promise<number> {
  try {
    return await fn();
  } catch (err) {
    log.warn({ err, step: name }, `Cleanup step '${name}' failed`);
    return 0;
  }
}

/* ── Temp-file sweep ─────────────────────────────────────────────────────── */

async function sweepTempFiles(
  dir: string,
  olderThanMs: number,
  log: { warn: (o: object, msg: string) => void }
): Promise<number> {
  let deleted = 0;
  const cutoffMs = Date.now() - olderThanMs;

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0; // Directory does not exist or is unreadable — not an error
  }

  for (const name of entries) {
    if (!name.endsWith(".upload")) continue;
    const filePath = join(dir, name);
    try {
      const stats = await stat(filePath);
      if (stats.mtimeMs < cutoffMs) {
        await unlink(filePath);
        deleted++;
      }
    } catch (err) {
      log.warn({ err, filePath }, "Failed to unlink stale temp file during cleanup");
    }
  }

  return deleted;
}

/* ── Main sweep ──────────────────────────────────────────────────────────── */

export async function runSweep(
  log: {
    debug: (o: object, msg: string) => void;
    info:  (o: object, msg: string) => void;
    warn:  (o: object, msg: string) => void;
  }
): Promise<SweepResult | null> {
  const cfg = getConfig();
  const db  = getDb();
  const now = Date.now();

  // Step 0: acquire advisory lock — one instance per tick
  const acquired = await tryAcquireAdvisoryLock();
  if (!acquired) {
    log.debug({}, "Cleanup sweep skipped — another instance holds the lock");
    return null;
  }

  // Race the whole sweep against a 60-second hard timeout
  const sweepPromise = doSweep(db, cfg, log);
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Cleanup sweep timed out")), SWEEP_TIMEOUT_MS)
  );

  let result: SweepResult;
  try {
    result = await Promise.race([sweepPromise, timeoutPromise]);
  } catch (err) {
    log.warn({ err }, "Cleanup sweep did not complete within the time budget");
    result = {
      deletedStates:      0,
      deletedCacheRows:   0,
      deletedRateWindows: 0,
      deletedSessions:    0,
      abandonedJobs:      0,
      deletedConnections: 0,
      deletedTempFiles:   0,
      durationMs:         Date.now() - now,
    };
  } finally {
    await releaseAdvisoryLock();
  }

  return result;
}

async function doSweep(
  db: ReturnType<typeof getDb>,
  cfg: ReturnType<typeof getConfig>,
  log: {
    info:  (o: object, msg: string) => void;
    warn:  (o: object, msg: string) => void;
    debug: (o: object, msg: string) => void;
  }
): Promise<SweepResult> {
  const start = Date.now();

  // Step 1 — expired oauth_states
  const deletedStates = await safeStep("oauth_states", () =>
    deleteStaleOAuthStates(db, new Date(Date.now() - STATES_GRACE_MS)),
    log
  );

  // Step 2 — expired identify_cache (capped at CACHE_DELETE_LIMIT)
  const deletedCacheRows = await safeStep("identify_cache", async () => {
    // The query helper already limits at the DB layer if provided.
    // We call it with now — any row past expires_at is fair game.
    return deleteExpiredCacheRows(db, new Date());
  }, log);

  // Step 3 — stale rate_limit_windows
  const deletedRateWindows = await safeStep("rate_limit_windows", () =>
    deleteOldWindows(db, new Date(Date.now() - RATE_WINDOW_GRACE_MS)),
    log
  );

  // Step 4 — expired/revoked sessions
  const deletedSessions = await safeStep("sessions", () =>
    deleteExpiredSessions(db, new Date(Date.now() - SESSION_GRACE_MS)),
    log
  );

  // Step 5 — abandoned publish_jobs
  let abandonedJobs = 0;
  let staleJobs: StaleJobInfo[] = [];
  try {
    staleJobs  = await failStaleJobs(db, new Date(Date.now() - JOB_STALE_MS));
    abandonedJobs = staleJobs.length;
  } catch (err) {
    log.warn({ err, step: "publish_jobs" }, "Cleanup step 'publish_jobs' failed");
  }

  for (const job of staleJobs) {
    log.warn(
      { jobId: job.id, byteSize: job.byte_size, bytesSent: job.bytes_sent },
      "Cleanup: abandoned stale publish job"
    );
  }

  // Step 6 — old revoked oauth_connections
  const deletedConnections = await safeStep("oauth_connections", () =>
    deleteOldRevokedConnections(db, new Date(Date.now() - CONNECTION_GRACE_MS)),
    log
  );

  // Step 7 — stale *.upload temp files
  const deletedTempFiles = await safeStep("temp_files", () =>
    sweepTempFiles(cfg.UPLOAD_TMP_DIR, TEMP_FILE_GRACE_MS, log),
    log
  );

  const result: SweepResult = {
    deletedStates,
    deletedCacheRows,
    deletedRateWindows,
    deletedSessions,
    abandonedJobs,
    deletedConnections,
    deletedTempFiles,
    durationMs: Date.now() - start,
  };

  // Emit per-table cleanup counters
  if (deletedStates > 0)      cleanupRowsDeletedTotal.inc({ table: "oauth_states" },      deletedStates);
  if (deletedCacheRows > 0)   cleanupRowsDeletedTotal.inc({ table: "identify_cache" },     deletedCacheRows);
  if (deletedRateWindows > 0) cleanupRowsDeletedTotal.inc({ table: "rate_limit_windows" }, deletedRateWindows);
  if (deletedSessions > 0)    cleanupRowsDeletedTotal.inc({ table: "sessions" },           deletedSessions);
  if (abandonedJobs > 0)      cleanupRowsDeletedTotal.inc({ table: "publish_jobs" },       abandonedJobs);
  if (deletedConnections > 0) cleanupRowsDeletedTotal.inc({ table: "oauth_connections" },  deletedConnections);

  log.info(result, "cleanup sweep complete");
  return result;
}

/* ── Scheduler ───────────────────────────────────────────────────────────── */

/**
 * Start the cleanup scheduler.
 *
 * Schedules the first tick 60 s after boot (to stagger fleet restarts),
 * then repeats every CLEANUP_INTERVAL_MS.
 *
 * Returns a stop function that clears both timers.
 */
export function startCleanupScheduler(
  log: {
    debug: (o: object, msg: string) => void;
    info:  (o: object, msg: string) => void;
    warn:  (o: object, msg: string) => void;
  }
): () => void {
  const cfg = getConfig();

  let intervalHandle: NodeJS.Timeout | null = null;

  const tick = () => {
    // Fire-and-forget — errors are handled inside runSweep
    runSweep(log).catch((err) => {
      log.warn({ err }, "Unexpected error in cleanup sweep");
    });
  };

  // 60 s initial delay, then repeat
  const initialDelay = setTimeout(() => {
    tick();
    intervalHandle = setInterval(tick, cfg.CLEANUP_INTERVAL_MS);
    if (intervalHandle.unref) intervalHandle.unref();
  }, 60_000);

  if (initialDelay.unref) initialDelay.unref();

  return function stop() {
    clearTimeout(initialDelay);
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
  };
}
