# 2Factor SMS OTP Integration - UKTextiles HRMS

The HRMS can send its **one-time codes by SMS through 2Factor.in**: **sign in with a code**, **forgot password** and **first-time account activation**. **SMS is used for these codes only** - no notification, document, bulk or promotional SMS exists in the code (`sms_service.send_otp` is the only send, and a test proves no other module calls the 2Factor client). Every other message goes by WhatsApp through the Meta WhatsApp Cloud API (`whatsapp-meta-cloud-integration.md`).

**SMS codes and WhatsApp codes are independent (2026-11-20).** SMS codes have their own master switch on **SMS Control -> Settings -> OTP Switches** (default OFF), WhatsApp codes theirs on **WhatsApp Control -> OTP**. Either one alone is enough; with both on, the apps let the employee choose ("Send code by WhatsApp" / "Send code by SMS") and offer the other way after sending. Neither needs the other to be configured. The old single "channel" setting (`SmsSettings.otp_channel`) is no longer read; migration `0169` set `otp_enabled` from it.

2Factor is the **only** SMS provider of the HRMS. (An earlier draft used another provider; it was removed completely. There is no provider setting any more.)

> **What was and was not verified.** The call was written against 2Factor's published API documentation (read 2026-10-17, links under *The 2Factor call*) and is covered by automated tests that mock the HTTP call. **No real call has ever been made from this repository to 2Factor.** Items marked *(confirm)* depend on the account or on 2Factor's behaviour: confirm them with the **first test message** and with 2Factor support.

## How it works

```
 Employee (mobile app / web app)        HRMS server (Django)                              2Factor           Employee's phone
        |   asks for a code (Employee Code + purpose)                                          |                    |
        | ----------------------------->  checks: purpose switched on? 2Factor configured and allowed here?
        |                                 employee active with a valid mobile? resend wait over? hourly allowance left?
        |                                 makes a 4-digit code (Python `secrets`), stores ONLY a salted HMAC of it
        |                                 limits: circuit breaker, hourly / daily cap, per-number cap (log row "sent" BEFORE the call)
        |                                 GET https://2factor.in/API/V1/<key>/SMS/+91..../<code>/UKT_HRMS_OTP -->|
        |                                                                                      | -> operator -----> | SMS arrives
        | <-- "We've sent a code by SMS to ••••••3210."                                        |                    |
        | types the 4 digits --------->   verifies (purpose, expiry, single use, at most 5 wrong tries, constant time)
```

- The employee types only the **Employee Code**; the server uses the mobile number HR has on file (answers show the last four digits only).
- The code is generated and verified **by the HRMS**; 2Factor is only the carrier (its own AUTOGEN calls are not used).
- The **previous** code stays valid until the new SMS was really accepted: a failed or blocked send deletes the new code and leaves the old one working. Twelve simultaneous requests for one employee send one SMS (the cooldown check runs under a lock on the employee row).
- No retries: a retry could send the code twice.

### Code map

