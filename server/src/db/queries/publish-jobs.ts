/**
 * Query helpers: publish_jobs
 *
 * Status lifecycle:
 *   initializing → uploading → uploaded → processing → complete
 *                                                     ↘ failed (from any state)
 *
 * Concurrency rule: a principal may have at most one job in
 * 'initializing' or 'uploading' at a time (enforced by createJob).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { ConflictError } from "../../lib/errors.js";

/* ── Row type ────────────────────────────────────────────────────────────── */

export type JobStatus =
  | "initializing"
  | "uploading"
  | "uploaded"
  | "processing"
  | "complete"
  | "failed";

export interface PublishJobRow {
  id: string;
  provider: string;
  session_id: string | null;
  user_id: string | null;
  connection_id: string;
  publish_id: string | null;
  title: string | null;
  file_name: string | null;
  content_type: string;
  byte_size: number;
  chunk_size: number;
  chunk_count: number;
  chunks_sent: number;
  bytes_sent: number;
  status: JobStatus;
  provider_status: string | null;
  fail_reason: string | null;
  error_code: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

/* ── Active statuses ─────────────────────────────────────────────────────── */

export const ACTIVE_STATUSES: JobStatus[] = ["initializing", "uploading"];

/* ── Queries ─────────────────────────────────────────────────────────────── */

export interface CreateJobInput {
  userId: string | null;
  sessionId: string | null;
  connectionId: string;
  title: string | null;
  fileName: string | null;
  contentType: string;
  byteSize: number;
  chunkSize: number;
  chunkCount: number;
}

/**
 * Create a new publish job.
 *
 * Enforces the concurrency rule: if the principal already has a job in
 * 'initializing' or 'uploading', throws ConflictError.
 *
 * Ownership rule: scoped to userId when authenticated, sessionId otherwise.
 */
export async function createJob(
  db: SupabaseClient,
  input: CreateJobInput
): Promise<PublishJobRow> {
  // Check for an existing active job for this principal.
  const existing = await findActiveJobForPrincipal(
    db,
    input.userId,
    input.sessionId
  );

  if (existing) {
    throw new ConflictError(
      "A publish is already in progress. Wait for it to finish."
    );
  }

  const { data, error } = await db
    .from("publish_jobs")
    .insert({
      user_id: input.userId,
      session_id: input.sessionId,
      connection_id: input.connectionId,
      title: input.title,
      file_name: input.fileName,
      content_type: input.contentType,
      byte_size: input.byteSize,
      chunk_size: input.chunkSize,
      chunk_count: input.chunkCount,
      status: "initializing" satisfies JobStatus,
    })
    .select("*")
    .single();

  if (error) throw error;
  return data as PublishJobRow;
}

/**
 * Load a job by internal id, scoped to the owning principal.
 * Returns null when the job does not exist or belongs to a different principal.
 */
export async function findJobById(
  db: SupabaseClient,
  jobId: string,
  userId: string | null,
  sessionId: string | null
): Promise<PublishJobRow | null> {
  if (!userId && !sessionId) return null;

  let query = db.from("publish_jobs").select("*").eq("id", jobId);

  if (userId) {
    query = query.eq("user_id", userId);
  } else {
    query = query.eq("session_id", sessionId!).is("user_id", null);
  }

  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return (data as PublishJobRow | null);
}

/**
 * Load a job by publish_id (TikTok's publish_id), scoped to the owning principal.
 *
 * The status route accepts a publishId query param that is TikTok's publish_id,
 * not our internal UUID.  This query enforces ownership so a caller cannot probe
 * other users' publish IDs.
 *
 * Returns null when the job does not exist or belongs to a different principal.
 */
export async function findJobByPublishId(
  db: SupabaseClient,
  publishId: string,
  userId: string | null,
  sessionId: string | null
): Promise<PublishJobRow | null> {
  if (!userId && !sessionId) return null;

  let query = db.from("publish_jobs").select("*").eq("publish_id", publishId);

  if (userId) {
    query = query.eq("user_id", userId);
  } else {
    query = query.eq("session_id", sessionId!).is("user_id", null);
  }

  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return (data as PublishJobRow | null);
}

/**
 * Find the most recent active (initializing or uploading) job for a principal.
 */
export async function findActiveJobForPrincipal(
  db: SupabaseClient,
  userId: string | null,
  sessionId: string | null
): Promise<PublishJobRow | null> {
  if (!userId && !sessionId) return null;

  let query = db
    .from("publish_jobs")
    .select("*")
    .in("status", ACTIVE_STATUSES)
    .order("created_at", { ascending: false })
    .limit(1);

  if (userId) {
    query = query.eq("user_id", userId);
  } else {
    query = query.eq("session_id", sessionId!).is("user_id", null);
  }

  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return (data as PublishJobRow | null);
}

/**
 * Advance a job to 'uploading' and set started_at + publish_id.
 * Called once TikTok's init endpoint returns a publish_id and upload_url.
 */
export async function markJobUploading(
  db: SupabaseClient,
  jobId: string,
  publishId: string
): Promise<void> {
  const { error } = await db
    .from("publish_jobs")
    .update({
      status: "uploading" satisfies JobStatus,
      publish_id: publishId,
      started_at: new Date().toISOString(),
    })
    .eq("id", jobId)
    .eq("status", "initializing" satisfies JobStatus);

  if (error) throw error;
}

/**
 * Increment progress counters after a successful chunk PUT.
 * Also increments `attempts`.
 */
export async function recordChunkProgress(
  db: SupabaseClient,
  jobId: string,
  chunkBytes: number
): Promise<void> {
  // Supabase JS doesn't support column arithmetic directly; use rpc or raw sql.
  // We fall back to a read-modify-write here because chunk uploads are
  // serialised within one process; there is no concurrent writer for the same job.
  const { data: current, error: readErr } = await db
    .from("publish_jobs")
    .select("chunks_sent, bytes_sent, attempts")
    .eq("id", jobId)
    .single();

  if (readErr) throw readErr;
  const row = current as { chunks_sent: number; bytes_sent: number; attempts: number };

  const { error } = await db
    .from("publish_jobs")
    .update({
      chunks_sent: row.chunks_sent + 1,
      bytes_sent: row.bytes_sent + chunkBytes,
      attempts: row.attempts + 1,
    })
    .eq("id", jobId);

  if (error) throw error;
}

/**
 * Increment `attempts` for a failed chunk attempt without advancing progress.
 */
export async function recordChunkAttempt(
  db: SupabaseClient,
  jobId: string
): Promise<void> {
  const { data: current, error: readErr } = await db
    .from("publish_jobs")
    .select("attempts")
    .eq("id", jobId)
    .single();

  if (readErr) throw readErr;
  const row = current as { attempts: number };

  const { error } = await db
    .from("publish_jobs")
    .update({ attempts: row.attempts + 1 })
    .eq("id", jobId);

  if (error) throw error;
}

/**
 * Transition a job to 'uploaded' once all chunks are acknowledged.
 */
export async function markJobUploaded(
  db: SupabaseClient,
  jobId: string
): Promise<void> {
  const { error } = await db
    .from("publish_jobs")
    .update({ status: "uploaded" satisfies JobStatus })
    .eq("id", jobId)
    .eq("status", "uploading" satisfies JobStatus);

  if (error) throw error;
}

/**
 * Update status and provider_status from a TikTok status poll.
 */
export async function updateJobProviderStatus(
  db: SupabaseClient,
  jobId: string,
  localStatus: JobStatus,
  providerStatus: string
): Promise<void> {
  const update: Record<string, unknown> = {
    status: localStatus,
    provider_status: providerStatus,
  };
  if (localStatus === "complete" || localStatus === "failed") {
    update["completed_at"] = new Date().toISOString();
  }

  const { error } = await db
    .from("publish_jobs")
    .update(update)
    .eq("id", jobId);

  if (error) throw error;
}

/**
 * Transition a job to 'failed'.
 * Safe to call from any non-terminal state.
 */
export async function failJob(
  db: SupabaseClient,
  jobId: string,
  failReason: string,
  errorCode: string
): Promise<void> {
  const { error } = await db
    .from("publish_jobs")
    .update({
      status: "failed" satisfies JobStatus,
      fail_reason: failReason,
      error_code: errorCode,
      completed_at: new Date().toISOString(),
    })
    .eq("id", jobId)
    .not("status", "in", '("complete","failed")');

  if (error) throw error;
}

export interface StaleJobInfo {
  id: string;
  byte_size: number;
  bytes_sent: number;
}

/**
 * Mark stale in-flight jobs as failed.
 *
 * "Stale" means status in ('initializing','uploading') AND updated_at older
 * than `updatedBefore`.  Using updated_at (not created_at) ensures a job
 * that is actively writing progress is never mistakenly abandoned.
 *
 * Returns details of every affected row so the caller can log them.
 */
export async function failStaleJobs(
  db: SupabaseClient,
  updatedBefore: Date
): Promise<StaleJobInfo[]> {
  const { data, error } = await db
    .from("publish_jobs")
    .update({
      status:       "failed" satisfies JobStatus,
      fail_reason:  "The upload stopped unexpectedly.",
      error_code:   "abandoned",
      completed_at: new Date().toISOString(),
    })
    .in("status", ACTIVE_STATUSES)
    .lt("updated_at", updatedBefore.toISOString())
    .select("id, byte_size, bytes_sent");

  if (error) throw error;
  return (data as StaleJobInfo[]);
}
