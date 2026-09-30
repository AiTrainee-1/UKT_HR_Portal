# Gmail / Email Integration -UKTextiles HRMS

The HRMS emails salary slips, offer letters, ID cards, resignation letters, visitor arrival notices and resume-screening mail (rejection notices, interview invitations) through **one Gmail (SMTP) account** saved in **Settings → SMTP**. Every email goes through one central service and is logged, so HR can watch and control all of it from one page: **Gmail Control** (`/hr/gmail-control`).

## How it works

```
HRMS module ──▶ send_email() ──▶ wording (email_catalog) ──▶ smtp.gmail.com ──▶ recipient
 (salary slip,       │  checks the switches, renders subject + text,
  visitor, HR…)      │  logs a row, sends over STARTTLS / SSL
                     ▼
              EmailMessageLog  ──▶  Gmail Control page
```

- **Credentials live in Settings → SMTP** (`PayrollSettings.smtp_*`), edited there exactly as before. Gmail Control shows them read-only (login partly hidden) and **never receives the password**. A branch's own SMTP settings are honoured: each sender passes in the account it resolved (`settings_for(request)` / `settings_for_employee(emp)`).
- **Every attempt is logged** in `EmailMessageLog` with one of three statuses:
  - **Sent**: the mail server accepted it. SMTP has no delivery receipt, so this is "Gmail took it", not "it reached the inbox".
  - **Failed**: an attempt that could not complete (no address on file, a malformed address, wrong password, the server refused it or was unreachable).
  - **Not sent** (`blocked`): deliberately not attempted: HR switched it off, this is a development machine, the daily limit was reached, or SMTP isn't set up.
- **Failures never break the workflow.** `send_email()` never raises for an expected failure; callers get the log row back and report from it. A visitor's check-in still succeeds if the host's email can't be sent.
- **Automatic mail leaves no noise.** Mail the system sends on its own (the visitor arrival notice) is skipped silently, with no history row, when there is nothing to attempt (no address, switched off, SMTP not set up). A real attempt that fails is always logged.
- **Attachments are built only when the mail will really go out**, so a switched-off or over-limit bulk salary-slip run doesn't render hundreds of PDFs for nothing.

To add an email: add one entry to `backend/api/email_catalog.py` (name, module, default subject and wording, variables) and call `email_service.send_email(...)` from the place that sends it. The control page, the wording editor and the history pick it up automatically.

### Code map

| File | Role |
|---|---|
| `backend/api/email_catalog.py` | **Every email type**: label, module, default subject / wording / heading, variables, fixed details table, banner colour. The single source the rest reads. |
| `backend/api/email_service.py` | `send_email()`, the switches, the daily limit, wording rendering (plain text + HTML), the SMTP conversation, the log. |
| `backend/api/email_control_views.py` | The `/api/gmail-control/*` endpoints behind the **Gmail Control** HR page. |
| `backend/api/models/mail.py` | `EmailMessageLog`, `EmailSettings` (switches + daily limit), `EmailMessageTemplate` (per-type subject / wording / on-off). Migration `0104_email_control`. |
| `frontend/src/pages/hr/GmailControl.tsx` (+ `gmail-control/`) | The Gmail Control page. |
| `frontend/src/lib/api-client/custom-hooks/gmail.ts` | Types and hooks for the page. |
| `backend/config/settings.py` | `EMAIL_ALLOW_SENDING` (below). |

The senders that go through the service: `salary_slip_views._send_slip_email` (single + bulk salary slips), `company_documents_views.offer_letter_email`, `growth_views.email_idcard`, `recruitment_views.resignation_email`, `outpass_visitor_views._send_visitor_email`, `resume_screening_views.send_rejection_email` / `send_interview_invite_email`. The salary-slip, visitor and resume-screening "already emailed" stamps (`emailed_at`, `notified_email_at`, `rejection_emailed_at`, `interview_invited_at`) are still set by those senders, only when the mail is sent.

## Setup

1. Turn on **2-Step Verification** on the Gmail / Google Workspace account that will send.
2. Create an **App Password** (Google Account → Security → 2-Step Verification → App passwords). It is 16 characters; Gmail refuses the account's normal password over SMTP.
3. In the HRMS: **Settings → SMTP / Email**: host `smtp.gmail.com`, port `587` (STARTTLS; `465` = implicit SSL), the Gmail address as username, the App Password as password, and a From address / name.
4. Open **Gmail Control → Configuration**, type your own address and press **Send test email**. It goes through the same path as every other email and is recorded on the Messages tab.

### Development machines don't send

Like WhatsApp, a machine running `runserver` or with `DEBUG` on **does not send email**, because the Gmail account in Settings is often the live one and a laptop connected to it would email real employees. Every attempt is logged as **Not sent** with the reason, and the Configuration tab explains it. Set `EMAIL_ALLOW_SENDING=true` in that machine's environment to send anyway (or `false` to force it off on a server). `manage.py test` never sends. Blank (the default) = automatic: sends on a real server, not on a dev machine.