| File | Role |
|---|---|
| `backend/api/otp_service.py` | Code generation, hashing, expiry, single use, attempts, per-employee limits, **which channels are available for each purpose** (`available_channels`, `channel_status`). Shared by WhatsApp and SMS; each channel has its own expiry, cooldown and limits. |
| `backend/api/sms_service.py` | The SMS pipeline: configuration and the placeholder rule, "may this machine send?" (incl. the `SMS_ONLY_TO_EMPLOYEES` development lock), number validation, circuit breaker, caps, log row, `send_otp()` (the only send: 4-6 digits, a known purpose) / `send_test()`, `balance()` (cached 5 minutes), `temporarily_unavailable()`. |
| `backend/api/twofactor_client.py` | The HTTP calls to 2Factor (the OTP send and the read-only balance `/{key}/BAL/SMS`), timeouts, error classification, **API-key redaction** (the key is in the URL). |
| `backend/api/otp_views.py`, `auth_views.py` | The public endpoints `auth/login-options`, `auth/otp/*`, sign-in (per-address throttled). |
| `backend/api/throttles.py` | The per-address throttle (`@throttle("scope")`) and its 429 shape. |
| `backend/api/sms_control_views.py` | The HR endpoints `/api/sms-control/overview`, `usage`, `settings`, `messages`, `test`. |
| `backend/api/models/sms.py`, migrations `0123_sms_otp_channel`, `0124_sms_default_caps`, `0169_meta_cloud_independent_otp` | `SmsSettings` (`otp_enabled`, `price_per_sms`, `monthly_budget` since 0169), `SmsMessageLog`; `EmployeeOtp.channel`. |
| `backend/config/settings.py`, `backend/.env.example` | `TWOFACTOR_*`, `SMS_COUNTRY_CODE`, `SMS_ALLOW_SENDING`, `SMS_ONLY_TO_EMPLOYEES`, `NUM_PROXIES`, `THROTTLE_RELAXED`. |

## Setup, step by step

### Step 1 - 2Factor account, template and key (HR owner)

1. Have an active **2Factor.in** account with SMS balance (panel -> Dashboard).
2. The DLT-approved template is registered in the 2Factor panel (SMS -> Templates):

   | | |
   |---|---|
   | Template name | `UKT_HRMS_OTP` |
   | Sender ID (header) | `UKTHRM` |
   | Text | `XXXX is your UK Textiles HRMS OTP. Official message from UK Textiles. Do not share it with anyone.` |

   2Factor puts the code we pass in the `XXXX` place. The SMS code is **4 digits**, exactly the `XXXX` of the template (the documentation allows 4 to 6 characters, but 6-digit codes were not delivered as SMS through this template). The WhatsApp code keeps its 6 digits; the length lives in one place, `otp_service.CODE_LENGTH` (`sms` 4, `whatsapp` 6). Four digits are only 10 000 combinations, so the SMS channel is held tighter than WhatsApp; see *Why 4 digits are still safe enough* below. Still **read the first test SMS** to confirm the digits appear where `XXXX` is *(confirm)*.
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
| `SMS_ONLY_TO_EMPLOYEES` | local only, e.g. `30020` | Employee codes a development machine may text (like `WHATSAPP_ONLY_TO_EMPLOYEES`). Required on a development machine that is allowed to send: with no list it sends nothing. A refused number is logged **Blocked** (`dev_lock`). Ignored in production; never set it on Railway. |

- **Locally:** copy the block from `backend/.env.example` into `backend/.env`.
- **Production (Railway):** service -> **Variables** -> add the `TWOFACTOR_*` values -> redeploy. The variables must be on **the server that answers**. **`DEBUG` must be `false` on Railway.**
- A value that still looks like an example (`your_...`, `demo...`, `xxx`, `changeme`, `todo`, `<...>`, `..._here`) counts as **not configured**; the demo values can never cause a send.

**Local machine safety rule.** A development machine (`DEBUG=true`, or `runserver`) **never sends SMS** unless `SMS_ALLOW_SENDING=true` says so, and then only to the employees named in `SMS_ONLY_TO_EMPLOYEES`; `false` forces it off everywhere. `python manage.py test` blanks the credentials and the list and forces sending off, so the test suite can never send a real SMS.

### Step 3 - Test, then switch SMS codes on (developer + HR owner)

