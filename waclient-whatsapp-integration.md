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
- **Every attempt is logged** in `WhatsAppMessageLog` (queued / sending / sent / delivered / read / failed / expired / skipped, with the reason).

### One central layer, one paced sender (the send queue, 2026-11-06)

```
HRMS module ──▶ send_notification() / send_document() ──▶ template (whatsapp_catalog)
 (leave, geo,        │  checks the switches (master, module, type, opt-out), renders the wording,
  visitor, gate…)    │  writes the WhatsAppMessageLog row as "queued" (codes: sent at once)
                     ▼
              WhatsAppMessageLog (the outbox) ──▶ whatsapp_dispatcher.tick() every 10 s ──▶ WAClient ──▶ employee
                     │                              one message per tick, paced, capped, quiet at night
                     ▼
              WhatsApp Control page
```

No module talks to WAClient itself, and since 2026-11-06 **nothing but a one-time code is sent from the request or job that raised it**. Everything else is written as a `queued` row and leaves when the dispatcher's pacing allows (see *The send queue* below). To add a notification: add one entry to `whatsapp_catalog.py` (name, module, default wording, variables, switch, and for the queue its kind and freshness) and call `whatsapp_service.send_notification(...)` from the place that raises it. The control page, template editor, message log, per-type switch and on/off checks pick it up from the catalog with no other change (and no migration). To cover a **new approval workflow**, add a builder to `whatsapp_approvals.py` and its key to `APPROVAL_MODULES`.

- **Failures never break the workflow.** Not configured, no phone, switched off, WAClient down, even a bug in the messaging code: the approval / gate scan / check-in still happens, and HR sees the row with its status and reason.
- **Nobody waits on WhatsApp.** A queued row is written in the request and the dispatcher sends it later, from its own scheduler thread. A message left "sending" (or a code left "pending") by a server restart is marked failed after 10 minutes, never retried.
- **Exactly once.** Automatic messages reserve a log row under a unique key, so a double click, a retry or overlapping jobs never queue twice.

## The send queue: why the number stopped getting restricted

WAClient is an unofficial WhatsApp Web link. WhatsApp restricts a number for automated, high-volume, repetitive messaging: the same text to many people within minutes, several messages a day to one person, recipients who never reply. The cure is fewer messages, fewer per person, a steady pace, quiet nights and no catch-up bursts. There is deliberately **no random jitter**: it would only disguise the pattern, not change it.

Every message type in `whatsapp_catalog.py` has a **kind**, a **priority** (lower goes first) and a **freshness**:

| Kind | Types | Priority | Freshness (after it was raised) |
|---|---|---|---|
| `code` | login / reset / activation codes | 0 | sent at once, never queued |
| `document` | salary slip, ID card, letters, other documents | 3 (a **bulk** send: 6, behind everything time-critical) | until the end of the day |
| `requested` | approval / rejection of the employee's own request, Geo / On-Duty decisions | 4 | approvals: end of day; Geo: 120 min |
| `automatic` | absent (60 min), late (30), missing punch (60), punch reminders (the lead window, 15 min), visitor + contact card (30), gate out / in (30), HoD pending reminders (end of day) | 5 | as listed |

The alert job knows exactly when each alert stops being useful (a reminder: the punch time; absent: an hour after it became due; late: 30 min after the punch; missing: its window), and passes that. **A row expires at the earliest of: raised + freshness, the alert's own moment, and the end of that day (IST).** Nothing from an earlier day is ever sent.

**The dispatcher** (`api/whatsapp_dispatcher.py`, an APScheduler job every 10 seconds registered in `apps.py`, `max_instances=1`, `coalesce`, skipped under `manage.py test`) does, on each tick:

