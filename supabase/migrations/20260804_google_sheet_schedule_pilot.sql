begin;

/*
 * Read-only Google Sheet scheduling pilot.
 *
 * This table records what the Battle Mountain Sheet WOULD do. It does not
 * insert, update, cancel, or move any rows in schedule_bookings.
 */
create table if not exists public.google_sheet_schedule_pilot (
  id uuid primary key default gen_random_uuid(),
  source_key text not null,
  spreadsheet_id text not null,
  sheet_id bigint,
  sheet_name text not null,
  source_cell text not null,
  appointment_date date not null,
  time_range text not null,
  time_label text not null,
  territory text not null default 'battle_mountain_nv',
  external_account_number text,
  raw_value text not null,
  parsed_address text,
  address_id uuid references public.addresses(id) on delete set null,
  schedule_slot_id uuid references public.schedule_slots(id) on delete set null,
  existing_booking_id uuid references public.schedule_bookings(id) on delete set null,
  audit_status text not null,
  audit_reason text,
  slot_capacity integer,
  slot_booked_count integer,
  openings_before integer,
  is_present boolean not null default true,
  first_seen_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz not null default clock_timestamp(),
  last_run_id uuid not null,
  source_payload jsonb not null default '{}'::jsonb,
  constraint google_sheet_schedule_pilot_source_key_uidx unique (source_key),
  constraint google_sheet_schedule_pilot_status_check check (
    audit_status in (
      'would_book',
      'would_link_existing',
      'would_update_existing',
      'would_overbook',
      'slot_missing',
      'address_not_found',
      'address_ambiguous',
      'territory_mismatch',
      'invalid'
    )
  )
);

create index if not exists idx_google_sheet_schedule_pilot_date
  on public.google_sheet_schedule_pilot (appointment_date, time_label);

create index if not exists idx_google_sheet_schedule_pilot_status
  on public.google_sheet_schedule_pilot (audit_status, is_present, appointment_date);

create index if not exists idx_google_sheet_schedule_pilot_account
  on public.google_sheet_schedule_pilot (external_account_number)
  where nullif(trim(external_account_number), '') is not null;

alter table public.google_sheet_schedule_pilot enable row level security;

revoke all on table public.google_sheet_schedule_pilot from anon, authenticated;
grant select, insert, update, delete on table public.google_sheet_schedule_pilot to service_role;

comment on table public.google_sheet_schedule_pilot is
  'Audit-only Battle Mountain Google Sheet observations. Never drives live capacity directly.';

commit;

/*
 * Verification: should return zero because the pilot table starts empty.
 */
select count(*) as pilot_rows
from public.google_sheet_schedule_pilot;