## Gmail Control (HR page)

`/hr/gmail-control` (sidebar → Administration → Gmail Control; permission module `gmail_control`, granted per HR role like any other page; **view** can read everything, **edit** is needed to change switches, wording or send a test). Six tabs:

| Tab | What it is for |
|---|---|
| Overview | **Today** and **this month** (total / sent / failed / not sent), the chosen range's totals, today's count against the daily limit, a card per module, an activity chart, recent failures with the reason. Refreshes every 30 s. |
| Messages | Every email, newest first: recipient (name + address), email type, module, status, subject and the **failure / not-sent reason**. Filter by status, module, email type, search (name, code, address, subject) and date. Open a row for the full text, the attachment name and who sent it. |
| Employees | Per-employee history: last email, counts, and that employee's whole log. Candidates and other outside recipients appear on the Messages tab only. |
| Feature Controls | The switches below, and the daily limit. |
| Message Text | The **subject and wording of every email**, grouped by module, with a live preview of the finished email (the real HTML), variable chips, and a per-email on/off switch. |
| Configuration | Setup checklist, **Send a test email**, and the connection details (host, port, security, login partly hidden, "app password saved" yes/no, From, company name, today's count). The password is never shown or editable here. |

A branch login sees only its own branch's employees' emails, plus the non-employee mail (a candidate, a test) it sent itself.

### Switches and defaults

An email goes out only when **its own switch** (Message Text tab), **its module's switch** and the **master switch** are all ON. Everything defaults **ON**: these emails were already being sent before the page existed, so nothing changes until HR turns something off.

| Switch | Default | Effect when OFF |
|---|---|---|
| Send emails (master) | **ON** | Nothing is emailed. Every attempt is logged as Not sent. |
| Document emails | **ON** | Salary slips (single and bulk), offer letters, ID cards and resignation letters can't be emailed. The Documents pages show the reason. |
| Visitor arrival email | **ON** | The host employee isn't emailed; check-in still works. |
| Recruitment emails | **ON** | Rejection notices and interview invitations can't be sent (the bulk result lists each as not sent). |
| Per-email switch (Message Text → Edit → Send this email) | **ON** | Just that email type stays quiet. |
| Daily email limit | **0 (none)** | Once the day's *sent* count (IST) reaches it, the rest are held back as Not sent until tomorrow. A bulk salary-slip run respects it. |

Gmail stops a regular account at about **500 emails a day** (Google Workspace about **2,000**), and a stopped account also stops every other mail from it. Set the limit a little under yours.

### Wording

Subject and text use `{{name}}` placeholders (the editor lists the ones each email has). A blank line starts a new paragraph, `**double asterisks**` make text bold, and a line whose placeholders are all empty is left out. Values are HTML-escaped, so a visitor named `<script>` can't inject anything; a subject can never carry a line break. Emails with a fixed table (the resignation letter's details, the visitor's phone and purpose, the interview date and place) take `{{details}}` to say where the table goes; without it the table is added at the end. The banner, colours and layout are fixed for every email. A typo like `{{nmae}}` is refused when saving (it would send a blank). Leave a box empty to send the default.

### The emails

| Module | Email | Sent when | Variables |
|---|---|---|---|
| Documents | Salary Slip | HR emails a slip (single or bulk) | `employee_name`, `month_year`, `net_salary`, `company_name` (+ slip PDF) |
| Documents | Offer Letter | HR emails an offer letter | `employee_name`, `designation`, `company_name` (+ letter PDF) |
| Documents | ID Card | HR emails an ID card | `employee_name`, `employee_code`, `company_name` (+ card PNG) |
| Documents | Resignation Acceptance Letter | HR emails an approved resignation | `employee_name`, `employee_code`, `department`, `last_working_day`, `approved_by`, `approval_date`, `company_name` (+ letter PDF; details table) |
| Visitors | Visitor Arrival | A visitor checks in to meet an employee (automatic) | `employee_name`, `visitor_name`, `visitor_phone`, `purpose`, `company_name` (details table) |
| Recruitment | Application Update (Rejection) | HR sends rejection emails from Resume Screening | `candidate_name`, `company_name` |
| Recruitment | Interview Invitation | HR invites a shortlisted candidate | `candidate_name`, `interview_datetime` (factory time, IST), `location`, `company_name` (details table) |
| Other | Test Email | HR presses Send test email | `company_name` |

`company_name` is always the company name saved in Settings.

## Testing

```
python manage.py test api.tests_email_control        # 90 tests: catalog, wording, service, endpoints, every sender (smtplib mocked)
cd frontend && npx playwright test e2e/gmail-control.spec.ts
```

The browser suite never sends anything: it saves an SMTP account pointing at `127.0.0.1:9`, where nothing listens, so a send fails with "connection refused", which exercises the failure path end to end. The successful send (SMTP conversation, STARTTLS / SSL, attachments, stamping) is covered against a mocked `smtplib` in the backend tests.
