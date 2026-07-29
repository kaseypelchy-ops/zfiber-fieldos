# FieldOS Login Refresh Loop Fix

Build: `2026.07.28-offline-pin-safety-dashboard-time-v3`

## Root cause

`version.json` advertised the dashboard-time-v2 build while `app.js` still declared the older offline-pin-safety-v1 build. The required update check therefore saw a mismatch after every page load and repeatedly reloaded the login screen.

## Corrections

- Synchronized the build identifier in `app.js` and `version.json`.
- Bumped the `app.js` and service-worker cache-busting query strings.
- Bumped the service-worker cache version.
- Added a five-minute session reload guard so a bad or partial future deployment cannot cause an endless refresh loop.
