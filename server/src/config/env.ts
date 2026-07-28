/**
 * Configuration module.
 *
 * Reads process.env exactly once at boot, validates every variable with Zod,
 * normalises values, derives feature flags, and exports a frozen typed object.
 * No other module reads process.env directly.
 *
 * All credentials are optional — the server starts in a degraded mode and
 * disables features whose credentials are absent rather than crashing.
 */

import { z } from "zod";
import os from "node:os";

/* ── Primitive helpers ────────────────────────────────────────────────────── */

const boolEnv = z
  .string()
  .toLowerCase()
  .transform((v) => v === "true" || v === "1" || v === "yes");

const intEnv = (min: number, max: number) =>
  z
    .string()
    .transform((v) => Number(v))
    .pipe(z.number().int().min(min).max(max));

const absoluteUrl = z
  .string()
  .url()
  .refine((v) => !v.endsWith("/"), {
    message: "Must not have a trailing slash",
  });

/** Accept a URL or empty string; normalise empty to undefined. */
const optionalUrl = z
  .string()
  .optional()
  .transform((v) => (v && v.trim().length > 0 ? v.replace(/\/+$/, "") : undefined))
  .pipe(
    z
      .string()
      .url()
      .refine((v) => !v.endsWith("/"), { message: "Must not have a trailing slash" })
      .optional()
  );

const hexBytes = (bytes: number) =>
  z
    .string()
    .length(bytes * 2, `Must be exactly ${bytes * 2} hex characters`)
    .regex(/^[0-9a-fA-F]+$/, "Must be a hex string");

/** Accept a hex secret or empty string; normalise empty to undefined. */
const optionalHexBytes = (bytes: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined))
    .pipe(hexBytes(bytes).optional());

/** Strip scheme, leading/trailing whitespace and all trailing slashes. */
function normaliseHost(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
}

/* ── Raw schema ───────────────────────────────────────────────────────────── */