1. Deploy the backend and run `python manage.py migrate` (`0123`, `0124`, `0169`: additive; SMS codes stay as they were).
2. **SMS Control -> Overview** should show 2Factor set up: Yes and This machine sends: Allowed. If not, **Setup** lists what is missing.
3. **SMS Control -> Test**: choose an employee (their registered number) or type your own mobile number and send. The real template goes out with the dummy code `1234`. Read the SMS: the four digits must appear where `XXXX` is. **Messages** shows the row (Sent, number masked). A test costs a real SMS and counts against the caps; 3 tests an hour per HR user.
4. **SMS Control -> Settings -> OTP Switches -> SMS codes ON -> Save** (the page asks to confirm). **The server refuses to switch SMS codes on until 2Factor is configured on it** (400 with a sentence; nothing is saved). The three purpose switches below it choose what SMS codes are offered for. WhatsApp codes are not touched.
5. Ask one employee of each kind to try it (code sign-in, forgot password, activation for a test employee without password). Watch **Messages** for the first day.
6. **Keep password login ON** (WhatsApp Control -> OTP; one switch serves both channels). It is the fallback: if SMS cannot send for the moment (a company cap used up, the breaker paused) the system lets password sign-in through by itself even if it was switched off, and `login-options` keeps saying `passwordLogin: true`. The same holds while 2Factor's ACCOUNT refuses (a refused key, no balance, a refused template: `sms_service.account_problem`), and that lasts until an SMS really goes out again, not only for the breaker's 10 minutes; such a failure also reopens the first-time password setup (a cap or the breaker never does: anybody can use a cap up).

**Rollback:** SMS Control -> Settings -> OTP Switches -> SMS codes OFF -> Save. From the next code on no SMS is sent and the apps stop offering SMS (they re-read the options whenever a screen opens or the app comes back to the front); if WhatsApp codes are on, employees keep getting codes there, else they sign in with their password. Codes already sent by SMS stay valid until they expire.

## What employees see

The apps read `otpChannels` (per purpose, WhatsApp first) and `channels` (`codeLength` 4 for SMS, 6 for WhatsApp) from `GET /api/auth/login-options` (never cached; re-read when a screen gains focus and when the app returns to the foreground), and `channel`, `codeLength` and `otherChannels` from the request answer. One channel available: it is used automatically. Both: the employee picks, the last pick is remembered on the device, and "Didn't get it? Send by SMS instead" appears after sending. Older app builds read only `otpChannel` / `codeLength` (the first channel) and send no channel, which still works; they size the code box, the "Enter the N-digit code" check and the hint from `codeLength` (an older server sends none: SMS 4, WhatsApp 6, unknown 6), and word every screen to match ("Send code by SMS", "Code sent by SMS to ••••••3210. It expires in 5 minutes."). An older server that sends no channel gets neutral wording. An employee without a valid mobile number on file cannot get a code and is told to contact HR. The mobile app needs a new APK and the Employee Web App its own deploy to show the new words and the 4-digit box; the server change is additive. An app build from before the 4-digit change only knows 6-digit codes: it cannot sign in with an SMS code until it is updated (WhatsApp codes still work in it).

## SMS Control (HR page)

`/hr/sms-control` (permission module `sms_control`: **View** reads, **Edit** changes settings and sends tests; a branch login reads its own branch's messages but cannot change settings or send a test). Tabs (in the address, `/hr/sms-control/<tab>`): **Overview** (status: SMS codes on / 2Factor set up / this server sends / paused; the 2Factor balance, read with the balance call and cached 5 minutes; this month's sent, failed, blocked, used codes, delivery and used rates; cost so far against the budget with the projection; today against the caps; alerts), **Usage & Cost** (month picker, daily chart, by purpose, cost), **Settings** (OTP Switches / Limits / Cost: price per SMS, default ₹0.20, and a monthly budget; the old `settings/channel` address opens OTP Switches), **Messages** (every attempt, never a code or a full number), **Test** (a test code to an employee or a number; no free text), **Setup** (the variables by name, the template and sender, the voice-call note). The API key is **never shown, accepted or editable** on the page, only whether it is set. Settings changes and test sends are audited (module `sms_control`, masked number only).

## Limits and protections

All apply to SMS only; WhatsApp codes keep their own limits. A cap or the breaker pauses SMS (the request fails with the sentence below) but SMS stays listed in `login-options`, and WhatsApp codes keep working for the same employee.

