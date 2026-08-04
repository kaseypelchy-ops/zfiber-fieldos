# Battle Mountain Google Sheet Scheduling Pilot

This pilot compares future Battle Mountain appointments in the existing Google
Sheet with FieldOS. It writes the comparison to
`public.google_sheet_schedule_pilot` only.

It does **not** create, move, cancel, or delete live `schedule_bookings`. It does
not change `schedule_slots.capacity` or `schedule_slots.booked_count`, and it
does not create `sales_orders` or send customer confirmation emails.

## Pilot scope

- Spreadsheet: `*NEW* Fiber Install Outlook(USE THIS ONE)`
- Spreadsheet ID: `16b2htgg29qEQ1eVcXjY9oPJ4JkK2xlgLR0LvuOCMYMA`
- Tab: `Pacific/ Mountain`
- Tab ID: `1352848155`
- Column: `D` (`Battle Mountain`)
- Territory: `battle_mountain_nv`
- Dates: today and later
- Times: `8:00-10:00`, `10:00-12:00`, `1:00-3:00`, `3:00-5:00`

## 1. Create the Supabase pilot table

Open Supabase **SQL Editor** and run:

`supabase/migrations/20260804_google_sheet_schedule_pilot.sql`

Expected verification result:

```text
pilot_rows: 0
```

The table has RLS enabled. `anon` and `authenticated` cannot read or write it;
only the server-side service role used by the protected FieldOS endpoint can.

## 2. Add the Vercel secret

In the FieldOS Vercel project, open **Settings → Environment Variables**.

Add:

| Variable | Value |
|---|---|
| `GOOGLE_SHEET_PILOT_SECRET` | A new random secret containing at least 24 characters |

Apply it to **Production** and any Preview environment used for the pilot.

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are also required. They should
already exist because the sale-confirmation endpoint uses them.

Never place the service-role key or pilot secret in HTML, `app.js`, GitHub, or
a spreadsheet cell.

## 3. Deploy the updated FieldOS build

Deploy this build to Vercel. It adds:

```text
/api/google-sheet-schedule-pilot
```

The endpoint accepts only authenticated audit payloads for the exact workbook,
tab, and Battle Mountain pilot scope.

## 4. Attach the Apps Script

1. Open the Fiber Install Outlook Google Sheet.
2. Select **Extensions → Apps Script**.
3. Delete the placeholder `myFunction()` code.
4. Paste the complete contents of:
   `integrations/google-sheets/BattleMountainPilot.gs`
5. Select **Save project**.
6. Select `configureBattleMountainPilot` from the function list and click
   **Run**.
7. Approve the Google authorization prompt.
8. Enter the deployed endpoint, for example:

   ```text
   https://YOUR-FIELDOS-DOMAIN/api/google-sheet-schedule-pilot
   ```

9. Enter the exact `GOOGLE_SHEET_PILOT_SECRET` value stored in Vercel.
10. Refresh the Google Sheet.

A new **FieldOS Pilot** menu will appear. The script stores the endpoint and
secret in Apps Script Properties, not in worksheet cells.

## 5. Run the audit

In the Google Sheet, select:

**FieldOS Pilot → Run Battle Mountain audit**

The result dialog reports the number of future appointments and categories
such as:

- `would_book`: address and slot matched, with capacity available.
- `would_link_existing`: the Sheet appointment already has a matching FieldOS
  booking and would not consume capacity twice.
- `would_update_existing`: a previously tracked Sheet appointment would be
  refreshed or moved.
- `would_overbook`: FieldOS reports the destination slot as full.
- `address_not_found`: the account/location number was not found in
  `addresses.external_location_id`.
- `address_ambiguous`: the account/location number matched multiple addresses.
- `territory_mismatch`: the account/location number belongs to another
  territory.
- `slot_missing`: the corresponding active FieldOS slot does not exist.
- `invalid`: malformed or duplicate Sheet data requires review.

## 6. Review the audit in Supabase

Run:

```sql
select
  source_cell,
  appointment_date,
  time_range,
  external_account_number,
  raw_value,
  audit_status,
  audit_reason,
  slot_capacity,
  slot_booked_count,
  openings_before,
  address_id,
  schedule_slot_id,
  existing_booking_id
from public.google_sheet_schedule_pilot
where is_present = true
order by appointment_date, time_label, source_cell;
```

Confirm each result against the Sheet and the FieldOS schedule.

## Safety controls

- The Apps Script runs manually; no `onEdit` or timed synchronization trigger
  is installed during the pilot.
- The API contains no insert, update, or delete operation against
  `schedule_bookings`, `schedule_slots`, or `sales_orders`.
- Missing Sheet entries are marked `is_present = false` in the pilot table;
  live bookings are untouched.
- Existing FieldOS rep sales continue through `fieldos_submit_sale` exactly as
  before.
- The pilot is limited to 250 appointments per request.
- Placeholder and non-install values are ignored by the Sheet parser.

Only after the audit results are verified should the live reservation function
and automatic trigger be enabled.
