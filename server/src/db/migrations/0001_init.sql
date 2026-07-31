-- 0001_init.sql
-- Extensions, shared trigger, users, sessions.

create extension if not exists pgcrypto;

-- ── Shared trigger function ───────────────────────────────────────────────────

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ── users ─────────────────────────────────────────────────────────────────────

create table users (
  id             uuid        primary key default gen_random_uuid(),
  auth0_sub      text        not null,
  email          text        null,
  email_verified boolean     not null default false,
  name           text        null,
  picture        text        null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  last_login_at  timestamptz not null default now(),

  constraint users_auth0_sub_key unique (auth0_sub),
  constraint users_auth0_sub_len check (char_length(auth0_sub) between 1 and 255),
  constraint users_email_len     check (email is null or char_length(email) <= 320),
  constraint users_name_len      check (name is null or char_length(name) <= 255),
  constraint users_picture_len   check (picture is null or char_length(picture) <= 2048)
);

create index users_email_idx         on users (lower(email)) where email is not null;
create index users_last_login_at_idx on users (last_login_at desc);

create trigger users_set_updated_at
  before update on users
  for each row execute function set_updated_at();

-- ── sessions ──────────────────────────────────────────────────────────────────

create table sessions (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        null references users (id) on delete cascade,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz null,
  ip           inet        null,
  user_agent   text        null,

  constraint sessions_user_agent_len check (user_agent is null or char_length(user_agent) <= 512),
  constraint sessions_expiry_future  check (expires_at > created_at)
);

create index sessions_user_id_idx    on sessions (user_id) where user_id is not null;
create index sessions_expires_at_idx on sessions (expires_at);
create index sessions_last_seen_idx  on sessions (last_seen_at);

create trigger sessions_set_updated_at
  before update on sessions
  for each row execute function set_updated_at();
