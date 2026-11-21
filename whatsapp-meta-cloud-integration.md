# WhatsApp in UK Textiles HRMS: the Meta WhatsApp Cloud API integration (as built)

Built 2026-11-20. Every WhatsApp message the HRMS sends goes through Meta's official **WhatsApp Cloud API** (the Graph API),
as a **message template Meta has approved**. The earlier unofficial WhatsApp Web link (and its variables, endpoints, QR /
instance screens, wording editor and e2e fake) is removed. This file describes what the code does. Where each value comes
from in Meta (business verification, the developer app, the number, the system-user token, the webhook settings) is in
`whatsappintegrationsetup.md` (Steps 1-8, 11-12). SMS one-time codes are in `twofactor-sms-otp-integration.md`.

---

## 1. The pieces

| File (backend/api/) | What it does |
|---|---|
| `whatsapp_cloud.py` | The Graph API client and nothing else: `send_template`, `send_auth_code`, `upload_media`, `list_templates` (follows the paging cursor), `create_template`, `delete_template`, `phone_number_info`, `pricing_analytics`; `is_configured()`, `missing_env()`, `env_status()`; `MetaApiError(code, message, temporary, http_status)` with plain-words `friendly` text; `verify_signature()` (HMAC-SHA256, constant-time) and `verify_token_matches()`; `sanitize_param()` (one line, at most 300 characters, empty becomes `-`). The token and app secret are scrubbed from every error, answer and log line. |
| `whatsapp_catalog.py` | Every HRMS message type: label, module, variables with samples, its HRMS wording, and its Meta template (`meta_template`: `""` = `hrms_<key>`, `"-"` = never sent through Meta), `meta_header` (`""` / `document` / `image`), `meta_category` (`UTILITY` / `AUTHENTICATION`). |
| `whatsapp_service.py` | The HRMS side: which template a type goes out as (`template_name_for`, `template_for` -> name, language, status, category, header, variables, problem), `deliver_template` / `deliver_code`, the machine rules (`sending_allowed`, the local-only `WHATSAPP_ONLY_TO_EMPLOYEES` lock), opt-outs, caps, `queue_to_recipient`, `phone_status()` (cached 5 minutes). |
| `whatsapp_dispatcher.py` | The paced send queue (min gap, hourly / daily / per-employee caps, quiet hours, end-of-day expiry, circuit breaker), unchanged in behaviour except as described in section 4. |
| `whatsapp_templates.py` | Templates on WhatsApp Control: drafts from the catalog wording, Meta's rules (validation with field messages), create + submit (document / image headers get a sample file through Meta's Resumable Upload API), create-missing, sync, delete, which types use which template. |
| `whatsapp_usage.py` | This month's counts, cost (rates, GST, projection, budget), Meta's own pricing analytics (cached 10 minutes), and the Overview's alerts. |
| `whatsapp_views.py` | The webhook (`/api/whatsapp/webhook/`). |
| `whatsapp_control_views.py`, `whatsapp_test_views.py` | The WhatsApp Control API (section 6). |
| `otp_service.py` | One-time codes: WhatsApp and SMS are independent channels (section 7). |

Callers (approvals, notifications, alerts, Department Head messages, HoD reminders, Attendance Notify, salary slips, offer /
experience / resignation letters, ID cards, employee documents, gate and visitor messages) pass **named, single-line
variables** of their type; `whatsapp_format.one_line()` / `flat()` flatten anything multi-line (the HoD reminder's pending
list is `Leave 2, Permission 1`).

Database (migration `0169_meta_cloud_independent_otp`, additive): `WhatsAppSettings.otp_enabled`, `template_overrides`,
`price_rates`, `monthly_budget`, `last_webhook_at`; `WhatsAppMessageLog.template_name`, `pricing_category`, `billable`,
`delivered_at`, `read_at`; the new `WhatsAppTemplate` table (`whatsapp_meta_template`, the local mirror of Meta's templates,
unique on name + language); `SmsSettings.otp_enabled`, `price_per_sms`, `monthly_budget`; `EmployeeOtp.channel`. The old
`WhatsAppMessageTemplate` wording table and `SmsSettings.otp_channel` are kept but no longer read.

