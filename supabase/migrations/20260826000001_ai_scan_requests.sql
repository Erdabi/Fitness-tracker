-- ===========================================================================
-- The AI scan ledger
--
-- One row per analysis request. It exists for two jobs that happen to need the
-- same record: enforcing a per-user daily quota, and giving operators
-- something to look at when scanning misbehaves.
--
-- ── What is deliberately NOT here ──────────────────────────────────────────
--
-- No image, no image reference, and no extracted nutrition.
--
-- Images are processed and discarded within the request — there is no bucket,
-- no retention policy and no cleanup job, because the cheapest way to avoid
-- mishandling photographs of people's food and homes is not to keep them.
-- The extracted values are equally private: what somebody scanned is a record
-- of what they eat, and the diary already stores that with the user's
-- consent, under their own RLS.
--
-- What is left — that a scan happened, how large the image was, how it turned
-- out, and what it cost in tokens — is enough to run a quota and diagnose a
-- fault, and is not a record of anybody's diet.
-- ===========================================================================

create table public.ai_scan_requests (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,

  operation    text not null
               check (operation in ('analyzeNutritionLabel', 'analyzeFoodPhoto')),

  /*
   * The model's own status, or an error code. Free text rather than an enum:
   * the set grows with provider behaviour, and a migration to add a value to
   * an operational log is friction with no benefit.
   */
  outcome      text not null check (length(outcome) between 1 and 64),

  image_bytes  integer check (image_bytes is null or image_bytes >= 0),
  input_tokens  integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),

  created_at   timestamptz not null default clock_timestamp()
);

/*
 * The quota query: "how many did this user make in the last 24 hours". Counted
 * over a rolling window rather than a calendar day, so the limit cannot be
 * reset by waiting for midnight in a convenient timezone.
 */
create index ai_scan_requests_quota_idx
  on public.ai_scan_requests (user_id, created_at desc);

comment on table public.ai_scan_requests is
  'Quota ledger and operational log for AI scans. Deliberately stores no image and no extracted nutrition.';

-- --------------------------------------------------------------------- RLS

alter table public.ai_scan_requests enable row level security;

/*
 * Users may read their own usage — "you have used 12 of 60 today" is theirs to
 * know — and may write nothing at all.
 *
 * There is no INSERT policy and no INSERT grant on purpose. Usage is recorded
 * ABOUT a user, not BY them: a client able to write its own ledger rows could
 * also stop writing them, and the quota would be advisory. The Edge Function
 * writes with the service role, which bypasses RLS and never leaves the
 * server.
 */
create policy "Read own scan usage"
  on public.ai_scan_requests for select
  to authenticated
  using (user_id = auth.uid());

grant select on public.ai_scan_requests to authenticated;
revoke all on public.ai_scan_requests from anon;
