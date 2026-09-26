# WAClient WhatsApp Integration -UKTextiles HRMS

The HRMS sends WhatsApp messages (documents, sign-in/reset/activation codes, attendance alerts and punch reminders, approval and rejection decisions for every request workflow, Geo Attendance and punch decisions, visitor arrivals, and outpass gate IN/OUT) through **WAClient's WhatsApp Web API** (`app.waclient.com`). This replaced the earlier Gupshup integration; nothing of Gupshup remains in the code.

## How it works

```
Django backend ──POST https://api.waclient.com/send (JSON)──▶ WAClient ──▶ your linked WhatsApp number ──▶ employee
   whatsapp_service                                              │
        ▲                                                        └── fetches the PDF from
        └──────────── GET /api/whatsapp/media/<token> ◀──────────────  https://<api-host>/api/whatsapp/media/<token>
```

- **A WhatsApp number is linked to a WAClient "instance" once, by scanning a QR code** in the WAClient dashboard. After that, every message is sent as that number. There are **no Meta templates and nothing to get approved** -the wording is plain text you can edit (Settings → WhatsApp).
- **Documents are sent by URL.** WAClient downloads the PDF/PNG from a public link, so the backend stores each generated file for 24 hours (`WhatsAppMediaAsset`) and gives WAClient `GET /api/whatsapp/media/<token>` (random, unguessable, no login). This endpoint must be reachable from the internet.
- **Every attempt is logged** in `WhatsAppMessageLog` (sent / delivered / read / failed, with the reason).

### One central layer

```
HRMS module ──▶ send_notification() ──▶ template (whatsapp_catalog) ──▶ WAClient ──▶ employee
 (leave, geo,        │  checks the switches, renders the wording,
  visitor, gate…)    │  logs a row, delivers (in the background)
                     ▼
              WhatsAppMessageLog  ──▶  WhatsApp Control page
```

No module talks to WAClient itself. To add a notification: add one entry to `whatsapp_catalog.py` (name, module, default wording, variables, switch) and call `whatsapp_service.send_notification(...)` from the place that raises it. The control page, template editor, message log and on/off checks pick it up from the catalog with no other change (and no migration). To cover a **new approval workflow**, add a builder to `whatsapp_approvals.py` and its key to `APPROVAL_MODULES`.

- **Failures never break the workflow.** Not configured, no phone, switched off, WAClient down, even a bug in the messaging code: the approval / gate scan / check-in still happens, and HR sees the failed row with its reason.
- **Delivered in the background.** Approval, visitor and gate messages are handed to a single worker (`WHATSAPP_ASYNC_SEND`), so nobody waits on WhatsApp and a burst is spread out (`WHATSAPP_MIN_SEND_GAP_SECONDS`). Codes and the attendance job send immediately. A message left "pending" by a server restart is marked failed after 10 minutes.
- **Exactly once.** Automatic messages reserve a log row under a unique key before sending, so a double click, a retry or overlapping jobs never send twice.

### Code map

| File | Role |
|---|---|
| `backend/api/whatsapp_catalog.py` | **Every message type**: label, module, default wording, variables, switch. The single source the rest reads. |
| `backend/api/whatsapp_service.py` | The notification service (`send_notification()`), switches, wording and rendering, the background worker, the log, and all WAClient calls (text, link preview, documents, contact cards). Documents use `send_document()`. |
| `backend/api/whatsapp_approvals.py` | Approve / reject messages for every workflow (`notify_decision()` + one builder per workflow). |
| `backend/api/whatsapp_format.py` | Shared date / time / duration / phone formatting for the messages. |
| `backend/api/whatsapp_views.py` | Settings → WhatsApp endpoints (status, message wording), the public media link, and the delivery-status webhook. |
| `backend/api/models/whatsapp.py` | `WhatsAppMessageLog`, `WhatsAppMessageTemplate` (per-type wording + on/off switch), `WhatsAppMediaAsset`, `WhatsAppSettings` (feature switches + timings), `EmployeeOtp`. |
| `backend/api/otp_service.py`, `otp_views.py` | WhatsApp OTP: issue, verify, expire, rate-limit; the `auth/login-options` and `auth/otp/*` endpoints used by the Employee Web App and the mobile app. |
| `backend/api/whatsapp_alerts.py`, `whatsapp_alert_scheduler.py` | Automatic attendance alerts (a background job every minute). |
| `backend/api/whatsapp_notifications.py` | Geo Attendance / punch decisions, gate IN/OUT and visitor arrivals. |
| `backend/api/whatsapp_control_views.py` | The `/api/whatsapp-control/*` endpoints behind the **WhatsApp Control** HR page. |
| `frontend/src/pages/hr/WhatsAppControl.tsx` (+ `whatsapp-control/`) | The WhatsApp Control page. |
| `backend/config/settings.py` | The `.env` settings below -never stored in the database. |

