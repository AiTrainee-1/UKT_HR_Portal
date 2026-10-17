# 2Factor SMS OTP Integration - UKTextiles HRMS

The HRMS sends its **one-time codes by SMS through 2Factor.in** instead of WhatsApp when HR switches the channel. That covers the three code messages an employee can ask for: **sign in with a code**, **forgot password**, and **first-time account activation**. Everything else (salary slips, attendance alerts, approvals, visitor and gate messages) keeps going out on WhatsApp through WAClient, exactly as described in `waclient-whatsapp-integration.md`. HR chooses the channel for the codes on the **SMS Control** page (sidebar -> Administration -> SMS Control); the default stays **WhatsApp**, so nothing changes until the 2Factor key is on the server and HR switches.

2Factor is the **only** SMS provider of the HRMS. (An earlier draft used another provider; it was removed completely. There is no provider setting any more.)

> **What was and was not verified.** The call was written against 2Factor's published API documentation (read 2026-10-17, links under *The 2Factor call*) and is covered by automated tests that mock the HTTP call. **No real call has ever been made from this repository to 2Factor.** Items marked *(confirm)* depend on the account or on 2Factor's behaviour: confirm them with the **first test message** and with 2Factor support.

## How it works

```
 Employee (mobile app / web app)        HRMS server (Django)                              2Factor           Employee's phone
        |   asks for a code (Employee Code + purpose)                                          |                    |
        | ----------------------------->  checks: purpose switched on? 2Factor configured and allowed here?
        |                                 employee active with a valid mobile? resend wait over? hourly allowance left?
        |                                 makes a 6-digit code (Python `secrets`), stores ONLY a salted HMAC of it
        |                                 limits: circuit breaker, hourly / daily cap, per-number cap (log row "sent" BEFORE the call)
        |                                 GET https://2factor.in/API/V1/<key>/SMS/+91..../<code>/UKT_HRMS_OTP -->|
        |                                                                                      | -> operator -----> | SMS arrives
        | <-- "We've sent a code by SMS to ••••••3210."                                        |                    |
        | types the 6 digits --------->   verifies (purpose, expiry, single use, at most 5 wrong tries, constant time)
```

- The employee types only the **Employee Code**; the server uses the mobile number HR has on file (answers show the last four digits only).
- The code is generated and verified **by the HRMS**; 2Factor is only the carrier (its own AUTOGEN calls are not used).
- The **previous** code stays valid until the new SMS was really accepted: a failed or blocked send deletes the new code and leaves the old one working. Twelve simultaneous requests for one employee send one SMS (the cooldown check runs under a lock on the employee row).
- No retries: a retry could send the code twice.

### Code map

| File | Role |
|---|---|
| `backend/api/otp_service.py` | Code generation, hashing, expiry, single use, attempts, per-employee limits, the **channel switch**. Shared by WhatsApp and SMS. |
| `backend/api/sms_service.py` | The SMS pipeline: configuration and the placeholder rule, "may this machine send?", number validation, circuit breaker, caps, log row, `send_otp()` / `send_test()`, `temporarily_unavailable()`. |
| `backend/api/twofactor_client.py` | The one HTTP call to 2Factor, timeouts, error classification, **API-key redaction** (the key is in the URL). |
| `backend/api/otp_views.py`, `auth_views.py` | The public endpoints `auth/login-options`, `auth/otp/*`, sign-in (per-address throttled). |
| `backend/api/throttles.py` | The per-address throttle (`@throttle("scope")`) and its 429 shape. |
| `backend/api/sms_control_views.py` | The HR endpoints `/api/sms-control/overview`, `settings`, `messages`, `test`. |
| `backend/api/models/sms.py`, migrations `0123_sms_otp_channel`, `0124_sms_default_caps` | `SmsSettings`, `SmsMessageLog`. |
| `backend/config/settings.py`, `backend/.env.example` | `TWOFACTOR_*`, `SMS_COUNTRY_CODE`, `SMS_ALLOW_SENDING`, `NUM_PROXIES`, `THROTTLE_RELAXED`. |

## Setup, step by step

### Step 1 - 2Factor account, template and key (HR owner)

1. Have an active **2Factor.in** account with SMS balance (panel -> Dashboard).
2. The DLT-approved template is registered in the 2Factor panel (SMS -> Templates):

   | | |
   |---|---|
   | Template name | `UKT_HRMS_OTP` |
   | Sender ID (header) | `UKTHRM` |
   | Text | `XXXX is your UK Textiles HRMS OTP. Official message from UK Textiles. Do not share it with anyone.` |

   2Factor puts the code we pass in the `XXXX` place. The code is 6 digits; the documentation requires 4 to 6 characters but does not say how `XXXX` is filled for other lengths, so **read the first test SMS** *(confirm)*.
