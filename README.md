# UKTextiles HR & ERP System

A complete, on-premise HR and ERP platform built for UKTextiles — a garments manufacturing company. The system covers attendance (biometric), leave, payroll, shift management, settlement, reporting, and a React Native employee mobile app.

**Related documents in `docs/`:**
- [`docs/MOBILE_APP_V2_SPEC.md`](docs/MOBILE_APP_V2_SPEC.md) — current, authoritative page-by-page mobile app spec (endpoints, DB tables, business rules, what's built vs. pending)
- [`docs/DEPLOYMENT_GUIDE.md`](docs/DEPLOYMENT_GUIDE.md) — full step-by-step on-premise deployment runbook (Nginx + Waitress + Cloudflare Tunnel + NSSM services), including a postmortem of two real deployment bugs worth knowing about in advance
- [`docs/MOBILE_INTEGRATION.md`](docs/MOBILE_INTEGRATION.md) — older, terser API reference (superseded by `MOBILE_APP_V2_SPEC.md` where they overlap)
- [`docs/PROJECT_REVIEW.md`](docs/PROJECT_REVIEW.md) — full workflow review and known-issues list
- [`PortDetails.md`](PortDetails.md), [`BIOMETRIC_INTEGRATION.md`](BIOMETRIC_INTEGRATION.md), [`EMPLOYEE_MOBILE_APP_PROMPT.md`](EMPLOYEE_MOBILE_APP_PROMPT.md) — earlier research/planning notes, kept for history

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture](#2-architecture)
3. [Tech Stack](#3-tech-stack)
4. [Modules & Features](#4-modules--features)
5. [Project Structure](#5-project-structure)
6. [Setup & Installation](#6-setup--installation)
7. [Environment Variables](#7-environment-variables)
8. [API Reference](#8-api-reference)
9. [Database Schema](#9-database-schema)
10. [Biometric Integration](#10-biometric-integration)
11. [User Management & Department Approvals](#11-user-management--department-approvals)
12. [Mobile App Integration](#12-mobile-app-integration)
13. [Deployment (On-Premise)](#13-deployment-on-premise)

---

## 1. Project Overview

| Concern | Details |
|---------|---------|
| **Company** | UKTextiles — garments manufacturing |
| **Deployment** | On-premise (company PC, same LAN as biometric device) |
| **Users** | HR admin (web), Department managers (mobile), Employees (mobile) |
| **Scale** | ~266+ employees, 150,000+ attendance records |
| **Biometric device** | eSSL e2008 face recognition terminal (ZKTeco protocol) |

The system replaces manual HR work — attendance sheets, leave registers, salary slips — with a live digital system that syncs from the biometric device automatically.

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
- **Biometric device** is on the same LAN — Django pulls attendance records over ZK protocol

---

## 3. Tech Stack

### Backend
| Package | Version | Purpose |
|---------|---------|---------|
| Django | 5.1 | Web framework |
| Django REST Framework | 3.15 | REST API |
| django-cors-headers | 4.6 | CORS for React frontend and mobile app |
| psycopg2-binary | 2.9 | PostgreSQL driver |
| PyJWT | 2.9 | JWT token auth (HR + Employee tokens) |
| bcrypt | 4.2 | Password hashing |
| python-dotenv | 1.0 | `.env` config loading |
| pyzk | 0.9 | ZKTeco/eSSL biometric device protocol |
| APScheduler | 3.10 | Scheduled biometric sync (7:30 AM + 8:30 PM IST) |

### Frontend (HR Portal)
| Package | Purpose |
|---------|---------|
| React 19 + Vite | UI framework + dev server |
| Wouter | Client-side routing |
| TanStack Query | Server state, caching, polling |
| Tailwind CSS + shadcn/ui | Styling and component library |
| Recharts | Charts and graphs |
| Orval (generated) | Type-safe API hooks from OpenAPI spec |
| Lucide React | Icons |

### Mobile App (Employee)
| Package | Purpose |
|---------|---------|
| React Native + Expo | Cross-platform mobile app |
| Expo Router | Navigation |
| TanStack Query | API data fetching |

---

## 4. Modules & Features

### HR Portal

#### Dashboard
- Live attendance summary (present / absent / on leave today)
- Pending leave and permission request count
- Monthly salary totals (production vs. staff)
- Gender breakdown, open jobs, pending applicants
- Auto Sync button — pulls biometric attendance on demand
- Automatic biometric sync scheduled at **7:30 AM** and **8:30 PM IST** daily

#### Employees
- Full employee directory with search and filters
- Add / edit employee profiles (code, name, department, designation, bank details, ID proof, PF/ESI/UAN)
- Employment type: Production (daily/weekly wage) or Staff (monthly salary)
- Profile photo, emergency contact, father/mother name
- Status management (active / inactive / on leave / terminated)
- Employee code is the primary identifier across all modules

#### Attendance
- Daily and monthly attendance views
- Biometric sync — pulls eSSL e2008 records via ZK protocol
- Manual attendance entry for special cases
- Attendance history per employee (present / absent / on leave / late)
- Employee search by code in all attendance forms

#### Leave & Holiday
- Leave types with configuration (CL, SL, EL, ML, etc.)
- Leave balance allocation per employee per year, carry-forward support
- Leave request approval/rejection with HR comment
- Permission requests (up to 3 per month per employee)
- Holiday calendar (national / regional / company) by branch and department
- Single-day leave (one date picker) and multi-day leave (start + end date)
- Approved leave automatically reflected in attendance records (no separate entry needed)
- Tab-specific summary cards: Leave tab shows leave stats, Permissions tab shows permission stats

#### Payroll
- Full payroll engine for both production and staff employees
- Production employees: daily/weekly wage × days worked
- Staff employees: monthly salary ÷ working days × present days
- Deductions: PF, ESI, TDS, LOP, advances
- Allowances: HRA, TA, special
- Payroll breakdown drawer per employee (earnings vs. deductions)
- Salary slip generation and email delivery
- Shift-level overrides (custom start/end times, Saturday-off flag per employee)

#### Casual Leave (CL)
- Paid leave, staff-only, one per calendar month, eligible after 6 months of service
- Separate from Leave/Permission — its own request table and approval flow
- Approve/reject from HR Portal or from a Department Head's mobile Approvals tab
- Approving/rejecting automatically writes the attendance record for that date (present + paid, or unpaid leave) — payroll picks it up with no manual step

#### Night Shift Relaxation
- Employees who work late into the night are excused from being marked Late the next morning, within a configurable grace window
- Detected automatically from biometric punches (last night's checkout time), matched against rule-based thresholds (e.g. worked until 10:30 PM → allowed in until 10:00 AM)
- The threshold for "worked into the night" is derived from each employee's own assigned shift end time, never a fixed clock time — so a normal end-of-shift checkout is never mistaken for night work

#### Shift Management
- Shift templates (start time, end time, grace period, department, gender rule)
- Assign shifts to departments (bulk) or individual employees
- Per-employee override: custom start/end times and Saturday-off flag
- Production shift auto-sync
- Production attendance uses a segment-based engine (configurable punch windows + per-segment shift value) — Sunday is a normal working day for production, unlike staff

#### Digital ID Card
- Template-driven ID card generator (colors, fonts, corner style, logo position — configurable in Settings)
- Separate staff (vertical) and production (horizontal) card layouts, each with a QR-code back face
- QR code encodes a public verification URL (`/verify-employee/<code>`) — no login required to check an ID card's authenticity
- Bulk generation for multiple employees at once

#### Promotions & Increments
- Record department/designation changes with an effective date and notes
- Track salary increments against each employee's initial salary baseline
- Increment dashboard with summary stats

#### Settlement
- Advance loans with repayment schedules
- Payment method tracking
- Settlement report

#### Reports
- Attendance log, attendance summary
- Leave report, leave balance report
- Payroll report, PF/ESI report
- Employee report, headcount report
- Settlement report, new joinings report
- CSV export for all reports

#### User Management
- **Department Users (Approvers)** — assign existing employees as department-level managers
  - Search employee by code → assign as manager
  - Enable/disable: Can Approve Leaves, Can Approve Permissions
  - Assign whole departments and/or individual cross-department employees
  - Managers receive requests from their team in the mobile app
  - Click any manager → detail dialog with full assignment view and inline toggles
- **HR Portal Users** — separate admin accounts for the web portal
- **Roles & Permissions** — RBAC matrix (view/create/edit/delete/approve per module)

#### Requests (Approved Requests)
- Unified view of all Leave and Permission requests
- Period filter: Today / This Week / All
- One-click Approve / Reject from the list
- Sidebar badge with amber pulse animation showing pending request count

---

## 5. Project Structure

```
UK-textile/
├── backend/
│   ├── api/
│   │   ├── models.py              # All DB models
│   │   ├── views.py               # Employees, attendance, dashboard, auth
│   │   ├── leave_views.py         # Leave types, balances, requests, permissions, holidays
│   │   ├── attendance_views.py    # Attendance endpoints + biometric sync API
│   │   ├── shift_views.py         # Shift templates and assignments
│   │   ├── payroll_views.py       # Full payroll engine
│   │   ├── salary_slip_views.py   # Salary slip generation and email
│   │   ├── settlement_views.py    # Advances and repayments
│   │   ├── manager_views.py       # Department manager CRUD + mobile approval endpoints
│   │   ├── hr_user_views.py       # HR portal users and RBAC roles
│   │   ├── org_views.py           # Branches and designations
│   │   ├── reports_views.py       # All report endpoints
│   │   ├── serializers.py         # Shared JSON serializers
│   │   ├── auth.py                # JWT helpers and decorators
│   │   ├── apps.py                # APScheduler startup (biometric auto-sync)
│   │   ├── urls.py                # All URL routing
│   │   └── migrations/            # Django migrations (0001–0012)
│   ├── management/
│   │   └── commands/
│   │       └── sync_biometric.py  # python manage.py sync_biometric
│   └── config/
│       └── settings.py
│
├── frontend/
│   ├── src/
│   │   ├── pages/hr/
│   │   │   ├── Dashboard.tsx
│   │   │   ├── Employees.tsx
│   │   │   ├── Attendance.tsx
│   │   │   ├── LeaveHoliday.tsx
│   │   │   ├── PayrollFull.tsx
│   │   │   ├── ManageShift.tsx
│   │   │   ├── UserManagement.tsx
│   │   │   ├── ApprovedRequests.tsx
│   │   │   ├── Settlement.tsx
│   │   │   └── Reports.tsx
│   │   ├── components/
│   │   │   ├── EmployeeSearchSelect.tsx   # Dynamic employee search by code
│   │   │   ├── HrLayout.tsx
│   │   │   └── ui/
│   │   │       └── dashboard-sidebar.tsx  # Sidebar with pending badge
│   │   └── lib/
│   │       └── api-client/
│   │           ├── custom-hooks.ts        # Hand-written hooks (biometric sync, managers, etc.)
│   │           └── index.ts              # Orval-generated hooks
│
├── BIOMETRIC_INTEGRATION.md
├── PortDetails.md
└── README.md
```

---

## 6. Setup & Installation

### Prerequisites
- Python 3.11+
- Node.js 20+
- PostgreSQL 15+

### Step 1 — Database

```bash
# Create the database
psql -U postgres
CREATE DATABASE uk_textile;
\q
```

### Step 2 — Backend

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
# Edit .env — see Environment Variables section below

# Run migrations
python manage.py migrate

# Start backend
python manage.py runserver 8080
```

API is live at: `http://localhost:8080/api`
Health check: `GET http://localhost:8080/api/healthz`

### Step 3 — Frontend

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

| Field | Value |
|-------|-------|
| Username | `admin` (or `HR_USERNAME` from `.env`) |
| Password | Value of `HR_PASSWORD` from `.env` |

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

## 7. Environment Variables

Create `backend/.env` from `.env.example`:

```env
# Database
DATABASE_URL=postgresql://postgres:password@localhost:5432/uk_textile

# HR Admin credentials
HR_USERNAME=admin
HR_PASSWORD=your_secure_password

# JWT signing key (keep secret, don't change after deployment)
JWT_SECRET=your_long_random_secret_key

# CORS — comma-separated list of allowed frontend origins
CORS_ALLOWED_ORIGINS=http://localhost:5173,http://192.168.1.xx:5173,https://your-tunnel-domain.com

# Biometric device (eSSL e2008)
BIOMETRIC_HOST=192.168.0.x
BIOMETRIC_PORT=4370
BIOMETRIC_PASSWORD=0

# Email (for salary slip delivery)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your@gmail.com
SMTP_PASSWORD=your_app_password
```

---

## 8. API Reference

All endpoints are prefixed with `/api/`. JWT token must be in the `Authorization: Bearer <token>` header for protected routes.

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
| GET | `/payroll/<id>/breakdown` | Per-employee detailed breakdown |
| GET/POST | `/payroll-settings` | Payroll configuration |

### Department Managers

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET/POST | `/department-managers` | List all / create manager (HR only) |
| GET/PUT/DELETE | `/department-managers/<id>` | Detail / update / remove |
| POST/DELETE | `/department-managers/<id>/departments` | Assign / remove a department |
| POST/DELETE | `/department-managers/<id>/employees` | Assign / remove an individual employee |

### Mobile — Manager Approvals

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

## 9. Database Schema

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
| `attendance` | Daily present/absent flag (legacy + manual) |
| `attendance_logs` | Raw biometric punches (in/out times) |
| `work_sessions` | Computed work sessions from punch pairs |

### Leave

| Table | Purpose |
|-------|---------|
| `leave_types` | CL, SL, EL, etc. with configuration |
| `leave_balances` | Per-employee per-year allocation and remaining |
| `leave_requests` | Employee leave requests with status |
| `employee_permissions` | Short-leave / permission requests (max 3/month) |
| `holidays` | Holiday calendar |

### Shift & Payroll

| Table | Purpose |
|-------|---------|
| `shift_templates` | Shift definitions (start/end time, department) |
| `employee_shift_assignments` | Employee → shift mapping with overrides |
| `payroll` | Payroll run records per employee per month |
| `salary_slips` | Generated salary slip PDFs / data |
| `salary_records` | Legacy salary records |

### Settlement

| Table | Purpose |
|-------|---------|
| `advances` | Loan/advance records |
| `advance_repayments` | Monthly repayment schedule |

### User Management

| Table | Purpose |
|-------|---------|
| `department_managers` | Employees designated as department approvers |
| `manager_department_assignments` | Manager ↔ Department mapping |
| `manager_employee_assignments` | Manager ↔ Individual employee (cross-dept) |
| `hr_users` | HR portal admin accounts |
| `roles` | RBAC role definitions |

### Other

| Table | Purpose |
|-------|---------|
| `notifications` | In-app notifications |
| `jobs` / `applicants` | Recruitment |
| `employee_requests` | Mobile app general requests (salary enquiry, etc.) |
| `payroll_settings` | Global payroll configuration |

---

## 10. Biometric Integration

**Device:** eSSL e2008 Face Recognition Terminal  
**Protocol:** ZKTeco/ICLOCK over TCP port 4370  
**Library:** pyzk  

The device stores all attendance punches in internal memory. Django **pulls** records from it on a schedule — the device does not push to the server.

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

## 11. User Management & Department Approvals

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
4. **Status updates** immediately via the matching `PATCH /manager/<type>/{id}/status` endpoint — approving Casual Leave or an Attendance Correction also writes straight to that employee's attendance record, so payroll picks it up automatically
5. **HR can still see and act on** every request type from the HR Portal web pages — the mobile Approvals tab is the Department Head's interface, HR doesn't need the mobile app

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

A manager assigned to "Cutting" department can also have individual employees from "Finishing" directly assigned — they will appear in the same Approvals queue regardless of their department.

---

## 12. Mobile App Integration

The React Native app communicates with the same Django backend using employee JWT tokens.

**→ For the current, fully detailed page-by-page spec (every screen, exact endpoint, exact DB table, business rules, and what's still pending), see [`docs/MOBILE_APP_V2_SPEC.md`](docs/MOBILE_APP_V2_SPEC.md).** The summary below is kept short and may lag behind that doc as the mobile app evolves — treat the spec as the source of truth.

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

### Manager — Approvals tab

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

Current tabs: **Home · Leave · Alerts · Profile · Approval** (the Approval tab only appears when `GET /manager/me` succeeds for the logged-in employee — see `docs/MOBILE_APP_V2_SPEC.md` for the full page-by-page breakdown, including the larger side-drawer navigation: Attendance, Salary Slip, Permission, My Shift, ID Card, Holidays, Chat, Resignation, etc.)

---

## 13. Deployment (On-Premise)

The system is designed for on-premise deployment on the company's own PC, on the same LAN as the biometric device, with Nginx + Cloudflare Tunnel exposing it publicly under a real domain.

**→ Full step-by-step deployment runbook: [`docs/DEPLOYMENT_GUIDE.md`](docs/DEPLOYMENT_GUIDE.md)** — covers Django (via `waitress`, not the dev `runserver`), Nginx reverse proxy config, Cloudflare Tunnel setup, all three services wired up with NSSM for auto-start on boot, the mobile app handoff, and a troubleshooting cheat sheet built from two real deployment bugs (a non-portable `.venv` and an NSSM/`waitress-serve.exe` gotcha) — read that doc before deploying, it will save you from re-hitting both.

### Why on-premise

- Biometric device communicates over local LAN only (TCP 4370 — not internet-accessible)
- No internet dependency for attendance punches
- Data stays within the company network
- Zero cloud cost

### Access matrix (once deployed per the guide above)

| Who | URL | Network |
|-----|-----|---------|
| HR Portal | `http://192.168.x.x` (LAN) or the public domain | Office LAN / Internet |
| Biometric device | `http://192.168.x.x:4370` | Office LAN only |
| Employee mobile app | `https://<your-domain>/api` | Internet (Cloudflare Tunnel) |

All three point to the same Django server and the same PostgreSQL database — nothing is duplicated or mirrored.

**Cost:** Only the domain name. Cloudflare account, Tunnel, and TLS are free.

### Auto power on/off (optional)

| What | How |
|------|-----|
| Auto power on at 8 AM | BIOS → Power Management → RTC Wake / Scheduled Power On |
| Auto shutdown at 10 PM | Windows Task Scheduler → `shutdown /s /t 0` at 22:00 |

Accepted tradeoff: the public site is only reachable while the PC is powered on — fine for a single-location factory used only during working hours.

---

## Contributing / Development Notes

- Employee Code is the **primary human identifier** across all modules. Numeric DB IDs are used internally only.
- All POST endpoints accept both camelCase and snake_case field names (for React Native compatibility).
- Leave approval automatically reflects in attendance — no separate attendance record needed.
- `GET /api/dashboard/employee-summary` is the single source of truth for what an employee can do in the mobile app (`isManager`, `canSubmitLeave`).
- APScheduler runs inside Django's `ready()` — in development with auto-reload, Django starts twice; `RUN_MAIN` check prevents double scheduling.
