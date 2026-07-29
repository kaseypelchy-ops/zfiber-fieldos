# FieldOS Address Realtime v4

- Subscribes to `address_events` INSERT activity for the rep’s assigned territories.
- Updates the matching map pin, address list, statistics, and open address status without a page refresh.
- Preserves local pending-sync dispositions until the device queue is confirmed.
- Uses an incremental Supabase poll as a fallback when Realtime disconnects or a phone sleeps.
- Displays Live, Connecting, Live fallback, or Offline status in the top bar.
- Requires `address_events` in the `supabase_realtime` publication; run `SUPABASE_ADDRESS_REALTIME_SETUP.sql` once.
