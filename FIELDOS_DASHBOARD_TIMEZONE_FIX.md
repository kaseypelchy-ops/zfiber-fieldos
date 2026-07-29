# FieldOS dashboard timezone fix

Build: `2026.07.28-offline-pin-safety-dashboard-time-v2`

## Problem

The team dashboard appended `T00:00:00` and `T23:59:59` directly to date-filter values. Because `address_events.created_at` is a PostgreSQL `timestamptz`, those timezone-less filter values were effectively compared at UTC boundaries. During Eastern daylight saving time, events occurring after 8:00 p.m. Eastern were stored on the next UTC date and disappeared when the dashboard end date was the current local calendar date.

## Fix

- Convert the selected local start-of-day and end-of-day boundaries to explicit UTC ISO timestamps before querying Supabase.
- Group worked-door and sales activity by the viewer's local calendar date rather than the raw UTC date prefix.
- Retain all prior offline pin-safety changes.