## 2. Environment variables

`.env` locally, Railway Variables in production. Never stored in the database, never returned by an endpoint (WhatsApp
Control -> Settings shows only whether each one is set), never logged. Blank `ACCESS_TOKEN` / `APP_SECRET` /
`WEBHOOK_VERIFY_TOKEN` / `APP_ID` under `manage.py test`.

| Variable | Required | Meaning |
|---|---|---|
| `WHATSAPP_CLOUD_PHONE_NUMBER_ID` | yes | the sending number's id |
| `WHATSAPP_CLOUD_BUSINESS_ACCOUNT_ID` | yes | the WhatsApp Business Account (WABA) id: templates, pricing |
| `WHATSAPP_CLOUD_ACCESS_TOKEN` | yes (secret) | the permanent system-user token |
| `WHATSAPP_CLOUD_APP_SECRET` | for the webhook (secret) | checks `X-Hub-Signature-256` |
| `WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN` | for the webhook (secret) | answers Meta's one-time verification |
| `WHATSAPP_CLOUD_API_VERSION` | no, `v23.0` | Graph API version |
| `WHATSAPP_CLOUD_TEMPLATE_LANGUAGE` | no, `en` | the templates' language |
| `WHATSAPP_CLOUD_APP_ID` | no | the Meta app, for the sample upload of a document / image template (blank: asked from Meta) |
| `WHATSAPP_CLOUD_API_BASE` | no | `https://graph.facebook.com`; the e2e stack points it at its local fake (plain http only for a local address) |
| `WHATSAPP_DEFAULT_COUNTRY_CODE` | no, `91` | prefixed to a 10-digit employee number |
| `WHATSAPP_ALLOW_SENDING` | no | blank = automatic: a real server sends, a development machine (DEBUG / runserver) never does |
| `WHATSAPP_ONLY_TO_EMPLOYEES` | local only | employee codes a development machine may message (e.g. `30020`); ignored in production |
| `WHATSAPP_ASYNC_SEND` | no | `false` sends at once instead of through the background worker (the e2e stack) |

Configured = phone number id, WABA id and token are all set. Retired 2026-11-20 and read by nothing: the old provider's
variables and `WHATSAPP_WEBHOOK_TOKEN` (delete them from Railway when you deploy; `whatsappintegrationsetup.md` Step 11 lists
the names).

## 3. Templates

Every type goes out as its template: HR's override (`WhatsAppSettings.template_overrides[type]`) else the catalog default.

| Templates | Header | Category |
|---|---|---|
| `hrms_salary_slip`, `hrms_offer_letter`, `hrms_experience_letter`, `hrms_resignation_letter`, `hrms_document` | document (PDF) | UTILITY |
| `hrms_id_card` | image | UTILITY |
| `hrms_otp` (sign-in, password reset and activation codes share it) | - | AUTHENTICATION (copy-code button) |
| `hrms_absent_alert`, `hrms_late_alert`, `hrms_punch_reminder`, `hrms_on_duty_punch_reminder`, `hrms_missing_punch_alert`, `hrms_attendance_report` | - | UTILITY |
| `hrms_approval_approved`, `hrms_approval_rejected`, `hrms_hod_request_waiting`, `hrms_hod_pending_reminder` | - | UTILITY |
| `hrms_geo_approval`, `hrms_geo_rejection`, `hrms_geo_punch_approval`, `hrms_geo_punch_rejection` | - | UTILITY |
| `hrms_visitor_at_reception` (the visitor's phone is one of its variables), `hrms_gate_out`, `hrms_gate_in` | - | UTILITY |

Not sent through Meta: the visitor **contact card** (a template can't carry one) and **WhatsApp groups** (Attendance Notify
refuses to save an automation with groups and skips a group an older automation still lists, with the reason).

**On WhatsApp Control -> Templates** HR can: Sync now (pull every template from Meta, upsert by name + language, mark the ones
Meta no longer has as DELETED); create a template from an HRMS message type (the draft is the catalog wording with named
`{{variables}}`, the `- UK Textiles HR` sign-off moved to the footer, a line that is only a variable becomes `Note: {{x}}`,
examples from the catalog samples; editable, with a live WhatsApp preview) or from scratch; **Create all missing** (one draft
per switched-on type without an approved / pending template; a shared one such as `hrms_otp` once); delete (at Meta and here,
after a confirmation). Meta's rules are checked before submitting (lowercase name, no variable at the start or end, every
variable has an example, footer at most 60 characters, body at most 1024, no MARKETING) and Meta's own refusal comes back
readable. A REJECTED template is edited and resubmitted under its Meta id. The code template is Meta's AUTHENTICATION shape
(security line, expiry from the OTP settings, Copy code button). New wording for a type that already has an approved template
(a new name, e.g. `hrms_otp_v2`) does not take over at once: the type keeps going out as its approved template until Meta
approves the new one (webhook or Sync now), so a rejection or a day in review never stops it. A type without an approved
template moves onto the new one at once.

