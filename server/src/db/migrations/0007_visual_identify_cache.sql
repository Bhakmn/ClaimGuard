-- 0007_visual_identify_cache.sql
-- visual_identify_cache — content-addressed result cache for frame-level
-- visual copyright detection (Granite Vision / heuristic pipeline).
--
-- Keyed by SHA-256 of the raw JPEG/PNG frame bytes (32 bytes, same scheme as
-- identify_cache).  TTL-based expiry, same cleanup path.

create table visual_identify_cache (
  frame_sha256  bytea       primary key,
  frame_bytes   integer     not null,
  -- "heuristic" | "granite_vision" — whichever path produced the result
  source        text        not null,
  -- null = no match / no flag for this frame
  result        jsonb       null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  hit_count     integer     not null default 0,
  last_hit_at   timestamptz null,

  constraint visual_cache_digest_len  check (octet_length(frame_sha256) = 32),
  constraint visual_cache_bytes_chk   check (frame_bytes > 0),
  constraint visual_cache_expiry_chk  check (expires_at > created_at),
  constraint visual_cache_source_chk  check (source in ('heuristic', 'granite_vision'))
);

create index visual_identify_cache_expires_idx on visual_identify_cache (expires_at);

-- RLS: service-role key bypasses; non-service connections read nothing.
alter table visual_identify_cache enable row level security;