## Setup

1. Sign in at **app.waclient.com**, create a **WhatsApp Web API** instance and **scan the QR code** with the WhatsApp number you want to send from (WhatsApp → Linked devices). Keep that phone online and logged in.
2. Copy the instance's **Instance ID** and **Access Token**.
3. Put them in the backend environment (`backend/.env` locally; **Variables** on Railway):

| Variable | Required | Meaning |
|---|---|---|
| `WACLIENT_INSTANCE_ID` | yes | Instance ID from the dashboard |
| `WACLIENT_ACCESS_TOKEN` | yes | Access token from the dashboard |
| `BACKEND_PUBLIC_URL` | recommended on Railway | Public origin WAClient uses to download documents, e.g. `https://api.uktextiles.in` |
| `WHATSAPP_DEFAULT_COUNTRY_CODE` | no | Defaults to `91` |
| `WHATSAPP_SEND_DELAY_SECONDS` | no | Pause between messages in a bulk send. Default `2`; `0` disables |
| `WHATSAPP_WEBHOOK_TOKEN` | no | If set, the webhook URL must end with `?token=<value>` |
| `WACLIENT_API_URL` | no | Defaults to `https://api.waclient.com/send` |
| `WACLIENT_CONTACT_API_URL` | no | Contact cards; defaults to the send URL with `/send_contact` |
| `EMPLOYEE_PORTAL_URL` | recommended | Where the Employee Web App lives (e.g. `https://employee.uktextiles.in`). Approval messages then carry a "View request" link to the right page; blank = no link |
| `WHATSAPP_ASYNC_SEND` | no | Default `true`: approval / visitor / gate messages go from a background worker. `false` = inline |
| `WHATSAPP_MIN_SEND_GAP_SECONDS` | no | Minimum pause between two background messages. Default `1` |
| `WHATSAPP_LINK_PREVIEW` | no | Default `true`: a message with a link is sent as WAClient's "link" type (preview card), falling back to plain text if refused |

4. Restart the backend. **Settings → WhatsApp** should show *Configured -instance ending in …xxxx*.
5. Send one salary slip to a test employee (a different phone from the linked number) and confirm it arrives.

## Message wording

**WhatsApp Control → Message Text** lists every message the HRMS sends (grouped by module) with its wording, the variables it can use, a live preview with sample values, and Default / Customised. Wording is plain WhatsApp text (`*bold*`, `_italic_`, emojis) with `{{variable}}` placeholders. Click a variable chip to insert it; a placeholder the message doesn't have is refused (a typo would otherwise send a blank). A line whose placeholders are all empty is left out, so optional details (a note, a reason) vanish instead of leaving an empty label. Wording HR saved earlier with numbered placeholders (`{{1}}`, `{{2}}`) keeps working: the number is the variable's position in the list.

### Messages at a glance