const RawEnvSchema = z.object({
  // ── Process
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: intEnv(1, 65535).default("4000"),
  HOST: z.string().min(1).default("0.0.0.0"),

  // ── Public URLs (optional — default to localhost in dev)
  APP_BASE_URL: optionalUrl.default("http://localhost:3000"),
  API_BASE_URL: optionalUrl.default("http://localhost:4000"),

  // ── Proxy and CORS
  TRUST_PROXY: z
    .string()
    .default("false")
    .transform((v) => {
      const lower = v.toLowerCase();
      if (lower === "false" || lower === "0" || lower === "no") return false;
      if (lower === "true" || lower === "yes") return true;
      const n = Number(v);
      if (Number.isInteger(n) && n > 0) return n;
      return v; // treat as CIDR string / comma-separated list
    }),
  CORS_ALLOWED_ORIGINS: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    ),

  // ── Logging
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  LOG_PRETTY: boolEnv.default("false"),

  // ── Database (optional — features degrade when absent)
  SUPABASE_URL: optionalUrl,
  SUPABASE_SERVICE_ROLE_KEY: z
    .string()
    .optional()
    .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined)),
  DB_STATEMENT_TIMEOUT_MS: intEnv(1000, 60_000).default("10000"),

  // ── Secrets (optional — sessions/cookies disabled when absent)
  COOKIE_SECRET: optionalHexBytes(32),
  COOKIE_SECURE: z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === "") return "__derive__";
      const lower = v.toLowerCase();
      return lower === "true" || lower === "1" || lower === "yes";
    }),
  ENCRYPTION_KEY: optionalHexBytes(32),

  // ── Sessions
  SESSION_TTL_SECONDS: intEnv(300, 7_776_000).default("2592000"),
  SESSION_IDLE_TTL_SECONDS: intEnv(60, 7_776_000).default("604800"),

  // ── Auth0 (optional group)
  AUTH0_DOMAIN: z.string().optional().transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined)),
  AUTH0_CLIENT_ID: z.string().optional().transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined)),
  AUTH0_CLIENT_SECRET: z.string().optional().transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined)),
  AUTH0_SCOPE: z.string().default("openid profile email"),

  // ── ACRCloud (optional group)
  ACRCLOUD_HOST: z.string().optional().transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined)),
  ACRCLOUD_ACCESS_KEY: z.string().optional().transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined)),
  ACRCLOUD_ACCESS_SECRET: z.string().optional().transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined)),
  ACRCLOUD_TIMEOUT_MS: intEnv(1_000, 60_000).default("15000"),
  ACRCLOUD_MAX_CONCURRENCY: intEnv(1, 64).default("8"),

  // ── Identify cache
  IDENTIFY_CACHE_TTL_SECONDS: intEnv(0, 2_592_000).default("604800"),
  IDENTIFY_MAX_SAMPLE_BYTES: intEnv(1, 20_971_520).default("2097152"),

  // ── watsonx / Granite Vision (optional group)
  WATSONX_API_KEY: z.string().optional().transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined)),
  WATSONX_PROJECT_ID: z.string().optional().transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined)),
  WATSONX_MODEL_ID: z.string().default("ibm/granite-3-2-8b-instruct"),
  WATSONX_URL: z.string().url().default("https://us-south.ml.cloud.ibm.com"),
  WATSONX_IAM_URL: z.string().url().default("https://iam.cloud.ibm.com"),
  WATSONX_TIMEOUT_MS: intEnv(5_000, 120_000).default("30000"),
  WATSONX_MAX_CONCURRENCY: intEnv(1, 32).default("4"),

  // ── Visual identify cache
  VISUAL_IDENTIFY_CACHE_TTL_SECONDS: intEnv(0, 2_592_000).default("604800"),

  // ── Gemini (Google AI — reserved for future parallel signal)
  GEMINI_API_KEY: z.string().optional().transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined)),

  // ── TikTok (optional group)
  TIKTOK_CLIENT_KEY: z.string().optional().transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined)),
  TIKTOK_CLIENT_SECRET: z.string().optional().transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined)),
  TIKTOK_REDIRECT_URI: z
    .string()
    .url()
    .optional()
    .transform((v) => v ?? null),
  TIKTOK_TIMEOUT_MS: intEnv(1_000, 60_000).default("20000"),
  TIKTOK_CHUNK_TIMEOUT_MS: intEnv(5_000, 600_000).default("120000"),

  // ── Upload
  MAX_UPLOAD_BYTES: intEnv(1, 4_294_967_296).default("536870912"),
  UPLOAD_TMP_DIR: z.string().optional().transform((v) => v ?? os.tmpdir()),
  PUBLISH_MAX_DURATION_MS: intEnv(10_000, 600_000).default("300000"),

  // ── Background
  CLEANUP_INTERVAL_MS: intEnv(60_000, 86_400_000).default("900000"),

  // ── Rate limiting
  RATE_LIMIT_ENABLED: boolEnv.default("true"),

  // ── Metrics (optional — omit to disable the /metrics endpoint)
  METRICS_TOKEN: z.string().min(1).optional(),
});

/* ── Group completeness checks ───────────────────────────────────────────── */

function checkPartialGroup(
  data: z.infer<typeof RawEnvSchema>,
  keys: (keyof z.infer<typeof RawEnvSchema>)[],
  groupName: string,
  ctx: z.RefinementCtx
): void {
  const present = keys.filter((k) => data[k] !== undefined);
  if (present.length > 0 && present.length < keys.length) {
    const missing = keys.filter((k) => data[k] === undefined);
    for (const k of missing) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [k],
        message: `${k} is required when any ${groupName} credential is provided`,
      });
    }
  }
}

