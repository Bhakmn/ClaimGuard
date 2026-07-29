# ClaimGuard

## Database migrations

Migrations live in `server/src/db/migrations/` and are applied by the runner:

```bash
cd server
npm run migrations:apply
```

The runner uses an advisory lock, verifies checksums of already-applied migrations,
and applies new ones in a transaction.  **Never edit an applied migration file** —
the runner verifies checksums and will refuse to run if a recorded file has changed.
**Never paste migration SQL into the Supabase SQL editor** — doing so creates objects
without recording them, after which the runner tries to create them again and fails.

### Connection string

`migrations:apply` requires `DATABASE_URL` in `.env`.  Use the **session-mode
pooler** URI from the Supabase dashboard (Project Settings → Database → Connection
string → Session pooler).

- The **direct connection** host is IPv6-only on Supabase and cannot be resolved on
  most networks.
- Use the **session pooler** (port 5432), not the transaction pooler (port 6543) —
  the runner relies on advisory locks and multi-statement transactions that do not
  survive transaction-pooler interruptions.

The URI looks like:

```
postgresql://postgres.[project-ref]:[db-password]@aws-0-[region].pooler.supabase.com:5432/postgres
```

### Convention: every migration that creates a table must grant DML privileges

On Supabase, `CREATE TABLE` run by the `postgres` superuser does **not**
automatically give the `service_role` (used by the Supabase service-role key)
SELECT/INSERT/UPDATE/DELETE access.  RLS bypass does not substitute for missing
object-level privileges.

Every migration that creates a new table **must** include the following after the
`CREATE TABLE` and any index/trigger statements:

```sql
grant select, insert, update, delete
  on table public.<table_name>
  to service_role;
```

Migration `0008_grant_service_role.sql` retroactively adds these grants for all
tables created in migrations 0001–0007.  That migration is idempotent — re-granting
a privilege already held is a no-op on PostgreSQL.

### Schema cache

After applying migrations, PostgREST reloads its schema cache automatically within
~5 seconds.  If queries against new tables immediately return "relation not found",
wait a few seconds and retry.  Opening the Table Editor in the Supabase dashboard
also triggers a reload.
