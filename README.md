# UKTextiles HR System

A complete, on-premise HR and ERP platform built for UKTextiles -a garments manufacturing company. This repository is the **HR Portal** (Django REST API + React admin web app): attendance (biometric + geo-punch + on-duty), leave, payroll, shift management, recruitment, settlement, reporting, and system administration. It also serves as the single backend for a separate Employee Mobile App (React Native/Expo) and Employee Web App (React) -those live in their own codebases and are not part of this repo, but every business rule described below applies to them equally since they all call the same API.

**Related documents in `docs/`:**
- [`docs/MOBILE_APP_V2_SPEC.md`](docs/MOBILE_APP_V2_SPEC.md) -current, authoritative page-by-page mobile app spec (endpoints, DB tables, business rules, what's built vs. pending)
- [`docs/DEPLOYMENT_GUIDE.md`](docs/DEPLOYMENT_GUIDE.md) -full step-by-step on-premise deployment runbook (Nginx + Waitress + Cloudflare Tunnel + NSSM services), including a postmortem of two real deployment bugs worth knowing about in advance
- [`docs/MOBILE_INTEGRATION.md`](docs/MOBILE_INTEGRATION.md) -older, terser API reference (superseded by `MOBILE_APP_V2_SPEC.md` where they overlap)
- [`docs/PROJECT_REVIEW.md`](docs/PROJECT_REVIEW.md) -full workflow review and known-issues list
- [`PortDetails.md`](PortDetails.md), [`BIOMETRIC_INTEGRATION.md`](BIOMETRIC_INTEGRATION.md), [`EMPLOYEE_MOBILE_APP_PROMPT.md`](EMPLOYEE_MOBILE_APP_PROMPT.md) -earlier research/planning notes, kept for history

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture](#2-architecture)
3. [Tech Stack](#3-tech-stack)
4. [Modules & Features](#4-modules--features)
5. [Attendance Engine In-Depth](#5-attendance-engine-in-depth)
6. [Project Structure](#6-project-structure)
7. [Setup & Installation](#7-setup--installation)
8. [Environment Variables](#8-environment-variables)
9. [API Reference](#9-api-reference)
10. [Database Schema](#10-database-schema)
11. [Biometric Integration](#11-biometric-integration)
12. [User Management & Department Approvals](#12-user-management--department-approvals)
13. [Mobile App Integration](#13-mobile-app-integration)
14. [Deployment (On-Premise)](#14-deployment-on-premise)

---

## 1. Project Overview

| Concern | Details |
|---------|---------|
| **Company** | UKTextiles -garments manufacturing |
| **Deployment** | On-premise (company PC, same LAN as biometric device) |
| **Users** | HR admin (web), Department managers (mobile), Employees (mobile) |
| **Scale** | ~266+ employees, 150,000+ attendance records |
| **Biometric device** | eSSL e2008 face recognition terminal (ZKTeco protocol) |

The system replaces manual HR work -attendance sheets, leave registers, salary slips -with a live digital system that syncs from the biometric device automatically.


---
## 2. Architecture

```
┌─────────────────────────────────────────────────┐
│                 Company Network (LAN)           │
│                                                 │
│  ┌──────────────┐     ┌──────────────────────┐  │
│  │  eSSL e2008  │────▶│   Django Backend      │  │
│  │  Biometric   │ZK   │   Port 8080           │  │
│  │  192.168.0.x │TCP  │                       │  │
│  └──────────────┘4370 │   PostgreSQL (local)  │  │
│                       └─────────┬────────────┘  │
│                                 │ /api/*         │
│  ┌──────────────┐               │                │
│  │  HR Portal   │───────────────┘                │
│  │  React/Vite  │                                │
│  │  Port 5173   │                                │
│  └──────────────┘                                │
└─────────────────────────────────────────────────┘

         │ Cloudflare Tunnel (HTTPS)
         ▼
┌─────────────────────┐
│  Employee Mobile    │
│  React Native App   │
│  (4G/5G/WiFi)       │
└─────────────────────┘
```

- **HR Portal** uses Vite's proxy in development (`/api` → `http://localhost:8080`)
- **Mobile app** connects via a Cloudflare Tunnel public URL (same Django backend)
- **Biometric device** is on the same LAN -Django pulls attendance records over ZK protocol

---

## 3. Tech Stack

### Backend (`backend/`)
| Package | Purpose |
|---------|---------|
| Django 5.x | Web framework |
| Django REST Framework 3.15 | REST API |
| django-cors-headers | CORS for the HR frontend and the (separate) mobile/employee-web apps |
| psycopg2-binary | PostgreSQL driver |
| PyJWT | JWT token auth -separate HR-user and Employee token flavors, each carrying its own role/permission claims |
| bcrypt | Password hashing |
| pyzk | ZKTeco/eSSL biometric device protocol |
| APScheduler | Scheduled biometric sync + Auto Sync rules + scheduled DB backups |
| reportlab | PDF generation -salary slips, offer/experience/resignation letters, ID cards |
| spacy | NLP for the Resume Screening feature (skills/education/experience extraction) |
| google-api-python-client | Google Drive upload target for scheduled backups |

### Frontend -HR Portal (`frontend/`)
| Package | Purpose |
|---------|---------|
| React 19 + Vite | UI framework + dev server |
| Wouter | Client-side routing |
| TanStack Query | Server state, caching, polling (used for near-live notification/badge counts) |
| Tailwind CSS v4 + shadcn/ui | Styling and component library ("clay" glassmorphism visual language) |
| Recharts | Charts and graphs |
| Orval (generated, `lib/api-client/`) | Type-safe API hooks from the OpenAPI spec, supplemented by hand-written hooks in `custom-hooks.ts` for endpoints not on the generated spec |
| Lucide React | Icons |

### Employee-facing apps (separate repositories, not in this repo)
| App | Stack | Notes |
|-----|-------|-------|
| Employee Mobile App | React Native + Expo, Expo Router, TanStack Query | Punch, leave/permission/casual-leave submission, geo-attendance & on-duty, missing-punch requests, salary slip, ID card, chat, department-manager approvals |
| Employee Web App | React + Vite | Browser equivalent of the mobile app for employees without the app installed |

Both authenticate with employee JWTs against the same `/api/*` surface documented in [Section 9](#9-api-reference) and [Section 13](#13-mobile-app-integration).

---

## 4. Modules & Features

The sections below follow the HR Portal's actual sidebar grouping. Every module is gated per-role by the hierarchical permission system described in [4.11](#411-account-management--rbac) -a role can be given `hidden` / `view` / `edit` on any module, and on several modules (Settings, Employees, Recruitment) down to individual sub-tabs.

### 4.1 Dashboard
- Live attendance summary (present / absent / on leave today), gender breakdown
- Pending-action tiles: leave, permission, casual leave, missing punch, resume screening candidates awaiting review, document-completion percentage
- Recruitment snapshot: open jobs, pending applicants
- Monthly salary totals (production vs. staff)
- Auto Sync button -pulls biometric attendance on demand, in addition to the two scheduled daily syncs (see [Section 11](#11-biometric-integration))

### 4.2 Employees
- Full employee directory with search, filters, and Excel-like bulk view
- Add / edit employee profiles (code, name, department, designation, bank details, ID proof, PF/ESI/UAN, branch, gender, initial salary)
- Employment type: **Production** (daily/weekly wage, segment-based attendance) or **Staff** (monthly salary, Strict/Simple attendance mode)
- Bulk Upload -separate Download/Upload flows for Staff and Production, and a separate **Update Employees** upload that patches existing records by Employee Code without touching the create flow
- Employee Documents -per-employee document checklist with completion-percentage tracking (Section 4.6)
- Branch, Departments, and Designations are managed as their own sub-pages under this group

### 4.3 Attendance & Shift Management

This is the most heavily-configurable area of the system -see [Section 5](#5-attendance-engine-in-depth) for the full mechanics. Summary:

- **Two staff attendance modes**, switchable in Settings → Attendance → Staff:
  - **Strict Mode** -tracks all 4 punches (morning in, lunch out, lunch return, evening out); additionally polices lunch-break duration.
  - **Simple Mode** -only the first and last punch of the day matter; no lunch tracking.
  - Both modes share the same Full/Half-Shift decision (a first *and* a distinct last punch, both within the configurable **Shift Punctuality Window** of the employee's assigned shift).
- **Production attendance** uses a separate segment-based engine (configurable punch windows + per-segment shift value); Sunday is a normal working day for production, unlike staff.
- **Manage Shift** -shift templates (start/end time, grace period, first-half-end, lunch duration/grace, gender rule), bulk or per-employee assignment, an Assigned/Unassigned toggle to find employees with no shift, and company-wide *default* timings (grace/lunch fields only -start/end time is always per-shift) that pre-fill new shifts.
- **Late Detection & Without Permission policy** (Settings → Late Detection) -fully HR-configurable free-allowance-plus-slab-table deduction rules, decoupled from code. See [Section 5](#5-attendance-engine-in-depth).
- **Geo Attendance & On-Duty** -geofenced office punch-in/out from the mobile/web app (radius configured per Branch), plus a separate destination-based On-Duty flow for field work with department-head approval and live location tracking.
- **Missing Punch** -employee-submitted correction requests for a forgotten punch (4 punch slots: morning in, lunch out, lunch return, evening out), approved by the department head or HR.
- **Manual Punch Import** -bulk Excel import of punches for special cases (device outage, historic backfill).
- **Auto Sync Rules** -scheduled biometric pulls beyond the two fixed daily times, configurable per device.
- **Attendance Search** and **Report Log** -cross-employee search and a two-mode (summary/detail) report log.
- **Night Shift Relaxation** -employees who work late into the night are excused from being marked Late the next morning, within a configurable window derived from each employee's own shift end time (never a fixed clock time).

### 4.4 Leave & Holiday
- Leave types with configuration (CL, SL, EL, ML, etc.)
- Leave balance allocation per employee per year, carry-forward support
- Leave request approval/rejection with HR comment, attributable to whoever approved it (HR or a department head)
- Permission requests -an approved Permission also participates in the Late Detection pool (see [Section 5](#5-attendance-engine-in-depth))
- Holiday calendar (national / regional / company) by branch and department
- Approved leave automatically reflected in attendance records -no separate entry needed

### 4.5 Casual Leave (CL)
- Paid leave, staff-only, one per calendar month, eligible after 6 months of service
- Separate from Leave/Permission -its own request table and approval flow
- Approve/reject from HR Portal or from a Department Head's mobile Approvals tab
- Approving/rejecting automatically writes the attendance record for that date -payroll picks it up with no manual step

### 4.6 Recruitment
- **New Joinees** -offer letter generation and email delivery
- **Resignations** -employee-submitted, department-head first-stage approval, HR final approval
- **Required Roles** -department headcount planning
- **Interviews** -scheduling
- **Resume Screening** -upload resumes against an HR-defined rule set (education tier, experience, required/soft skills); a spaCy-based NLP pipeline extracts and scores candidates automatically, with a full explainable "why this score" view per candidate and a 4-stage pipeline (Upload → Screening → Pipeline → Overview)
- **Documents** -Company Documents (offer/experience/resignation letter and salary-slip templates, themeable) and per-employee Employee Documents (checklist + completion stats)

### 4.7 Payroll, Salary & Settlement
- Full payroll engine for both production and staff employees
- Production employees: daily/weekly wage × segments worked
- Staff employees: monthly salary ÷ working days × effective present days (Full/Half Shift), with the configurable Late Detection and Without Permission deduction pools layered on top (see [Section 5](#5-attendance-engine-in-depth))
- Deductions: PF, ESI, advances, Late Attendance penalty, Without Permission penalty
- Payroll breakdown drawer per employee -full day-by-day traceability of every deduction
- Skip-check dry run before generating a batch, so HR can see *why* an employee will be skipped before running it
- Salary Slip -premium PDF generation (reportlab), single or bulk download/email, Excel export
- Settlement -advance loans with repayment schedules

### 4.8 Digital ID Card
- Template-driven ID card generator (colors, fonts, corner style, logo position -configurable in Settings)
- Separate staff (vertical) and production (horizontal) card layouts, each with a QR-code back face
- QR code encodes a public verification URL (`/verify-employee/<code>`) -no login required to check an ID card's authenticity
- Bulk generation, bulk print, and bulk ZIP download

### 4.9 Promotions, Increments & Bonus
- Record department/designation changes with an effective date and notes
- Track salary increments against each employee's initial salary baseline
- Bonus tracking

### 4.10 Reports
- Attendance log, attendance summary, attendance search
- Leave report, leave balance report
- Payroll report, PF/ESI report
- Employee report, headcount report
- Settlement report, new joinings report
- CSV/Excel export for all reports

### 4.11 Account Management & RBAC
- **Account Management** -the canonical place to create HR users and assign roles; roles are built from a hierarchical module tree (parent modules like *Settings* or *Employees* cascade a permission level down to their children unless a child has its own override)
- **User Management (Department Approvers)** -assign existing employees as department-level managers who can approve their team's Leave / Permission / Casual Leave / Missing Punch / Resignation / On-Duty requests from the mobile app, independently toggled per request type
- **Activity Logs** -audit trail of HR actions
- **Login Devices** -Super-Admin-only view of every active HR login session (device, IP, last-seen), with remote revoke
- **Chat**, **Notifications** -internal messaging and a near-live (polled) notification feed with an unread badge

### 4.12 Settings
Tabbed configuration, each tab independently permissioned:
- **Company** -name, logo, contact details, documents/PDF branding
- **Attendance** -Staff (Strict/Simple mode, punctuality window, half-shift late reference, night relaxation toggle, default new-shift timings) and Production (segment windows) sub-tabs -see [Section 5](#5-attendance-engine-in-depth)
- **Late Detection** -the Late Attendance and Without Permission deduction pools, each with its own free allowance and editable slab table
- **Devices** -biometric device registration and multi-device sync targets
- **Company Documents** -offer/experience/resignation letter and salary-slip PDF theming
- **Payroll** -PF/ESI rates, pay day, production pay type, PF/EF salary-range rules
- **Salary Slip** -company branding for the slip PDF, minimum wage rate, signature
- **SMTP / Email** -outbound mail configuration for slips, letters, and notifications
- **Backup** -scheduled PostgreSQL backups to a local directory and/or Google Drive, with a restore management command

---

## 5. Attendance Engine In-Depth

The rules below live in `backend/api/shift_engine.py` and `backend/api/attendance_final.py`, and every threshold mentioned is HR-editable in Settings → Attendance / Late Detection (`PayrollSettings` model) -none of it is hardcoded, so the same codebase can be repointed at a different company's policy without a code change.

### Full vs Half Shift (staff, both modes)
A day is **Full Shift** only when a first punch *and* a distinct last punch both exist **and** both fall within the **Shift Punctuality Window** (`shiftPunctualityWindowMinutes`, default 60 min) of the employee's assigned shift's start/end time. Anything else with at least one punch is **Half Shift**; zero punches (and not on leave/holiday) is **Absent**. No assigned shift means no reference to check against, so an unassigned employee is never flagged late by this mechanism.

- **Half Shift Late Reference** -on a day that resolves to Half Shift, "Late" is decided purely by whether the first punch is strictly after a separate configured time (`halfShiftLateReferenceTime`, default 2:30 PM) -nothing to do with the shift's own start time or grace period.
- **Night Shift Relaxation** can upgrade a punctuality-caused Half Shift back to Full once the day completes, for employees who worked late the previous night (see 4.3).

### Strict vs Simple Mode (staff)
Both share the Full/Half decision above. The only difference:
- **Strict** additionally tracks the lunch break: a first-half-end window locates the lunch-out/lunch-return punches, and returning late from lunch (`lunchDurationMinutes` + `lunchGraceMinutes`) sets a separate lunch-return lateness flag.
- **Simple** only looks at the first and last punch of the day -no lunch tracking at all.

### Late Detection policy (Settings → Late Detection → Late Attendance)
Every month, an employee's plain lates (grace-exceeded arrivals, Half-Shift-day lateness, and strict-mode lunch-return lateness) are added to their approved Permission count into **one shared pool**. The first `lateFreeAllowance` (default 3) are free; every occurrence past that is "billable," and an HR-editable slab table (`lateDeductionSlabs`, e.g. "every 3 billable = ¼ shift") decides the shift deduction. An empty slab table disables the penalty entirely. This is the same mechanism that used to be a hardcoded `(billable // 3) * 0.25` formula -now fully configurable, with the shipped defaults reproducing the old hardcoded behavior exactly.

### Without Permission detection (Settings → Late Detection → Without Permission)
A separate, independent pool layered on top of the above, covering the narrow zone **between** the shift's small grace period and the wider punctuality window (i.e. before a day would be capped at Half Shift):

- **Morning (late-in):** arriving in that zone with an approved Permission requested near the shift's start time → no detection at all. Without one → flagged Late and tagged **Without Permission**.
- **Evening (early-out) -new, didn't exist before this feature:** leaving in the mirror zone before shift end with an approved Permission requested near the shift's end time → no detection. Without one → flagged Late and tagged **Without Permission**.
- Beyond either zone, the existing Half Shift rule takes over unchanged -this feature only ever governs the narrower "borderline but not yet Half Shift" band.
- A Permission with no time recorded is treated as covering whichever side actually happened that day (the model only ever stored one optional time per request, not a typed "morning" vs "evening" permission).
- Its own free allowance (`withoutPermissionFreeAllowance`, ships at **0**) and slab table (`withoutPermissionDeductionSlabs`, ships **empty** -i.e. zero payroll impact until HR explicitly configures it) -deliberately independent from the Late Attendance pool above, so the two never double-count the same occurrence, and every existing employee's payroll is byte-for-byte unchanged until this pool is turned on.

### Production attendance
A separate segment-based engine (`ProductionShiftConfig` / `ProductionShiftSegment`) -each configurable punch window (e.g. first half / second half / extra half) earns its own shift fraction independent of the staff Strict/Simple rules above. Sunday is a normal working day for production.

---

## 6. Project Structure

```
UK-textile/
├── backend/
│   ├── api/
│   │   ├── models.py                       # All DB models (60+ migrations' worth)
│   │   ├── views.py                        # Employees, dashboard, auth
│   │   ├── attendance_final.py             # Canonical attendance engine — compute_day_record/
│   │   │                                   #   compute_month_records, mode-aware, single source
│   │   │                                   #   of truth for Payroll/Salary
│   │   ├── shift_engine.py                 # Strict-mode 4-punch engine, punctuality window,
│   │   │                                   #   Half Shift late reference, Without Permission detection
│   │   ├── attendance_views.py             # Attendance endpoints + biometric sync API
│   │   ├── manual_attendance_import_views.py
│   │   ├── missing_punch_views.py
│   │   ├── auto_sync.py / auto_sync_views.py
│   │   ├── geo_attendance_views.py         # Geo punch + On-Duty sessions/verifications
│   │   ├── geo_utils.py
│   │   ├── night_shift.py / night_shift_views.py
│   │   ├── shift_views.py                  # Shift templates and assignments
│   │   ├── leave_views.py                  # Leave types, balances, requests, permissions, holidays
│   │   ├── casual_leave_views.py
│   │   ├── payroll_views.py                # Full payroll engine + Late Detection/Without
│   │   │                                   #   Permission pools + Settings GET/PUT
│   │   ├── payroll_progress.py
│   │   ├── salary_slip_views.py / salary_slip_bulk_pdf.py / salary_slip_bulk_progress.py
│   │   ├── settlement_views.py             # Advances and repayments
│   │   ├── recruitment_views.py            # Jobs, applicants, new joinees, resignations
│   │   ├── resume_screening_ml.py / resume_screening_views.py / resume_screening_progress.py
│   │   ├── company_documents_views.py / employee_documents_views.py / document_pdf.py
│   │   ├── manager_views.py                # Department manager CRUD + mobile approval endpoints
│   │   ├── hr_user_views.py                # HR portal users
│   │   ├── permission_registry.py          # Canonical hierarchical module/permission tree
│   │   ├── permission_middleware.py        # Enforces it per-request
│   │   ├── auth.py / jwt_utils.py / session_utils.py
│   │   ├── login_sessions_views.py         # Login Devices — active session list + revoke
│   │   ├── backup_service.py / backup_scheduler.py / backup_views.py / google_drive.py
│   │   ├── maintenance_middleware.py       # Serves a maintenance page during restore
│   │   ├── org_views.py                    # Branches and designations
│   │   ├── branch_scope.py                 # Per-branch data scoping helper
│   │   ├── reports_views.py                # All report endpoints
│   │   ├── chat_views.py
│   │   ├── growth_views.py
│   │   ├── audit_utils.py                  # Activity Logs
│   │   ├── serializers.py                  # Shared JSON serializers
│   │   ├── apps.py                         # APScheduler startup (biometric sync, auto sync, backups)
│   │   ├── urls.py                         # All URL routing
│   │   └── migrations/
│   ├── management/commands/
│   │   ├── sync_biometric.py               # python manage.py sync_biometric
│   │   └── restore_backup.py
│   └── config/settings.py
│
├── frontend/
│   ├── src/
│   │   ├── pages/hr/                       # ~35 page components — one per sidebar item
│   │   │   ├── Dashboard.tsx / Employees.tsx / Attendance.tsx / GeoAttendance.tsx
│   │   │   ├── ManageShift.tsx / MissingPunch.tsx / ManualPunchImport.tsx / AttendanceSearch.tsx
│   │   │   ├── LeaveHoliday.tsx / CasualLeave.tsx / ApprovedRequests.tsx
│   │   │   ├── PayrollFull.tsx / Salary.tsx / SalarySlip.tsx / Settlement.tsx
│   │   │   ├── Interviews.tsx / BulkUploadEmployees.tsx
│   │   │   ├── AccountManagement.tsx / UserManagement.tsx / ActivityLogs.tsx / LoginDevices.tsx
│   │   │   ├── Settings.tsx                # Every tab described in 4.12
│   │   │   └── ...
│   │   ├── components/
│   │   │   ├── EmployeeSearchSelect.tsx    # Dynamic employee search by code
│   │   │   ├── HrLayout.tsx                # View-only fieldset lock per permission level
│   │   │   └── ui/dashboard-sidebar.tsx    # Sidebar, pending badges, permission-filtered nav
│   │   └── lib/
│   │       ├── permission-modules.ts       # Frontend mirror of permission_registry.py
│   │       └── api-client/
│   │           ├── custom-hooks.ts         # Hand-written hooks for endpoints off the OpenAPI spec
│   │           └── index.ts                # Orval-generated hooks
│
├── docs/                                   # See the doc links at the top of this file
└── README.md
```

---

## 7. Setup & Installation

### Prerequisites
- Python 3.11+
- Node.js 20+
- PostgreSQL 15+

### Step 1 -Database

```bash
# Create the database
psql -U postgres
CREATE DATABASE uk_textile;
\q
```

### Step 2 -Backend

```bash
cd backend

# Create virtual environment
python -m venv .venv

# Activate (Windows)
.venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Copy and edit environment file
copy .env.example .env
# Edit .env -see Environment Variables section below

# Run migrations
python manage.py migrate

# Start backend
python manage.py runserver 8080
```

API is live at: `http://localhost:8080/api`
Health check: `GET http://localhost:8080/api/healthz`

### Step 3 -Frontend

```bash
cd frontend

npm install

# Copy environment file
copy .env.example .env
# Set VITE_API_URL if needed (default is relative /api which proxies to 8080)

npm run dev
```

HR Portal: `http://localhost:5173`

### HR Login

Auth is backed by the `hr_users` table (`HRUser` model), not a single hardcoded credential. On first startup (`AppConfig.ready()`), the backend bootstraps one Super Admin account from `ADMIN_USERNAME` / `ADMIN_PASSWORD` in `.env` if that username doesn't already exist — from then on, that Super Admin creates every other HR account (and its role) from **Account Management** in the portal itself.

| Field | Value |
|-------|-------|
| Username | `ADMIN_USERNAME` from `.env` (default `admin`) |
| Password | `ADMIN_PASSWORD` from `.env` |

Every subsequent HR user gets a role built from the hierarchical permission tree described in [4.11](#411-account-management--rbac) — `hidden` / `view` / `edit` per module, cascading from parent to child unless a child overrides it.

### Biometric Sync (manual)

```bash
# Sync today's records
python manage.py sync_biometric --today

# Sync last 3 days
python manage.py sync_biometric --days 3

# Sync all records from device
python manage.py sync_biometric --all
```

The scheduler in `apps.py` runs this automatically at **7:30 AM** and **8:30 PM IST** when the Django server is running.

---

## 8. Environment Variables

Create `backend/.env` from `.env.example`:

```env
# Database (discrete fields, not a DATABASE_URL)
DB_HOST=localhost
DB_PORT=5432
DB_NAME=uk_textile
DB_USER=postgres
DB_PASSWORD=password

# Bootstraps the one Super Admin HR account on first startup only —
# afterwards, all other HR accounts/roles are created from Account
# Management in the portal itself, not from this file.
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change_this_password

# JWT signing key (keep secret, don't change after deployment)
JWT_SECRET=your_long_random_secret_key
# Django's own secret key (session/CSRF signing, separate from JWT_SECRET)
DJANGO_SECRET_KEY=your_django_secret_key

DEBUG=false
ALLOWED_HOSTS=localhost,127.0.0.1,your.domain.com

# CORS — comma-separated list of allowed frontend origins
CORS_ALLOWED_ORIGINS=http://localhost:5173,http://192.168.1.xx:5173,https://your-tunnel-domain.com

# Biometric device (eSSL e2008)
BIOMETRIC_DEVICE_IP=192.168.0.x
BIOMETRIC_DEVICE_PORT=4370
BIOMETRIC_DEVICE_PASSWORD=0
# Shared key the biometric-facing punch endpoint checks
BIOMETRIC_API_KEY=change-this-to-a-strong-random-key
```

Everything else — SMTP/email, PF/ESI rates, attendance mode and every threshold in [Section 5](#5-attendance-engine-in-depth), company branding, backup destinations — is configured live in **Settings** from the HR Portal (backed by the `payroll_settings` table), not in `.env`. This is deliberate: it lets a Super Admin repoint the whole system at a different company's policy without touching code or redeploying.

---

## 9. API Reference

All endpoints are prefixed with `/api/`. JWT token must be in the `Authorization: Bearer <token>` header for protected routes.

> This section covers the core, stable surface. The system has grown well past what fits in a readable table here — for the full and current route list, `backend/api/urls.py` is the source of truth. Feature areas not detailed below (Geo Attendance & On-Duty, Missing Punch, Manual Punch Import, Auto Sync Rules, Login Devices, Backup, Resume Screening, Company/Employee Documents, Chat, Notifications) each have their own `*_views.py` file named after the feature, plus a matching frontend hook group in `custom-hooks.ts` — [`docs/MOBILE_APP_V2_SPEC.md`](docs/MOBILE_APP_V2_SPEC.md) documents the employee-facing side of most of them in full.

### Auth

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/auth/hr-login` | HR admin login → returns `{ token }` |
| POST | `/auth/employee-login` | Employee login by `identifier` (code, phone, or email) + password → returns `{ token, role, employeeId, name }` |
| GET | `/auth/me` | Current user info |
| POST | `/auth/set-password` | Set/change employee password |

### Organisation

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET/POST | `/branches` | List / create branches |
| GET/POST | `/departments` | List / create departments |
| GET/POST | `/designations` | List / create designations |

### Employees

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET/POST | `/employees` | List all / create employee |
| GET/PUT/DELETE | `/employees/<id>` | Get / update / delete employee |
| PATCH | `/employees/<id>/status` | Change active status |

### Attendance

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/attendance` | Daily attendance list |
| GET | `/attendance/summary` | Today's summary (present/absent/late) |
| GET | `/attendance/daily` | Day-level breakdown |
| GET | `/attendance/monthly-trend` | Monthly trend data |
| GET | `/attendance/employee/<id>` | Per-employee attendance history |
| POST | `/attendance/manual` | Add manual attendance record |
| POST | `/attendance/sync-biometric` | Trigger biometric sync via API |
| POST | `/biometric/punch` | Record a punch (from mobile/device) |

### Leave & Holiday

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET/POST | `/leave-types` | Leave type configuration |
| GET | `/leave-balances` | Leave balances (filtered by employee/year) |
| POST | `/leave-balances/allocate` | Allocate leave days to an employee |
| GET/POST | `/leave-requests` | List / submit leave request |
| PATCH | `/leave-requests/<id>/status` | HR approves/rejects leave |
| DELETE | `/leave-requests/<id>` | Delete leave request |
| GET/POST | `/permissions` | List / submit permission requests |
| PUT/DELETE | `/permissions/<id>` | HR updates/deletes permission |
| GET/POST | `/holidays` | Holiday calendar |

### Payroll

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET/POST | `/payroll` | List / generate payroll runs |
| GET | `/payroll/<id>/breakdown` | Per-employee detailed breakdown, including the Late Attendance and Without Permission deduction summaries (see [Section 5](#5-attendance-engine-in-depth)) |
| POST | `/payroll/skip-check` | Dry-run: see which employees would be skipped, and why, before generating |
| GET/PUT | `/payroll-settings` | The single shared configuration record behind every Settings tab (Company/Attendance/Late Detection/Payroll/Salary Slip/SMTP) — one endpoint, gated per-field by which settings.* permission group each submitted field belongs to (`FIELD_GROUPS` in `payroll_views.py`) |

### Department Managers

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET/POST | `/department-managers` | List all / create manager (HR only) |
| GET/PUT/DELETE | `/department-managers/<id>` | Detail / update / remove |
| POST/DELETE | `/department-managers/<id>/departments` | Assign / remove a department |
| POST/DELETE | `/department-managers/<id>/employees` | Assign / remove an individual employee |

### Mobile -Manager Approvals

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/manager/me` | Manager profile + `isManager`, `canSubmitLeave`, `pendingApprovalsCount` |
| GET | `/manager/pending-requests` | Team's pending leave + permission requests |
| PATCH | `/manager/leave-requests/<id>/status` | Approve / reject a leave |
| PATCH | `/manager/permissions/<id>/status` | Approve / reject a permission |

### Dashboard

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/dashboard/hr-summary` | HR portal dashboard stats |
| GET | `/dashboard/employee-summary` | Employee mobile app dashboard (includes `isManager`) |

---

## 10. Database Schema

### Core tables

| Table | Purpose |
|-------|---------|
| `branches` | Factory branches |
| `departments` | Departments within a branch |
| `designations` | Job titles, linked to department |
| `employees` | All employee records (code, name, bank, PF, ESI, etc.) |

### Attendance

| Table | Purpose |
|-------|---------|
| `attendance` | Legacy/manual present flag, still used for one-off manual entries |
| `attendance_logs` | Raw biometric/manual punches (in/out times) — the input every engine reads from |
| `attendance_day_records` | **The final per-day verdict** — status, `is_late`, `is_half_shift`, `late_in_without_permission`, `early_out_without_permission`, shifts earned. Single source of truth for Payroll/Salary; `source="manual"` rows are HR overrides that are never auto-recomputed |
| `daily_shift_log` | Strict-mode-only internal detail (punch1–4, lunch timing) that feeds `attendance_day_records` |
| `night_shift_relaxations` | Per-employee grants excusing next-morning lateness after a late night shift |
| `on_duty_sessions` / `on_duty_punch_verifications` | Destination-based field-work sessions and their punch verification |
| `biometric_devices` | Registered eSSL devices, sync targets, `last_synced_at` |
| `auto_sync_rules` | Extra scheduled biometric pulls beyond the two fixed daily times |
| `missing_punch_requests` | Employee-submitted forgotten-punch corrections (4 punch slots) |

### Leave

| Table | Purpose |
|-------|---------|
| `leave_types` | CL, SL, EL, etc. with configuration |
| `leave_balances` | Per-employee per-year allocation and remaining |
| `leave_requests` | Employee leave requests with status, `approvedBy`/`approverRole` |
| `employee_permissions` | Short-leave / permission requests — one date + one optional time; feeds both the Late Attendance and Without Permission pools ([Section 5](#5-attendance-engine-in-depth)) |
| `casual_leaves` | Separate paid-leave-per-month request table (staff only) |
| `holidays` | Holiday calendar |

### Shift & Payroll

| Table | Purpose |
|-------|---------|
| `shift_templates` | Staff shift definitions — start/end time, grace period, first-half-end, lunch duration/grace, gender rule |
| `employee_shift_assignments` | Employee → shift mapping with overrides |
| `production_shift_config` / `production_shift_segments` | Production's segment-based attendance windows |
| `payroll` | Payroll run records per employee per month, including the Late Attendance and Without Permission penalty line items |
| `payroll_settings` | The single row (singleton) behind every Settings tab — attendance mode, punctuality window, Half Shift late reference, both deduction pools' free allowance + slab tables, PF/ESI rates, SMTP, backup config, and more |
| `salary_slips` | Generated salary slip snapshot (PDF + `breakdown_details` JSON) — written at generation time, not recomputed live |
| `salary_records` | Legacy salary records |

### Settlement

| Table | Purpose |
|-------|---------|
| `advances` | Loan/advance records |
| `advance_repayments` | Monthly repayment schedule |

### User Management & Auth

| Table | Purpose |
|-------|---------|
| `department_managers` | Employees designated as department approvers |
| `manager_department_assignments` | Manager ↔ Department mapping |
| `manager_employee_assignments` | Manager ↔ Individual employee (cross-dept) |
| `hr_users` | HR portal accounts (super admin bootstrapped from `.env`, everyone else created via Account Management) |
| `roles` | Hierarchical permission-tree role definitions ([4.11](#411-account-management--rbac)) |
| `login_sessions` | Active HR login sessions — device, IP, last-seen — for the Login Devices page |
| `audit_logs` | Activity Logs — who did what, when |

### Recruitment & Documents

| Table | Purpose |
|-------|---------|
| `jobs` / `applicants` | Core recruitment |
| `hiring_rule_sets` / `screening_candidates` | Resume Screening — HR-defined scoring rules and the NLP-scored candidates against them |
| `company_document_settings` | Offer/experience/resignation letter and salary-slip PDF theming |
| `employee_documents` | Per-employee document checklist + completion tracking |

### Other

| Table | Purpose |
|-------|---------|
| `notifications` | In-app notifications |
| `employee_requests` | Mobile app general requests (salary enquiry, etc.) |
| `backup_schedules` / `backup_drive_configs` | Scheduled DB backup config (local + Google Drive) |
| `chat_messages` | Internal chat |

---

## 11. Biometric Integration

**Device:** eSSL e2008 Face Recognition Terminal  
**Protocol:** ZKTeco/ICLOCK over TCP port 4370  
**Library:** pyzk  

The device stores all attendance punches in internal memory. Django **pulls** records from it on a schedule -the device does not push to the server.

```
eSSL e2008 (192.168.0.x:4370)
        ▲
        │  ZK Protocol (TCP)
        │  "give me records since last sync"
        │
  Django sync_biometric command
        │
        ▼
  attendance_logs table  →  Payroll, Reports, Attendance views
```

### Sync methods

| Command | What it syncs |
|---------|--------------|
| `python manage.py sync_biometric --today` | Today's records |
| `python manage.py sync_biometric --days 3` | Last 3 days |
| `python manage.py sync_biometric --all` | All records on device |

### Automatic sync schedule

Configured in `backend/api/apps.py` using APScheduler:

```
07:30 AM IST  →  sync today's records
08:30 PM IST  →  sync today's records (captures end-of-day punches)
```

The scheduler starts when Django starts (`AppConfig.ready()`). It also runs at 7:30 AM so morning punches are available in the HR Portal before HR logs in.

### Manual sync from HR Portal

Both the **Dashboard** and **Attendance** pages have an **Auto Sync** button that calls `POST /api/attendance/sync-biometric` and invalidates all attendance queries.

---

## 12. User Management & Department Approvals

### The problem it solves

As the employee count grows across departments, HR alone cannot review every leave and permission request. This feature delegates approval authority to a senior employee in each department.

### How it works

```
HR Portal
  └─ User Management → Create User (by employee code)
       └─ Assign: Department(s) and/or individual employees
            └─ DepartmentManager record created in DB
                  │
                  ├─ Mobile App: isManager = true
                  │    └─ "Approvals" tab appears
                  │    └─ Can approve/reject team's requests
                  │
                  └─ GET /manager/pending-requests
                       └─ Returns all pending Leave + Permission + Casual
                          Leave + Attendance Correction + Resignation
                          requests from assigned departments/employees,
                          merged in one call
```

### Approval flow

1. **Employee submits** a Leave, Permission, Casual Leave, Attendance Correction, or Resignation request from the mobile app
2. **Manager opens** the Approvals tab in their mobile app
3. **Manager taps** Approve / Reject with optional comment
4. **Status updates** immediately via the matching `PATCH /manager/<type>/{id}/status` endpoint -approving Casual Leave or an Attendance Correction also writes straight to that employee's attendance record, so payroll picks it up automatically
5. **HR can still see and act on** every request type from the HR Portal web pages -the mobile Approvals tab is the Department Head's interface, HR doesn't need the mobile app

### Permissions in HR Portal

Each of the five approval types is gated independently per manager:

| Setting | Effect |
|---------|--------|
| Can Approve Leaves ✓ | Manager can approve/reject leave requests |
| Can Approve Permissions ✓ | Manager can approve/reject permission requests |
| Can Approve Resignations ✓ | Manager can approve/reject resignations (first-stage; HR does final approval) |
| Can Approve Attendance ✓ | Manager can approve/reject HR-submitted attendance corrections |
| Can Approve Casual Leave ✓ | Manager can approve/reject Casual Leave requests |
| Active | Whether the manager can log in with manager access at all |

> **Important:** All five permissions default to **enabled** when creating a user. If you see a 403 with a `code` like `APPROVE_LEAVES_DISABLED` on a PATCH request from mobile, open User Management → Details → verify the matching permission toggle is green.

### Cross-department assignments

A manager assigned to "Cutting" department can also have individual employees from "Finishing" directly assigned -they will appear in the same Approvals queue regardless of their department.

---

## 13. Mobile App Integration

The React Native app communicates with the same Django backend using employee JWT tokens.

**→ For the current, fully detailed page-by-page spec (every screen, exact endpoint, exact DB table, business rules, and what's still pending), see [`docs/MOBILE_APP_V2_SPEC.md`](docs/MOBILE_APP_V2_SPEC.md).** The summary below is kept short and may lag behind that doc as the mobile app evolves -treat the spec as the source of truth.

### Authentication

```
POST /api/auth/employee-login
Body: { identifier: "30020", password: "••••" }   // identifier = employee code, phone, or email
Returns: { token: "eyJ...", role: "employee", employeeId, name }
```

Store the token in SecureStore. Send it as `Authorization: Bearer <token>` on every request.

### Employee Dashboard

```
GET /api/dashboard/employee-summary?employeeId=<id>
Returns:
  presentDays, absentDays, leaveDays, leaveBalance,
  pendingRequests, approvedLeaves, recentSalaries,
  isManager, canSubmitLeave, pendingApprovalsCount
```

Use `isManager` to:
- Show/hide the Leave & Request submission tabs
- Show/hide the 5th "Approvals" tab

### Leave submission

```
POST /api/leave-requests
Body: {
  employeeCode: "30020",
  leaveTypeId: 1,
  startDate: "2026-07-01",
  endDate: "2026-07-01",   // same as startDate for single day
  reason: "Personal work"
}
```

### Permission submission

```
POST /api/permissions
Body: {
  employeeCode: "30020",
  date: "2026-07-01",
  permissionTime: "14:00",
  reason: "Doctor appointment"
}
```

### Attendance

```
GET /api/attendance/employee/<id>?month=7&year=2026
Returns: array of daily attendance records
```

### Manager -Approvals tab

```
GET /api/manager/me
→ isManager, pendingApprovalsCount, assignedDepartments, assignedEmployees

GET /api/manager/pending-requests?status=pending
→ { leaveRequests: [...], permissions: [...], totalPending: N }

PATCH /api/manager/leave-requests/<id>/status
Body: { status: "approved" | "rejected", comment: "optional" }

PATCH /api/manager/permissions/<id>/status
Body: { status: "approved" | "rejected", comment: "optional" }
```

### Bottom navigation

Current tabs: **Home · Leave · Alerts · Profile · Approval** (the Approval tab only appears when `GET /manager/me` succeeds for the logged-in employee -see `docs/MOBILE_APP_V2_SPEC.md` for the full page-by-page breakdown, including the larger side-drawer navigation: Attendance, Salary Slip, Permission, My Shift, ID Card, Holidays, Chat, Resignation, etc.)

---

## 14. Deployment (On-Premise)

The system is designed for on-premise deployment on the company's own PC, on the same LAN as the biometric device, with Nginx + Cloudflare Tunnel exposing it publicly under a real domain.

**→ Full step-by-step deployment runbook: [`docs/DEPLOYMENT_GUIDE.md`](docs/DEPLOYMENT_GUIDE.md)** -covers Django (via `waitress`, not the dev `runserver`), Nginx reverse proxy config, Cloudflare Tunnel setup, all three services wired up with NSSM for auto-start on boot, the mobile app handoff, and a troubleshooting cheat sheet built from two real deployment bugs (a non-portable `.venv` and an NSSM/`waitress-serve.exe` gotcha) -read that doc before deploying, it will save you from re-hitting both.

### Why on-premise

- Biometric device communicates over local LAN only (TCP 4370 -not internet-accessible)
- No internet dependency for attendance punches
- Data stays within the company network
- Zero cloud cost

### Access matrix (once deployed per the guide above)

| Who | URL | Network |
|-----|-----|---------|
| HR Portal | `http://192.168.x.x` (LAN) or the public domain | Office LAN / Internet |
| Biometric device | `http://192.168.x.x:4370` | Office LAN only |
| Employee mobile app | `https://<your-domain>/api` | Internet (Cloudflare Tunnel) |

All three point to the same Django server and the same PostgreSQL database -nothing is duplicated or mirrored.

**Cost:** Only the domain name. Cloudflare account, Tunnel, and TLS are free.

### Auto power on/off (optional)

| What | How |
|------|-----|
| Auto power on at 8 AM | BIOS → Power Management → RTC Wake / Scheduled Power On |
| Auto shutdown at 10 PM | Windows Task Scheduler → `shutdown /s /t 0` at 22:00 |

Accepted tradeoff: the public site is only reachable while the PC is powered on -fine for a single-location factory used only during working hours.

---

## Contributing / Development Notes

- Employee Code is the **primary human identifier** across all modules. Numeric DB IDs are used internally only.
- All POST endpoints accept both camelCase and snake_case field names (for React Native compatibility).
- Leave approval automatically reflects in attendance -no separate attendance record needed.
- `GET /api/dashboard/employee-summary` is the single source of truth for what an employee can do in the mobile app (`isManager`, `canSubmitLeave`).
- APScheduler runs inside Django's `ready()` -in development with auto-reload, Django starts twice; `RUN_MAIN` check prevents double scheduling.
