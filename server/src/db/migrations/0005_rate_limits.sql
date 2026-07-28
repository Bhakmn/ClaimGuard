-- 0005_rate_limits.sql
-- rate_limit_windows — fixed-window counters shared across instances.

create table rate_limit_windows (
  bucket       text        not null,
  subject      text        not null,
  window_start timestamptz not null,
  hits         integer     not null default 0,

  primary key (bucket, subject, window_start),
  constraint rate_limit_bucket_len  check (char_length(bucket) between 1 and 64),
  constraint rate_limit_subject_len check (char_length(subject) between 1 and 128)
);

create index rate_limit_window_start_idx on rate_limit_windows (window_start);
