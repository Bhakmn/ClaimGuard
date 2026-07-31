-- 0002_oauth.sql
-- oauth_states, oauth_connections.

-- ── oauth_states ──────────────────────────────────────────────────────────────

create table oauth_states (
  id            uuid        primary key default gen_random_uuid(),
  provider      text        not null,
  state         text        not null,
  code_verifier text        not null,
  redirect_uri  text        not null,
  return_to     text        null,
  session_id    uuid        null references sessions (id) on delete cascade,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  consumed_at   timestamptz null,

  constraint oauth_states_provider_chk  check (provider in ('auth0', 'tiktok')),
  constraint oauth_states_state_key     unique (provider, state),
  constraint oauth_states_state_len     check (char_length(state) between 16 and 128),
  constraint oauth_states_verifier_len  check (char_length(code_verifier) between 43 and 128),
  constraint oauth_states_return_to_len check (return_to is null or char_length(return_to) <= 512)
);

create index oauth_states_expires_at_idx on oauth_states (expires_at);
create index oauth_states_session_id_idx on oauth_states (session_id) where session_id is not null;

-- ── oauth_connections ─────────────────────────────────────────────────────────

create table oauth_connections (
  id                        uuid        primary key default gen_random_uuid(),
  provider                  text        not null,
  user_id                   uuid        null references users (id) on delete cascade,
  session_id                uuid        null references sessions (id) on delete cascade,
  provider_account_id       text        null,
  scope                     text        not null default '',
  access_token_ciphertext   bytea       not null,
  access_token_iv           bytea       not null,
  access_token_tag          bytea       not null,
  access_token_expires_at   timestamptz not null,
  refresh_token_ciphertext  bytea       null,
  refresh_token_iv          bytea       null,
  refresh_token_tag         bytea       null,
  refresh_token_expires_at  timestamptz null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  last_used_at              timestamptz null,
  revoked_at                timestamptz null,

  constraint oauth_connections_provider_chk check (provider in ('tiktok')),
  constraint oauth_connections_owner_chk    check (user_id is not null or session_id is not null),
  constraint oauth_connections_iv_len       check (octet_length(access_token_iv) = 12),
  constraint oauth_connections_tag_len      check (octet_length(access_token_tag) = 16),
  constraint oauth_connections_rt_parts     check (
    (refresh_token_ciphertext is null and refresh_token_iv is null and refresh_token_tag is null)
    or
    (refresh_token_ciphertext is not null and refresh_token_iv is not null and refresh_token_tag is not null)
  ),
  constraint oauth_connections_account_len  check (
    provider_account_id is null or char_length(provider_account_id) <= 255
  ),
  constraint oauth_connections_scope_len    check (char_length(scope) <= 512)
);

-- Unique active connection per user+provider (ignoring revoked rows)
create unique index oauth_connections_user_provider_uk
  on oauth_connections (provider, user_id)
  where user_id is not null and revoked_at is null;

-- Unique active connection per anonymous session+provider
create unique index oauth_connections_session_provider_uk
  on oauth_connections (provider, session_id)
  where user_id is null and session_id is not null and revoked_at is null;

create index oauth_connections_expires_idx on oauth_connections (access_token_expires_at)
  where revoked_at is null;
create index oauth_connections_user_idx    on oauth_connections (user_id)
  where user_id is not null;
create index oauth_connections_session_idx on oauth_connections (session_id)
  where session_id is not null;

create trigger oauth_connections_set_updated_at
  before update on oauth_connections
  for each row execute function set_updated_at();
