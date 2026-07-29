# FieldOS Offline Pin Safety Fix

Build: `2026.07.28-offline-pin-safety-v1`

## What changed

- Queued address dispositions are reapplied to the loaded address list after every reload or data refresh.
- Pins saved only on the phone show `Saved on device • pending sync` in the address list.
- Non-sale dispositions now report either `saved` or `saved on this device — pending sync` instead of always reporting `logged`.
- Database validation, permission, and schema failures are no longer mislabeled as offline work. Only connectivity failures are queued.
- Required version reloads and service-worker reloads are deferred while the offline queue contains work.
- Once the queue syncs successfully, a deferred application update may safely reload FieldOS.

## Deployment

Deploy the full folder together. The build marker in `version.json`, the `app.js` query string in `index.html`, and the cache version in `sw.js` have all been updated.

## Field test

1. Open FieldOS using the same browser/PWA the rep normally uses.
2. Load the rep and territory.
3. Turn on airplane mode or otherwise remove connectivity.
4. Disposition two test addresses.
5. Confirm each row says `Saved on device • pending sync` and the top sync button shows the pending count.
6. Refresh or fully reopen FieldOS while still offline.
7. Confirm both pins retain their selected dispositions.
8. Restore connectivity and tap the pending-sync button.
9. Confirm the button changes to `Synced`, the pending badges disappear, and the dispositions remain after another refresh.
10. Test a deliberately invalid database write in a nonproduction environment and confirm FieldOS shows an error instead of queuing it as offline.