A type whose template is missing or not APPROVED is **skipped with a reason** (never a failure, never a queue pause); the
Overview lists it under "templates missing" and Message Controls offers "Create template" next to it.

## 4. Sending

- **Body:** `{messaging_product: "whatsapp", to: "91XXXXXXXXXX", type: "template", template: {name, language, components}}`
  with named body parameters (`parameter_name`), each sanitised to one line; a code goes as Meta's authentication template
  (the code in the body and in the copy-code button).
- **Documents and the ID card:** the bytes wait in `WhatsAppMediaAsset` until their turn in the queue, are uploaded to Meta
  (`/{phone-number-id}/media`) and sent in the template's header; the media id is kept for a retry.
- **The log row** stores the template name and the rendered template text (a code's text with the code masked).
- **Errors:** an account-level error (190 token, 368 / 131048 spam limits, 131031 / 131042 / 131057 / 133010 account or
  payment) pauses the queue at once with plain words. A refusal of a single message (131026 not on WhatsApp, 131047, 131049,
  132xxx template mismatch) is logged as "Refused by WhatsApp: ..." and never counts towards the 3-failure pause, so a few
  employees without WhatsApp can't stop everyone's messages. 130429 / 131056 / 5xx / timeouts are retried.
- **Unchanged:** pacing, caps, quiet hours (codes still go), end-of-day expiry, opt-out, the per-type switches and the
  development lock (the last check before any call to Meta, uploads included).

## 5. The webhook

Callback URL `https://<backend>/api/whatsapp/webhook/` (WhatsApp Control -> Settings shows it to copy into the Meta app);
subscribe the `messages`, `message_template_status_update`, `message_template_quality_update`, `phone_number_quality_update`
fields.

- `GET` with `hub.mode=subscribe` and the right `hub.verify_token` answers `hub.challenge` as text; anything else 403.
- `POST` needs a valid `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with the app secret), else 403 and nothing is read.
  Every valid POST stamps `WhatsAppSettings.last_webhook_at` and answers 200.
- **Statuses** (`sent`, `delivered`, `read`, `failed`) update the log row by its wamid with timestamps, Meta's pricing
  (category, billable) and the error; a status never moves backwards.
- **Inbound** `STOP` (any case) from an employee's registered number opts out every employee record on that number
  (`WhatsAppOptOut`, reason "Replied STOP"). The text of inbound messages is never stored or logged.
- **Template status / quality / category** events update (or create) the `WhatsAppTemplate` row. `REINSTATED` (Meta lifted a
  pause) makes it APPROVED again, `UNARCHIVED` brings back an archived one; `FLAGGED` and `LOCKED` change no status (a flag
  shows as low quality). A template first seen in an event gets the category of the HRMS type sent as it (`hrms_otp` is
  AUTHENTICATION), so a code always goes out the copy-code way; Sync now fills in its text. A template made for a type whose
  review ends APPROVED takes over that type.
- Changes for **another WhatsApp Business Account** (`entry[].id` is not `WHATSAPP_CLOUD_BUSINESS_ACCOUNT_ID`) or another
  number (`metadata.phone_number_id` is not `WHATSAPP_CLOUD_PHONE_NUMBER_ID`) are ignored: one Meta app may be subscribed
  to a test account too. Also subscribe `template_category_update` if Meta offers it.

## 6. WhatsApp Control (/hr/whatsapp-control)

Tabs (permission keys `whatsapp_control.<tab>`, `?tab=`): **Overview** (the number, verified name, quality, messaging tier,
status, webhook last seen; this month's sent / delivered / read / failed; cost so far against the budget with the projection;
alerts such as not configured, token refused, queue paused, templates missing / rejected / pending, quality, tier, OTP
template, budget), **Usage & Cost** (month picker, daily chart by pricing category, by type, cost with and without 18% GST,
projection, Meta's own figures when available, the rates used), **Message Controls** (the engine master, module masters and a
switch for every message type with its template and status and this month's count, limits and quiet hours, the queue),
**Templates** (section 3), **OTP** (WhatsApp codes master, sign-in / reset / activation switches, expiry, the `hrms_otp`
status; SMS codes are set on SMS Control), **Messages** (delivery ticks, template, pricing category, billable, filters),
**Employees** (opt-outs), **Send a test** (a type to an employee: a preview of the template and its variables, then a real
send with Meta's answer; free text is refused), **Settings** (the variable checklist by name, the webhook URL, verify token /
app secret set, API version, price per category, monthly budget, the development lock).

API (`/api/whatsapp-control/...`, HR login, module `whatsapp_control`, non-GET needs Edit): `overview`, `usage?month=YYYY-MM`,
`settings` (GET / PATCH / PUT; `otpEnabled`, `templateOverrides`, `priceRates`, `monthlyBudget` besides the switches and
limits; GET also has `messageTypes {type: {templateName, switches}}`: each type's resolved template and the switches it
needs; a PATCH needs Edit on the TAB of every value it changes: OTP for the code switches / expiry / password sign-in,
Settings for prices and budget, Templates or Message Controls for `templateOverrides`, Message Controls for the rest, else
403 `permission_denied` with `tabs`), `messages`, `employees`, `employees/<id>/opt-out`, `queue`, `queue/clear`, `connection`, `test-message`,
`meta-templates` (GET / POST), `meta-templates/sync`, `meta-templates/create-missing`, `meta-templates/draft/<type>`,
`meta-templates/<id>` (DELETE). Shapes: `api-database-reference.md`.

**Prices** (defaults, editable on Settings): ₹ per delivered billable message before 18% GST: authentication 0.1150, utility
0.1150, marketing 0.8631, service 0. A message is counted under Meta's pricing category from the webhook, else its template's,
else its catalog category; billable from the webhook, else every sent message of a non-service category. A message sent
before the switch to Meta (no template name, no Meta pricing) is counted but never charged. Projection = month-to-date cost /
elapsed days x days in the month (the current month only).

## 7. One-time codes: WhatsApp and SMS are independent

A channel is offered for a purpose when its master switch is on (WhatsApp Control -> OTP / SMS Control -> OTP Switches), its
purpose switch is on, it can deliver here (WhatsApp: configured, engine on, `hrms_otp` APPROVED; SMS: 2Factor set up and
allowed to send) - either alone is enough, and with both on the apps let the employee choose. `GET /api/auth/login-options`
(no cache) keeps the old `otpChannel` / `codeLength` for old app builds and adds `otpChannels {login, reset, activate}` and
`channels {whatsapp: {codeLength 6}, sms: {codeLength 4}}`. `POST /api/auth/otp/request` takes an optional `channel`; an
unavailable one is a 400 `channel_unavailable` with `availableChannels`. Each channel has its own expiry, cooldown and limits;
a new code on either channel kills the earlier unused codes of that purpose. WhatsApp codes have limits of their own (they
cost money): 10 per employee and purpose a day, 10 an hour to one number, 300 an hour and 1,500 a day in all (Django
settings `WHATSAPP_OTP_MAX_PER_DAY`, `WHATSAPP_OTP_MAX_PER_NUMBER_PER_HOUR`, `WHATSAPP_OTP_HOURLY_CAP`,
`WHATSAPP_OTP_DAILY_CAP` override them; no page edits them yet).

**Nobody is locked out.** A channel that is set up but cannot send is *on hold*: WhatsApp while Meta's account pause or the
3-failure breaker holds or a global code limit is used up; SMS while its breaker holds or a cap is used up; and either one
while its provider ACCOUNT refuses (WhatsApp 190 / 368 / 131031 / 131042 / 131048 / 131057 / 133010, SMS a refused key, no
balance or a refused template) until a message really goes out again. Password sign-in can be refused only while a channel
is available for sign-in and not on hold. A code request on hold gets 503 with a plain sentence (WhatsApp: nothing reaches
Meta), and a request that names no channel (an older app) goes to the channel that is not on hold; `otpChannel` /
`codeLength` follow. The open first-password setup comes back only for an ACCOUNT failure, never for a limit or a breaker
(anybody can use a limit up). WhatsApp Control's Overview shows an `otp_paused` alert and the OTP tab the reason and the
limits. The mobile app and the Employee Web App re-read the options when a
screen gains focus or the app returns to the foreground.

## 8. Testing

- **Backend** (Meta is never reached): `tests_whatsapp_cloud`, `_service`, `_webhook`, `_test_send`, `_dispatcher`,
  `_no_link`, `_templates`, `_usage`, `_control`, `_callers`, `_alerts`, `_approvals`, `_events`, `_hod`,
  `tests_hod_reminders`, `tests_attendance_notify`, `tests_push_*`, `tests_otp`, `tests_otp_channels`, `tests_sms_otp`,
  `tests_sms_control`, `tests_twofactor`, `tests_throttles`. `tests_whatsapp_support.FakeMeta.install(self)` patches
  `api.whatsapp_cloud.requests` and records what was sent; `approve_templates()` makes APPROVED rows; `META` / `NO_META` are the
  settings overrides.
- **e2e** (`frontend/e2e`): `fake-meta.mjs` on 127.0.0.1:8190 stands in for the Graph API (messages, media, templates incl.
  the Resumable Upload, phone, pricing; `GET /messages` gives the specs what an employee would have received, a code in the
  copy-code `button`); `seed_e2e` submits every type's template to it through the real create path, so everything is APPROVED
  as on a live server. `whatsapp-control.spec.ts`, `sms-control.spec.ts`, `auth.spec.ts`, `hod-reminders.spec.ts`.
- **Local real test:** `WHATSAPP_ALLOW_SENDING=true` plus `WHATSAPP_ONLY_TO_EMPLOYEES=<your employee code>` in `backend/.env`,
  then WhatsApp Control -> Send a test (`whatsappintegrationsetup.md` Step 10).

## 9. Going live

1. Deploy the backend (migration 0169 is additive) and the HR portal; build a new APK and deploy the Employee Web App for the
   code-channel choice (old builds keep working on `otpChannel` / `codeLength`).
2. Railway Variables: add the `WHATSAPP_CLOUD_*` values, delete the old provider's variables, never set
   `WHATSAPP_ONLY_TO_EMPLOYEES` there.
3. Meta app: webhook URL + verify token, subscribe the fields.
4. WhatsApp Control -> Templates -> Sync now, then **Create all missing**; wait for APPROVED (minutes to 24 hours). Until a
   type's template is approved its messages are skipped with a reason; WhatsApp codes are offered only once `hrms_otp` is.
5. Settings tab all green, then Send a test to yourself and watch it turn delivered and read.