| Protection | Default | Range | When it trips |
|---|---|---|---|
| Code lifetime | 5 min | 1-15 | the code is "incorrect or expired" |
| Resend cooldown (employee + purpose, SMS codes only) | 60 s | 30-600 | 429 with `retryAfterSeconds` |
| Codes per employee per hour | 5 | 1-20 | 429 |
| Wrong tries per code | 5 | 3-5 (a larger value saved earlier acts as 5) | the code is dead (429) |
| Codes per employee and purpose in 24 hours | **10** | fixed | 429 "Too many codes requested today" (SMS only: 4-digit codes are easy to guess, see below) |
| Codes per phone number per hour (across employee records) | 5 | 1-20 | 429, logged **Blocked** |
| Company hourly cap (rolling hour) | **300** | 1-10000 | 503 "SMS is temporarily unavailable. Please use your password or contact HR."; logged **Blocked** |
| Company daily cap (IST day) | **1500** | 1-10000 | same, until tomorrow (hourly cannot exceed daily; never 0) |
| Circuit breaker | 3 failed sends in 10 min | fixed | SMS paused 10 minutes; password sign-in is open meanwhile. A refused **number** or one odd refusal (`number`, `rejected`) is one employee's problem and does not count. |
| Test messages | 3 per hour per HR user | fixed | 429 |

The caps and the per-number limit count `sent` rows of the log (a send counts from the moment it is attempted; a failed one stops counting), reserved under a lock on the settings row, so they hold across workers and restarts. A refused request writes at most **one `Blocked` row per employee per reason per minute**, so a flood cannot fill the log. **An anonymous caller who knows employee codes can use the company cap up**: that makes codes unavailable for a while but never closes password sign-in (the reason the cap defaults are generous and `temporarily_unavailable()` exists).