1. **Expire**: queued rows past `expires_at`, or created before today, become `expired` ("Too late to be useful: not sent"). Never sent, never retried.
2. **Nothing is sent** while the master switch is off, WhatsApp isn't configured on this machine, or it is **quiet hours** (default 21:00 to 07:00 IST).
3. **Circuit breaker**: 3 provider failures within 30 minutes (any message type; a missing phone number or a switch doesn't count) pause sending until 15 minutes after the last failure. Then one message is tried; a failure pauses again.
4. **Pacing**, measured in the database so it holds across processes and restarts: fewer than `max_per_hour` sent in the last 60 minutes (default **60**), fewer than `max_per_day` sent today (default **200**), and at least `min_gap_seconds` since the last message of any kind (default **30 s**; a code counts as the last message too).
5. **The next row** (lowest priority, then oldest) is taken under a row lock (`select_for_update(skip_locked=True)`, plus a lock on the settings row so two processes never decide at once). Per row: switched off since it was queued, or the employee **opted out** → `skipped`; an **automatic** message for an employee who already got `max_per_employee_per_day` automatic messages today (default **3**) → `skipped` ("Daily limit for this employee"); the same employee got the **same type with the same text in the last 24 hours** → `skipped` ("Duplicate"; for documents also the same file). Otherwise it is marked `sending`, sent (text, document or the visitor's contact card right after its message) and becomes `sent` with `sent_at`, or `failed`.
6. **Retries**: a temporary failure (network error, timeout, HTTP 5xx or 429) goes back to `queued` **once**, 60 seconds later, if it is still fresh and still today. Anything else (a refused number, a disconnected instance, a bad token) is final. Failed messages never re-enter the queue by themselves.

**One message per tick** at most, so even a burst of approvals or a month of salary slips leaves at the configured pace, one at a time.

**Codes** (`otp_*`) are sent immediately and synchronously, as before: they bypass the gap, the caps and quiet hours (an employee signing in at 22:00 still gets the code), but they count as the last message for the gap and in the hour / day totals. Only the **master switch** blocks them; with it off the apps treat WhatsApp as unavailable (`otp_service.OtpConfig.available`): no code is offered, password sign-in stays open, first-time activation falls back to the open set-password route and SMS keeps working, so nobody is locked out.

**Quiet hours**: a non-code message raised during quiet hours is recorded `skipped` ("Quiet hours: not sent") instead of queued; it is not sent in the morning. A row already queued when quiet hours begin waits, and expires at midnight if still unsent.

**Opt-out**: HR can opt an employee out (WhatsApp Control → Employees). They get no WhatsApp notifications or documents (each attempt is a `skipped` row); codes they ask for themselves still go. Their phone push / in-app notification (`push_messages.py`) is a separate channel and is not affected.

**Bulk sends** (Payslips → Bulk WhatsApp) queue one document row per employee with a batch id in its payload, build each PDF only when its turn comes, and answer at once with a sentence saying how many can go out today at the current limits. **Anything not sent by the end of the day expires** (owner rule): send the rest again the next day. The progress endpoint reads the batch's rows (queued / sent / failed / expired / skipped).

**Under tests** (`WHATSAPP_ASYNC_SEND=false`, always under `manage.py test`) a newly queued row is delivered inline at once: switches, opt-out, dedupe and kinds still apply; the gap, caps, duplicate check and quiet hours don't, and a temporary failure isn't retried. The dispatcher itself is tested by calling `tick(now=...)` with a frozen clock (`tests_whatsapp_dispatcher.py`). **Never set `WHATSAPP_ASYNC_SEND=false` on a real server**: it bypasses all of the above. (The e2e stack needs it, see Tests.)

### Code map

| File | Role |
|---|---|
| `backend/api/whatsapp_catalog.py` | **Every message type**: label, module, default wording, variables, switch, and its queue kind / priority / freshness. The single source the rest reads. |
| `backend/api/whatsapp_service.py` | The notification service (`send_notification()`), switches (master, module, type, opt-out), wording and rendering, writing the queued rows, codes (sent at once), and all WAClient calls (text, documents, contact cards). Documents use `send_document()`, bulk documents `queue_document()`. |
| `backend/api/whatsapp_dispatcher.py` | **The send queue's one paced sender** (every 10 s): expiry, quiet hours, circuit breaker, gap / hourly / daily / per-employee caps, duplicate check, one retry for a temporary failure; also the queue status and "clear" behind the WhatsApp Control page. |
| `backend/api/whatsapp_bulk_progress.py` | Progress of a bulk send, read from its batch's queued rows. |
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
| `WHATSAPP_WEBHOOK_TOKEN` | no | If set, the webhook URL must end with `?token=<value>` |
| `WACLIENT_API_URL` | no | Defaults to `https://api.waclient.com/send` |
| `WACLIENT_CONTACT_API_URL` | no | Contact cards; defaults to the send URL with `/send_contact` |
| `WHATSAPP_ASYNC_SEND` | no | Default `true`: every non-code message is queued and sent by the dispatcher. **`false` delivers each one inline at once, bypassing the pacing, caps and quiet hours: tests and the e2e stack only, never a real server** |
| `WHATSAPP_ALERTS_MAX_PER_RUN` / `_PER_HOUR` / `_PER_DAY` | no | Upper guard on how many attendance alerts the alert job may queue (8 / 200 / 700); the real pacing is the queue's (WhatsApp Control) |

`WHATSAPP_SEND_DELAY_SECONDS` and `WHATSAPP_MIN_SEND_GAP_SECONDS` no longer do anything: the gap between messages is the queue's `min_gap_seconds`, set on the WhatsApp Control page (default 30 s).

4. Restart the backend. **Settings → WhatsApp** should show *Configured -instance ending in …xxxx*.
5. Send one salary slip to a test employee (a different phone from the linked number) and confirm it arrives.

## Message wording

**WhatsApp Control → Message Text** lists every message the HRMS sends (grouped by module) with its wording, the variables it can use, a live preview with sample values, and Default / Customised. Wording is plain WhatsApp text (`*bold*`, `_italic_`, emojis) with `{{variable}}` placeholders.

**The default wordings were rewritten on 2026-11-06** to read like a company writing to its own staff rather than a bulk sender: short, plain, a bold title, no emojis or capitals, no motivational lines or lectures, every message signed `- UK Textiles HR`, and no link in any automatic message (only the Geo punch decisions keep their map link). Every variable is still filled in, so wording HR saved earlier (with greetings, quotes, emojis) keeps working unchanged; customised wording is never touched. The phone notification drops the `- UK Textiles HR` sign-off like the old one. Click a variable chip to insert it; a placeholder the message doesn't have is refused (a typo would otherwise send a blank). A line whose placeholders are all empty is left out, so optional details (a note, a reason) vanish instead of leaving an empty label. Wording HR saved earlier with numbered placeholders (`{{1}}`, `{{2}}`) keeps working: the number is the variable's position in the list.

### Messages at a glance

| Module | Message | Sent when | Key variables |
|---|---|---|---|
| Documents | Salary Slip, ID Card, Offer / Experience / Resignation Letter, Other Document | HR sends the document (the file is attached; the wording is its caption) | `employee_name`, `month_year` / `designation` / `last_working_day` / `document_category` |
| OTP & Login | Login OTP, Password Reset OTP, Account Activation OTP | An employee asks for a code | `code` (**must stay in the text**), `minutes` |
| Attendance | Absent Alert | No punch within the punctuality window after the shift starts | `employee_name`, `date`, `shift_start`, `cutoff_time`, `status` |
| Attendance | Late Attendance Alert | First punch inside the Late window: after start + the shift's grace, up to the Late window (60 min by default, Settings → Attendance). An approved Late-In permission excuses it, and a later arrival (quarter-shift or second-half) is not "Late" so gets no late alert | `shift_start`, `first_punch`, `late_by`, `status`, `grace_minutes`, `grace_period` |
| Attendance | Punch Reminder / On-Duty Punch Reminder | 15 minutes before a punch is expected, and it is still missing | `punch_name`, `punch_number` ("2 of 4"), `expected_time`, `greeting`, `action`, `quote`, `closing`, `minutes_left`, `destination` |
| Attendance | Missing Punch Alert | A punch is still missing 20 minutes after it was expected | `punch_name`, `expected_time`, `status`, `intro` (plus `recorded`, `missing`) |
| Approvals | Approval - Approved / Rejected | Any request below is decided | `request_type`, `date`, `time`, `details`, `approver`, `comment` |
| Geo Attendance | Geo Attendance Approved / Rejected | The request gets HR's final approval, or is rejected by anyone | `destination`, `requested_on`, `approved_by` / `rejected_by`, `comment`, `punches_note` |
| Geo Attendance | Geo Punch Approved / Rejected | One captured punch is decided | `punch_name`, `date`, `time`, `location`, `comment` |
| Visitors | Visitor Notification + Visitor Contact Card | A visitor checks in to meet an employee | `visitor_name`, `visitor_phone`, `company`, `purpose`, `department`, `visit_date`, `visit_time`, `branch` |
| Outpass & Gate | Gate OUT / Gate IN | The gate records the employee going out / coming back | `pass_type`, `destination`, `gate_out_time`, `gate_in_time`, `duration`, `gate_name`, `status` |

## WhatsApp Control (HR page)

`/hr/whatsapp-control` (sidebar → Administration → WhatsApp Control; permission module `whatsapp_control`, granted per HR role like any other page). Six tabs:

| Tab | What it is for |
|---|---|
| Overview | **Today** and **this month** (counts per status: queued / sending / sent / delivered / read / failed / expired / skipped / pending), the chosen range's totals, a card per module, an activity chart, recent failures with the reason, and the **send queue** (`GET /api/whatsapp-control/queue`: master switch, paused by the circuit breaker and why, quiet hours, how many are waiting, sent today / in the last hour, failed / expired / skipped today, when the next message may leave, the limits) with **Clear queue** (every waiting message becomes skipped, "Cleared by HR"). |
| Messages | Every message, newest first: employee, **mobile number**, message type, **module and workflow** ("Approvals - Leave"), its kind (code / requested / automatic / document), status and the message text or **reason** (failure, expiry, skip). Filter by status (any of the nine), module, workflow, employee, date. Open a row for the full text, the WAClient id, attempts, when it was sent and when it would have expired. Login/reset codes are always shown as `••••••`. |
| Employees | Per-employee history: last message, counts, that employee's whole log, and the **opt-out** switch (with a reason). `all=1` lists every employee, to find someone to opt out. |
| Feature Controls | The **master switch** (stops every WhatsApp message, codes included), one ON/OFF switch per feature and **per message type** (below), the timing knobs, the **queue limits** (gap, per hour, per day, per employee per day) and **quiet hours**. Changes apply immediately; the alert job and the dispatcher re-read them every run. |
| Message Text | The wording of every message type, grouped by module, with a live preview and variable chips. |
| Configuration | Connection status (instance shown as `…1234`), the webhook URL to paste into WAClient, the Employee Web App address, how messages are delivered. **Credentials are never shown or editable here** -they live in the server environment only. |

### Switches and defaults

A message goes out only when the **master switch**, its module's switch **and** its own switch are on, and (for anything but a code) the employee hasn't opted out. Its own switch is its boolean below where it has one; every other type (the documents, approved / rejected, the HoD reminder, each Geo decision, visitor message and contact card, gate out / in, and the two punch reminders, which share one boolean) has its own `type:<key>` switch on Feature Controls, stored in `WhatsAppSettings.disabled_message_types`.

| Switch | Default | Effect when OFF |
|---|---|---|
| **WhatsApp sending (master)** | **ON** | No WhatsApp message at all, codes included. The apps treat WhatsApp as unavailable: password sign-in stays, activation falls back to the open first-time setup, SMS keeps working. Queued messages wait and expire at midnight. |
| One switch per message type (`type:<key>`) | **ON** | Just that message type stays quiet. |
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

**The punch reminders (Punch Reminder and On-Duty Punch Reminder) are OFF** by owner decision (2026-11-06): migration `0143_whatsapp_send_queue` switched `four_punch_alert_enabled` off on the existing settings row, and it stays OFF by default. They were the most repetitive messages (up to four a day per person, the same text to a whole shift at once).

Timings: OTP validity 1-30 min (default 5); extra minutes on top of the shift's punctuality window before "absent" (default 0); how long before a punch its reminder goes (default 15); minutes after a punch was due before its Missing Punch message (default 20).

Queue limits ("careful" defaults, owner 2026-11-06): **at least 30 s between messages** (5-600), **at most 60 an hour** (1-1000), **at most 200 a day** (1-5000), **at most 3 automatic messages per employee per day** (1-20); **quiet hours 21:00 to 07:00** (IST, on by default; no message but a code goes out).

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

A background job (every minute, `Asia/Kolkata`) looks at **today** for staff employees and **queues** whatever is due, each **at most once per employee per day** (the log row is reserved under a unique key, so restarts and overlapping runs can't double-queue). It only decides; the send queue sends (or lets the alert expire the moment it stops being useful). Everything is judged against **the employee's own assigned shift** (start, end, grace, lunch times), never one company-wide time.

| Message | When |
|---|---|
| Absent | No punch once shift start + the **punctuality window** has passed (Settings → Attendance, "maximum first punch allowed", 60 minutes by default: the same "wait an hour, then Absent" rule the attendance engine uses) plus any extra minutes HR adds, and the shift hasn't ended. A polite "we haven't received your punch yet; are you absent, or did you forget to punch in?". |
| Late | As soon as the first punch is seen to be after shift start + **that shift's grace**, judged in **whole minutes: seconds don't count** (with a 9:00 shift and 10 minutes' grace, a punch through 9:10:59 is on time and 9:11 is the first late minute; the attendance engine, the daily Late count and this alert all use the same rule). Says the shift start, the grace, the first punch, **how late** (whole minutes past the end of the grace period) and the **status**: Late (still a full shift), Late - automatic Permission, or Late - Half Shift. |
| Punch reminder | A friendly heads-up **15 minutes before** each expected punch (HR can change the 15), only if that punch is still missing, so the messages are spread over a quarter of an hour rather than landing at one moment: check-in at the shift start, lunch-out at the shift's first-half end, lunch-in one lunch duration later, check-out at the shift end. This is the same in simple and strict attendance mode (simple mode only ignores lunch punches when working out the day's pay); a shift with no lunch break has just check-in and check-out. Greeting by time of day, wording per punch, and a short motivational line. |
| On-Duty punch reminder | The same, for employees with an On-Duty (Geo Punch) request today, counting punches they have submitted even before HR approves them, worded to ask for their Geo Punch. |
| Missing punch | A punch is still missing **20 minutes after it was expected** (HR can change the 20): "Expected Punch 9:00 AM, Current Status: Punch Not Recorded". One message per missing punch, per day; a missing *lunch* punch is only chased in strict mode (simple mode doesn't use lunch punches for the day). It lapses when the next punch's heads-up begins (the check-out one, a few hours after the shift ends). |

A person owes a punch only in order: the check-in first, then lunch-out, lunch-in and check-out (the check-out is owed to anyone still clocked in even if they skipped lunch). Two taps on the device within 5 minutes count as one punch, so a double-press can't skip someone ahead to the next punch.

Nobody is messaged on Sundays, holidays, Saturday-off, approved leave (full or half day), when HR already set that day by hand, or on a Compensation Day. "HR already set the day" means a day record written by hand (an HR override or an approved casual leave), or someone HR marked present who has no punches at all; the presence row the punch ingest writes for everyone who punches does **not** count (treating it as a decision is what once silenced every alert for anyone who had punched). An employee with an On-Duty request today gets only the punch reminders (not absent / late / missing). A permission covering the employee excuses the late alert. Employees with no shift, or a shift that crosses midnight, are skipped. Only active **staff** are checked (not production employees).

**Safeguards against a restricted number** (an unofficial WhatsApp Web connection can be restricted for automated bulk-looking sending, and once was):

- *A development machine never sends.* With `DEBUG=true`, or running under `runserver`, WhatsApp sending is refused (the WhatsApp Control page's config shows `sendingBlockedReason`), so a laptop connected to the live database and live number can't message anyone. `WHATSAPP_ALLOW_SENDING=true` overrides it deliberately; a real server (DEBUG off) sends normally. **Check that production has `DEBUG=false`** or it will not send.
- *Alerts are about now.* Each queued alert carries the moment it stops being useful: an absent alert an hour after it became due, a late alert 30 minutes after the punch, a missing-punch alert an hour after it became due, a reminder at the punch time. Past it, or past midnight, it expires unsent. A bug fix, an outage or a limit can therefore never release a backlog of stale messages at once.
- *Everything is paced by the send queue* (see *The send queue*): at least 30 s apart, at most 60 an hour, 200 a day, 3 automatic messages per employee per day, nothing between 21:00 and 07:00. The alert job's own limits (`WHATSAPP_ALERTS_MAX_PER_RUN` 8 / `_PER_HOUR` 200 / `_PER_DAY` 700) remain as an upper guard on how much it may queue. With a 30 s gap the queue sends about two messages a minute, so a crowd of alerts due at the same time is partly sent and the rest expires when it stops being useful: that is by design (fewer messages). There is deliberately no random jitter, which would only be disguising the pattern.
- *Pause on provider failure.* The queue's circuit breaker: 3 provider failures of any message in 30 minutes (a disconnected or restricted number) stop all sending, and the alert job stops queueing, until 15 minutes after the last failure. A missing phone number doesn't count.
- *Once per employee per alert per day* (already true) and one reminder per punch; the punch reminders themselves are OFF (owner decision, 2026-11-06).

None of this makes an unofficial connection compliant or restriction-proof; for a workforce this size, WhatsApp's official Business Platform (approved templates) is the durable route.

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

The message says the request type, date and time, what was requested, who approved or rejected it and the note or **rejection reason** if one was given. **No WhatsApp message carries a link to the Employee Web App** (the old "View request" line, its `{{link}}` placeholder, the preview card and the `EMPLOYEE_PORTAL_URL` / `WHATSAPP_LINK_PREVIEW` settings were removed; every text goes out as a plain WAClient "text" message). Wording HR saved earlier that still contained `{{link}}` was cleaned by migration `0130_whatsapp_strip_portal_link`, the editor refuses the placeholder as an unknown one, and if it ever reached the renderer the whole line would be dropped. The only address a message can still show is the map link in the Geo punch messages. On-Duty / Geo Attendance and Punch Approval are the same two workflows in the HRMS as "On Duty" and "On Duty Punch"; there is one set of messages for each.

### Geo Attendance and punches

- **Request approved / rejected.** Approved (HR's final approval) restates what the employee submitted: destination, when requested, approver, note. Rejected (by the Department Head or HR) says so with the same details, the reason, and how many recorded punches stopped counting. A Department Head's approval that only passes it to HR sends nothing.
- **Punch approved / rejected.** Each captured punch restates which punch, when and where (a map link); a rejection says it doesn't count and can be retried. A bulk decision on all pending punches sends one summary instead of a ping per punch.

## Visitors

When a visitor checks in to meet an employee, the employee gets the visitor's **name, contact number, company (if recorded), purpose, whom they came to meet, department, date, time and branch**, followed by the visitor's **contact card**. WAClient's WhatsApp Web API has no native buttons, so the tap-to-call action is that contact card (tap it to call, message or save the visitor) plus the number, which WhatsApp also makes tappable. The message is queued, so the visitor's check-in never waits, and Reception's "notified" time is stamped once it is really sent (the contact card goes right after the message, as part of it). There is no company field on the visitor form today, so that line is left out until one is added.

## Outpass gate IN / OUT

- **Gate OUT** when the gate scanner verifies an approved outpass and records the employee going out: outpass type, date, gate OUT time, destination, reason, gate name, status *Verified*, and a reminder to scan the Return QR.
- **Gate IN** when the return QR is verified: both times, how long they were out, the gate and status.
- **Gate QR form**: an entry recorded in an employee's name through the public gate form is confirmed to that employee as *not scanned by a guard*, with "If this wasn't you, please tell HR" (anyone can type an employee code there).

Denied scans (expired, already used) send nothing.

## Deploying these features

1. Run migrations (`0097_waclient_whatsapp`, `0098_whatsapp_control_otp_alerts`, `0099_whatsapp_otp_activation`, `0100_whatsapp_central_layer`, and `0143_whatsapp_send_queue`: the queue columns on the log, the master switch / per-type switches / limits / quiet hours on the settings, the opt-out table, and the punch reminders switched off; additive only, every new column has a database default so the previous release keeps working during a rolling deploy). The dispatcher starts with the app (`apps.py`), as the other scheduled jobs do.
2. The variables in **Setup** must be set on the server that answers (Railway → Variables).
3. Open **WhatsApp Control → Configuration**: it should say credentials are set. Send yourself a sign-in code from the Employee Web App to prove delivery.
4. Approval, visitor, gate and document messages are ON by default (approve a test request and check **Messages**); turn on the attendance alerts / punch reminders / Geo switches you want, one at a time, and watch **Messages** for the first run.
5. Set the WAClient webhook to the URL shown in **Configuration** (see *Delivery / read status* below).

## Delivery / read status (optional webhook)

In the WAClient dashboard set the instance's **webhook URL** to
`https://<api-host>/api/whatsapp/webhook/` (add `?token=<value>` if you set `WHATSAPP_WEBHOOK_TOKEN`). The endpoint always answers `200`, and moves a message's log status `sent → delivered → read` (or `failed`).

WAClient's webhook body format is not publicly documented, so the parser is deliberately tolerant (numeric or named statuses, several field layouts) and **every webhook body is logged** at WARNING as `WhatsApp webhook body: …`. After your first real send, look at that log line; if statuses aren't updating, the logged body shows exactly what to adjust in `_status_updates` (`whatsapp_views.py`).

## Things to know

- **This is the WhatsApp Web (linked device) route, not Meta's official Cloud API.** It's simple and needs no template approval, but WhatsApp can restrict a number that sends bulk or unsolicited messages. Send only to your own employees, keep the send queue's careful limits (WhatsApp Control), and use a number you can afford to lose access to. The linked phone must stay online, or sending stops until you relink.
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
| A message is stuck on Pending / Sending | The server restarted before recording the outcome; it is marked Failed within 10 minutes (never retried: it may have arrived) |
| Messages stay **Queued** | WhatsApp Control → Overview → send queue: the master switch is off, it is quiet hours, the circuit breaker paused sending (the reason says why), or a limit is reached (`nextSendAt` says when the next one may go). Queued messages that never go out expire at midnight |
| A message is **Expired** | It was too late to be useful (older than its freshness, or from an earlier day). By design it is never sent later |
| A message is **Skipped** | The reason says which: quiet hours, the employee opted out, the employee's daily limit of automatic messages, a duplicate of a message sent in the last 24 h, switched off after it was queued, or cleared by HR |
| A bulk salary-slip send only partly went out | The queue sends at most `max_per_day` messages a day and nothing during quiet hours; the rest expired at midnight. Send again the next day (the response of the bulk send says how many can go that day) |
| No contact card after a visitor message | Contact cards are a separate WAClient call; a failed one shows as its own row ("Visitor Contact Card") with WAClient's reason |

## Tests

`python manage.py test api.tests_whatsapp_dispatcher api.tests_whatsapp_service api.tests_whatsapp_webhook api.tests_otp api.tests_whatsapp_alerts api.tests_whatsapp_control api.tests_whatsapp_approvals api.tests_whatsapp_events api.tests_whatsapp_no_link` -`tests_whatsapp_dispatcher` covers the send queue with a frozen clock (queueing, kinds / priorities / freshness, the gap, hourly and daily caps, codes counting for the gap, quiet hours, today-only expiry, one retry for a temporary failure and none for a rejection, the per-employee cap, the duplicate skip, the circuit breaker, the master switch blocking codes and making the apps fall back to passwords, the opt-out, per-type switches, documents and the visitor contact card, bulk batch progress, the WhatsApp Control queue / settings / opt-out endpoints, the migration's data step and the default wordings); the rest covers the request shape, wording, variables and rendering, every approval workflow (approve, reject, two-stage hand-overs, switches, background delivery, failures that must not break the workflow), gate and visitor messages, punch reminders, phone handling, every failure path, the settings endpoints, that no message or sender carries an Employee Web App link (and that migration 0130 and the renderer clean old wording that did), the webhook parser, OTP security (expiry, single use, attempt limits, purpose separation, redaction), each alert rule and its exemptions, and the WhatsApp Control API. WAClient itself is mocked, and credentials are blanked while tests run, so nothing in the suite sends a real message.

The browser suite (`cd frontend && npx playwright test`) runs the real send path against a **fake WAClient** (`frontend/e2e/fake-waclient.mjs`, port 8190) so `whatsapp-control.spec.ts` can read the code an employee would have received. Codes still arrive at once; a spec that reads a queued message (an approval, a HoD reminder) right after the action needs `WHATSAPP_ASYNC_SEND: "false"` in the e2e backend's environment (`frontend/playwright.config.ts`), or it has to wait for the dispatcher (up to 10 s per message, 30 s apart, and nothing during quiet hours).