| Module | Message | Sent when | Key variables |
|---|---|---|---|
| Documents | Salary Slip, ID Card, Offer / Experience / Resignation Letter, Other Document | HR sends the document (the file is attached; the wording is its caption) | `employee_name`, `month_year` / `designation` / `last_working_day` / `document_category` |
| OTP & Login | Login OTP, Password Reset OTP, Account Activation OTP | An employee asks for a code | `code` (**must stay in the text**), `minutes` |
| Attendance | Absent Alert | No punch within the punctuality window after the shift starts | `employee_name`, `date`, `shift_start`, `cutoff_time`, `status` |
| Attendance | Late Attendance Alert | First punch after start + the shift's grace | `shift_start`, `first_punch`, `late_by`, `status`, `grace_minutes`, `grace_period` |
| Attendance | Punch Reminder / On-Duty Punch Reminder | 5 minutes before a punch is expected, and it is still missing | `punch_name`, `punch_number` ("2 of 4"), `expected_time`, `greeting`, `action`, `quote`, `closing`, `minutes_left`, `destination` |
| Attendance | Missing Punch Alert | A punch is still missing 20 minutes after it was expected | `punch_name`, `expected_time`, `status`, `intro` (plus `recorded`, `missing`) |
| Approvals | Approval - Approved / Rejected | Any request below is decided | `request_type`, `date`, `time`, `details`, `approver`, `comment`, `link` |
| Geo Attendance | Geo Attendance Approved / Rejected | The request gets HR's final approval, or is rejected by anyone | `destination`, `requested_on`, `approved_by` / `rejected_by`, `comment`, `punches_note` |
| Geo Attendance | Geo Punch Approved / Rejected | One captured punch is decided | `punch_name`, `date`, `time`, `location`, `comment` |
| Visitors | Visitor Notification + Visitor Contact Card | A visitor checks in to meet an employee | `visitor_name`, `visitor_phone`, `company`, `purpose`, `department`, `visit_date`, `visit_time`, `branch` |
| Outpass & Gate | Gate OUT / Gate IN | The gate records the employee going out / coming back | `pass_type`, `destination`, `gate_out_time`, `gate_in_time`, `duration`, `gate_name`, `status` |

## WhatsApp Control (HR page)

`/hr/whatsapp-control` (sidebar → Administration → WhatsApp Control; permission module `whatsapp_control`, granted per HR role like any other page). Six tabs:

| Tab | What it is for |
|---|---|
| Overview | **Today** and **this month** (total / sent / delivered / failed / pending), the chosen range's totals, a card per module, an activity chart, recent failures with the reason. Refreshes every 30 s. |
| Messages | Every message, newest first: employee, **mobile number**, message type, **module and workflow** ("Approvals - Leave"), status and the message text or **failure reason**. Filter by status, module, workflow, employee, date. Open a row for the full text and the WAClient id. Login/reset codes are always shown as `••••••`. |
| Employees | Per-employee history: last message, counts, and that employee's whole log. |
| Feature Controls | One ON/OFF switch per feature (below), plus the timing knobs. Changes apply immediately; the alert job re-reads them every run. |
| Message Text | The wording of every message type, grouped by module, with a live preview and variable chips. |
| Configuration | Connection status (instance shown as `…1234`), the webhook URL to paste into WAClient, the Employee Web App address, how messages are delivered. **Credentials are never shown or editable here** -they live in the server environment only. |

### Switches and defaults

A message goes out only when its own switch **and** its module's switch are on.

| Switch | Default | Effect when OFF |
|---|---|---|
| WhatsApp OTP - login / password reset / new-account activation | **ON** | That code can't be requested (the apps hide the option). Activation OFF brings back the old open first-time setup. |
| Password login | **ON** | Employees can only sign in with a WhatsApp code. Keep ON until OTP delivery is proven in production. |
| Document notifications | **ON** | Documents can't be sent (the attempt shows as a failed row saying why). |
| Attendance alerts (all) | **ON** | Master: none of the four alerts below is sent. |
| Absent alert / Late alert / Punch reminder / Missing punch alert | **OFF** | Nothing sent. Turning one on begins messaging employees automatically. |
| Approval notifications (all) | **ON** | Master: no approval / rejection message for any workflow. |
| One switch per approval workflow (Leave, Permission, Casual Leave, Missing Punch, Gate Outpass, Attendance Correction, Resignation, Advance, Other Requests) | **ON** | Just that workflow stays quiet. |
| Geo Attendance approval & rejection | **OFF** | Geo requests and their punches send nothing. |
| Visitor notification | **ON** | No visitor message or contact card; check-in still works. |
| Outpass gate IN / OUT | **ON** | No gate confirmation; the scan still works. |

Timings: OTP validity 1-30 min (default 5); extra minutes on top of the shift's punctuality window before "absent" (default 0); wait after a punch is due before its reminder (default 10); minutes after shift end before the end-of-day missing-punch message (default 30).

## WhatsApp OTP sign-in, password reset and first-time activation

Used by the **Employee Web App** and the **mobile app** (login screen → default method; "Use my password instead" and "First time at UKTextiles?" remain).

1. The employee types their **Employee Code**. The server looks up the phone number HR has on file (the employee never types a number) and WhatsApps a 6-digit code to it. The reply only shows the last digits (`••••••••0001`).
2. They enter the code; a correct code signs them in (same token as password login). *Forgot password* is the same flow, ending with choosing a new password.

