# UKTextiles HRMS -Backend

Django REST API for the HR Portal. This is the single backend for three frontends: the HR Portal (`frontend/`, in this repo), the Employee Web App, and the Employee Mobile App -the latter two live in their own separate repositories and are not part of this one, but every business rule described here applies to them equally since they all call this same API.

---

## 1. Quick Start

**Prerequisites:** Python 3.11+ (dev machines have run on 3.13/3.14 too), PostgreSQL 15+.

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate          # Windows
pip install -r requirements.txt
copy .env.example .env          # then fill in real values -see Section 3
python manage.py migrate
python manage.py runserver 8080
```

API base: `http://localhost:8080/api`
Health check: `GET http://localhost:8080/api/healthz`

### HR Login

Auth is backed by the `hr_users` table (`HRUser` model), not a single hardcoded credential. On first startup (`ApiConfig._bootstrap_admin_account` in `apps.py`), the backend bootstraps exactly **one** Super Admin account from `ADMIN_USERNAME`/`ADMIN_PASSWORD` in `.env`, if that username doesn't already exist. From then on, that Super Admin creates every other HR account (and its role) from **Account Management** inside the portal -nothing else ever needs to go in `.env`.

`migrate` itself only creates the database schema plus a couple of structural defaults the app needs to function (a default "Head Office" branch, default production shift segments) -it never creates login accounts. A one-time historical migration (`0032_seed_legacy_hr_accounts`) used to also seed MD/Director accounts from legacy env vars on cutover day; that cutover finished long ago and the migration is now a permanent no-op, kept only so `manage.py migrate` never creates a login account again on any future database.

### Biometric sync (manual)

```bash
python manage.py sync_biometric --today
python manage.py sync_biometric --days 3
python manage.py sync_biometric --all
```

Full detail, including Push and the not-yet-built ADMS path: **`biometric-integration.md`**.

---

## 2. Architecture

```
┌─────────────────────────────────────────────────┐
│                 Company Network (LAN)            │
│                                                   │
│  ┌──────────────┐     ┌──────────────────────┐  │
│  │  Biometric    │────▶│   Django Backend      │  │
│  │  device       │ ZK  │   Port 8080/8000      │  │
│  │  192.168.0.x  │TCP  │                        │  │
│  └──────────────┘4370 │   PostgreSQL           │  │
│                        └─────────┬──────────────┘ │
│                                  │ /api/*          │
│  ┌──────────────┐                │                │
│  │  HR Portal    │───────────────┘                │
│  │  React/Vite   │                                │
│  │  Port 5173    │                                │
│  └──────────────┘                                 │
└─────────────────────────────────────────────────┘

         │ Cloudflare Tunnel (HTTPS) -see deployment-guide.md
         ▼
┌─────────────────────┐
│  Employee Mobile /   │
│  Employee Web App    │
│  (separate repos)    │
└─────────────────────┘
```

- **HR Portal** uses Vite's dev proxy (`/api` → `http://localhost:8080`) in development; in production Nginx proxies `/api/` to Django directly.
- **Employee Mobile/Web apps** connect over the public HTTPS URL (same Django backend, employee JWT tokens instead of HR ones).
- **Biometric device** stays on the LAN -Django reaches it directly, so attendance never depends on the internet being up.

---

## 3. Environment Variables

Create `backend/.env` from `.env.example`:

```env
# Database (discrete fields, not a DATABASE_URL)
DB_HOST=localhost
DB_PORT=5432
DB_NAME=uk_textile
DB_USER=postgres
DB_PASSWORD=password
# Optional -defaults to "prefer" (uses SSL if the server offers it; fine for a
# local Postgres with none configured). Set explicitly (e.g. "require") only
# if a cloud/managed Postgres provider needs a specific mode.
DB_SSLMODE=prefer

# Bootstraps the one Super Admin HR account on first startup only -see Section 1.
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change_this_password

# JWT signing key (keep secret, never change after deployment -invalidates every session)
JWT_SECRET=your_long_random_secret_key
# Django's own secret key (session/CSRF signing, separate from JWT_SECRET)
DJANGO_SECRET_KEY=your_django_secret_key

DEBUG=false
ALLOWED_HOSTS=localhost,127.0.0.1,your.domain.com
CORS_ALLOWED_ORIGINS=http://localhost:5173,https://your-domain.com

# Biometric device (Pull path -see biometric-integration.md)
BIOMETRIC_DEVICE_IP=192.168.0.x
BIOMETRIC_DEVICE_PORT=4370
BIOMETRIC_DEVICE_PASSWORD=0
# Shared key the biometric Push endpoint checks (X-Device-Key header)
BIOMETRIC_API_KEY=change-this-to-a-strong-random-key

# WhatsApp Cloud API (Meta) -.env only, never stored in the DB or editable
# from the UI. See Section 8.
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_BUSINESS_ACCOUNT_ID=
WHATSAPP_API_VERSION=v21.0
WHATSAPP_DEFAULT_COUNTRY_CODE=91
```

