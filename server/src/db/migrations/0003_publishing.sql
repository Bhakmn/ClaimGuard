-- 0003_publishing.sql
-- publish_jobs.

create table publish_jobs (
  id               uuid        primary key default gen_random_uuid(),
  provider         text        not null default 'tiktok',
  session_id       uuid        null references sessions (id) on delete set null,
  user_id          uuid        null references users (id) on delete set null,
  connection_id    uuid        not null references oauth_connections (id) on delete cascade,
  publish_id       text        null,
  title            text        null,
  file_name        text        null,
  content_type     text        not null,
  byte_size        bigint      not null,
  chunk_size       bigint      not null,
  chunk_count      integer     not null,
  chunks_sent      integer     not null default 0,
  bytes_sent       bigint      not null default 0,
  status           text        not null default 'initializing',
  provider_status  text        null,
  fail_reason      text        null,
  error_code       text        null,
  attempts         integer     not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  started_at       timestamptz null,
  completed_at     timestamptz null,

  constraint publish_jobs_provider_chk check (provider in ('tiktok')),
  constraint publish_jobs_status_chk   check (status in (
    'initializing', 'uploading', 'uploaded', 'processing', 'complete', 'failed'
  )),
  constraint publish_jobs_size_chk     check (byte_size > 0),
  constraint publish_jobs_chunk_chk    check (chunk_size > 0 and chunk_count > 0),
  constraint publish_jobs_progress_chk check (
    chunks_sent between 0 and chunk_count and bytes_sent between 0 and byte_size
  ),
  constraint publish_jobs_title_len    check (title is null or char_length(title) <= 100),
  constraint publish_jobs_file_len     check (file_name is null or char_length(file_name) <= 255),
  constraint publish_jobs_publish_len  check (publish_id is null or char_length(publish_id) <= 255),
  constraint publish_jobs_reason_len   check (fail_reason is null or char_length(fail_reason) <= 512)
);

create unique index publish_jobs_publish_id_uk on publish_jobs (publish_id)
  where publish_id is not null;
create index publish_jobs_session_idx  on publish_jobs (session_id, created_at desc);
create index publish_jobs_user_idx     on publish_jobs (user_id, created_at desc)
  where user_id is not null;
create index publish_jobs_active_idx   on publish_jobs (status)
  where status in ('initializing', 'uploading');
create index publish_jobs_created_idx  on publish_jobs (created_at);

create trigger publish_jobs_set_updated_at
  before update on publish_jobs
  for each row execute function set_updated_at();
