# Meta WhatsApp Cloud API: complete migration guide for UK Textiles HRMS

Moving the HRMS's WhatsApp messages from WAClient (an unofficial WhatsApp Web link) to Meta's official **WhatsApp Cloud API**.

Written 2026-11-18 for this codebase (Django backend in `backend/`, React HR portal in `frontend/`, Railway deployment, API at
`https://api.uktextiles.in`). Meta changes its screens and limits from time to time: where a step says "check the dashboard",
trust what Meta shows you over this file.

---

## Contents

0. [Read this first: what changes when you leave WAClient](#0-read-this-first-what-changes-when-you-leave-waclient)
1. [Choose the phone number](#1-choose-the-phone-number)
2. [What you need before you start](#2-what-you-need-before-you-start)
3. [Step 1: Meta Business portfolio](#step-1-meta-business-portfolio)
4. [Step 2: Business verification](#step-2-business-verification)
5. [Step 3: Create the Meta developer app](#step-3-create-the-meta-developer-app)
6. [Step 4: Add and register the production phone number](#step-4-add-and-register-the-production-phone-number)
7. [Step 5: Payment method](#step-5-payment-method)
8. [Step 6: Permanent access token (System User)](#step-6-permanent-access-token-system-user)
9. [Step 7: Message templates](#step-7-message-templates)
10. [Step 8: Webhook](#step-8-webhook)
11. [Step 9: Django backend integration](#step-9-django-backend-integration)
12. [Step 10: Local testing](#step-10-local-testing)
13. [Step 11: Production deployment (Railway)](#step-11-production-deployment-railway)
14. [Step 12: Go-live checklist and rollback](#step-12-go-live-checklist-and-rollback)
15. [Running it: limits, quality, pricing, consent](#running-it-limits-quality-pricing-consent)
16. [Troubleshooting: error codes](#troubleshooting-error-codes)
17. [Appendix: environment variables, curl cheat sheet, glossary, links](#appendix)

---

## 0. Read this first: what changes when you leave WAClient

WAClient sent any text to anyone from a phone logged in to WhatsApp Web. That is exactly what WhatsApp restricts. The Cloud API
is the official channel: no restrictions for automation, but it has rules the HRMS must follow.

| Topic | WAClient (today) | Meta Cloud API |
|---|---|---|
| What you may send first | Any text, any time | **Only pre-approved message templates.** Free text is allowed only within 24 hours after the employee last messaged *you* (the "customer service window"). Almost every HRMS message is business-initiated, so **every message type needs an approved template**. |
| Editing the wording | HR edits freely on WhatsApp Control → Message Text | Wording lives in Meta. A change means submitting a new template (or an edited one) and waiting for Meta's approval (usually minutes, up to 24 h). Only the **variables** change per message. |
| Variables | `{{employee_name}}` etc. anywhere, multi-line values | Same idea, but a variable's value **may not contain new lines, tabs or more than 4 spaces in a row**, and the template text has length limits (body up to 1024 characters). |
| One-time codes (login, reset, activation) | Plain text | A special **Authentication** template with Meta's fixed wording ("123456 is your verification code.") and a copy-code button. |
| Documents (salary slip, ID card, letters) | Text + PDF link WAClient downloads | A template with a **document (or image) header**. The file is uploaded to Meta first (or given as a public HTTPS link). |
| WhatsApp groups (Attendance Notify) | Supported (`chat_id …@g.us`) | **Not supported** for sending into your existing groups. Send to individual numbers instead. |
| Contact card (visitor) | Supported any time | Allowed only inside the 24 h window. Put the visitor's number in the template text instead. |
| Delivery / read status | Undocumented webhook | Documented webhook: `sent`, `delivered`, `read`, `failed` with an error code. |
| Sender identity | A personal-style number | A business number with a **display name** Meta approves (for example "UK Textiles HR"). |
| Volume | Unlimited until the number got restricted | **Messaging limit** per business portfolio: starts at **250 different people per 24 hours**, then 2,000 → 10,000 → 100,000 → unlimited as quality stays good (details in [Running it](#running-it-limits-quality-pricing-consent)). |
| Cost | WAClient subscription | **Meta charges per template message** (utility / authentication / marketing rates per country). Messages inside an open 24 h window are cheaper or free depending on the current pricing. |
| Restrictions | Number restricted for "automated behaviour" | Official automation. Meta watches **quality** (blocks and reports by recipients); bad quality pauses templates or lowers limits, it does not ban the number for being automated. |

**Bottom line for the HRMS:** the send queue, the switches, the logs, the Department Head messages and the local test lock all
stay. What changes is (1) the provider call (Graph API instead of WAClient), (2) each message type maps to an approved template,
(3) the webhook format, (4) documents are uploaded to Meta, (5) one-time codes use an Authentication template, (6) groups and
contact cards are dropped or replaced.

---

## 1. Choose the phone number

1. **Use a new, dedicated number.** The current WAClient number (…5110) has been restricted. A number restricted or banned on
   WhatsApp may be refused when you register it on the Cloud API, and even if accepted it starts with a poor history. A fresh
   number avoids that.
2. The number **must not be active on WhatsApp** (the normal app or the WhatsApp Business app) when you register it. If it is,
   delete that WhatsApp account first: WhatsApp → Settings → Account → Delete account. (Meta also offers "coexistence" for
   WhatsApp Business app numbers through some providers; it does not apply to a restricted number, so ignore it here.)
3. It must be able to receive an **SMS or a voice call** once, for the verification code. A landline works (choose voice call).
4. It should be a number you will keep for years: employees will save it, and changing it later means re-registering.
5. Write down: the number in international form (`91XXXXXXXXXX`), who holds the SIM, and where it is kept.

---

## 2. What you need before you start

- [ ] A personal **Facebook account** for each person who will administer this (use real accounts with two-factor authentication on).
- [ ] The company's legal documents for **business verification** (India): GST certificate, Certificate of Incorporation / Udyam
      registration, PAN, a utility bill or bank statement showing the business address. The legal name and address must match
      what you enter in Meta.
- [ ] A **website on the company domain** (for example `uktextiles.in`) with a **privacy policy page**. Meta needs the privacy
      policy URL for the app, and the domain for verification.
- [ ] Access to the domain's **DNS** (to add a TXT record for domain verification), or to the website's HTML.
- [ ] A **company email address** on that domain (for example `hr@uktextiles.in`).
- [ ] A **payment card** (credit/debit card accepted by Meta) for message charges.
- [ ] The **new phone number** (section 1).
- [ ] The backend reachable on **public HTTPS**: `https://api.uktextiles.in` (needed for the webhook).
- [ ] Access to **Railway Variables** for the backend service.
- [ ] Time: business verification usually takes **1 to 5 working days**; display-name review about **1 to 2 days**; template
      reviews **minutes to 24 hours**. Start Steps 1–4 first and build the code (Step 9) while you wait.

---

## Step 1: Meta Business portfolio

The "Business portfolio" (formerly Business Manager) owns the WhatsApp account, the phone number, the app and the billing.

1. Go to **https://business.facebook.com** and sign in with the main administrator's Facebook account.
2. If the company already has a portfolio (for example for a Facebook page), use it. Otherwise click **Create a business
   portfolio**: enter the **legal business name** (exactly as on the GST certificate), your name and the company email.
3. Open **Settings** (gear icon) → **Business info** and fill in: legal name, address, phone, website (`https://uktextiles.in`).
4. **Settings → People → Add**: add a second administrator (so the company never loses access if one person leaves). Give both
   **Full control**.
5. Turn on **two-factor authentication** for everyone: Settings → Security Center → Two-factor authentication → *Everyone*.

---

## Step 2: Business verification

Verification raises the messaging limit above 250 people per day, allows the display name to be approved normally, and is needed
for most real use. Do it now; it runs in parallel with the rest.

1. **Verify the domain first** (it speeds up verification): Settings → Brand safety → **Domains** → Add `uktextiles.in` →
   choose **DNS TXT record**, add the TXT record at your DNS provider, wait a few minutes, click **Verify**.
2. Settings → **Security Center** → **Start verification** (if the button is not there yet, it appears after you create the
   WhatsApp app in Step 3; come back then).
3. Enter the legal name, address, phone and website exactly as on the documents.
4. Upload the documents (GST certificate and Certificate of Incorporation / Udyam work well; add a utility bill if asked for
   address proof).
5. Choose how Meta contacts you to confirm (email on the domain is the fastest).
6. Wait for the result (email + Security Center shows **Verified**). If it is rejected, the email says why (usually a name or
   address mismatch); fix and resubmit.

---

## Step 3: Create the Meta developer app

The app is what the HRMS uses to call the Graph API.

1. Go to **https://developers.facebook.com** → **My Apps** → **Create app**.
2. Use case: **Other** → app type **Business** (or the "Connect with customers through WhatsApp" use case if it is offered).
3. App name: `UK Textiles HRMS`. Contact email: the company email. **Business portfolio:** choose the one from Step 1.
4. In the app dashboard, find **WhatsApp** → **Set up**. Choose the business portfolio again when asked. Meta creates:
   - a **WhatsApp Business Account (WABA)**,
   - a free **test phone number** (it can message up to 5 numbers you add as "allowed recipients"),
   - a **temporary access token** (valid 24 hours).
5. Open **WhatsApp → API Setup** and write down:
   - **Phone number ID** (of the test number for now; the production number gets its own ID in Step 4),
   - **WhatsApp Business Account ID** (WABA ID),
   - the **API version** shown in the sample request (for example `v23.0`). Use that version in the backend.
6. In **App settings → Basic**: note the **App ID** and click **Show** next to **App secret** (needed to check webhook signatures).
   Fill in **Privacy Policy URL** (`https://uktextiles.in/privacy`), **App icon**, **Category** (Business and Pages), then
   **Save changes**.
7. **Quick test with the test number** (proves the account works before any code):
   - API Setup → **To** → **Manage phone number list** → add employee 30020's number → enter the code WhatsApp sends to it.
   - Click **Send message** (it sends the built-in `hello_world` template), or run:

```bash
curl -X POST "https://graph.facebook.com/v23.0/<TEST_PHONE_NUMBER_ID>/messages" \
  -H "Authorization: Bearer <TEMPORARY_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"messaging_product":"whatsapp","to":"91XXXXXXXXXX","type":"template",
       "template":{"name":"hello_world","language":{"code":"en_US"}}}'
```

   The answer contains `"messages":[{"id":"wamid...."}]` and the phone receives "Hello World".
8. **Publish the app** when Step 4 is done: top of the dashboard → switch **App mode** from Development to **Live**. Production
   webhooks for the real number need the app to be Live.

---

## Step 4: Add and register the production phone number

1. Open **WhatsApp Manager**: https://business.facebook.com/wa/manage → choose the WhatsApp account → **Phone numbers** →
   **Add phone number**.
2. **Display name**: the name employees see, for example **UK Textiles HR**. Rules: it must clearly relate to your business
   (match the business name or a brand on your website), no generic words alone, no all-caps, no emojis. It is reviewed by Meta.
3. **Category**: Professional services (or the closest). Add a description and the website.
4. Enter the **new number** (section 1), choose **Text message** (mobile) or **Phone call** (landline), enter the 6-digit code.
5. The number now appears with its own **Phone number ID**. Copy it: this is the production `WHATSAPP_CLOUD_PHONE_NUMBER_ID`.
6. **Two-step verification PIN**: WhatsApp Manager → the number → **Settings → Two-step verification** → set a 6-digit PIN and
   store it in the company password manager. It protects the number from being registered elsewhere.
7. **Register the number for the Cloud API** (if WhatsApp Manager shows the status *Pending* or *Not registered*):

```bash
curl -X POST "https://graph.facebook.com/v23.0/<PHONE_NUMBER_ID>/register" \
  -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
  -d '{"messaging_product":"whatsapp","pin":"<YOUR_6_DIGIT_PIN>"}'
```

   `{"success": true}` means it is ready.
8. Check its state at any time:

```bash
curl "https://graph.facebook.com/v23.0/<PHONE_NUMBER_ID>?fields=display_phone_number,verified_name,name_status,quality_rating,code_verification_status,platform_type,throughput" \
  -H "Authorization: Bearer <TOKEN>"
```

   You want `name_status` approved, `platform_type` `CLOUD_API`, `quality_rating` `GREEN`.
9. Optional: business profile (photo = company logo, about text, address, email, website) under the number's **Profile** tab.
   Employees see it when they open the chat.

---

## Step 5: Payment method

Template messages are charged by Meta, so a payment method is required before the production number can send them.

1. WhatsApp Manager → **Overview** (or Business settings → **Billing & payments** → **WhatsApp Business accounts**).
2. **Add payment method** → choose the currency (**INR** if offered; it cannot be changed later), add the card, and the
   **GST number** in the tax section so invoices carry it.
3. Set a **spending alert** (Billing → Payment settings) so a sudden jump in messages is noticed.

---

## Step 6: Permanent access token (System User)

The temporary token from Step 3 expires in 24 hours. Production needs a token that does not expire, owned by a "system user"
(not a person), so it keeps working when staff change.

1. https://business.facebook.com → **Settings → Users → System users** → **Add**. Name: `uktextiles-hrms-api`. Role: **Admin**.
2. Select it → **Assign assets**:
   - **Apps** → `UK Textiles HRMS` → **Full control** (Manage app),
   - **WhatsApp accounts** → your WABA → **Full control**.
3. **Generate new token** → app `UK Textiles HRMS` → **Token expiration: Never** → permissions:
   - `whatsapp_business_messaging` (send messages),
   - `whatsapp_business_management` (templates, phone numbers, webhooks subscription).
4. Copy the token **once** into the company password manager. It becomes `WHATSAPP_CLOUD_ACCESS_TOKEN`. Never put it in git,
   chat, email or the database.
5. Confirm it works:

```bash
curl "https://graph.facebook.com/v23.0/<WABA_ID>/phone_numbers" -H "Authorization: Bearer <SYSTEM_USER_TOKEN>"
```

6. **Rotation:** if the token ever leaks, generate a new one here, update Railway, then revoke the old one (System users →
   the user → token → Revoke).

---

## Step 7: Message templates

Every message the HRMS starts must be an approved template. This is the biggest piece of work: plan the list, submit, then map
each HRMS message type to its template in the backend.

### 7.1 Rules that matter for the HRMS

- **Category:** use **UTILITY** for everything about a specific employee's own work (attendance, approvals, documents, gate,
  HOD reminders); **AUTHENTICATION** for one-time codes. Never MARKETING (more expensive, stricter limits). Meta may re-classify a
  template if the wording looks promotional: keep the text factual.
- **Name:** lowercase letters, numbers and underscores, for example `hrms_hod_request_waiting`. Use the HRMS message-type key
  after an `hrms_` prefix so the mapping stays obvious.
- **Language:** pick one and use it everywhere, for example `en` (English). The code sends that exact code; `en` and `en_US` are
  different templates to Meta.
- **Variables:** use **named** parameters (`"parameter_format": "named"`) with the same names the HRMS already uses
  (`{{employee_name}}`, `{{date}}` …). Names: lowercase and underscores. Every variable needs an **example** value at submission.
- **Variable values:** no new lines, no tabs, no more than 4 spaces in a row, keep each short. Multi-line content (the pending
  list of an HOD reminder, an attendance report) must be flattened, for example `Leave 2, Permission 1`.
- **A template may not start or end with a variable**, and needs enough fixed text around variables (Meta rejects templates that
  are mostly variables).
- **Optional lines:** WAClient dropped a line whose variables were empty ("Note: …"). Templates cannot drop lines. Send a dash
  (`-`) or `None` for an empty value, or make a second template without that line.
- **Sign-off:** a footer of up to 60 characters can hold `UK Textiles HR`.

### 7.2 The template list for UK Textiles HRMS

Submit these (wording below is a proposal; keep it close to the current HRMS wording so employees see the same messages).
Priority order: **Department Head messages first** (the current priority), then approvals and attendance, then documents.

| HRMS message type (catalog key) | Template name | Category | Header | Variables (named) |
|---|---|---|---|---|
| `hod_request_waiting` | `hrms_hod_request_waiting` | Utility | — | hod_name, employee_name, employee_code, request_type, date, details |
| `hod_pending_reminder` | `hrms_hod_pending_reminder` | Utility | — | hod_name, total, pending_list, date |
| `approval_approved` | `hrms_approval_approved` | Utility | — | employee_name, request_type, date, details, approver, comment |
| `approval_rejected` | `hrms_approval_rejected` | Utility | — | employee_name, request_type, date, details, approver, comment |
| `absent_alert` | `hrms_absent_alert` | Utility | — | employee_name, date, shift_start, cutoff_time |
| `late_alert` | `hrms_late_alert` | Utility | — | employee_name, date, shift_start, first_punch, late_by |
| `four_punch_alert` | `hrms_punch_reminder` | Utility | — | employee_name, punch_name, expected_time, minutes_left |
| `on_duty_punch_reminder` | `hrms_on_duty_punch_reminder` | Utility | — | employee_name, destination, punch_name, expected_time, minutes_left |
| `missing_punch_alert` | `hrms_missing_punch_alert` | Utility | — | employee_name, punch_name, expected_time, date |
| `geo_approval` | `hrms_geo_approval` | Utility | — | employee_name, destination, requested_on, approved_by, comment |
| `geo_rejection` | `hrms_geo_rejection` | Utility | — | employee_name, destination, requested_on, rejected_by, comment |
| `geo_punch_approval` | `hrms_geo_punch_approval` | Utility | — | employee_name, punch_name, date, time, approved_by |
| `geo_punch_rejection` | `hrms_geo_punch_rejection` | Utility | — | employee_name, punch_name, date, time, rejected_by, comment |
| `visitor_notification` | `hrms_visitor_at_reception` | Utility | — | employee_name, visitor_name, company, purpose, visitor_phone, visit_time |
| `outpass_gate_out` | `hrms_gate_out` | Utility | — | employee_name, pass_type, date, gate_out_time, destination, gate_name |
| `outpass_gate_in` | `hrms_gate_in` | Utility | — | employee_name, date, gate_in_time, duration, gate_name |
| `salary_slip` | `hrms_salary_slip` | Utility | **Document** | employee_name, month_year |
| `id_card` | `hrms_id_card` | Utility | **Image** | employee_name |
| `offer_letter` | `hrms_offer_letter` | Utility | Document | employee_name, designation |
| `experience_letter` | `hrms_experience_letter` | Utility | Document | employee_name |
| `resignation_letter` | `hrms_resignation_letter` | Utility | Document | employee_name, last_working_day |
| `other` (document) | `hrms_document` | Utility | Document | employee_name, document_category |
| `attendance_report` | `hrms_attendance_report` | Utility | — | report_title, date, summary (one line: `Absent 4, CL 2, On Leave 1`) |
| `otp_login`, `otp_reset`, `otp_activate` | `hrms_otp` (one template for all three) | **Authentication** | — | the code (Meta's fixed text) |
| `visitor_contact` | *(none)* | — | — | Dropped: the visitor's phone is in `hrms_visitor_at_reception` instead |

**Example bodies for the two Department Head templates** (submit these first):

`hrms_hod_request_waiting`
```
Dear {{hod_name}},
{{employee_name}} ({{employee_code}}) has a {{request_type}} request waiting for your approval.
Date: {{date}}
Request: {{details}}
Please review it in the UK Textiles app under Approvals.
```
Footer: `UK Textiles HR`

`hrms_hod_pending_reminder`
```
Dear {{hod_name}},
You have {{total}} request(s) waiting for your approval as of {{date}}: {{pending_list}}.
Kindly review and approve them in the UK Textiles app at the earliest.
```
Footer: `UK Textiles HR`

Note: today the Notify reminder's text is written freely on Requests → Notify. With templates, that free text cannot be sent as is
(it is multi-line and not approved). The reminder keeps its schedule and its recipients; its WhatsApp wording becomes this
template, and `pending_list` is the categories on one line (`Leave 2, Permission 1`).

**Authentication template (`hrms_otp`)**: in WhatsApp Manager choose category *Authentication* → *Copy code*. Meta writes the text
itself ("*{{1}}* is your verification code."); you can add the security disclaimer and an expiry ("This code expires in 5
minutes"). You cannot add your own sentences.

### 7.3 Submitting templates

**Option A, WhatsApp Manager (easiest for the first few):** WhatsApp Manager → **Message templates** → **Create template** →
category, name, language → type the header/body/footer → add an example for each variable → **Submit**.

**Option B, the API (repeatable, good for all 25):**

```bash
curl -X POST "https://graph.facebook.com/v23.0/<WABA_ID>/message_templates" \
  -H "Authorization: Bearer <SYSTEM_USER_TOKEN>" -H "Content-Type: application/json" \
  -d '{
    "name": "hrms_hod_request_waiting",
    "language": "en",
    "category": "UTILITY",
    "parameter_format": "named",
    "components": [
      {
        "type": "BODY",
        "text": "Dear {{hod_name}},\n{{employee_name}} ({{employee_code}}) has a {{request_type}} request waiting for your approval.\nDate: {{date}}\nRequest: {{details}}\nPlease review it in the UK Textiles app under Approvals.",
        "example": {
          "body_text_named_params": [
            {"param_name": "hod_name", "example": "Suresh Kumar"},
            {"param_name": "employee_name", "example": "Asha Kumar"},
            {"param_name": "employee_code", "example": "30012"},
            {"param_name": "request_type", "example": "Leave"},
            {"param_name": "date", "example": "26 Sep 2026 to 27 Sep 2026"},
            {"param_name": "details", "example": "Sick Leave - 2 days"}
          ]
        }
      },
      {"type": "FOOTER", "text": "UK Textiles HR"}
    ]
  }'
```

A **document header** template adds `{"type":"HEADER","format":"DOCUMENT","example":{"header_handle":["<handle>"]}}`, where the
handle comes from Meta's *Resumable Upload API* (upload a sample PDF once). Creating document-header templates in WhatsApp Manager
is simpler: it lets you upload the sample file in the form.

### 7.4 After submission

- Status goes **PENDING → APPROVED** (or REJECTED with a reason). Check: WhatsApp Manager → Message templates, or
  `GET /<WABA_ID>/message_templates?fields=name,status,category,language,quality_score`.
- **Rejected?** Common reasons: variables at the start/end, too little fixed text, wording that looks promotional, a variable
  example that does not fit. Edit and resubmit.
- An approved template can be **paused** (low quality) or **disabled**; the webhook tells you (Step 8).
- Editing an approved template sends it back to review. You can edit a given template only a limited number of times per day /
  month; plan wording before submitting.

---

## Step 8: Webhook

The webhook tells the HRMS what happened to each message (`sent`, `delivered`, `read`, `failed`) and about template and quality
changes. The HRMS already has the route `/api/whatsapp/webhook/`; it must be rewritten for Meta's format (Step 9.6).

### 8.1 How Meta's webhook works

- **Verification (once):** Meta calls `GET https://api.uktextiles.in/api/whatsapp/webhook/?hub.mode=subscribe&hub.verify_token=<YOUR_VERIFY_TOKEN>&hub.challenge=<NUMBER>`.
  The backend must check `hub.verify_token` equals your secret `WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN` and answer **200 with the
  `hub.challenge` value as plain text**.
- **Events:** Meta sends `POST` with a JSON body and the header `X-Hub-Signature-256: sha256=<hex>`, which is the HMAC-SHA256 of
  the **raw request body** keyed with the **App secret**. The backend must check it (reject with 403 if wrong) and answer **200
  quickly** (Meta retries non-200 answers for a while).

### 8.2 Configure it in Meta

1. Choose the verify token: a long random string (for example `python -c "import secrets; print(secrets.token_urlsafe(32))"`).
   It becomes `WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN` on Railway.
2. Deploy the backend with the new webhook code first (Step 11), otherwise verification fails.
3. developers.facebook.com → your app → **WhatsApp → Configuration** → **Webhook** → **Edit**:
   - Callback URL: `https://api.uktextiles.in/api/whatsapp/webhook/`
   - Verify token: the same string → **Verify and save**.
4. **Webhook fields → Manage** → subscribe to:
   - `messages` (delivery/read/failed statuses **and** messages employees send to the number),
   - `message_template_status_update` (approved / rejected / paused / disabled),
   - `message_template_quality_update`,
   - `phone_number_quality_update` (quality rating and messaging-limit changes),
   - `account_update` (bans, restrictions, verification changes).
5. **Subscribe your app to the WhatsApp account** (otherwise no events arrive for the production number):

```bash
curl -X POST "https://graph.facebook.com/v23.0/<WABA_ID>/subscribed_apps" -H "Authorization: Bearer <SYSTEM_USER_TOKEN>"
```

6. Test: on the Configuration page, next to `messages`, click **Test** → the backend log should show a received webhook.

### 8.3 What the events look like

Status update (one message delivered):

```json
{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "<WABA_ID>",
    "changes": [{
      "field": "messages",
      "value": {
        "messaging_product": "whatsapp",
        "metadata": {"display_phone_number": "91XXXXXXXXXX", "phone_number_id": "<PHONE_NUMBER_ID>"},
        "statuses": [{
          "id": "wamid.HBgM...",
          "status": "delivered",
          "timestamp": "1763452800",
          "recipient_id": "919876543210",
          "pricing": {"billable": true, "category": "utility"}
        }]
      }
    }]
  }]
}
```

A failed message has `"status": "failed"` and `"errors": [{"code": 131026, "title": "Message undeliverable", ...}]`.

An employee replying (opens the 24 h window; also how an employee can ask to stop):

```json
"messages": [{"from": "919876543210", "id": "wamid...", "timestamp": "...", "type": "text", "text": {"body": "STOP"}}]
```

---

## Step 9: Django backend integration

Everything below is a change to this codebase. File names are the current ones. The design keeps the HRMS layers intact: the
modules call `whatsapp_service.send_notification()` / `send_document()` exactly as today, the queue (`whatsapp_dispatcher.py`)
paces and logs as today, and only the provider underneath changes.

### 9.1 Environment variables (settings)

Add to `backend/config/settings.py` (read from the environment, `.env` locally, Railway Variables in production; never stored in
the database, never shown in the portal):

```python
# Meta WhatsApp Cloud API
WHATSAPP_PROVIDER = os.environ.get("WHATSAPP_PROVIDER", "waclient").strip().lower()  # "meta" after the migration
WHATSAPP_CLOUD_API_VERSION = os.environ.get("WHATSAPP_CLOUD_API_VERSION", "v23.0").strip()
WHATSAPP_CLOUD_PHONE_NUMBER_ID = os.environ.get("WHATSAPP_CLOUD_PHONE_NUMBER_ID", "").strip()
WHATSAPP_CLOUD_BUSINESS_ACCOUNT_ID = os.environ.get("WHATSAPP_CLOUD_BUSINESS_ACCOUNT_ID", "").strip()
WHATSAPP_CLOUD_ACCESS_TOKEN = os.environ.get("WHATSAPP_CLOUD_ACCESS_TOKEN", "").strip()
WHATSAPP_CLOUD_APP_SECRET = os.environ.get("WHATSAPP_CLOUD_APP_SECRET", "").strip()
WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN = os.environ.get("WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN", "").strip()
WHATSAPP_CLOUD_TEMPLATE_LANGUAGE = os.environ.get("WHATSAPP_CLOUD_TEMPLATE_LANGUAGE", "en").strip()
if len(sys.argv) > 1 and sys.argv[1] == "test":  # tests never reach Meta (same rule as WACLIENT_*)
    WHATSAPP_CLOUD_ACCESS_TOKEN = ""
```

`has_credentials()` in `whatsapp_service.py` then checks the variables of the chosen provider. The existing machine rules stay as
they are: `WHATSAPP_ALLOW_SENDING` and the local-only `WHATSAPP_ONLY_TO_EMPLOYEES` lock (applies only under `manage.py runserver`).

### 9.2 New module `backend/api/whatsapp_cloud.py` (the Graph API client)

One small module that knows Meta and nothing about the HRMS:

```python
"""Meta WhatsApp Cloud API client: send a template, upload media, read the phone number's state."""

import requests
from django.conf import settings as s

class CloudError(Exception):
    def __init__(self, message, code=None, temporary=False, http_status=None, response=None):
        super().__init__(message)
        self.code, self.temporary, self.http_status, self.response = code, temporary, http_status, response

TEMPORARY_CODES = {1, 2, 4, 130429, 131000, 131016, 131056, 133004}       # retry once later
ACCOUNT_CODES = {190, 368, 131031, 131042, 131057, 133010}                  # the whole account cannot send: pause the queue

def _url(path):
    return f"https://graph.facebook.com/{s.WHATSAPP_CLOUD_API_VERSION}/{path}"

def _headers():
    return {"Authorization": f"Bearer {s.WHATSAPP_CLOUD_ACCESS_TOKEN}"}

def _raise_for(resp):
    try:
        data = resp.json()
    except ValueError:
        data = {}
    if resp.ok and "error" not in data:
        return data
    err = data.get("error") or {}
    code = err.get("code")
    detail = (err.get("error_data") or {}).get("details") or err.get("message") or f"HTTP {resp.status_code}"
    raise CloudError(
        f"Send failed: {detail} (code {code})",
        code=code,
        temporary=resp.status_code >= 500 or code in TEMPORARY_CODES,
        http_status=resp.status_code,
        response=data,
    )

def send_template(to, name, language, body_params=None, header=None, button_params=None):
    """to: '91XXXXXXXXXX'. body_params: {name: value} (named template). header: {'type': 'document', 'document': {...}}."""
    components = []
    if header:
        components.append({"type": "header", "parameters": [header]})
    if body_params:
        components.append({"type": "body", "parameters": [
            {"type": "text", "parameter_name": k, "text": _clean(v)} for k, v in body_params.items()]})
    for index, value in (button_params or {}).items():
        components.append({"type": "button", "sub_type": "url", "index": str(index),
                           "parameters": [{"type": "text", "text": value}]})
    body = {"messaging_product": "whatsapp", "to": to, "type": "template",
            "template": {"name": name, "language": {"code": language}, "components": components}}
    resp = requests.post(_url(f"{s.WHATSAPP_CLOUD_PHONE_NUMBER_ID}/messages"), json=body, headers=_headers(), timeout=(5, 20))
    data = _raise_for(resp)
    return data["messages"][0]["id"]  # the wamid: what the webhook refers to

def _clean(value):
    """A template variable: one line, no tabs, no long runs of spaces, never empty."""
    text = " ".join(str(value or "").split())
    return text[:1000] or "-"

def upload_media(content: bytes, filename: str, mime_type: str) -> str:
    resp = requests.post(_url(f"{s.WHATSAPP_CLOUD_PHONE_NUMBER_ID}/media"), headers=_headers(),
                         data={"messaging_product": "whatsapp", "type": mime_type},
                         files={"file": (filename, content, mime_type)}, timeout=(5, 60))
    return _raise_for(resp)["id"]  # a media id, valid for 30 days

def phone_number_status() -> dict:
    fields = "display_phone_number,verified_name,name_status,quality_rating,platform_type,throughput"
    resp = requests.get(_url(s.WHATSAPP_CLOUD_PHONE_NUMBER_ID), params={"fields": fields}, headers=_headers(), timeout=(5, 15))
    return _raise_for(resp)
```

(The original Meta integration of this project, before Gupshup and WAClient, is still in git history: `git show 29533f4` /
`git show eca404c`, search for `graph.facebook.com`. Useful for reference; the module above is the one to build.)

### 9.3 Each HRMS message type gets its template

In `backend/api/whatsapp_catalog.py`, add to `MessageType` two fields and fill them per type:

```python
    meta_template: str = ""        # e.g. "hrms_hod_request_waiting"; "" = this type is not sent by Meta (dropped)
    meta_header: str = ""          # "" | "document" | "image"
```

The variable names of each catalog type are already the template's named parameters (`variable_names`), so the backend sends
`{name: value}` for exactly the variables the template has. For the HOD reminder, `hod_reminders.py` sends `pending_list` as
one line built from `by_category` (`Leave 2, Permission 1`) instead of the free multi-line text.

### 9.4 Change the provider call in `backend/api/whatsapp_service.py`

Today `_post_send()` posts to WAClient. Keep its contract (raise `WhatsAppServiceError(message, temporary, http_status,
provider_response)`; return something with the provider message id) and branch on the provider:

```python
def _send_via_meta(to_phone, document_type, params, media=None):
    spec = catalog.get(document_type)
    if not spec or not spec.meta_template:
        raise WhatsAppServiceError(f"'{document_type}' has no WhatsApp template (Meta): not sent.")
    refused = recipient_block_reason(to_phone)  # the local-only test lock stays the last line of defence
    if refused:
        raise WhatsAppServiceError(refused)
    values = _values(params, spec.variable_names)
    body = {name: values.get(name, "") for name in spec.variable_names}
    header = None
    if media and spec.meta_header:
        media_id = whatsapp_cloud.upload_media(media["content"], media["filename"], media["mime_type"])
        header = {"type": spec.meta_header, spec.meta_header: {"id": media_id, **({"filename": media["filename"]} if spec.meta_header == "document" else {})}}
    try:
        wamid = whatsapp_cloud.send_template(to_phone, spec.meta_template, dj_settings.WHATSAPP_CLOUD_TEMPLATE_LANGUAGE, body, header)
    except whatsapp_cloud.CloudError as exc:
        raise WhatsAppServiceError(str(exc), temporary=exc.temporary, http_status=exc.http_status, provider_response=exc.response)
    return {"status": "success", "message_payload": {"key": {"id": wamid}}}  # what _provider_message_id() already reads
```

Points to change around it:

- **Queue rows keep the variables, not just the text.** Today a queued row stores the rendered `message_text`. Meta needs the
  variable values at send time, so store them in the row's `payload` (`{"params": {...}}`, never a secret) when it is queued, and
  let the dispatcher pass them to `_send_via_meta`. `message_text` stays for the log (rendered from the template wording).
- **Documents:** `send_document()` / `queue_document()` no longer need a public link: the dispatcher builds the PDF
  (`DOCUMENT_BUILDERS`, already there) and uploads it with `upload_media`. `BACKEND_PUBLIC_URL` is then no longer needed for
  WhatsApp.
- **One-time codes** (`_send_code_now`): send `hrms_otp` with the code as the body parameter **and** as the copy-code button's
  parameter (`button_params={0: code}`). Check the current "Send authentication templates" page of Meta's docs for the exact
  button form when you build it.
- **Groups** (`is_group_id`, `fetch_groups`): with Meta, refuse group ids with a clear reason ("WhatsApp groups are not
  available with the official API: add individual numbers"). On Attendance Notify, hide the group picker when the provider is
  Meta.
- **Contact cards** (`send_contact_message`): skip with the provider Meta; the visitor template carries the phone number.
- **Phone format:** Meta wants digits with the country code, no `+` (`919876543210`). `normalize_phone()` already produces that.

### 9.5 WhatsApp Control page

- **Message Text tab:** the wording can no longer be edited freely. Show each type's **template name, language, category and
  Meta status** (APPROVED / PENDING / REJECTED / PAUSED), read with `GET /<WABA_ID>/message_templates`, plus the template's text
  for reference. Editing = a link to WhatsApp Manager (or a "submit change" action that calls the templates API and goes back to
  PENDING). Mark a type whose template is missing or not approved as "cannot be sent".
- **Feature Controls:** unchanged (the switches, including **Department Head notifications**, work the same).
- **Configuration → Connection check:** replace the WAClient instance status with `whatsapp_cloud.phone_number_status()`: display
  name and its status, quality rating (GREEN / YELLOW / RED), platform `CLOUD_API`, plus how many templates are approved.
- **Send a test:** sends the chosen type's template (with sample variables and the employee's name); shows Meta's error code and
  message on failure.
- **Queue limits:** Meta handles throughput (about 80 messages a second), so the 30-second gap can drop to a few seconds. Keep the
  per-employee daily cap and the end-of-day expiry; keep the circuit breaker but key it on the `ACCOUNT_CODES` above.

### 9.6 Rewrite the webhook (`backend/api/whatsapp_views.py`, `whatsapp_webhook`)

```python
import hashlib, hmac

def whatsapp_webhook(request):
    if request.method == "GET":                        # Meta's one-time verification
        q = request.query_params
        if q.get("hub.mode") == "subscribe" and q.get("hub.verify_token") == dj_settings.WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN:
            return HttpResponse(q.get("hub.challenge", ""), content_type="text/plain")
        return HttpResponse(status=403)
    raw = request.body                                 # the RAW body: read it before request.data
    expected = "sha256=" + hmac.new(dj_settings.WHATSAPP_CLOUD_APP_SECRET.encode(), raw, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, request.headers.get("X-Hub-Signature-256", "")):
        return HttpResponse(status=403)
    try:
        payload = json.loads(raw or b"{}")
        for entry in payload.get("entry", []):
            for change in entry.get("changes", []):
                value = change.get("value", {})
                if change.get("field") == "messages":
                    for st in value.get("statuses", []):
                        _apply_status(st["id"], st["status"], (st.get("errors") or [{}])[0])
                    for msg in value.get("messages", []):
                        _employee_wrote(msg)   # e.g. "STOP" -> opt the employee out
                elif change.get("field") == "message_template_status_update":
                    _template_status(value)    # APPROVED / REJECTED / PAUSED / DISABLED
                elif change.get("field") in ("phone_number_quality_update", "account_update"):
                    logger.warning("WhatsApp account event: %s %s", change.get("field"), value.get("event"))
    except Exception:
        logger.exception("WhatsApp webhook event could not be processed")
    return HttpResponse(status=200)                    # always 200 for a signed body, so Meta does not retry forever
```

Notes:
- The view must be **exempt from login/JWT** (it is today) and accept GET and POST.
- `_apply_status` finds `WhatsAppMessageLog` by `provider_message_id == wamid` and moves it `sent → delivered → read`, or to
  `failed` with `f"Send failed: {error['title']} (code {error['code']})"` so the queue's circuit breaker can see it.
- Keep logging a summary only, never the message body (it holds personal data).
- `WHATSAPP_WEBHOOK_TOKEN` (`?token=`) is no longer needed: the signature replaces it.

### 9.7 Migrations

None are strictly needed: `provider_message_id`, `payload` and the switches already exist. Add one only if you choose to store
template status in the database (for example a `WhatsAppTemplateStatus` table filled by the webhook). Keep any migration
**additive** (new columns with database defaults), as with every migration in this project.

### 9.8 Tests

- Mock `api.whatsapp_cloud.requests.post` / `.get` like the WAClient tests mock `requests.post` today.
- Cover: a template send builds the right body (named parameters, language, header document); a Meta error becomes the right
  `WhatsAppServiceError` (temporary for 130429 / 5xx, account pause for 131031 / 368 / 190); the webhook verifies GET, rejects a
  bad signature, applies `delivered` / `read` / `failed`; groups and contact cards are refused with Meta; the local test lock
  still blocks everyone but 30020 under runserver and never in production.
- Run the whole backend suite (`python manage.py test api --noinput`, serially) and the frontend suite before deploying.

---

## Step 10: Local testing

1. In WhatsApp Manager / API Setup, add **employee 30020's number** as an allowed recipient of the **test number** (the test
   number may message only those numbers; a production number has no such list).
2. Local `backend/.env` (never committed):

```
WHATSAPP_PROVIDER=meta
WHATSAPP_CLOUD_API_VERSION=v23.0
WHATSAPP_CLOUD_PHONE_NUMBER_ID=<test or production phone number id>
WHATSAPP_CLOUD_BUSINESS_ACCOUNT_ID=<WABA id>
WHATSAPP_CLOUD_ACCESS_TOKEN=<system user token>
WHATSAPP_CLOUD_APP_SECRET=<app secret>
WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN=<random string>
WHATSAPP_CLOUD_TEMPLATE_LANGUAGE=en
WHATSAPP_ALLOW_SENDING=true
WHATSAPP_ONLY_TO_EMPLOYEES=30020
```

   `WHATSAPP_ONLY_TO_EMPLOYEES` keeps the local server limited to 30020 (it only works under `manage.py runserver` and is ignored
   in production).
3. Restart the local backend. WhatsApp Control → Configuration → **Connection check** must show the number, its quality and the
   approved templates.
4. WhatsApp Control → **Send a test** → type **New request waiting for approval** → recipient 30020 → Preview → Send. Check the
   phone, then Messages: the row shows `sent` with a `wamid`.
5. **Department Head flow end to end:** with Feature Controls → Department Head notifications ON, raise a request whose
   Department Head is 30020 (or use Requests → Notify → Send now limited to that head and the WhatsApp channel). The message
   arrives; the Messages log shows `sent`.
6. **Webhook locally (optional):** Meta cannot reach `localhost`. Use a tunnel (for example `cloudflared tunnel --url
   http://localhost:8000`), temporarily set the tunnel URL as the callback in the app, watch statuses arrive, then set the callback
   back to `https://api.uktextiles.in/api/whatsapp/webhook/`. Simpler: test the webhook on production in Step 11.
7. When local testing is done, remove the Meta variables from your local `.env` (as you did with WAClient).

---

## Step 11: Production deployment (Railway)

1. **Code:** commit and push the integration (Steps 9.1–9.8) with all tests passing. Deploy on Railway.
2. **Railway → backend service → Variables:**
   - **Add:** `WHATSAPP_PROVIDER=meta`, `WHATSAPP_CLOUD_API_VERSION`, `WHATSAPP_CLOUD_PHONE_NUMBER_ID` (the **production**
     number's id), `WHATSAPP_CLOUD_BUSINESS_ACCOUNT_ID`, `WHATSAPP_CLOUD_ACCESS_TOKEN` (system user token),
     `WHATSAPP_CLOUD_APP_SECRET`, `WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN`, `WHATSAPP_CLOUD_TEMPLATE_LANGUAGE=en`.
   - **Remove:** `WACLIENT_INSTANCE_ID`, `WACLIENT_ACCESS_TOKEN`, `WACLIENT_API_URL`, `WACLIENT_CONTACT_API_URL`,
     `WHATSAPP_WEBHOOK_TOKEN`, and **make sure `WHATSAPP_ONLY_TO_EMPLOYEES` is not set** (it is ignored in production by the code,
     but do not keep it there).
   - **Do not set** `WHATSAPP_ALLOW_SENDING=false` or `DEBUG=true` in production.
   - Railway redeploys after variable changes.
3. **Migrations:** `python manage.py migrate` (Railway shell), as after every deploy of this project.
4. **Webhook:** do Step 8.2 now (callback URL + verify token → Verify and save; subscribe the fields; `subscribed_apps`).
5. **Smoke test on production:** WhatsApp Control → Configuration → Connection check (all green) → Send a test to yourself
   (30020) → the message arrives and the Messages row turns `delivered` then `read` (that proves the webhook).
6. **Turn features on gradually** (WhatsApp Control → Feature Controls), watching Messages and the quality rating:
   - Day 1: **Department Head notifications** (section ON, "New request waiting for approval" ON, "HoD Pending Approvals Reminder"
     ON) and the Requests → Notify schedule.
   - Day 2–3: Approval notifications (approved / rejected).
   - Then: attendance alerts (they are the biggest volume: check the messaging limit first), On-Duty / Geo, gate, visitors.
   - Then: documents.
   - Login / reset codes last, after the authentication template is approved and tested (until then employees keep password
     and SMS sign-in).
7. **Tell employees** the new official number (save it as "UK Textiles HR") and that the old number is no longer used.

---

## Step 12: Go-live checklist and rollback

**Checklist**

- [ ] Business portfolio verified; domain verified.
- [ ] Production number registered (`platform_type` CLOUD_API), display name approved, two-step PIN stored.
- [ ] Payment method added; spending alert set.
- [ ] System user token (never expires) stored in the password manager and in Railway.
- [ ] Templates for the enabled message types APPROVED (Department Head ones first).
- [ ] Webhook verified; fields subscribed; `subscribed_apps` done; statuses update in Messages.
- [ ] Connection check all green on production; a test message delivered and read.
- [ ] WAClient variables removed from Railway; `WHATSAPP_ONLY_TO_EMPLOYEES` not set in Railway.
- [ ] Employees told about the new number; opt-out handling works (an employee writing STOP is opted out).
- [ ] App switched to **Live** mode.

**Rollback:** WAClient's number is restricted, so going back is not a real option. If something fails after go-live, switch the
WhatsApp **master switch OFF** in WhatsApp Control (nothing is sent, nothing breaks: the HRMS workflows, phone notifications and
emails carry on), fix, and switch it on again. Keep `WHATSAPP_PROVIDER` in the code so the provider can be changed by a variable
if you ever add another one.

---

## Running it: limits, quality, pricing, consent

**Messaging limit (business-initiated):** counted in different **people** reached in a rolling 24 hours, for the whole business
portfolio (since October 2025). A new portfolio starts at **250**; it rises automatically (2,000 → 10,000 → 100,000 → unlimited)
when quality stays high and you use a good part of your limit over several days. Replies inside a 24 h window opened by the
employee do not count. See the current tier in WhatsApp Manager → Insights / the number's page. With about 250+ staff, the first
tier can be reached on a day of attendance alerts: enable attendance alerts after the tier has grown, or keep them to fewer people.

**Throughput:** about 80 messages a second per number by default; and **one message to the same person every few seconds** at most
(error 131056 if you go faster). The HRMS queue already paces messages, so this is safe.

**Quality rating** (GREEN / YELLOW / RED): falls when employees block or report the number. Keep messages useful, short and
expected; do not send the same reminder repeatedly; honour opt-outs. Low quality pauses a template or lowers the limit; the
webhook reports it.

**Pricing:** Meta charges per delivered template message by category (utility, authentication, marketing) and by the recipient's
country, billed to the payment method in WhatsApp Manager. Rates and the rules for messages inside the 24 h window change from time
to time: check Meta's pricing page before go-live and set a monthly budget alert.

**Consent (required by Meta's policy):** employees must have agreed to receive WhatsApp messages from the company. Add a line to the
employment / onboarding form ("I agree to receive work notifications on WhatsApp at this number") and keep the HRMS's per-employee
**opt-out** (WhatsApp Control → Employees). Treat a reply of STOP as an opt-out.

**Template housekeeping:** keep one list (the table in 7.2) of template name ↔ HRMS type; when HR wants new wording, edit the
template in WhatsApp Manager (it goes back to review) rather than creating near-duplicates.

**Token and secret hygiene:** the system user token and app secret live only in Railway Variables and the password manager. Rotate
them if anyone who knew them leaves.

---

## Troubleshooting: error codes

| Code | Meaning | What to do |
|---|---|---|
| 190 | Access token invalid or expired | Generate a new system-user token (Step 6), update Railway. |
| 10 / 200 | Permission missing | The token lacks `whatsapp_business_messaging` / `management`, or the system user is not assigned the WABA. |
| 100 | Invalid parameter | A wrong field, phone number id, or template component. Check the request body. |
| 368 | Temporarily blocked for policy violations | Check WhatsApp Manager → Account quality; stop sending until resolved. |
| 130429 | Throughput limit | Sending too fast; the queue retries later. |
| 131026 | Message undeliverable | The number is not on WhatsApp, or the app is very old. Check the employee's phone number. |
| 131030 | Recipient not in allowed list | Only with the **test number**: add the recipient in API Setup. |
| 131031 | Account locked | Account restricted by Meta: see Account quality; appeal if needed. |
| 131042 | Payment problem | Fix the payment method in WhatsApp Manager. |
| 131047 | Re-engagement message (24 h window closed) | A non-template message was sent outside the window: use the template. |
| 131049 | Not delivered to keep the ecosystem healthy | Meta chose not to deliver (usually marketing-like content or a user who ignores you). Keep templates utility. |
| 131056 | Too many messages to the same number | Space messages to one employee (the queue does). |
| 132000 | Number of template parameters does not match | The variables sent differ from the template's. |
| 132001 | Template does not exist | Wrong name or language (`en` vs `en_US`), or not approved yet. |
| 132005 | Template text too long after filling | Shorten variable values. |
| 132007 / 132012 | Template format / parameter format problem | A value has new lines, tabs or too many spaces, or a wrong type. |
| 132015 / 132016 | Template paused / disabled | Low quality: improve or replace the template. |
| 133010 | Phone number not registered | Register the number (Step 4.7). |

"(#100) Param text cannot have new-line/tab characters or more than 4 consecutive spaces" means a variable value needs flattening
(`_clean()` in 9.2 does it).

---

## Appendix

### A. Environment variables

| Variable | Where | Example / note |
|---|---|---|
| `WHATSAPP_PROVIDER` | Railway + local | `meta` |
| `WHATSAPP_CLOUD_API_VERSION` | Railway + local | `v23.0` (the version your app dashboard shows) |
| `WHATSAPP_CLOUD_PHONE_NUMBER_ID` | Railway + local | the production number's id (local: may be the test number's) |
| `WHATSAPP_CLOUD_BUSINESS_ACCOUNT_ID` | Railway + local | WABA id |
| `WHATSAPP_CLOUD_ACCESS_TOKEN` | Railway + local | system-user token, never expires; secret |
| `WHATSAPP_CLOUD_APP_SECRET` | Railway + local | App settings → Basic; secret; checks webhook signatures |
| `WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN` | Railway | random string you also type in the app's webhook settings |
| `WHATSAPP_CLOUD_TEMPLATE_LANGUAGE` | Railway + local | `en` |
| `WHATSAPP_DEFAULT_COUNTRY_CODE` | existing | `91` |
| `WHATSAPP_ALLOW_SENDING` | local only | `true` to let the local runserver send |
| `WHATSAPP_ONLY_TO_EMPLOYEES` | **local only** | `30020`; ignored in production; never set it in Railway |
| `WACLIENT_*`, `WHATSAPP_WEBHOOK_TOKEN` | remove | WAClient is retired |

### B. curl cheat sheet

```bash
V=v23.0; PID=<PHONE_NUMBER_ID>; WABA=<WABA_ID>; T=<TOKEN>

# phone number state
curl "https://graph.facebook.com/$V/$PID?fields=display_phone_number,verified_name,name_status,quality_rating,platform_type" -H "Authorization: Bearer $T"

# list templates and their status
curl "https://graph.facebook.com/$V/$WABA/message_templates?fields=name,status,category,language&limit=100" -H "Authorization: Bearer $T"

# send a named template
curl -X POST "https://graph.facebook.com/$V/$PID/messages" -H "Authorization: Bearer $T" -H "Content-Type: application/json" -d '{
  "messaging_product":"whatsapp","to":"91XXXXXXXXXX","type":"template",
  "template":{"name":"hrms_hod_request_waiting","language":{"code":"en"},"components":[{"type":"body","parameters":[
    {"type":"text","parameter_name":"hod_name","text":"Surya M"},
    {"type":"text","parameter_name":"employee_name","text":"Asha Kumar"},
    {"type":"text","parameter_name":"employee_code","text":"30012"},
    {"type":"text","parameter_name":"request_type","text":"Leave"},
    {"type":"text","parameter_name":"date","text":"20 Nov 2026"},
    {"type":"text","parameter_name":"details","text":"Sick Leave - 1 day"}]}]}}'

# upload a PDF (returns a media id) and send it in a document-header template
curl -X POST "https://graph.facebook.com/$V/$PID/media" -H "Authorization: Bearer $T" \
  -F messaging_product=whatsapp -F type=application/pdf -F "file=@slip.pdf;type=application/pdf"

# subscribe the app to the WhatsApp account (webhooks)
curl -X POST "https://graph.facebook.com/$V/$WABA/subscribed_apps" -H "Authorization: Bearer $T"

# register the number (two-step PIN)
curl -X POST "https://graph.facebook.com/$V/$PID/register" -H "Authorization: Bearer $T" -H "Content-Type: application/json" \
  -d '{"messaging_product":"whatsapp","pin":"123456"}'
```

### C. Glossary

- **Business portfolio:** the company's account in Meta Business (formerly Business Manager).
- **WABA:** WhatsApp Business Account, inside the portfolio; holds phone numbers and templates.
- **Phone number ID:** Meta's id of one registered number; every send goes to `/<PHONE_NUMBER_ID>/messages`.
- **Template:** pre-approved message wording with variables; required for business-initiated messages.
- **Customer service window:** 24 hours after an employee's last message to you; free-form messages are allowed only inside it.
- **wamid:** Meta's id of a sent message (`wamid.…`); webhook status updates refer to it.
- **System user:** a non-person user in the portfolio that owns the permanent token.
- **Quality rating / messaging limit:** Meta's measure of how recipients react, and how many people you may message per 24 hours.

### D. Official documentation (check before each step; Meta updates these)

- Get started: https://developers.facebook.com/docs/whatsapp/cloud-api/get-started
- Phone numbers and registration: https://developers.facebook.com/docs/whatsapp/cloud-api/phone-numbers
- Message templates and components: https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/components
- Authentication templates (copy code): https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/authentication-templates/copy-code-button-authentication-templates/
- Webhooks: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks
- Messaging limits and throughput: https://developers.facebook.com/documentation/business-messaging/whatsapp/throughput
- Pricing: https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing
- Error codes: https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
- Business verification: https://www.facebook.com/business/help/2058515294227817
- WhatsApp Business Messaging Policy: https://business.whatsapp.com/policy
