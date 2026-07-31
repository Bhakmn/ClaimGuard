-- 0008_grant_service_role.sql
--
-- Grant the four DML privileges (SELECT, INSERT, UPDATE, DELETE) on every
-- application table to the `service_role` role used by the Supabase service-
-- role key.
--
-- Background
-- ----------
-- On Supabase, CREATE TABLE run by the `postgres` superuser gives ownership to
-- `postgres`.  The `service_role` only receives incidental default privileges
-- (TRUNCATE, REFERENCES, TRIGGER, MAINTAIN) — NOT the DML privileges the
-- application needs.  RLS bypass does not substitute for missing object-level
-- privileges.
--
-- Every migration from 0001–0007 creates tables without granting anything.
-- The tables that happened to work (e.g. identify_cache) did so because
-- Supabase granted privileges manually or at project-creation time on the
-- specific live database — not because the migrations were correct.
--
-- This migration is idempotent: granting a privilege that is already held is
-- a no-op on PostgreSQL, so it is safe to run against a database where some
-- or all of these grants were already made by hand.
--
-- From this point forward, every migration that creates a new table MUST
-- include the GRANT statements below.  See README.md §"Database migrations"
-- for the project convention.

grant select, insert, update, delete
  on table public.users
  to service_role;

grant select, insert, update, delete
  on table public.sessions
  to service_role;

grant select, insert, update, delete
  on table public.oauth_states
  to service_role;

grant select, insert, update, delete
  on table public.oauth_connections
  to service_role;

grant select, insert, update, delete
  on table public.publish_jobs
  to service_role;

grant select, insert, update, delete
  on table public.identify_cache
  to service_role;

grant select, insert, update, delete
  on table public.rate_limit_windows
  to service_role;

grant select, insert, update, delete
  on table public.visual_identify_cache
  to service_role;
