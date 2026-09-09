# TCF Canada Multi-City Monitor

This repository monitors official TCF Canada registration data for Alliance
Francaise locations in Edmonton, Toronto, Montreal, and Ottawa. It sends an
email alert to `qordmlwls@gmail.com` only when a session has a reliable booking
signal. New sessions that are already sold out or closed do not send email.

The sources are:

- Edmonton's complete public schedule table, including `Show More` pages.
- Toronto's ActiveNet exam search, sub-course, detail, and final
  enrollment-button endpoints.
- Montreal's official AEC registration page, examination feed, and cart links.
- Ottawa's official AEC registration page, computer and paper examination
  feeds, and cart links.

For Toronto, Montreal, and Ottawa, a positive seat count by itself is not enough
to trigger an alert. The final registration system must expose an active booking
link. Toronto discovery comes directly from ActiveNet, including expansion of
parent results into their actual sub-courses. Every Toronto leaf course must
have a live ActiveNet enrollment action before it can send email. This rejects
courses whose metadata claims an opening while the rendered registration flow
is full, on hold, cancelled, or has no enrollable sub-course.

It does not automate checkout, payment, CAPTCHA, queueing, or final registration
submission. You should review the official page yourself before submitting
payment or registration details.

## Free Edmonton Apps Script Pilot

An independent Edmonton-only checker is available in
[`apps-script/edmonton`](apps-script/edmonton/README.md). It requests a Google-hosted
check every five minutes, sends email through Google authorization, and records
full schedule snapshots and actual check gaps in a private spreadsheet.

This is a parallel pilot, not an automatic replacement for GitHub Actions.
Uploading the code does not activate it: run `installPilot` in its Apps Script
project and authorize it. Configure the independent Healthchecks.io watchdog,
then validate actual Google-hosted timing and email delivery before relying on
it. A green test run or configured trigger does not prove ongoing coverage.

## GitHub Actions Setup

The workflow file is included at:

```text
.github/workflows/tcf-monitor.yml
```

It requests a run every 5 minutes at non-zero minute offsets to reduce schedule
delays around the top of the hour. It also supports manual runs from the GitHub
Actions tab.

Each check validates every city independently. If one site refuses every
network retry, the workflow records a warning, preserves that city's previous
state, and continues checking the other cities. A malformed official feed,
incompatible page change, or code/test failure still fails visibly instead of
silently treating sessions as closed.

### 1. Add Repository Secrets

Open the GitHub repository:

```text
https://github.com/qordmlwls/TCF_monitor
```

Then go to:

```text
Settings -> Secrets and variables -> Actions -> New repository secret
```

Create this secret:

```text
TCF_SMTP_USERNAME
```

Value:

```text
your_gmail_address@gmail.com
```

Create this secret:

```text
TCF_SMTP_PASSWORD
```

Value:

```text
your_16_character_gmail_app_password_without_spaces
```

Do not put your normal Gmail password here. Use a Gmail app password.

### 2. Send A Manual Test Alert

In GitHub:

1. Go to `Actions`.
2. Select `TCF Canada Multi-City Monitor`.
3. Click `Run workflow`.
4. Choose `test-alert`.
5. Click `Run workflow`.

You should receive a test email at `qordmlwls@gmail.com`.

### 3. Run A Dry Check

Run the workflow manually again, but choose `dry-run`. This prints the detected
state in the workflow log and does not email or update the saved monitor state.

### 4. Let The Schedule Run

After the secrets are set, the scheduled workflow will run automatically from
the default branch. Your laptop can be off.

GitHub scheduled workflows are best-effort and can be delayed or skipped under
load, even when the cron expression is set to the shortest supported 5-minute
interval. A green run is either a complete validated check or a network outage
recorded as a skipped check; the `Run monitor` log identifies which occurred.
The absence of a run does not confirm continuous monitoring. Use an always-on
server with the `--watch` command when a dependable two-to-five-minute interval
is required.

## Local Usage

Create a local `.env` file:

```bash
TCF_ALERT_EMAIL_TO=qordmlwls@gmail.com
TCF_SMTP_HOST=smtp.gmail.com
TCF_SMTP_PORT=587
TCF_SMTP_USERNAME=your_gmail_address@gmail.com
TCF_SMTP_PASSWORD=your_gmail_app_password
TCF_SMTP_FROM=your_gmail_address@gmail.com
TCF_SMTP_STARTTLS=true
```

Install dependencies:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Run one dry check across all four cities:

```bash
python -m tools.tcf_monitor --once --dry-run
```

Send a test email:

```bash
python -m tools.tcf_monitor --test-alert
```

Run continuously on your own machine:

```bash
python -m tools.tcf_monitor --watch --interval-seconds 180
```

## Tests

```bash
python -m unittest discover -s tests -v
```