**Per-address throttle (flood guard).** `@throttle("scope")` counts requests per client address: HR / gate / reception login **30 a minute** (one shared bucket), employee login and set-password **300 a minute**, ask for a code **300 a minute**, verify a code **600 a minute**, outpass / visitor gate forms **120 a minute**. Generous on purpose: a whole shop floor sits behind one address at shift start; the real cost guards are the per-employee, per-number and company limits. Who the "address" is follows `NUM_PROXIES` (default **1**: the last hop of `X-Forwarded-For`, which Railway's proxy adds, so a caller who rotates the header they write cannot dodge it; set `0` if no proxy sits in front, `2` for two). An answer over the limit is 429 `{ "error": "Too many attempts from this network. Please wait N seconds and try again.", "retryAfterSeconds": N }` with a `Retry-After` header. The counters live in the server process's cache (one gunicorn worker in production). `THROTTLE_RELAXED=true` lifts every rate to 100000 a minute for the isolated end-to-end stack only; **never set it on a real server.** Before this was fixed the throttle names were declared but never applied, so these limits are new behaviour: if a large site is refused in a busy minute, raise `REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]`.

## API contract

Public endpoints (apps; per-address throttled): `GET /api/auth/login-options` -> `{ otpLogin, otpReset, otpActivate, passwordLogin, otpChannel, codeLength, otpChannels: {login, reset, activate}, channels: {whatsapp?, sms?} }`; `POST /api/auth/otp/request` `{ employeeCode, purpose, channel? }` -> `{ message, maskedPhone, expiresInSeconds, resendAfterSeconds, channel, codeLength, otherChannels }` (a channel that is not available: 400 `{ code: "channel_unavailable", availableChannels }`); `POST /api/auth/otp/login`, `/otp/reset-password`, `/otp/activate`. Errors are `{ "error": "<sentence>" }` (plus `retryAfterSeconds` for a cooldown or throttle). Hostile input (a non-text code or password, a NUL byte, a body that is not a JSON object) is a clean 400 and never uses up a code. `POST /api/auth/set-password` stays refused for an unauthenticated first-time call while activation codes are ON and SMS is configured and allowed.

HR endpoints (module `sms_control`: GET view, PUT/PATCH/POST edit): `GET /api/sms-control/overview` (status, balance, month, cost, alerts, today, limits, circuit), `GET /api/sms-control/usage?month=YYYY-MM`, `GET|PUT|PATCH /api/sms-control/settings` (all-or-nothing, `expectedVersion` stale guard; `otpEnabled`, `pricePerSms`, `monthlyBudget`; `otpChannel` is refused with 400; switching `otpEnabled` on while 2Factor is not configured is 400), `GET /api/sms-control/messages`, `POST /api/sms-control/test` `{ employeeCode | employeeId | phone }`. Full shapes: `api-database-reference.md`. None ever returns the key.

## The 2Factor call, as implemented

The **custom-OTP** call is used (we generate and verify the code):

```
GET {TWOFACTOR_API_BASE}/{api_key}/SMS/+{country code + number}/{otp}/{template_name}
    e.g. https://2factor.in/API/V1/<api key>/SMS/+919876543210/4829/UKT_HRMS_OTP
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
- **Why 4 digits are still safe enough.** A 4-digit code is only 10 000 combinations, so what limits a guesser is how many guesses fit in a day, not the code's size: **5 wrong tries per code** (the sixth is refused and the code is dead, even for the right number), a code is **single use** and lives **5 minutes**, a new code (a resend) always replaces the old one and starts with fresh tries, and the number of codes one employee can ask for per purpose is **1 a minute (cooldown), 5 an hour and 10 in 24 hours**. So at most 5 x 5 = 25 guesses an hour and 5 x 10 = **50 guesses a day** against one account and purpose: 0.5 % of the code space (per-address throttles and the company SMS caps limit the spread across employees: at the default 300 SMS an hour the whole company is open to at most 1 500 guesses an hour, spread over at least 300 codes). The code row records its length (`EmployeeOtp.code_length`) so a code issued before HR switches the channel still verifies with the length it was issued with. WhatsApp codes keep 6 digits and their old limits.
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
| Switching SMS codes on is refused (2Factor is not configured on the server) | Set the variables, restart, check Overview, save again. |
| A development machine refuses every number ("not on the development list", `dev_lock`) | `SMS_ONLY_TO_EMPLOYEES` names who this machine may text; it is empty or does not include that employee. |
| The employee gets a phone call instead of an SMS | 2Factor may voice-deliver a code (its own fallback); nothing in the HRMS can change it: ask 2Factor support. |
| Employee: "Too many attempts from this network. Please wait N seconds and try again." | The per-address throttle. If normal use hits it, raise the rate in `settings.py` and check `NUM_PROXIES`. |

## Deploy notes

- Backend: `migrate` (0123, 0124, 0169), set the `TWOFACTOR_*` variables (never `SMS_ONLY_TO_EMPLOYEES` on Railway), keep `DEBUG=false`, confirm `NUM_PROXIES` matches the proxies in front of Django (Railway: 1), keep `THROTTLE_RELAXED` unset.
- Frontend: Employee Web App deploys separately (Vercel); the mobile app needs a new APK (or OTA update) for the WhatsApp / SMS choice. Old apps keep working (they read `otpChannel` / `codeLength` and send no channel).
- Rolling back the code is safe: the migrations only add tables and change defaults.

## Tests

`python manage.py test api.tests_twofactor api.tests_sms_otp api.tests_sms_control api.tests_otp api.tests_otp_channels api.tests_throttles` covers the channel independence matrix (only WhatsApp, only SMS, both, neither, mixed per purpose, the `channel` parameter, old clients, per-channel limits, the lockout rules), the development lock, the balance and the usage figures, and the client (request shape, every failure, key never leaking through exceptions, logs, rows, answers), the send pipeline (caps, per-number cap, breaker, bounded blocked rows, concurrency), the "never lock everybody out" matrix, the SMS Control API and the throttles. 2Factor itself is mocked and credentials are blanked while tests run, so nothing sends a real SMS.
