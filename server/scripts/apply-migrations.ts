/**
 * Migration runner.
 *
 * Usage:
 *   npm run migrations:apply
 *
 * Steps:
 *  1. Ensure schema_migrations table exists.
 *  2. Read all files in src/db/migrations/, sorted ascending by name.
 *  3. For each already-recorded version: verify the checksum matches the file
 *     on disk — abort if not (never silently re-apply a changed migration).
 *  4. For each unrecorded version: acquire advisory lock, execute the file
 *     in a transaction, insert the schema_migrations row, commit.
 *  5. Print each applied version and exit 0. On failure, exit 1.
 *
 * Migrations run as a deploy step before the new server version starts.
 * They are never run automatically from the application process.
 */

import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/* ── Environment ─────────────────────────────────────────────────────────── */

const SUPABASE_URL = process.env["SUPABASE_URL"];
const SUPABASE_SERVICE_ROLE_KEY = process.env["SUPABASE_SERVICE_ROLE_KEY"];

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set."
  );
  process.exit(1);
}

/* ── Client ──────────────────────────────────────────────────────────────── */

// We need raw SQL access; Supabase JS wraps PostgREST which doesn't accept
// arbitrary DDL.  We use the Supabase client's rpc() to call a helper that
// runs the SQL, or we use the pg driver directly.
//
// For migration purposes, we use the Supabase rpc approach through a
// helper function `run_migration_sql` that must be created on the database
// before first run (bootstrapped below), OR we accept that Supabase JS
// doesn't support raw DDL and use a direct postgres connection via the
// DATABASE_URL env var.
//
// We use DATABASE_URL when present, otherwise fall back to Supabase RPC.

const DATABASE_URL = process.env["DATABASE_URL"];

interface MigrationRecord {
  version: string;
  applied_at: string;
  checksum: string;
}

async function run(): Promise<void> {
  const __dir = dirname(fileURLToPath(import.meta.url));
  const migrationsDir = join(__dir, "../src/db/migrations");

  // Read and sort migration files
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    console.log("No migration files found.");
    process.exit(0);
  }

  // We need a raw SQL connection for DDL.  Supabase PostgREST does not
  // support arbitrary DDL.  Use the pg package when DATABASE_URL is set.
  if (!DATABASE_URL) {
    console.error(
      "DATABASE_URL is required for the migration runner (Supabase PostgREST cannot execute DDL)."
    );
    process.exit(1);
  }

  // Dynamic import so the script still type-checks without pg in devDeps.
  // Add 'pg' to dependencies when running migrations.
  let pgClient: {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    end: () => Promise<void>;
  };

  try {
    const { default: pg } = await import("pg") as { default: typeof import("pg") };
    const client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    pgClient = client;
  } catch (err) {
    console.error(
      "Failed to connect via DATABASE_URL. Is the 'pg' package installed?",
      err
    );
    process.exit(1);
  }

  try {
    // 1. Ensure schema_migrations exists
    await pgClient.query(`
      create table if not exists schema_migrations (
        version    text        primary key,
        applied_at timestamptz not null default now(),
        checksum   text        not null
      );
    `);

    // 2. Load recorded versions
    const { rows } = await pgClient.query(
      "select version, checksum from schema_migrations order by version"
    );
    const recorded = new Map<string, string>(
      (rows as MigrationRecord[]).map((r) => [r.version, r.checksum])
    );

    // 3 & 4. Process each file
    let applied = 0;

    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      const filePath = join(migrationsDir, file);
      const sql = readFileSync(filePath, "utf8");
      const checksum = sha256Hex(sql);

      if (recorded.has(version)) {
        // Verify checksum
        const storedChecksum = recorded.get(version)!;
        if (storedChecksum !== checksum) {
          console.error(
            `Checksum mismatch for already-applied migration: ${version}\n` +
            `  Stored:  ${storedChecksum}\n` +
            `  On disk: ${checksum}\n` +
            `Do not modify applied migrations. Create a new migration file.`
          );
          process.exit(1);
        }
        // Already applied and verified — skip
        continue;
      }

      // Apply in a transaction with advisory lock
      console.log(`Applying ${version}…`);
      await pgClient.query("begin");

      try {
        // Advisory lock prevents concurrent migration from another deploy instance
        await pgClient.query("select pg_advisory_xact_lock(4711)");

        // Re-check inside the lock (another instance may have applied it)
        const { rows: check } = await pgClient.query(
          "select version from schema_migrations where version = $1",
          [version]
        );
        if ((check as MigrationRecord[]).length > 0) {
          await pgClient.query("rollback");
          console.log(`  (already applied by another instance, skipping)`);
          continue;
        }

        // Execute the migration SQL
        await pgClient.query(sql);

        // Record the migration
        await pgClient.query(
          "insert into schema_migrations (version, checksum) values ($1, $2)",
          [version, checksum]
        );

        await pgClient.query("commit");
        console.log(`  ✓ ${version}`);
        applied++;
      } catch (err) {
        await pgClient.query("rollback");
        console.error(`  ✗ ${version}: ${err}`);
        throw err;
      }
    }

    if (applied === 0) {
      console.log("All migrations already applied.");
    } else {
      console.log(`\nApplied ${applied} migration(s).`);
    }
  } finally {
    await pgClient.end();
  }
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

run().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