const EnvSchema = RawEnvSchema.superRefine((data, ctx) => {
  checkPartialGroup(
    data,
    ["AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET"],
    "Auth0",
    ctx
  );
  checkPartialGroup(
    data,
    ["ACRCLOUD_HOST", "ACRCLOUD_ACCESS_KEY", "ACRCLOUD_ACCESS_SECRET"],
    "ACRCloud",
    ctx
  );
  checkPartialGroup(
    data,
    ["WATSONX_API_KEY", "WATSONX_PROJECT_ID"],
    "watsonx",
    ctx
  );
  checkPartialGroup(data, ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"], "TikTok", ctx);
  checkPartialGroup(
    data,
    ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"],
    "Supabase",
    ctx
  );
  checkPartialGroup(
    data,
    ["COOKIE_SECRET", "ENCRYPTION_KEY"],
    "Secrets",
    ctx
  );
}).transform((data) => {
  // Derive COOKIE_SECURE from NODE_ENV when not explicitly set
  const cookieSecure =
    data.COOKIE_SECURE === "__derive__"
      ? data.NODE_ENV === "production"
      : (data.COOKIE_SECURE as boolean);

  // Normalise ACRCLOUD_HOST
  const acrcloudHost = data.ACRCLOUD_HOST
    ? normaliseHost(data.ACRCLOUD_HOST)
    : undefined;

  // Derive feature flags
  const authEnabled = Boolean(
    data.AUTH0_DOMAIN && data.AUTH0_CLIENT_ID && data.AUTH0_CLIENT_SECRET
  );
  const acrcloudEnabled = Boolean(
    acrcloudHost && data.ACRCLOUD_ACCESS_KEY && data.ACRCLOUD_ACCESS_SECRET
  );
  const tiktokEnabled = Boolean(
    data.TIKTOK_CLIENT_KEY && data.TIKTOK_CLIENT_SECRET
  );
  const dbEnabled = Boolean(
    data.SUPABASE_URL && data.SUPABASE_SERVICE_ROLE_KEY
  );
  const sessionsEnabled = Boolean(
    data.COOKIE_SECRET && data.ENCRYPTION_KEY && dbEnabled
  );

  // Resolve TikTok redirect URI
  const apiBase = data.API_BASE_URL ?? "http://localhost:4000";
  const tiktokRedirectUri =
    data.TIKTOK_REDIRECT_URI ?? `${apiBase}/api/tiktok/callback`;

  return {
    ...data,
    APP_BASE_URL: data.APP_BASE_URL ?? "http://localhost:3000",
    API_BASE_URL: apiBase,
    SUPABASE_URL: data.SUPABASE_URL ?? "",
    SUPABASE_SERVICE_ROLE_KEY: data.SUPABASE_SERVICE_ROLE_KEY ?? "",
    COOKIE_SECRET: data.COOKIE_SECRET ?? "0".repeat(64),
    ENCRYPTION_KEY: data.ENCRYPTION_KEY ?? "0".repeat(64),
    COOKIE_SECURE: cookieSecure,
    ACRCLOUD_HOST: acrcloudHost,
    TIKTOK_REDIRECT_URI: tiktokRedirectUri,
    // Feature flags (derived, not from env directly)
    authEnabled,
    acrcloudEnabled,
    tiktokEnabled,
    dbEnabled,
    sessionsEnabled,
  };
});

/* ── Parse once and freeze ───────────────────────────────────────────────── */

export type Config = z.infer<typeof EnvSchema>;

let _config: Config | null = null;

/**
 * Parse and validate the environment. Throws a structured error on failure.
 * Call once from src/index.ts; everywhere else calls `getConfig()`.
 */
export function parseConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = EnvSchema.safeParse(env);

  if (!result.success) {
    const failingVars = [...new Set(
      result.error.issues.flatMap((i) =>
        i.path.length > 0 ? [String(i.path[0])] : []
      )
    )];
    const err = new Error(
      `Configuration invalid. Failing variables: ${failingVars.join(", ")}`
    );
    (err as Error & { issues: z.ZodIssue[]; failingVars: string[] }).issues =
      result.error.issues;
    (err as Error & { issues: z.ZodIssue[]; failingVars: string[] }).failingVars =
      failingVars;
    throw err;
  }

  _config = Object.freeze(result.data) as Config;
  return _config;
}

/**
 * Return the already-parsed config. Throws if parseConfig() was not called
 * first. This guarantee means config access outside the bootstrap path is
 * always a programming error, caught at startup.
 */
export function getConfig(): Config {
  if (!_config) {
    throw new Error("Configuration has not been parsed yet. Call parseConfig() first.");
  }
  return _config;
}
