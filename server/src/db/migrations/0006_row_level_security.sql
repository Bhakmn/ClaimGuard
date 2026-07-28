-- 0006_row_level_security.sql
-- Enable RLS with default-deny on every table.
-- The service-role key bypasses these policies, so backend access is unaffected.
-- Any future connection made with a non-service key reads nothing.

alter table users              enable row level security;
alter table sessions           enable row level security;
alter table oauth_states       enable row level security;
alter table oauth_connections  enable row level security;
alter table publish_jobs       enable row level security;
alter table identify_cache     enable row level security;
alter table rate_limit_windows enable row level security;
