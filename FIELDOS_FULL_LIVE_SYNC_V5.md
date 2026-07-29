# FieldOS Full Live Sync v5

Build: `2026.07.29-full-live-sync-v5`

This build improves the live sale/schedule/dashboard experience after testing showed that address dispositions arrived live while installation availability and dashboard data sometimes required a manual refresh.

## Changes

- Adds a separate visible Schedule Live status in the field app.
- Refreshes schedule availability after any `schedule_slots`, `schedule_bookings`, or `sales_orders` Realtime event.
- Removes client-side payload filtering that could discard a legitimate schedule event.
- Re-renders the schedule even if the picker was hidden when the event arrived.
- Reconciles schedule/sales data every five seconds as a mobile websocket fallback.
- Makes the team dashboard report its Realtime subscription state in the console.
- Queues dashboard refreshes received while the dashboard is already loading or hidden instead of discarding them.
- Reduces the team-dashboard reconciliation fallback from 20 seconds to five seconds.
- Retains offline pin protection, dashboard timezone handling, and update-loop protection.

## Expected indicators

- `● Live` means address dispositions are live.
- `● Schedule Live` means schedule and sales table subscriptions are live.
- `↻ Schedule Sync` means the websocket is reconnecting and the five-second reconciliation is active.