3. Copy the **API key** (panel -> API / API Docs). **Treat it like a password.** 2Factor's API carries the key in the web address, which is why this system hides it everywhere (see *Security notes*).

### Step 2 - Put the values on the server (developer)

| Variable | Value | Notes |
|---|---|---|
| `TWOFACTOR_API_KEY` | the API key | Secret. Placeholder `your_2factor_api_key_here` counts as "not set". |
| `TWOFACTOR_TEMPLATE_NAME` | `UKT_HRMS_OTP` | The template **name**, not an id. |
| `TWOFACTOR_SENDER_ID` | `UKTHRM` | Informational (2Factor takes the sender from the template). |
| `TWOFACTOR_API_BASE` | `https://2factor.in/API/V1` | https only (plain http only for a localhost fake server). |
| `SMS_COUNTRY_CODE` | blank = `WHATSAPP_DEFAULT_COUNTRY_CODE` (91) | Numbers are checked against it: Indian numbers must be 10-digit mobiles starting 6-9. |
| `SMS_ALLOW_SENDING` | blank | See the safety rule below. |

- **Locally:** copy the block from `backend/.env.example` into `backend/.env`.
- **Production (Railway):** service -> **Variables** -> add the `TWOFACTOR_*` values -> redeploy. The variables must be on **the server that answers**. **`DEBUG` must be `false` on Railway.**
- A value that still looks like an example (`your_...`, `demo...`, `xxx`, `changeme`, `todo`, `<...>`, `..._here`) counts as **not configured**; the demo values can never cause a send.

**Local machine safety rule.** A development machine (`DEBUG=true`, or `runserver`) **never sends SMS** unless `SMS_ALLOW_SENDING=true` says so; `false` forces it off everywhere. `python manage.py test` blanks the credentials and forces sending off, so the test suite can never send a real SMS.

### Step 3 - Test, then switch (developer + HR owner)

1. Deploy the backend and run `python manage.py migrate` (migrations `0123`, `0124`: two tables, nothing seeded; the channel stays WhatsApp).
2. **SMS Control -> Overview** should show 2Factor set up: Yes and This machine sends: Allowed. If not, **Setup** lists what is missing.
3. **SMS Control -> Test**: type your own mobile number and send. The real template goes out with the dummy code `123456`. Read the SMS: the six digits must appear where `XXXX` is. **Messages** shows the row (Sent, number masked). A test costs a real SMS and counts against the caps; 3 tests an hour per HR user.
4. **SMS Control -> Settings -> Channel -> SMS -> Save**. **The server refuses to select SMS until 2Factor is configured on it** (400 with a sentence listing what is missing; nothing is saved).
5. Ask one employee of each kind to try it (code sign-in, forgot password, activation for a test employee without password). Watch **Messages** for the first day.
6. **Keep password login ON** (WhatsApp Control -> Feature Controls; one switch serves both channels). It is the fallback: if SMS cannot send for the moment (a company cap used up, the breaker paused) the system lets password sign-in through by itself even if it was switched off, and `login-options` keeps saying `passwordLogin: true`.

**Rollback:** SMS Control -> Settings -> Channel -> WhatsApp -> Save. From the next code on, codes go by WhatsApp again with every limit and sentence as before. Codes already sent by SMS stay valid until they expire.

## What employees see

The apps read `otpChannel` from `GET /api/auth/login-options` and `channel` from the request answer and word every screen to match ("Send code by SMS", "Code sent by SMS to ••••••3210. It expires in 5 minutes."). An older server that sends no channel gets neutral wording. An employee without a valid mobile number on file cannot get a code and is told to contact HR. The mobile app needs a new APK and the Employee Web App its own deploy to show the new words; the server change is additive.

## SMS Control (HR page)

