-- 0004_identify_cache.sql
-- identify_cache — content-addressed ACRCloud result cache.

create table identify_cache (
  sample_sha256   bytea       primary key,
  sample_bytes    integer     not null,
  acr_status_code integer     not null,
  match           jsonb       null,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  hit_count       integer     not null default 0,
  last_hit_at     timestamptz null,

  constraint identify_cache_digest_len check (octet_length(sample_sha256) = 32),
  constraint identify_cache_bytes_chk  check (sample_bytes > 0),
  constraint identify_cache_expiry_chk check (expires_at > created_at)
);

create index identify_cache_expires_idx on identify_cache (expires_at);
