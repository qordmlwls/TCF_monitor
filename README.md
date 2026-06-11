# TCF Edmonton Monitor

This repository monitors the public Alliance Francaise Edmonton TCF schedule
table and sends an email alert to `qordmlwls@gmail.com` when a TCF Canada row is
available or bookable. New rows that are already `SOLD OUT!` and `Closed` do
not send email.

It does not automate checkout, payment, CAPTCHA, queueing, or final registration
submission. You should review the official page yourself before submitting
payment or registration details.

## GitHub Actions Setup

The workflow file is included at:

```text
.github/workflows/tcf-monitor.yml
```

It runs every 15 minutes at non-zero minute offsets to reduce schedule delays
around the top of the hour. It also supports manual runs from the GitHub Actions
tab.

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
2. Select `TCF Edmonton Monitor`.
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

GitHub scheduled workflows can be delayed under load, and the shortest supported
schedule interval is 5 minutes. If this repository is private, frequent
scheduled runs may consume GitHub Actions minutes.

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

Run one dry check:

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