`/hr/sms-control` (permission module `sms_control`: **View** reads, **Edit** changes settings and sends tests; a branch login reads its own branch's messages but cannot change settings or send a test). Tabs: **Overview** (checklist, cards, 7-day chart; the balance card says to look in the 2Factor panel because 2Factor documents no balance call), **Settings** (Channel / Limits / Switches), **Messages** (every attempt, never a code or a full number), **Test**, **Setup**. The API key is **never shown, accepted or editable** on the page, only whether it is set. Settings changes and test sends are audited (module `sms_control`, masked number only).

## Limits and protections

All apply to SMS only; with the channel on WhatsApp everything is as it was before.

| Protection | Default | Range | When it trips |
|---|---|---|---|
| Code lifetime | 5 min | 1-15 | the code is "incorrect or expired" |
| Resend cooldown (employee + purpose) | 60 s | 30-600 | 429 with `retryAfterSeconds` |
| Codes per employee per hour | 5 | 1-20 | 429 |
| Wrong tries per code | 5 | 3-10 | the code is dead (429) |
| Codes per phone number per hour (across employee records) | 5 | 1-20 | 429, logged **Blocked** |
| Company hourly cap (rolling hour) | **300** | 1-10000 | 503 "SMS is temporarily unavailable. Please use your password or contact HR."; logged **Blocked** |
| Company daily cap (IST day) | **1500** | 1-10000 | same, until tomorrow (hourly cannot exceed daily; never 0) |
| Circuit breaker | 3 failed sends in 10 min | fixed | SMS paused 10 minutes; password sign-in is open meanwhile. A refused **number** or one odd refusal (`number`, `rejected`) is one employee's problem and does not count. |
| Test messages | 3 per hour per HR user | fixed | 429 |

The caps and the per-number limit count `sent` rows of the log (a send counts from the moment it is attempted; a failed one stops counting), reserved under a lock on the settings row, so they hold across workers and restarts. A refused request writes at most **one `Blocked` row per employee per reason per minute**, so a flood cannot fill the log. **An anonymous caller who knows employee codes can use the company cap up**: that makes codes unavailable for a while but never closes password sign-in (the reason the cap defaults are generous and `temporarily_unavailable()` exists).

**Per-address throttle (flood guard).** `@throttle("scope")` counts requests per client address: HR / gate / reception login **30 a minute** (one shared bucket), employee login and set-password **300 a minute**, ask for a code **300 a minute**, verify a code **600 a minute**, outpass / visitor gate forms **120 a minute**. Generous on purpose: a whole shop floor sits behind one address at shift start; the real cost guards are the per-employee, per-number and company limits. Who the "address" is follows `NUM_PROXIES` (default **1**: the last hop of `X-Forwarded-For`, which Railway's proxy adds, so a caller who rotates the header they write cannot dodge it; set `0` if no proxy sits in front, `2` for two). An answer over the limit is 429 `{ "error": "Too many attempts from this network. Please wait N seconds and try again.", "retryAfterSeconds": N }` with a `Retry-After` header. The counters live in the server process's cache (one gunicorn worker in production). `THROTTLE_RELAXED=true` lifts every rate to 100000 a minute for the isolated end-to-end stack only; **never set it on a real server.** Before this was fixed the throttle names were declared but never applied, so these limits are new behaviour: if a large site is refused in a busy minute, raise `REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]`.

## API contract

Public endpoints (apps; per-address throttled): `GET /api/auth/login-options` -> `{ otpLogin, otpReset, otpActivate, passwordLogin, otpChannel }`; `POST /api/auth/otp/request` `{ employeeCode, purpose }` -> `{ message, maskedPhone, expiresInSeconds, resendAfterSeconds, channel }`; `POST /api/auth/otp/login`, `/otp/reset-password`, `/otp/activate`. Errors are `{ "error": "<sentence>" }` (plus `retryAfterSeconds` for a cooldown or throttle). Hostile input (a non-text code or password, a NUL byte, a body that is not a JSON object) is a clean 400 and never uses up a code. `POST /api/auth/set-password` stays refused for an unauthenticated first-time call while activation codes are ON and SMS is configured and allowed.

HR endpoints (module `sms_control`: GET view, PUT/POST edit): `GET /api/sms-control/overview` -> `{ provider: "twofactor", channel, configured, sendingAllowed, sendingNote, env: { authKey: bool, senderId, templateName, apiBase }, balance: { available: null, checkedAt: null, error }, today, last7Days, lastSentAt, limits: { hourlyCap, dailyCap, hourUsed, dayUsed }, circuit }`; `GET|PUT /api/sms-control/settings` (all-or-nothing, `expectedVersion` stale guard; selecting `sms` while 2Factor is not configured is `400`); `GET /api/sms-control/messages`; `POST /api/sms-control/test` `{ phone }`. None ever returns the key.

## The 2Factor call, as implemented

The **custom-OTP** call is used (we generate and verify the code):

```
GET {TWOFACTOR_API_BASE}/{api_key}/SMS/+{country code + number}/{otp}/{template_name}
    e.g. https://2factor.in/API/V1/<api key>/SMS/+919876543210/482913/UKT_HRMS_OTP
```

- Success: HTTP 200 `{ "Status": "Success", "Details": "<session id>" }` (the session id goes in the log). Refusals: HTTP 400 `{ "Status": "Error", "Details": "Invalid API Key" | "Invalid Phone Number - Length Mismatch(Expected: 10)" | "Invalid OTP Code - Length Mismatch(Expected: 4-6)" }`. The documentation lists no complete error table, so **anything that is not exactly a success is a failure**, classified by words in `Details` (auth, template, balance, number, rate, server error, anything else with 2Factor's own cleaned wording).
- Phone format: international with the country code; the documentation's example is `+919999999999` *(confirm with the first test that 2Factor accepts it; the error text mentions "Expected: 10")*.
- One attempt, **5 s connect / 10 s read** timeouts, redirects not followed, the answer streamed and read up to 20,000 bytes, https only.
- A **read timeout** after the request was sent is a failure (the code is discarded) but the log says "the SMS may still arrive".
- No balance call is documented, so none is made.
- Documentation read: <https://2factor.in/API/DOCS/SMS_OTP.html> and the "2Factor API Documentation" collection <https://documenter.getpostman.com/view/301893/TWDamFGh>.

## Security notes

- **The API key is in the URL path, so it must never leak.** Exceptions from `requests` / `urllib3` embed the URL: every one is caught and re-raised `from None` with our own sentence. `redact()` removes the key (any letter case) and the `/API/V1/<key>/` path segment from anything stored or shown, and a log filter on the urllib3 / requests loggers redacts the DEBUG line `GET /API/V1/<key>/...`. The key is never in a log line, exception text, `sms_message_log.error`, audit row, HTTP answer or the HR page. Tests scan captured logs, errors, rows and answers for it.
- **The code is never stored or logged.** Only a salted HMAC is saved; single use, expiring, bound to purpose and employee, dead after the wrong tries. (Changing `DJANGO_SECRET_KEY` invalidates codes in flight.)
- **A leaked key = rotate it**: generate a new key in the 2Factor panel, update the Railway variable, redeploy, revoke the old one, and look at **Messages** and 2Factor's own report for anything you did not send.
- A stranger can ask for a code for any employee code they know; the cooldown, per-number cap, per-address throttle and company caps bound the annoyance and the cost.
- A development machine never sends; the test suite is blocked from sending.

## Troubleshooting

| Symptom (Test tab or Messages) | Cause and fix |
|---|---|
| "SMS is not set up on this server: TWOFACTOR_API_KEY is empty or still the placeholder value" (or `TWOFACTOR_TEMPLATE_NAME`, `TWOFACTOR_API_BASE ...`) | Not configured on the server that answers. Set it in Railway Variables, restart. |
| "SMS sending is switched off on this machine because it is a development setup" | `DEBUG` on or `runserver`. On Railway set `DEBUG=false`; locally `SMS_ALLOW_SENDING=true` only if you mean to send. |
| "2Factor did not accept the API key..." (`auth`) | Wrong, deleted or mis-pasted key. |
| "2Factor does not accept the template name..." (`template`) | Wrong name, or the template is not approved / not linked to the account. |
| "The 2Factor account has no balance..." (`balance`) | Top up in the 2Factor panel. |
| "2Factor refused the mobile number." (`number`) / "isn't a valid mobile number" | Fix the number on the employee record (`+91...`, `91...`, plain 10 digits all work). Does not trigger the breaker. |
| The SMS arrives with the wrong text or without the code | Template text mismatch, or `XXXX` not filled for this code length: check the template in the panel and read the Test SMS *(confirm)*. |
| Log says Sent, nothing arrives | Accepted is not delivered. Check 2Factor's own delivery report; DND / header category issues are on 2Factor / DLT's side. |
| "Blocked: SMS sending is paused until HH:MM (IST) ..." | Circuit breaker: three provider-side failures in ten minutes. Fix the cause above; it restarts by itself. Employees use their password meanwhile. |
| "Blocked: the hourly / daily limit of N SMS was reached." | Raise the cap in Settings -> Limits if the use is genuine; otherwise look for one caller asking again and again. |
| "2Factor did not answer in time: the SMS may still arrive." | A read timeout: 2Factor had the request. The employee asks again; the previous code stays valid. |
| Saving the SMS channel is refused ("SMS cannot be selected until 2Factor is configured on the server: missing: ...") | Set the variables, restart, check Overview, save again. |
| Employee: "Too many attempts from this network. Please wait N seconds and try again." | The per-address throttle. If normal use hits it, raise the rate in `settings.py` and check `NUM_PROXIES`. |

## Deploy notes

- Backend: `migrate` (0123, 0124), set the `TWOFACTOR_*` variables, keep `DEBUG=false`, confirm `NUM_PROXIES` matches the proxies in front of Django (Railway: 1), keep `THROTTLE_RELAXED` unset.
- Frontend: Employee Web App deploys separately (Vercel); the mobile app needs a new APK for the new wording. Old apps keep working during the switch.
- Rolling back the code is safe: the migrations only add tables and change defaults.

## Tests

`python manage.py test api.tests_twofactor api.tests_sms_otp api.tests_sms_control api.tests_otp api.tests_throttles` covers the client (request shape, every failure, key never leaking through exceptions, logs, rows, answers), the send pipeline (caps, per-number cap, breaker, bounded blocked rows, concurrency), the channel switch and the "never lock everybody out" matrix, the SMS Control API and the throttles. 2Factor itself is mocked and credentials are blanked while tests run, so nothing sends a real SMS.
