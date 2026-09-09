# North York, Edmonton, Montreal Apps Script Monitor

This checker runs on Google's servers with a personal Google account. It requests
one check of each preferred centre every five minutes and leaves the existing multi-city GitHub
monitor untouched. The laptop does not need to remain on after installation.
It is not a reservation bot and never follows booking links, submits forms,
enters queues, solves CAPTCHA, pays, or registers a candidate.

The preference is **North York > Edmonton > Montreal**. Lower-priority cities
still send alerts for verified openings. No exam-date restriction is applied;
check your repeat-test eligibility before booking. An existing booking is never
modified. North York means that campus specifically, not all Toronto campuses.

## Upgrade the Existing Edmonton Project

1. Build and upload to the same linked Google project.
2. Run `dryRunAllCities`. All three must succeed. Zero available sessions is a
   valid result; a failed or overlapping check is not.
3. Create two additional Healthchecks.io checks, one for North York and one for
   Montreal. Use five-minute periods, ten-minute grace, and your email channel.
4. Set `TCF_NORTH_YORK_HEALTHCHECKS_URL` and `TCF_MONTREAL_HEALTHCHECKS_URL` to their
   respective private ping URLs. Keep `TCF_HEALTHCHECKS_URL` unchanged for Edmonton.
5. Run `installAllCities`. It validates all providers before replacing the old
   Edmonton triggers with `checkAllCities` every five minutes and
   `sendAllDailyReport` once daily. It preserves Edmonton's state and `Checks` sheet.
6. Verify automatic executions, all three city sheets in the existing private
   spreadsheet, all three independent watchdogs, and email delivery. Initial
   currently open sessions produce real availability emails.

The legacy `installPilot` remains available for a new Edmonton-only deployment.
Once the all-city schedule exists, it reinstalls the all-city schedule instead.
`stopPilot` similarly stops the all-city schedule after an upgrade.

### Expanded Controls

| Function | Effect |
| --- | --- |
| `installAllCities` | Validates all three, replaces only managed triggers, checks immediately. |
| `dryRunAllCities` | Logs each city's snapshot without email, notification-state changes or heartbeat. |
| `checkAllCities` | Performs real checks; a city error is recorded without skipping the other cities. |
| `showAllStatus` | Shows each city's health and check-history link, in preference order. |
| `sendAllDailyReport` | Sends one combined health report. |
| `dryRunNorthYork`, `dryRunMontreal` | Checks just the named added provider without alerting. |
| `testNorthYorkWatchdog`, `testMontrealWatchdog` | Sends an intentional DOWN test for that city. |
| `stopAllCities` | Stops the Google schedule, retaining all state and leaving GitHub unchanged. |

New state is stored separately under `NORTH_YORK_STATE_*` and `MONTREAL_STATE_*`.
New diagnostic properties use `TCF_NORTH_YORK_*` and `TCF_MONTREAL_*`. These are
managed automatically; do not edit or delete them. The separate `North York`
and `Montreal` sheets use the same log format and retention as Edmonton's `Checks`.

### Added Provider Rules

- **North York:** validate every ActiveNet search page and all TCF Canada
  sub-courses, excluding preparation courses and other campuses. Pagination is
  sent in the HTTP `page_info` header, and returned page identity/counts must
  match. Parent location or parent enrollment links are not availability evidence.
  Require a North York leaf-course detail and its final matching **Enroll Now**
  action; reject hold, full, waitlist, countdown, disabled and closed states.
  Recheck previously open future courses even when the catalogue hides them.
- **Montreal:** read the official public TCF Canada registration feed using its
  current public settings. Require valid registration dates, available capacity,
  unblocked flags, and an exact official registration link for the same exam ID.
  A stale link with zero capacity does not alert. Cart links are never followed.
- Valid empty North York/Montreal catalogs are successful observations. Partial
  pages, schema changes and network failures are explicit errors, not sold-out
  results. Each city's state, deduplication and success heartbeat are independent.
- Requests have count and between-request time limits. North York detail/status
  requests are batched in groups of eight. Shared execution checks Edmonton first
  to protect the established home monitor if a new provider stalls.

### Shared Free-Account Budget

All three cities share Google's account-wide quotas. The 18.75-second average
budget below applies to the **combined** five-minute run, not to each city.
Runtime warnings start at 20 measured minutes/day for a city or 60 combined.
The runtime state retains only the latest 24 hours (up to 650 attempts); the
spreadsheet retains the longer history. State has per-city bounded storage and
never silently resets deduplication when storage is full. Watch actual Google
runtime for 24-48 hours before treating this expanded configuration as proven.

## Legacy Edmonton-Only Activation

When the project has already been uploaded, open its Apps Script editor:

1. Select `installPilot` in the function dropdown next to **Run**.
2. Click **Run** and complete Google's authorization for your own project.
3. Wait for completion and the email titled
   `[TCF Edmonton health] Five-minute pilot installed`.
4. Open the **Check history** spreadsheet linked in that email.
5. Verify that new rows with mode `CHECK` and outcome `SUCCESS` appear without
   manually running anything. `DRY_RUN` is not a scheduled check.