Everything else -SMTP/email, PF/ESI rates, attendance mode and every threshold in Section 6, company branding, backup destinations, WhatsApp message templates -is configured live in **Settings** from the HR Portal (backed by the `payroll_settings` table and a couple of dedicated tables), not in `.env`. This is deliberate: a Super Admin can repoint the whole system at a different company's policy without touching code or redeploying.

**Moving the database to a managed/cloud Postgres later** works with these same env vars -no code change needed, provided the `DB_USER` has owner privileges on the `public` schema (needed for Backup → Restore's schema-reset step) and `pg_dump`/`psql` client tools are present wherever Django itself runs. See `deployment-guide.md` and `clouddeployment.md`.

---

## 4. Modules & Features

Every module is gated per-role by the hierarchical permission system (Section 4.11) -`hidden`/`view`/`edit`, cascading from parent to child modules.

### 4.1 Dashboard
Live attendance summary, pending-action tiles (leave/permission/casual leave/missing punch/resume screening/documents), recruitment snapshot, monthly salary totals, on-demand biometric sync.

### 4.2 Employees
Directory with search/filters/Excel-like bulk view; add/edit; **Production** (daily/weekly wage, segment attendance) vs **Staff** (monthly salary, Strict/Simple attendance); Bulk Upload (separate Staff/Production flows plus an Update-existing-by-code flow); per-employee Documents checklist; Branch/Department/Designation sub-pages.

### 4.3 Attendance & Shift Management
The most heavily-configurable area -see Section 6 for full mechanics.
- **Staff:** Strict Mode (all 4 punches, plus lunch-break policing) or Simple Mode (first/last punch only) -both share the same Full/Half-Shift decision.
- **Production:** separate segment-based engine; Sunday is a normal working day (unlike staff).
- **Manage Shift:** templates, bulk/per-employee assignment, Assigned/Unassigned view, per-employee time overrides.
- **Late Detection & Without Permission policy:** fully HR-configurable free-allowance + slab-table deduction rules (Section 6).
- **Geo Attendance & On-Duty:** geofenced punch-in/out, destination-based field-work sessions with department-head approval and live location tracking.
- **Missing Punch:** employee-submitted forgotten-punch correction (4 slots), HOD/HR approval.
- **Manual Punch Import:** bulk Excel import for device outages/backfill.
- **Auto Sync Rules, Attendance Search, Report Log, Night Shift Relaxation.**

### 4.4 Leave & Holiday
Configurable leave types, per-employee/year balances with carry-forward, request approval (HR or department head, attributed), Permission requests (also feed the Late Detection pool), Holiday calendar, automatic attendance reflection.

### 4.5 Casual Leave (CL)
Paid, staff-only, one per calendar month, eligible after 6 months of service. Separate table/flow from Leave/Permission. Approving/rejecting writes the attendance record directly -payroll picks it up automatically.

### 4.6 Recruitment
New Joinees (offer letter + email/WhatsApp), Resignations (department-head then HR approval), Required Roles, Interviews, Resume Screening (spaCy NLP scoring against an HR-defined rule set, explainable per-candidate scoring, 4-stage pipeline; uploaded resumes for non-selected candidates are **auto-purged after 10 days** -see Section 7), Documents (Company Documents theming + per-employee Employee Documents checklist).

### 4.7 Payroll, Salary & Settlement
Full engine for both employment types:
- **Staff:** monthly salary ÷ working days × effective present days (Full/Half Shift), plus Late Detection and Without Permission deduction pools (Section 6).
- **Production:** shift-based, on a configurable pay-period cycle (weekly/2-weekly/3-weekly/monthly) -**not** tied to calendar months, so a given month can span more than one still-unpaid pay period. This is why any "how many employees are pending" figure for Production must count **distinct employees**, not raw Payroll rows -a fix applied to the Payslip list query and the Production Payroll page's KPI card after exactly this miscount was found (August 2026).
- **Skipped Employees:** a dry-run preview (before generating) of exactly which employees would be skipped and why (no Salary Amount / no Salary Per Shift / zero working days in the period) -surfaced as a KPI card on both Staff and Production Payroll pages. Staff's check runs automatically on page load (~14s for ~120 employees); Production's is click-triggered instead, since its equivalent check is measurably slower (~84s for ~114 employees, since the production engine's per-employee work is heavier) and firing it automatically on every page visit would be a bad tradeoff.
- Deductions: PF, ESI, advances, Late Attendance penalty, Without Permission penalty.
- Full day-by-day breakdown drawer per payroll record.
- Salary Slip: PDF generation, single/bulk download/email/**WhatsApp** (Section 8), Excel export.
- Settlement: advance/loan records with auto-generated repayment schedules, deducted from payroll automatically each cycle.

### 4.8 Digital ID Card
Template-driven generator (colors/fonts/corner style/logo, configurable in Settings), separate staff (vertical) / production (horizontal) layouts with a QR-code back face (public verification, no login required), bulk generate/print/ZIP-download, single/bulk email and **WhatsApp** send (Section 8) using a dedicated server-side image renderer (`backend/api/idcard_render.py`, Pillow-based -a clean single-image card, not a pixel replica of the print layout).

### 4.9 Promotions, Increments & Bonus
Department/designation change history, salary increment tracking against each employee's initial-salary baseline, bonus tracking.

### 4.10 Reports
Attendance (log/summary/search), leave (report/balance), payroll, PF/ESI, employee/headcount, settlement, new joinings -CSV/Excel export throughout.

### 4.11 Account Management & RBAC
**Account Management** creates HR users and assigns roles from a hierarchical module tree (a parent module cascades its permission level to children unless a child overrides it). **User Management** assigns employees as department-level approvers for the mobile app's Approvals tab (Leave/Permission/Casual Leave/Missing Punch/Resignation/On-Duty, independently toggled). Plus Activity Logs, Login Devices (active-session view + remote revoke), Chat, Notifications.

### 4.12 Settings
Tabbed, each tab independently permissioned: Company, Attendance (Staff/Production sub-tabs), Late Detection, Devices, Company Documents, Payroll, Production Payroll, Salary Slip, **WhatsApp** (Section 8 -credential status is read-only here, message-template selection is editable), SMTP/Email, Backup.

---

## 5. Project Structure (backend)

```
backend/
├── api/
│   ├── models.py                       # All DB models (65+ migrations' worth)
│   ├── views.py                        # Employees, dashboard, auth
│   ├── attendance_final.py             # Canonical attendance engine -single source of truth
│   ├── shift_engine.py                 # Strict-mode 4-punch engine, punctuality window
│   ├── attendance_views.py             # Attendance endpoints + biometric Push endpoint
│   ├── biometric_sync.py               # Pull-path device connection (pyzk)
│   ├── manual_attendance_import_views.py / missing_punch_views.py
│   ├── auto_sync.py / auto_sync_views.py
│   ├── geo_attendance_views.py         # Geo punch + On-Duty sessions/verifications
│   ├── night_shift.py / night_shift_views.py
│   ├── shift_views.py                  # Shift templates and assignments
│   ├── leave_views.py / casual_leave_views.py
│   ├── payroll_views.py                # Full payroll engine (staff + production) + Late/WP pools
│   ├── production_payroll_views.py / production_period.py
│   ├── payroll_progress.py             # In-memory bulk-generation progress tracker
│   ├── salary_slip_views.py / salary_slip_bulk_pdf.py / salary_slip_bulk_progress.py
│   ├── whatsapp_service.py / whatsapp_views.py / whatsapp_bulk_progress.py / idcard_render.py
│   ├── settlement_views.py             # Advances and repayments
│   ├── recruitment_views.py            # Jobs, applicants, new joinees, resignations
│   ├── resume_screening_ml.py / resume_screening_views.py / screening_cleanup*.py
│   ├── company_documents_views.py / employee_documents_views.py / document_pdf.py
│   ├── manager_views.py                # Department manager CRUD + mobile approval endpoints
│   ├── hr_user_views.py
│   ├── permission_registry.py          # Canonical hierarchical module/permission tree
│   ├── permission_middleware.py        # Enforces it per-request
│   ├── auth.py / jwt_utils.py / session_utils.py / login_sessions_views.py
│   ├── backup_service.py / backup_scheduler.py / backup_views.py / google_drive.py
│   ├── maintenance_middleware.py       # Serves a maintenance page during restore
│   ├── org_views.py / branch_scope.py  # Branches, designations, per-branch data scoping
│   ├── reports_views.py / chat_views.py / growth_views.py
│   ├── audit_utils.py                  # Activity Logs
│   ├── apps.py                         # APScheduler startup (biometric sync, backups, retention)
│   ├── urls.py                         # All URL routing -source of truth for the full route list
│   └── migrations/
├── management/commands/
│   ├── sync_biometric.py
│   ├── restore_backup.py
│   └── purge_screening_documents.py
└── config/settings.py
```

---

## 6. Attendance Engine In-Depth

Lives in `shift_engine.py` and `attendance_final.py`; every threshold below is HR-editable in Settings → Attendance/Late Detection (`PayrollSettings` model) -none of it is hardcoded, so the same codebase serves any company's policy without a code change.

**Full vs Half Shift (staff, both modes):** Full only when a first *and* distinct last punch both fall within the **Shift Punctuality Window** (`shiftPunctualityWindowMinutes`, default 60 min) of the assigned shift's start/end. Anything else with ≥1 punch is Half Shift; zero punches (and not on leave/holiday) is Absent. No assigned shift ⇒ no reference, so no late flag either.

- **Half Shift Late Reference:** on a Half Shift day, "Late" is decided purely by whether the first punch is after a separate configured time (`halfShiftLateReferenceTime`, default 2:30 PM).
- **Night Shift Relaxation:** can upgrade a punctuality-caused Half Shift back to Full for employees who worked late the previous night.
- **Cross-midnight punch reattribution:** a forgotten evening exit punched after midnight is reattributed back to the correct shift-day within a configurable grace window, instead of corrupting the next day's punch order.

**Strict vs Simple (staff):** both share the Full/Half decision above. Strict additionally tracks lunch-return lateness (a first-half-end window locates the lunch punches). Simple only looks at first/last punch.

**Late Detection pool (Settings → Late Detection → Late Attendance):** plain lates + Half-Shift-day lateness + strict-mode lunch-return lateness + approved Permissions all feed **one shared monthly pool**. First `lateFreeAllowance` (default 3) are free; every occurrence past that is billable, priced by an HR-editable slab table. Empty table = no penalty.

**Without Permission detection (Settings → Late Detection → Without Permission):** a separate, independent pool covering the narrow zone between the shift's grace period and the wider punctuality window (morning late-in and evening early-out, mirrored). An approved Permission near the relevant shift boundary suppresses it; without one, the day is flagged "Without Permission." Ships with **0 free allowance and an empty slab table** (zero payroll impact until HR explicitly configures it) -deliberately independent from the Late Attendance pool so nothing double-counts.

**Production attendance:** a separate segment-based engine (`ProductionShiftConfig`/`ProductionShiftSegment`) -each configurable punch window earns its own shift fraction. Sunday is a normal working day.

---

## 7. Scheduled Jobs (APScheduler, started in `apps.py`)

| Job | Schedule | What |
|---|---|---|
| Biometric sync | 7:30 AM & 8:30 PM IST (fixed) + any custom Auto Sync Rules | Pulls attendance from every enabled device |
| Scheduled backups | HR-configurable (Settings → Backup) | Full DB + media backup, optional Google Drive upload |
| Screening document retention | Fixed, 1:00 AM IST daily | Purges `resume_file` (not the candidate row) for any `ScreeningCandidate` older than 10 days that's still `uploaded`/`screened`/`shortlisted`/`not_shortlisted` -`selected` is never touched, `rejected` is already cleared immediately at rejection time. Manual/ops equivalent: `python manage.py purge_screening_documents` |

Each runs in its own lightweight `BackgroundScheduler` instance (simpler and safer than sharing one scheduler across unrelated job types), guarded against the dev autoreloader's double-start via the `RUN_MAIN` check.

---

## 8. WhatsApp Integration (Meta Cloud API)

Added as a second delivery channel alongside the existing SMTP email flow, for the same document set: Salary Slip, ID Card, Offer Letter, Experience Letter, Resignation Letter, and other uploaded Employee Documents.

- **Credentials are `.env`-only** (Section 3) -never stored in the database or editable from the UI, unlike SMTP (which does live in `PayrollSettings`, editable from Settings). Settings → WhatsApp shows read-only status ("Configured" / "Not configured") sourced straight from those env vars.
- **Message templates are genuinely different from email's** -Meta requires every business-initiated WhatsApp message to use a **pre-approved template** (create and get it approved in Meta Business Manager first); the wording itself can't be freely edited from this app, only which approved template name/language is used per document type, configured in Settings → WhatsApp (`WhatsAppMessageTemplate` model) with a free-text note on what each `{{n}}` variable maps to.
- **Service module:** `whatsapp_service.py` -`is_configured()`, phone normalization (`Employee.phone` is a plain local number; prefixed with `WHATSAPP_DEFAULT_COUNTRY_CODE` to build the international number Meta requires), `upload_media`/`send_document_template` (Graph API), and `send_document()` -the one entry point every send endpoint calls, which always writes a `WhatsAppMessageLog` row (`sent`/`failed` + reason) whether it succeeds or not, so single-send and bulk-send callers get one uniform result to report.
- **Every send endpoint checks `is_configured()` before generating any document** -a bulk send against an unconfigured server fails in well under a second instead of generating a PDF per employee first and failing after the fact (a real inefficiency found and fixed once the feature was live-tested).
- **Bulk send** (Salary Slip) follows the same in-memory progress-tracker pattern used by bulk email/payroll generation (`whatsapp_bulk_progress.py`), polled by the frontend for a live progress bar with succeeded/failed counts and per-employee failure reasons.
- **ID Card** needed a new server-side renderer (`idcard_render.py`, Pillow) since ID cards were previously only ever rasterized in the browser -this incidentally also fixed a pre-existing bug where "Email to employee" on the ID Cards page silently never attached an image.

---

## 9. Backup & Restore

`backup_service.py` / `backup_views.py` / `backup_scheduler.py`. A backup is one zip: `db.sql` (plain `pg_dump` SQL) + `manifest.json` (timestamp, row counts for a few headline tables) + a full copy of `MEDIA_ROOT`. Restore is a full, reliable replace (`DROP SCHEMA public CASCADE` → reload) -not a row-level merge, deliberately (see `deployment-guide.md` for the reasoning). Validation now compares a candidate backup's row counts against what's currently live and warns in the UI if restoring it would discard newer data; a fresh safety backup of the current state is always taken automatically immediately before any restore runs, so a bad restore is always undoable. Cloud-Postgres readiness (SSL mode, timeouts, a clear error on a schema-ownership failure) is covered in `deployment-guide.md`/`clouddeployment.md`.

---

## 10. API Reference

All endpoints prefixed `/api/`. JWT in `Authorization: Bearer <token>`. This covers the core, stable surface -`backend/api/urls.py` is the source of truth for the full, current route list; each feature area has its own `*_views.py` file named after it.

| Area | Examples |
|---|---|
| Auth | `POST /auth/hr-login`, `POST /auth/employee-login`, `GET /auth/me`, `POST /auth/set-password` |
| Organisation | `GET/POST /branches`, `/departments`, `/designations` |
| Employees | `GET/POST /employees`, `GET/PUT/DELETE /employees/<id>`, `PATCH /employees/<id>/status` |
| Attendance | `GET /attendance/summary`, `/daily`, `/monthly-trend`, `/employee/<id>`; `POST /attendance/manual`, `/attendance/sync-biometric`, `/biometric/punch` |
| Leave & Holiday | `GET/POST /leave-types`, `/leave-requests`, `/permissions`, `/holidays`; `PATCH /leave-requests/<id>/status` |
| Payroll | `GET/POST /payroll`, `GET /payroll/<id>/breakdown`, `POST /payroll/skip-check`, `GET/PUT /payroll-settings` |
| Production Payroll | `GET/POST /payroll/production`, `GET /payroll/production/skip-check`, `/next-period` |
| Salary Slip | `GET/POST /salary-slips`, `/<id>/email`, `/<id>/whatsapp`, `/bulk-email`, `/bulk-whatsapp` |
| WhatsApp | `GET /whatsapp/status`, `GET/PUT /whatsapp/templates` |
| ID Card | `GET /idcard`, `POST /idcard/email`, `/idcard/whatsapp` |
| Department Managers | `GET/POST /department-managers`, `POST/DELETE .../departments`, `.../employees` |
| Manager Approvals (mobile) | `GET /manager/me`, `/manager/pending-requests`, `PATCH /manager/leave-requests/<id>/status` |
| Dashboard | `GET /dashboard/hr-summary`, `/dashboard/employee-summary` |
| Backup | `GET/POST /backup`, `POST /backup/restore/validate`, `/backup/restore/run`, `GET /backup/restore/status` |

---

## 11. Database Schema (selected tables)

| Group | Tables |
|---|---|
| Core | `branches`, `departments`, `designations`, `employees` |
| Attendance | `attendance`, `attendance_logs`, `attendance_day_records` (final per-day verdict, payroll's source of truth), `daily_shift_log`, `night_shift_relaxations`, `on_duty_sessions`/`on_duty_punch_verifications`, `biometric_devices`, `auto_sync_rules`, `missing_punch_requests` |
| Leave | `leave_types`, `leave_balances`, `leave_requests`, `employee_permissions`, `casual_leaves`, `holidays` |
| Shift & Payroll | `shift_templates`, `employee_shift_assignments`, `production_shift_config`/`production_shift_segments`, `payroll`, `payroll_settings`, `salary_slips`, `whatsapp_message_log`, `whatsapp_message_template` |
| Settlement | `advances`, `advance_repayments` |
| User Management & Auth | `department_managers`, `manager_department_assignments`, `manager_employee_assignments`, `hr_users`, `roles`, `login_sessions`, `audit_logs` |
| Recruitment & Documents | `jobs`/`applicants`, `hiring_rule_sets`/`screening_candidates`, `company_document_settings`, `employee_documents` |
| Other | `notifications`, `employee_requests`, `backup_schedules`/`backup_drive_configs`, `chat_messages` |

---

## 12. Known Limitations

- **Weekly-off is hardcoded to Sunday** for staff -not configurable per branch/unit yet.
- **Legacy leftovers:** `SessionConfig`/`WorkSession` models, `prod_first_half_*` `PayrollSettings` fields, and the "Legacy Session Config" panel on Staff Payroll exist only to keep old session-based records viewable. Safe to remove once those old records no longer need viewing.
- **Legacy `SalaryRecord` auto-calc** (`÷26` monthly / `÷6` weekly, in `views.py`) is superseded by the real payroll engine -a removal candidate.
- **Production employees without `salary_per_shift` are skipped at generation**, by design -reported clearly in the Skipped Employees list.
- **Biometric device Comm Key** can't be validated against the device itself from the UI -a wrong value is only caught when a sync actually fails.

---

## Contributing / Development Notes

- Employee Code is the **primary human identifier** across every module; numeric DB IDs are internal only.
- POST endpoints accept both camelCase and snake_case field names (React Native compatibility).
- `GET /api/dashboard/employee-summary` is the single source of truth for what an employee can do in the mobile/web app (`isManager`, `canSubmitLeave`).
- APScheduler runs inside Django's `ready()` -in dev with autoreload, Django starts twice; every scheduler module checks `RUN_MAIN` to avoid double-scheduling.
- Never bulk-mutate payroll/financial data as a side effect of a code fix -a verified-safe query/display fix and an actual data correction are always separate, explicitly-approved steps.
