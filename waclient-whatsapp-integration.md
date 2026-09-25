# WAClient WhatsApp Integration -UKTextiles HRMS

The HRMS sends WhatsApp messages (salary slips, ID cards, offer/experience/resignation letters, other employee documents, and Reception's "you have a visitor" alert) through **WAClient's WhatsApp Web API** (`app.waclient.com`). This replaced the earlier Gupshup integration; nothing of Gupshup remains in the code.

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

### Code map

| File | Role |
|---|---|
| `backend/api/whatsapp_service.py` | All WAClient calls, phone normalisation, message wording (`DEFAULT_MESSAGES`, `{{n}}` placeholders), media storage, `pace()` delay for bulk sends. Every document-send view calls `send_document()` / `send_text()`. |
| `backend/api/whatsapp_views.py` | Settings → WhatsApp endpoints (status, message wording), the public media link, and the delivery-status webhook. |
| `backend/api/models/whatsapp.py` | `WhatsAppMessageLog`, `WhatsAppMessageTemplate` (per-type wording + on/off switch), `WhatsAppMediaAsset`. |
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

4. Restart the backend. **Settings → WhatsApp** should show *Configured -instance ending in …xxxx*.
5. Send one salary slip to a test employee (a different phone from the linked number) and confirm it arrives.

## Message wording

Settings → WhatsApp lists every document type with an editable text box. Leave it blank to use the built-in default. Placeholders are filled in order:

| Document | Placeholders |
|---|---|
| Salary slip | `{{1}}` employee name, `{{2}}` month and year |
| ID card | `{{1}}` employee name |
| Offer letter | `{{1}}` employee name, `{{2}}` designation |
| Experience letter | `{{1}}` employee name |
| Resignation letter | `{{1}}` employee name, `{{2}}` last working day |
| Other documents | `{{1}}` employee name, `{{2}}` document category |
| Visitor alert | `{{1}}` employee, `{{2}}` visitor name, `{{3}}` visitor phone, `{{4}}` purpose |

Each type also has an Enabled switch; a disabled type fails with "turned off in Settings" instead of sending.

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

## Tests

`python manage.py test api.tests_whatsapp_service api.tests_whatsapp_webhook` -covers the request shape, wording and placeholders, phone handling, every failure path, the settings endpoints, and the webhook parser. WAClient itself is mocked; nothing in the suite sends a real message.