Rules enforced server-side: the code is never stored (salted HMAC), works once, expires (default 5 min), is tied to its purpose (a login code can't reset a password), allows 5 wrong guesses, 1 request per 60 s and 5 per hour per employee, plus per-IP rate limits. Asking for a code says plainly when the employee code isn't registered, the account is inactive or no phone is on file (password login already says the same, and the employee needs to know what to do); *verifying* a code gives one generic "incorrect or expired" message for every failure, so guessing learns nothing. If WhatsApp itself fails, the employee is told to try again or use their password, and the failure is logged for HR.

Endpoints: `GET auth/login-options`, `POST auth/otp/request` `{employeeCode, purpose: "login"|"reset"|"activate"}`, `POST auth/otp/login` `{employeeCode, otp}`, `POST auth/otp/reset-password` `{employeeCode, otp, password}`, `POST auth/otp/activate` `{employeeCode, otp, password}`. (The mobile app sends `identifier` instead of `employeeCode`; both are accepted.)

### First-time password ("Set password" screen)

A new employee - one with no password yet - opens **First time at UKTextiles?** in the app (or the Employee Web App's *Set your password*), enters their Employee Code, and a code is WhatsApped to the number HR registered. Only after entering it can they choose a password (min. 8 characters); they then sign in with it. The code is worded as an *account activation* code and is single-use, expiring and attempt-limited exactly like the others. Someone who already has a password is told to sign in or use *Forgot password* instead.

An employee **without a phone number on file cannot activate** - the app tells them to contact HR, who add the number.

**The old open route is closed.** `POST auth/set-password` used to let anyone set the first password for any employee code that had none. While activation codes are ON *and* WhatsApp is configured, it now refuses an unauthenticated first-time call (403, "confirm the code we send to your registered WhatsApp number"). It still accepts the employee's own signed-in session (changing a password, or setting one after signing in by code), and still stays open if the *OTP new-account activation* switch is OFF or WhatsApp isn't configured - so nobody is locked out, at the cost of the old weakness. Older mobile builds that still call `set-password` directly therefore need updating before their users can activate.

## Automatic attendance alerts and punch reminders

A background job (every minute, `Asia/Kolkata`) looks at **today** for staff employees and sends, each **at most once per employee per day** (the log row is reserved before sending, so restarts and overlapping runs can't double-send). Everything is judged against **the employee's own assigned shift** (start, end, grace, lunch times), never one company-wide time.

| Message | When |
|---|---|
| Absent | No punch once shift start + the **punctuality window** has passed (Settings → Attendance, "maximum first punch allowed", 60 minutes by default: the same "wait an hour, then Absent" rule the attendance engine uses) plus any extra minutes HR adds, and the shift hasn't ended. A polite "we haven't received your punch yet; are you absent, or did you forget to punch in?". |
| Late | As soon as the first punch is seen to be after shift start + **that shift's grace** (compared to the second, as the attendance engine does). Says the shift start, the grace, the first punch, **how late** (counted from the end of the grace period, in whole minutes) and the **status**: Late (still a full shift), Late - automatic Permission, or Late - Half Shift. |
| Punch reminder | A friendly heads-up **5 minutes before** each expected punch (HR can change the 5), only if that punch is still missing: check-in at the shift start, lunch-out at the shift's first-half end, lunch-in one lunch duration later, check-out at the shift end (two punches in simple mode). Greeting by time of day, wording per punch, and a short motivational line. |
| On-Duty punch reminder | The same, for employees with an On-Duty (Geo Punch) request today, counting punches they have submitted even before HR approves them, worded to ask for their Geo Punch. |
| Missing punch | A punch is still missing **20 minutes after it was expected** (HR can change the 20): "Expected Punch 9:00 AM, Current Status: Punch Not Recorded". One message per missing punch, per day. It lapses when the next punch's heads-up begins (the check-out one, a few hours after the shift ends). |

A person owes a punch only in order: the check-in first, then lunch-out, lunch-in and check-out (the check-out is owed to anyone still clocked in even if they skipped lunch). Two taps on the device within 5 minutes count as one punch, so a double-press can't skip someone ahead to the next punch.

Nobody is messaged on Sundays, holidays, Saturday-off, approved leave (full or half day), when HR already set that day by hand, or on a Compensation Day. "HR already set the day" means a day record written by hand (an HR override or an approved casual leave), or someone HR marked present who has no punches at all; the presence row the punch ingest writes for everyone who punches does **not** count (treating it as a decision is what once silenced every alert for anyone who had punched). An employee with an On-Duty request today gets only the punch reminders (not absent / late / missing). A permission covering the employee excuses the late alert. Employees with no shift, or a shift that crosses midnight, are skipped. Only active **staff** are checked (not production employees).

**Why didn't employee X get a message?** Run `python manage.py whatsapp_alert_trace 30020` (optionally `--at 09:25`). It runs the scheduler's own decision code for today and prints the shift, the punches and, for every alert, whether it is due and exactly why not. It sends nothing. **Point it at the database you mean:** it reads whatever `DATABASE_URL` says.

Wording HR has saved on the Messages page replaces the defaults above; a saved wording written for the old rules keeps working (`recorded` and `missing` are still filled in), but only the new default carries the new lines.

## Approval and rejection messages

Every approval workflow tells the employee, on WhatsApp and automatically, what was decided:

| Workflow | Decided by | Notes |
|---|---|---|
| Leave, Permission, Casual Leave, Gate Outpass | HR or the Department Head (whoever acts first) | Outpass approvals add "Show your pass QR at the gate within 60 minutes". |
| Missing Punch | Department Head then HR | The Department Head's approval only hands it to HR, so nothing is sent until HR decides; a rejection at either stage is sent at once. |
| Attendance Correction | Department Head | HR proposes it; the employee is told whether it was applied. |
| Resignation | Department Head then HR | Same two-stage rule. |
| Advance, Other Requests (salary enquiry, shift correction ...) | HR | Approved or rejected only; "in review" / "more info" send nothing. |
| Geo Attendance (On-Duty) request | Department Head then HR | Own wording (below). |
| Geo punch ("Punch Approval") | HR | Own wording (below). |

The message says the request type, date and time, what was requested, who approved or rejected it and the note or **rejection reason** if one was given, with a "View request" link when `EMPLOYEE_PORTAL_URL` is set. On-Duty / Geo Attendance and Punch Approval are the same two workflows in the HRMS as "On Duty" and "On Duty Punch"; there is one set of messages for each.

### Geo Attendance and punches

- **Request approved / rejected.** Approved (HR's final approval) restates what the employee submitted: destination, when requested, approver, note. Rejected (by the Department Head or HR) says so with the same details, the reason, and how many recorded punches stopped counting. A Department Head's approval that only passes it to HR sends nothing.
- **Punch approved / rejected.** Each captured punch restates which punch, when and where (a map link); a rejection says it doesn't count and can be retried. A bulk decision on all pending punches sends one summary instead of a ping per punch.

## Visitors

When a visitor checks in to meet an employee, the employee gets the visitor's **name, contact number, company (if recorded), purpose, whom they came to meet, department, date, time and branch**, followed by the visitor's **contact card**. WAClient's WhatsApp Web API has no native buttons, so the tap-to-call action is that contact card (tap it to call, message or save the visitor) plus the number, which WhatsApp also makes tappable. The message is sent in the background, so the visitor's check-in never waits, and Reception's "notified" time is stamped once it is really delivered. There is no company field on the visitor form today, so that line is left out until one is added.

## Outpass gate IN / OUT

- **Gate OUT** when the gate scanner verifies an approved outpass and records the employee going out: outpass type, date, gate OUT time, destination, reason, gate name, status *Verified*, and a reminder to scan the Return QR.
- **Gate IN** when the return QR is verified: both times, how long they were out, the gate and status.
- **Gate QR form**: an entry recorded in an employee's name through the public gate form is confirmed to that employee as *not scanned by a guard*, with "If this wasn't you, please tell HR" (anyone can type an employee code there).

Denied scans (expired, already used) send nothing.

## Deploying these features

1. Run migrations (`0097_waclient_whatsapp`, `0098_whatsapp_control_otp_alerts`, `0099_whatsapp_otp_activation`, `0100_whatsapp_central_layer`).
2. The variables in **Setup** must be set on the server that answers (Railway → Variables).
3. Open **WhatsApp Control → Configuration**: it should say credentials are set. Send yourself a sign-in code from the Employee Web App to prove delivery.
4. Set `EMPLOYEE_PORTAL_URL` so approval messages link to the Employee Web App. Approval, visitor, gate and document messages are ON by default (approve a test request and check **Messages**); turn on the attendance alerts / punch reminders / Geo switches you want, one at a time, and watch **Messages** for the first run.
5. Set the WAClient webhook to the URL shown in **Configuration** (see *Delivery / read status* below).

## Delivery / read status (optional webhook)

In the WAClient dashboard set the instance's **webhook URL** to
`https://<api-host>/api/whatsapp/webhook/` (add `?token=<value>` if you set `WHATSAPP_WEBHOOK_TOKEN`). The endpoint always answers `200`, and moves a message's log status `sent → delivered → read` (or `failed`).

WAClient's webhook body format is not publicly documented, so the parser is deliberately tolerant (numeric or named statuses, several field layouts) and **every webhook body is logged** at WARNING as `WhatsApp webhook body: …`. After your first real send, look at that log line; if statuses aren't updating, the logged body shows exactly what to adjust in `_status_updates` (`whatsapp_views.py`).

## Things to know

- **This is the WhatsApp Web (linked device) route, not Meta's official Cloud API.** It's simple and needs no template approval, but WhatsApp can restrict a number that sends bulk or unsolicited messages. Send only to your own employees, keep the default pause between bulk messages, and use a number you can afford to lose access to. The linked phone must stay online, or sending stops until you relink.
- There is **no 250-customers-per-day style limit** here (that was Meta's Cloud API tier), but the ban risk above is the trade-off.
- Documents are fetched by WAClient from `BACKEND_PUBLIC_URL`; if a message arrives without its file (or fails), check that this URL opens from the internet and isn't behind bot protection that blocks `/api/whatsapp/media/*`.

## Troubleshooting

| Symptom | Check |
|---|---|
| 400 "WhatsApp is not configured…" | `WACLIENT_INSTANCE_ID` / `WACLIENT_ACCESS_TOKEN` missing on the server that's answering (Railway variables, not just local `.env`) |
| "Send failed: …" | WAClient's own message is shown; commonly the instance is disconnected (relink the QR code) or the token is wrong |
| "No phone number on file" | Add the employee's phone (any format; `+91…`, `91…` and plain 10-digit numbers all work) |
| "turned off in Settings" | Settings → WhatsApp → enable that document type |
| Sent but nothing arrives | The number isn't on WhatsApp, or WAClient couldn't download the file from `BACKEND_PUBLIC_URL` |
| Status stays `sent` | Webhook not set, or its body format differs -see the logged `WhatsApp webhook body` |
| Employee says "no code arrived" | WhatsApp Control → Messages → filter category *OTP & Login*: a failed row shows WAClient's reason; a sent row means the number on file is wrong or not on WhatsApp |
| Employee gets "wait N seconds" | The 60 s resend cooldown or the 5-per-hour cap (both by design) |
| An alert never went out | Its switch (or Attendance alerts (all)) is OFF, the employee is exempt (leave / holiday / On-Duty / no shift), or it already went out today |
| An approval sent no message | Approval notifications (all), or that workflow's switch, is OFF; or the decision was a Department Head hand-over (only final decisions and rejections are sent); or it was already sent for that decision |
| A message is stuck on Pending | The server restarted before delivering it; it is marked Failed within 10 minutes |
| Approval message has no link | `EMPLOYEE_PORTAL_URL` isn't set on the server |
| No contact card after a visitor message | Contact cards are a separate WAClient call; a failed one shows as its own row ("Visitor Contact Card") with WAClient's reason |

## Tests

`python manage.py test api.tests_whatsapp_service api.tests_whatsapp_webhook api.tests_otp api.tests_whatsapp_alerts api.tests_whatsapp_control api.tests_whatsapp_approvals api.tests_whatsapp_events` -covers the request shape, wording, variables and rendering, every approval workflow (approve, reject, two-stage hand-overs, switches, background delivery, failures that must not break the workflow), gate and visitor messages, punch reminders, phone handling, every failure path, the settings endpoints, the webhook parser, OTP security (expiry, single use, attempt limits, purpose separation, redaction), each alert rule and its exemptions, and the WhatsApp Control API. WAClient itself is mocked, and credentials are blanked while tests run, so nothing in the suite sends a real message.

The browser suite (`cd frontend && npx playwright test`) runs the real send path against a **fake WAClient** (`frontend/e2e/fake-waclient.mjs`, port 8190) so `whatsapp-control.spec.ts` can read the code an employee would have received.