The requested permissions are outbound web requests, email sending, spreadsheets,
and creating this project's scheduled triggers. Inbox reading is not required.
No Gmail password or app password is used. If Google presents an unverified-app
warning, confirm this is the project in your own account and review its requested
permissions; do not approve an unrelated project or unexpected permissions.

`installPilot` creates a private spreadsheet, validates a live fetch, creates a
five-minute check trigger and a daily health-report trigger (between 18:00 and
19:00 Edmonton time), performs a real check, and sends the setup email. Re-running
it replaces only these two triggers and preserves notification history. There
is no need to use **Deploy > New deployment** or create a public web app.

If initial validation fails, do not assume it is installed. Read the execution
error and inspect the trigger list. If installation fails after creating the
triggers (for example, email authorization fails), the triggers may already
exist. Re-running after fixing the problem is safe.

## Independent Stop Warning

**This is necessary before trusting the pilot as your only Edmonton monitor.**
Google's daily report and its own failure emails cannot reliably warn you if
Google stops running your script altogether. Use a separate free heartbeat check:

1. Create a free account at <https://healthchecks.io/> with your email address.
2. Create a check named `TCF Edmonton Apps Script`.
3. Set its period to **5 minutes** and grace time to **10 minutes**. This warns
   after approximately 15 minutes without a successful ping.
4. Confirm an email notification channel for `qordmlwls@gmail.com` is enabled.
5. In Apps Script, open **Project Settings > Script Properties > Add script
   property**. Set `TCF_HEALTHCHECKS_URL` to the check's private
   `https://hc-ping.com/<uuid>` URL, without a trailing slash. Save it.
6. Run `checkEdmonton`. Confirm the external check shows **UP**.
7. Run `testWatchdogFailure` and confirm the external **DOWN** email arrives.
   The next successful normal check restores **UP**.
8. Test an actual missing-run warning: run `stopPilot`, leave the Healthchecks
   check unpaused, and wait at least 15 minutes. Confirm its warning email, then
   run `installPilot` to resume and verify new scheduled `CHECK` rows.

Only a complete validated check with successful alert processing and committed
state sends a success ping. Dry runs, test emails, failures, and overlapping
checks do not. The ping contains only a generic success message, not schedule
data, your email address, or Google credentials. Treat the ping URL as a secret:
someone with it could falsely mark the monitor healthy. Never commit it.

The pilot can run before this setting is added, but its status will explicitly
say `NOT CONFIGURED`. This is not an independently supervised deployment yet.

## Controls

| Function | Effect |
| --- | --- |
| `installPilot` | Installs/replaces the two pilot triggers, checks immediately, sends setup email. |
| `dryRun` | Fetches and logs a snapshot without sending email, modifying notification state, or pinging the watchdog. Creates the log sheet if needed. |
| `testAlert` | Sends a clearly labeled test email; does not start monitoring. |
| `checkEdmonton` | Performs one real check and sends any new, verified availability alerts. |
| `showStatus` | Prints trigger count, last success, gaps, runtime estimate, and the spreadsheet link. |
| `sendDailyReport` | Sends the current health report without refreshing the watchdog. |
| `testWatchdogFailure` | Sends an intentional DOWN signal to test external warning delivery. |
| `stopPilot` | Removes only this pilot's triggers, preserving history and state. Does not pause the external watchdog or stop GitHub. |

Script properties:

| Property | Value |
| --- | --- |
| `TCF_ALERT_EMAIL_TO` | Optional; defaults to `qordmlwls@gmail.com`. One recipient only. |
| `TCF_HEALTHCHECKS_URL` | Optional during installation, required for independent supervision. |
| `TCF_LOG_SPREADSHEET_ID` | Created automatically; do not delete or replace casually. |
| `EDMONTON_STATE_*` | Managed notification history; do not edit. |
| Other `TCF_*` properties | Managed installation and diagnostic metadata. |

## Availability Rules

- Read the complete official schedule, requesting 200 rows per page and following
  validated same-site Show More links. Reject pagination loops, conflicting
  duplicates, missing tables, changed columns, HTTP errors, and empty TCF catalogs.
- Require an active, non-hidden **Book Now** or **Register** link to a recognized
  official booking path. A seat count alone is not enough.
- Sold-out, zero-seat, closed, waitlisted, and not-yet-open statuses suppress
  alerts even if stale links remain. This is deliberately stricter than the
  legacy Python Edmonton checker.
- Check the published registration window in Edmonton's timezone. An unrecognized
  window or changed booking control raises a visible error instead of silently
  being interpreted as an unavailable seat.
- Do not notify for newly posted sessions that are already sold out or closed.
- Send once per observed opening, and send again after an observed closure and
  reopening. Registration-date and seat-count edits alone do not re-alert.
- Preserve notification state if a session disappears or a fetch fails. A missing
  row is not proof of closure. Expire missing records only after 90 days.
- Retry an unsent alert only after rechecking that the session is still bookable.
  Successful email submission is recorded separately from detecting availability.

Two independent systems do not share notification history. During the pilot,
both Apps Script and GitHub may notify for the same genuinely open session.
Apps Script emails are labeled to distinguish them. Exactly-once delivery cannot
be guaranteed if Google accepts an email but execution stops before saving that
fact; the next check can send a duplicate rather than silently lose the alert.

## Logs and Acceptance Check

The private `Checks` sheet retains the latest 10,000 observations, approximately
34 days at five-minute intervals, less when there are extra manual/error rows.
Each row records UTC check time, mode, outcome, duration, previous-success gap,
page count, available count, number of alerted sessions, and the **full parsed
schedule as JSON**, including each row's reason for rejection.

`SUCCESS` means the observation, alert handling, and notification state were
completed. `FAILED` means monitoring encountered a problem, not that all seats
are full. `OBSERVED` means a snapshot was written but final completion was not
confirmed in that row; inspect subsequent rows and execution logs. An execution
terminated by Google can leave only an execution error, without a spreadsheet
row. External supervision is what catches this lack of success.

Transient errors remain visible in execution logs. Separate health emails are
throttled to at most one per six hours, with five email-recipient slots reserved
for availability alerts. Google's own trigger-failure notifications are managed
by Google and may still arrive.

Before any replacement of the existing Edmonton monitor, review at least 24-48
hours of Google-hosted operation:

- Roughly 288 successful checks per full day, with measured gaps near five minutes.
- Investigate every gap over 10 minutes; the external warning must work at 15.
- Test email and both intentional-failure and missing-run watchdog tests arrive.
- Live page and logged session decisions match; local tests cover synthetic
  open/reopened sessions when the actual schedule has no available seat.
- Measured runtime remains comfortably below 60 minutes/day, allowing margin
  below Google's 90-minute personal-account trigger limit.

Do not switch off the GitHub monitor or increase frequency based solely on unit
tests, a successful manual check, or the presence of a trigger. One-minute checks
are intentionally not provided as an installation control in this pilot.

## Limits

Google does not promise exact scheduling. Personal accounts currently allow
90 minutes/day of trigger runtime, 20,000 URL fetches/day, and 100 email recipients
per day across their scripts. At five-minute intervals, the average run must be
below 18.75 seconds even before other scripts use quota. These quotas can change.

The runtime report is a local estimate measured around each check, not Google's
quota meter. Startup, state saving, watchdog calls, reports, and hard-terminated
executions can add unrecorded time. The 60-minute warning is a margin, not a quota
guarantee. The parser permits at most five pages and checks a 45-second budget
between page fetches. Apps Script does not expose a per-request timeout here, so
that budget cannot interrupt an already blocked request; Google's execution limit
and the external missing-success warning remain the safeguards. There are no
in-run retry sleeps that could consume the daily runtime allowance.

## Development and Upload

Use Node.js 24 and pnpm 11.19.0. The runtime code is bundled with an established
HTML parser and URL parser, so there are no third-party library fetches at run
time. Third-party license notices are included in the generated file.

```sh
cd apps-script/edmonton
pnpm install --frozen-lockfile
pnpm run build
pnpm test
pnpm run verify
node verify-preferred.mjs
```

`verify` and `verify-preferred.mjs` are read-only and run locally. Their latency is **not** a Google-hosted
measurement. Use `node verify-live.mjs path/to/captured.html` for a saved full
page. The captured public-table fixture contains no account or checkout data.
Tests also execute the exact generated bundle in a sandbox with mocked Google
services and no browser or Node globals.

For a new deployment, enable the Apps Script API in
<https://script.google.com/home/usersettings>, then:

```sh
pnpm dlx @google/clasp login
pnpm dlx @google/clasp create-script --type standalone --title "TCF Edmonton Monitor - Five-Minute Pilot" --rootDir dist
pnpm run build
pnpm dlx @google/clasp push --force
pnpm dlx @google/clasp open-script
```

Rebuilding after project creation restores the intended manifest and minimum
runtime scopes. For an existing linked project, rebuild and push without creating
another project. `--force` accepts the manifest update; verify `.clasp.json`
points to the intended pilot before using it. Run `installPilot` in the editor
after uploading. Upload alone never starts a schedule.

Clasp credentials remain in the user's home directory. `.clasprc.json`, local
project bindings, and local deployment metadata are excluded from Git. The
separate GitHub test workflow checks the bundle and its tests only; it does not
deploy to Google or change the original monitor schedule.

## References

- [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas)
- [Five-minute clock triggers](https://developers.google.com/apps-script/reference/script/clock-trigger-builder)
- [Installable trigger behavior](https://developers.google.com/apps-script/guides/triggers/installable)
- [Mail authorization](https://developers.google.com/apps-script/reference/mail/mail-app)
- [URL Fetch options](https://developers.google.com/apps-script/reference/url-fetch/url-fetch-app)
- [Clasp upload tool](https://developers.google.com/apps-script/guides/clasp)
- [Healthchecks free plan](https://healthchecks.io/pricing/)
- [Healthchecks period and grace time](https://healthchecks.io/docs/configuring_checks/)
