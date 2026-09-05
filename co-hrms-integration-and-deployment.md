# UKTextiles HRMS ↔ Co HRMS Portal — Integration & Deployment Documentation

Complete technical record of how the **Co HRMS Portal** was built as a second, semi-independent HRMS application, how it connects to the **Main HRMS**, and everything encountered — and fixed — while deploying both to production (Railway + Vercel, dashboard-only, no CLI). This complements the existing docs (`backend.md`, `frontend.md`, `clouddeployment.md`, `api-database-reference.md`) rather than replacing them.

---



## Table of Contents

1. [Architecture & Purpose of Both Applications](#1-architecture--purpose-of-both-applications)
2. [How Co HRMS Connects to Main HRMS](#2-how-co-hrms-connects-to-main-hrms)
3. [Employee & Attendance Data Sync — How It Actually Works](#3-employee--attendance-data-sync--how-it-actually-works)
4. [Complete Connection & Configuration Process](#4-complete-connection--configuration-process)
5. [Production Deployment — Railway Dashboard + Vercel](#5-production-deployment--railway-dashboard--vercel)
6. [Environment Variables Reference](#6-environment-variables-reference)
7. [Database Configuration](#7-database-configuration)
8. [Security & Access Configuration](#8-security--access-configuration)
9. [Errors Encountered & Fixes — Full Log](#9-errors-encountered--fixes--full-log)
10. [Final Production Setup & Day-to-Day Workflow](#10-final-production-setup--day-to-day-workflow)

---

## 1. Architecture & Purpose of Both Applications

### Main HRMS (UKTextiles HRMS)

The original, full-featured HR/ERP system for the whole company — Django REST backend + React frontend. Covers employees, departments, designations, branches, attendance (biometric + geo-punch + manual), payroll (staff and production), recruitment, resume screening, leave, casual leave, promotions, increments, bonuses, ID cards, documents, settlements, reports, chat, account management/RBAC, backups, and WhatsApp/email document delivery.

- **Backend**: `D:\Projects\UK-textile\backend` → deployed to **Railway** at `https://api.uktextiles.in`
- **Frontend**: `D:\Projects\UK-textile\frontend` → deployed to **Vercel** at `https://hrms.uktextiles.in`
- **Database**: Railway-managed PostgreSQL (`UKTex_DB` locally; Railway's own addon in production, connected via its auto-injected `DATABASE_URL`)

### Co HRMS Portal

A second, **separate** application — its own repository, its own database, its own login accounts, its own secrets — built by copying the Main HRMS codebase and trimming it down to a smaller set of pages, for a specific subset of employees. It depends on the Main HRMS **only** for employee identity data and attendance punches; everything else (payroll, leave, shifts, promotions, chat, account management, etc.) runs entirely on its own local database using the same underlying engine code.

- **Backend**: `D:\Projects\Co HRMS Portal\backend` → deployed to **Railway** at `https://co.uktextiles.in`
- **Frontend**: `D:\Projects\Co HRMS Portal\frontend` → deployed to **Vercel** at `https://hr.uktextiles.in`
- **Database**: PostgreSQL, connected via its own explicit `CO_DATABASE_URL` (see [Section 7](#7-database-configuration))

**Pages kept in Co HRMS Portal** (everything else was deliberately removed — routes, nav entries, and permission-module keys): Dashboard, Employees, Departments, Designations, Branches, Attendance (Staff/Production/Report Log), Shifts, Casual Leave, Promotion, Increment, Bonus, ID Cards, Documents, Payroll, Production Payroll, Settlement, Reports, Account Management, Chat, Login Devices, Settings.

**Why it exists**: to give a specific subset of employees (and whoever administers them) a lighter, focused HRMS experience without recruitment, geo-attendance, multi-branch admin tooling, etc. — while still sharing one authoritative source of truth for *who these employees are* and *when they punched in*.

---

## 2. How Co HRMS Connects to Main HRMS

**The connection is one-way, read-only, and server-to-server only** — the Co Portal's browser frontend never talks to the Main HRMS directly; only its own backend does, on a schedule, over plain HTTPS API calls.

```
┌─────────────────┐         ┌──────────────────────┐
│  hr.uktextiles.in │──HTTPS─▶│  co.uktextiles.in     │
│  (Co Portal        │  /api  │  (Co Portal backend,  │
│   frontend, Vercel) │        │   Railway)            │
└─────────────────┘         └──────────┬───────────┘
                                        │ scheduled pull
                                        │ (X-Portal-Key header)
                                        ▼
                             ┌──────────────────────┐
                             │  api.uktextiles.in     │
                             │  (Main HRMS backend,   │
                             │   Railway)             │
                             └──────────────────────┘
```

### The "Co Emp" toggle — what makes an employee visible to the Portal at all

In the Main HRMS, `Employee.co_emp_enabled` (a boolean field) is toggled per employee from **Employees → Co Emp tab**. Only employees with this flag **on** are ever visible to, or synced into, the Co Portal. Nothing else about that employee changes in the Main HRMS — it's purely a visibility flag for the external API described below.

### The external API (Main HRMS side)

A small, isolated, **GET-only** surface in `backend/api/co_portal_views.py`, registered under `/api/co-portal/*`:

| Endpoint | Returns |
|---|---|
| `GET /api/co-portal/employees` | Every `co_emp_enabled=True` employee, **safe-subset fields only** (see below). Supports `?updatedSince=<ISO timestamp>` for incremental pulls. |
| `GET /api/co-portal/attendance-logs` | Raw punch records (`AttendanceLog`) for those employees, filtered by `?dateFrom=<date>`. |
| `GET /api/co-portal/departments` | All departments (org structure, not sensitive). |
| `GET /api/co-portal/designations` | All designations. |
| `GET /api/co-portal/branches` | All active branches. |

**Safe-subset employee fields** (`co_portal_employee_json()` in `backend/api/serializers.py`): id, employee code, name, gender, DOB, email, phone, photo, status, employment type, department/designation/branch (id + name), join date, updated-at timestamp. **Explicitly excluded**: salary amount, salary per shift, bank name/account/IFSC, PF number, ESI number, UAN number, address, ID proof. This was written as a standalone function — not a filtered view of the main `employee_json()` serializer — specifically so a future field added to the internal serializer can never silently leak through this external endpoint.

### Authentication between the two apps

Not JWT — there's no human logging in on the Main HRMS side for this. Instead, a **static shared secret** in a request header, modeled on the existing biometric-device authentication pattern already used elsewhere in this codebase:

- Header: `X-Portal-Key: <shared secret>`
- Main HRMS: `CO_PORTAL_API_KEY` env var, checked by the `require_portal_key` decorator (`backend/api/auth.py`)
- Co Portal: `MAIN_HRMS_PORTAL_KEY` env var — **must be the exact same string** as the Main HRMS's `CO_PORTAL_API_KEY`
- Fails closed: if the server-side key is unset, the endpoint returns 500 rather than silently accepting any request; a wrong/missing key returns 401
- Every one of the five endpoints is declared `@api_view(["GET"])` only — a `POST`/`PUT`/`DELETE` against any of them returns `405 Method Not Allowed`, which is a structural (not just conventional) guarantee that this integration cannot write to the Main HRMS

---

## 3. Employee & Attendance Data Sync — How It Actually Works

### The `sync_bridge` app (Co Portal backend only)

A dedicated Django app, `Co HRMS Portal\backend\sync_bridge\`:

- **`client.py`** — a thin `requests`-based HTTP client with functions `fetch_employees()`, `fetch_attendance_logs()`, `fetch_departments()`, `fetch_designations()`, `fetch_branches()`. Contains **no** `requests.post/put/patch/delete` anywhere in the file — that absence is itself the write-impossibility guarantee for this whole integration.
- **`sync_jobs.py`** — the actual sync logic:
  - `sync_branches()` / `sync_departments()` / `sync_designations()` — pull and upsert, run first so an employee's foreign keys have somewhere to point.
  - `sync_employees()` — pulls Co-Emp-enabled employees (incrementally, via `?updatedSince=`) and upserts them.
  - `sync_attendance()` — pulls a rolling window of raw punches (`CO_ATTENDANCE_SYNC_WINDOW_DAYS`, default 7 days) and feeds them through `_ingest_punches()` — **the exact same function** the Main HRMS's own biometric-device sync uses — so every downstream computation (shift logs, monthly summaries, payroll) works completely unmodified, as if the punches had come from a biometric device.
  - `run_full_sync()` — runs both, used by both the scheduler and the manual trigger.
- **`models.py`** — `MainHrmsSyncState`, one row per scope (`employees`, `attendance`), tracking `last_synced_at`/`last_run_status`/`last_run_summary`. The employees row's `last_synced_at` doubles as the next `?updatedSince=` cursor.
- **`scheduler.py`** — an APScheduler `BackgroundScheduler` running `_run_sync()` on a fixed interval (`CO_SYNC_INTERVAL_MINUTES`, default 15, currently set to **5** minutes in this deployment), plus one immediate run at process startup so the Portal isn't empty right after a fresh deploy.
- **`views.py`** — a manual trigger: `POST /api/co-portal-sync/run` (starts a sync on a background thread, HR-authenticated) and `GET /api/co-portal-sync/status` (poll for progress/result) — surfaced in the UI as the **"Sync from Main HRMS"** button on the Employees and Attendance pages.

### ID-preserving mirroring

The Main HRMS's numeric IDs are reused as the Co Portal's own IDs for `Employee`/`Department`/`Designation`/`Branch` rows (`update_or_create(id=row["id"], ...)`). This means an employee payload's embedded `departmentId`/`designationId`/`branchId` can be assigned straight to the local foreign key — no ID-translation table needed anywhere in this integration.

### Read-only enforcement, not just a UI convention

Employees/Departments/Designations/Branches in the Co Portal are a **mirror**, not independently editable data:

- **API layer**: every non-GET path on these four resources' views now returns `405 Method Not Allowed` with an explicit error message ("...is a read-only sync from the main HRMS") — enforced in `backend/api/views.py` and `backend/api/org_views.py`, not just hidden in the UI.
- **UI layer**: Add/Edit/Delete/Bulk-Upload buttons, and two easy-to-miss secondary write-paths found during implementation — `Departments.tsx`/`Designations.tsx`'s quick-assign dialog (`AssignEmployeeDialog`) and a hidden inline-assign dropdown in the shared `EmployeeAssignmentLookup.tsx` component — were all removed.
- **Employee status** is treated the same way (sync-owned) for consistency — no independent active/inactive toggle in the Portal's Employees page.

### The one intentional exception: Promotion

The Portal's **Promotion** page still lets HR record a promotion, but it no longer durably changes `Employee.department`/`designation` — those two fields are the sync's exclusive property. A promotion still writes a `Promotion` history row (for local audit/reporting), but the actual org-chart move has to happen in the Main HRMS's own Promotions feature, or the next sync would silently revert it. This was a deliberate design decision, not a bug — see [Section 9](#9-errors-encountered--fixes--full-log) for the reasoning.

---

## 4. Complete Connection & Configuration Process

Step by step, this is what actually connects the two systems in production:

1. **Main HRMS** has `CO_PORTAL_API_KEY` set (a long random string) in its Railway Variables.
2. **Co Portal** has `MAIN_HRMS_PORTAL_KEY` set to that **exact same string**, and `MAIN_HRMS_BASE_URL=https://api.uktextiles.in` (the Main HRMS's live API domain).
3. HR, in the **Main HRMS**, flips **Co Emp** on for whichever employees should appear in the Portal (Employees page → Co Emp tab).
4. The Co Portal's background scheduler (every 5 minutes, plus once immediately on every restart) calls `https://api.uktextiles.in/api/co-portal/employees` and `.../attendance-logs` with the `X-Portal-Key` header, and upserts the results into its own database.
5. HR can also force an immediate pull via the **"Sync from Main HRMS"** button on the Portal's Employees or Attendance page, instead of waiting for the next scheduled tick.
6. From that point on, the Co Portal's own (independent) attendance engine, payroll, shifts, etc. all operate on the locally-synced data exactly as if it were a fully local system.

No part of this process ever routes through the Co Portal's frontend (`hr.uktextiles.in`) calling the Main HRMS directly — CORS between those two domains was never a requirement, and isn't configured.

---

## 5. Production Deployment — Railway Dashboard + Vercel

Both apps use **Railway's web dashboard exclusively** — no CLI was used for this deployment. Steps below reflect what was actually done, including the two dashboard-only workarounds that replaced what would otherwise have been CLI commands.

### 5.1 Main HRMS — Railway (backend)

1. Railway → **New Project → Deploy from GitHub repo**, pointing at this repository.
2. On the created service → **Settings → Source → Root Directory** → `backend`.
3. **+ New → Database → PostgreSQL** in the same project — Railway auto-injects `DATABASE_URL`.
4. **Settings → Deploy → Start Command**:
   ```
   gunicorn config.wsgi:application --bind 0.0.0.0:$PORT
   ```
5. **Variables tab** → paste every line from `backend/.env.production` (see [Section 6](#6-environment-variables-reference)) via Railway's Raw Editor.
6. **Settings → Networking** → custom domain `api.uktextiles.in` added, DNS pointed per Railway's instructions.
7. First deploy: migrations were run via Railway's **Shell tab** (dashboard-native, no CLI): `python manage.py migrate` then `python manage.py collectstatic --noinput`.
8. `backend/nixpacks.toml` (already in the repo) adds the `postgresql` Nix package so `pg_dump`/`psql`/`pg_restore` are on `PATH` — needed for the in-app Backup & Restore feature to work on Railway's build image.

### 5.2 Main HRMS — Vercel (frontend)

1. Vercel → **Add New → Project**, import the same repo, **Root Directory** → `frontend`.
2. **Environment Variables** → `VITE_API_URL=https://api.uktextiles.in` (no trailing `/api`).
3. Custom domain `hrms.uktextiles.in` added under Domains.
4. Deploys automatically on every push to the connected branch.

### 5.3 Co HRMS Portal — Railway (backend)

Its own, separate Railway project (own service, own Postgres, own domain):

1. New Project → Deploy from GitHub repo (the Co Portal's own repository).
2. Root Directory → `backend`.
3. Database: **an explicit `CO_DATABASE_URL`** was used instead of relying on an auto-attached Railway Postgres addon (see [Section 7](#7-database-configuration) for why and how this was wired into the code).
4. **Start Command** — this is the dashboard-only replacement for what a CLI-based deploy would do with a separate `railway run migrate` step:
   ```
   python manage.py migrate && gunicorn config.wsgi:application --bind 0.0.0.0:$PORT
   ```
   Running `migrate` as part of the start command guarantees it always executes inside the *exact* container about to serve traffic, against the *exact* database that container will use — removing any risk of a CLI session accidentally targeting the wrong linked environment.
5. **Variables tab** → paste every line from `Co HRMS Portal\backend\.env.production`.
6. **Settings → Networking** → custom domain `co.uktextiles.in`.

### 5.4 Co HRMS Portal — Vercel (frontend)

1. Separate Vercel project, Root Directory → `frontend`.
2. `VITE_API_URL=https://co.uktextiles.in`.
3. Custom domain `hr.uktextiles.in`.

### 5.5 Redeploying after a code change (both apps, dashboard-only)

Railway auto-deploys on every push to the connected branch — no manual trigger needed in normal operation. To force a redeploy without a new commit (e.g. after only changing a Variable): **Deployments tab → Redeploy** on the latest deployment. Logs are read live from the **Deployments tab → click a deployment → log stream** — this is the dashboard-native equivalent of tailing `django_err.log` in the on-premise setup.

---

## 6. Environment Variables Reference

Full `.env.production` files exist in the repo for reference (gitignored, never committed): `backend/.env.production` and `frontend/.env.production` for the Main HRMS, and the equivalents under `Co HRMS Portal\`. These files are **not** read automatically by Railway or Vercel — they're a written record of exactly what to paste into each platform's own Variables UI.

### Main HRMS backend (Railway)

| Variable | Purpose |
|---|---|
| `DEBUG` | `false` in production |
| `ALLOWED_HOSTS` | `api.uktextiles.in,localhost,127.0.0.1` |
| `CORS_ALLOWED_ORIGINS` | `https://hrms.uktextiles.in,https://emp.uktextiles.in` |
| `FRONTEND_URL` | `https://hrms.uktextiles.in` — used to build public links (QR verification etc.) |
| `DB_SSLMODE` | `require` — managed Postgres needs TLS |
| `DJANGO_SECRET_KEY` / `JWT_SECRET` | Freshly generated per environment, never reused between local/production or between the two apps |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Bootstrap Super Admin — creates itself on first successful boot only |
| `BIOMETRIC_API_KEY` | Only relevant if a device pushes directly to this URL |
| `CO_PORTAL_API_KEY` | Shared secret — **must match** the Co Portal's `MAIN_HRMS_PORTAL_KEY` exactly |
| `WHATSAPP_*` | Optional, only if that channel is used |
| `DATABASE_URL` | **Not set manually** — Railway auto-injects this from the attached Postgres addon |

### Main HRMS frontend (Vercel)

| Variable | Purpose |
|---|---|
| `VITE_API_URL` | `https://api.uktextiles.in` (no trailing `/api`) |

### Co HRMS Portal backend (Railway)

| Variable | Purpose |
|---|---|
| `DEBUG` | `false` |
| `ALLOWED_HOSTS` | `co.uktextiles.in,localhost,127.0.0.1` |
| `CORS_ALLOWED_ORIGINS` | `https://hr.uktextiles.in` — must exactly match the frontend's origin, no trailing slash |
| `FRONTEND_URL` | `https://hr.uktextiles.in` |
| `CO_DATABASE_URL` | **This app's one explicit database connection** — see [Section 7](#7-database-configuration) |
| `DB_SSLMODE` | `require` |
| `DJANGO_SECRET_KEY` / `JWT_SECRET` | Freshly generated, distinct from the Main HRMS's own values |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | This Portal's own bootstrap Super Admin — a separate account from the Main HRMS's admin |
| `BIOMETRIC_DEVICE_IP` / `PORT` / `PASSWORD` / `BIOMETRIC_API_KEY` | Left blank — this app never talks to a biometric device directly |
| `MAIN_HRMS_BASE_URL` | `https://api.uktextiles.in` — where the sync pulls from |
| `MAIN_HRMS_PORTAL_KEY` | Shared secret — **must match** the Main HRMS's `CO_PORTAL_API_KEY` exactly |
| `CO_SYNC_INTERVAL_MINUTES` | How often the background scheduler pulls (currently `5`) |
| `CO_ATTENDANCE_SYNC_WINDOW_DAYS` | Rolling window re-pulled every attendance sync (currently `7`) |

### Co HRMS Portal frontend (Vercel)

| Variable | Purpose |
|---|---|
| `VITE_API_URL` | `https://co.uktextiles.in` (no trailing `/api`) |

---

## 7. Database Configuration

### Main HRMS

Standard Railway pattern: attach a PostgreSQL addon to the project, Railway auto-injects `DATABASE_URL`, `config/settings.py` parses it automatically. No manual `DB_HOST`/`DB_NAME`/etc. needed in production.

### Co HRMS Portal — `CO_DATABASE_URL`

This app was deliberately given its **own, explicitly-named** database variable rather than relying purely on Railway's auto-injected `DATABASE_URL`, so there's never ambiguity about which database the whole app uses. This required one small code change in `Co HRMS Portal\backend\config\settings.py`:

```python
_DATABASE_URL = (
    os.environ.get("CO_DATABASE_URL", "").strip()
    or os.environ.get("DATABASE_URL", "").strip()
)
```

Precedence: `CO_DATABASE_URL` (this app's own explicit connection) → `DATABASE_URL` (Railway's auto-injected value, if a Postgres addon happens to also be attached) → discrete `DB_*` vars (local development fallback, unchanged). Local development was completely unaffected by this change — confirmed with `python manage.py check` against the local `.env` both before and after.

### Local development note — `CO_UKTex_DB` naming history

During local development, the Co Portal's database was pointed at a Postgres database named `CO_UKTex_DB` that already existed on the same local Postgres server, originally created for a **dormant, unrelated** internal "CO Compliance" feature in the Main HRMS (a session-based database-routing feature that was never fully activated — confirmed its Django app isn't registered in `INSTALLED_APPS` and its module folder contains no live source code). This was investigated directly (table counts confirmed 0 rows in every business table) before reuse, to rule out any risk of colliding with real data. **This local-only naming coincidence does not carry into production** — production uses a completely separate, purpose-provisioned database via `CO_DATABASE_URL`.

### `django_migrations` state and the auto-migrate Start Command

Because Django's migration bookkeeping (`django_migrations` table) can end up out of sync with the actual physical tables if a migration is applied against a different environment than the one actually running (see the CLI-linking issue in [Section 9](#9-errors-encountered--fixes--full-log)), the Co Portal's Start Command runs `migrate` automatically on every boot:
```
python manage.py migrate && gunicorn config.wsgi:application --bind 0.0.0.0:$PORT
```
Trade-off: every deploy applies any pending migration automatically, with no manual review gate. Acceptable for how this app is currently operated; if a review gate is wanted later, this can be reverted in favor of running `migrate` manually from Railway's dashboard Shell tab before each deploy that includes a schema change.

---

## 8. Security & Access Configuration

- **Separate secrets per application, per environment.** `DJANGO_SECRET_KEY`, `JWT_SECRET`, and the bootstrap `ADMIN_PASSWORD` are all distinct between local dev, Main HRMS production, and Co Portal production — a token minted by one is never valid against another. The **one deliberate exception** is `CO_PORTAL_API_KEY` / `MAIN_HRMS_PORTAL_KEY`, which must match by design (it's the shared secret enabling the sync).
- **`.env.production` files are gitignored** in both repositories (`.gitignore` explicitly lists `.env.production` in addition to the pre-existing `.env`/`.env.local` rules) — confirmed with `git check-ignore -v` in both repos before relying on it.
- **Safe-subset employee data.** The external sync API can never return salary, bank details, or statutory ID numbers — this is enforced by using a dedicated serializer function rather than filtering the internal one, specifically so a future field addition elsewhere can't silently regress this boundary.
- **GET-only, shared-key auth for the inter-app API.** No JWT, no session, no cookie — a single header compared against a server-side secret, failing closed if that secret is ever unset. Structurally cannot accept a write (every view is declared GET-only at the `@api_view` level).
- **Read-only enforcement at the API layer, not just the UI**, for the Co Portal's mirrored resources (Employees/Departments/Designations/Branches) — a 405 response, not just a missing button.
- **`DB_SSLMODE=require`** on both apps' production database connections.
- **Bootstrap admin passwords should be rotated** after first login on both apps, from each app's own Account Management page — the `.env` values are only used once, to create the very first account.

---

## 9. Errors Encountered & Fixes — Full Log

In the order they came up during deployment:

### 9.1 — `500 Internal Server Error` on `hr-login`

**Symptom**: repeated 500s attempting to log into the freshly-deployed Co Portal.
**Cause**: `DEBUG=false` correctly hides the traceback from the browser, but Railway's own deployment logs showed the real cause: `relation "hr_users" does not exist` — migrations had never been run against the database `CO_DATABASE_URL` pointed at.
**Fix**: run `python manage.py migrate`. Initially attempted via `railway run` from a local terminal — this didn't take effect (see 9.3 below) — ultimately fixed by folding `migrate` into the Start Command itself (see 9.3).

### 9.2 — `404 Not Found` visiting `https://co.uktextiles.in/` directly

**Not a bug.** This is a Django REST API backend with no view registered at the bare root path — only `/api/...` routes exist. A 404 at the bare domain is expected; the correct liveness check is `GET /api/healthz`, which returns `{"status": "ok"}`.

### 9.3 — Migrations "not applying" even after running them

**Symptom**: identical `relation ... does not exist` errors persisted across multiple attempts, even after running `python manage.py migrate` via the Railway CLI (`railway run`).
**Cause**: `railway run` executes on the local machine but only affects whichever Railway project/service/environment the CLI happens to be linked to at that moment — if that link pointed at a different service or environment than the one actually serving traffic, the migration silently applied to the wrong (or no) database, while the live container's database stayed untouched.
**Fix**: eliminated the whole class of problem by moving `migrate` into the container's own Start Command (`python manage.py migrate && gunicorn ...`), guaranteeing it always runs inside the exact container, against the exact database, that's about to serve requests. Confirmed fixed by observing `Applying api.0001_initial... OK`-style output immediately followed by clean Gunicorn startup in the next deploy's logs.

### 9.4 — Admin account never bootstrapped

**Cause**: downstream of 9.1/9.3 — the bootstrap-admin code (`apps.py::_bootstrap_admin_account`) runs once per process start, and had already run (and failed silently, logging "Admin account bootstrap skipped: relation 'hr_users' does not exist") *before* the tables existed. It doesn't retroactively re-run just because `migrate` was run afterward without a restart.
**Fix**: resolved automatically once 9.3's fix caused a clean restart with tables already present — the next boot's bootstrap attempt succeeded (confirmed by its absence of any "skipped" log line, which is itself the success signal since that code logs nothing when the account already exists).

### 9.5 — CORS error on `/api/payroll-settings`

**Symptom**: `Access to fetch at 'https://co.uktextiles.in/...' from origin 'https://hr.uktextiles.in' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present.`
**Cause**: `CORS_ALLOWED_ORIGINS` in the Co Portal's Railway Variables didn't yet contain the exact frontend origin (`https://hr.uktextiles.in`) — this codebase's CORS config does an exact string match per comma-separated entry (no trailing slash, scheme required).
**Fix**: set `CORS_ALLOWED_ORIGINS=https://hr.uktextiles.in` exactly in Railway's Variables tab, then let the auto-redeploy complete.

### 9.6 — `502 Bad Gateway` presenting as a CORS error

**Symptom**: a subsequent request showed the same CORS-style browser error, but this time paired with an explicit `502 Bad Gateway` in the Network tab.
**Explanation, not really a separate bug**: a 502 means Railway's proxy got no real response from the app at all — when that happens there are no CORS headers either (Django/`corsheaders` never got a chance to run), so the browser reports it as a CORS failure regardless of the actual `CORS_ALLOWED_ORIGINS` correctness. This clarified that at least one of the earlier "CORS" symptoms may have actually been this same underlying issue, not a configuration mistake.
**Root cause traced to**: the sync job's database connection handling (9.7) — once that was fixed, this symptom did not recur.

### 9.7 — `SSL SYSCALL error: EOF detected` in the background sync job

**Symptom**: the scheduled "Co Portal sync" intermittently failed with this Postgres-level error.
**Investigation note**: an initial external diagnosis attributed this to a Gunicorn `--preload` fork/shared-socket conflict. That mechanism was checked against this deployment's actual Start Command (`gunicorn config.wsgi:application --bind 0.0.0.0:$PORT`, no `--preload` flag) and ruled out — Gunicorn's default (non-preload) behavior has each worker load Django independently after forking, so there is no shared master connection to split.
**Actual root cause**: Django's database connections are **thread-local**, and the automatic `close_old_connections()` cleanup that keeps them healthy only fires on Django's `request_started`/`request_finished` signals — which a background thread never triggers. The sync's recurring job runs through APScheduler's `BackgroundScheduler`, which **reuses a small pool of worker threads** across scheduled runs. A database connection opened by one run stayed cached on that thread across the full multi-minute idle gap until the next run; Railway's managed Postgres (or the network path to it) silently closed that idle connection in the meantime, and the next run's attempt to reuse it failed with exactly this error.
**Fix**: `close_old_connections()` (from `django.db`) called both immediately before and immediately after every sync run, in `sync_bridge/scheduler.py::_run_sync()` — so this thread never holds a connection open across an idle interval at all. The same defensive cleanup was added to the manual "Sync Now" button's background thread (`sync_bridge/views.py`) as good practice, though that code path uses a fresh thread per click and wasn't actually exposed to this specific bug.

### 9.8 — `notFound` set not JSON-serializable (found proactively, before it could crash in production)

**Cause**: `_ingest_punches()`'s return value includes `notFound` as a Python `set()`, which `json.dumps` cannot serialize. This value flows straight into the `GET /api/co-portal-sync/status` response the moment any sync run has even one unmatched employee code.
**Fix**: converted to a sorted list (`result["notFound"] = sorted(result["notFound"])`) in `sync_jobs.py::sync_attendance()` before it's stored/returned. Caught and fixed while building the manual "Sync Now" button, before it ever reached a real user.

### 9.9 — Dead links left over from trimming the Portal's frontend

Several UI elements in the copied-and-trimmed frontend still pointed at routes that had been deleted:
- A **"Punch View"** button on the Attendance page linking to the removed `/hr/attendance/punch-view` route — removed, replaced with the new "Sync from Main HRMS" button in the same spot.
- A **"+ Add Employee"** button on the Dashboard linking to the removed `/hr/employees/new` route — removed.
- The Dashboard's "Recruitment & Documents" widget, "Pending Approvals" grid, a standalone Leave-management widget, a Geo Attendance widget, and a bottom "Activity Summary" widget all contained tiles pointing at removed features (Recruitment, Leave & Holiday, Requests, Missing Punch, Geo Attendance, Activity Logs, User Management, Notifications) — each was either stripped down to keep only its still-valid tiles (e.g. Documents-related ones) or removed entirely where every tile in it was dead.

**Why these weren't caught earlier**: the frontend-trimming pass focused on routing/nav/permission-module deletion as a first sweep; these were internal page content (buttons and dashboard widgets referencing deleted routes) that needed a dedicated follow-up sweep per page, plus live browser verification, to surface.

### 9.10 — Two additional hidden write-paths found during read-only enforcement

While making Employees/Departments/Designations/Branches read-only, two write-capable UI elements were found that weren't part of the obvious Add/Edit/Delete button set:
- `Departments.tsx`/`Designations.tsx`'s **`AssignEmployeeDialog`** — let HR reassign an employee's department/designation directly from those pages.
- A shared **`EmployeeAssignmentLookup.tsx`** component (used by both pages) had an "Unassigned" tab with an inline quick-assign dropdown wired to the same mutation.

Both were removed; `EmployeeAssignmentLookup.tsx` was kept only for its read-only "find employee" search view.

### 9.11 — Promotion feature vs. synced department/designation — a design conflict, not a bug

The Portal's Promotion feature originally mutated `Employee.department`/`designation` directly (copied verbatim from the Main HRMS). Since those same two fields are also overwritten by every sync run, a promotion made in the Portal would have been silently reverted the next time the sync ran. **Resolved by design decision** (confirmed with the user): sync always wins for department/designation/branch; Promotion in the Portal now only records history, and the actual org-chart change must happen in the Main HRMS.

---

## 10. Final Production Setup & Day-to-Day Workflow

**Live URLs**:

| | Main HRMS | Co HRMS Portal |
|---|---|---|
| Frontend | `https://hrms.uktextiles.in` | `https://hr.uktextiles.in` |
| Backend API | `https://api.uktextiles.in` | `https://co.uktextiles.in` |
| Database | Railway-managed Postgres (own addon) | Own Postgres via `CO_DATABASE_URL` |

**To add an employee to the Co Portal**: in the Main HRMS, go to Employees → **Co Emp** tab, toggle the employee on. Within `CO_SYNC_INTERVAL_MINUTES` (currently 5 minutes) they'll appear in the Portal automatically — or click **"Sync from Main HRMS"** on the Portal's Employees/Attendance page to pull immediately.

**To deploy a code change to either app**: push to the connected branch — Railway and Vercel both auto-deploy. For a Co Portal backend change that includes a new migration, no extra step is needed; the Start Command applies it automatically on boot.

**To check either backend is alive**: `GET https://api.uktextiles.in/api/healthz` or `GET https://co.uktextiles.in/api/healthz` → `{"status": "ok"}`.

**To check sync health** (Co Portal): the "Sync from Main HRMS" button's toast reports the last result directly; `GET /api/co-portal-sync/status` (HR-authenticated) gives the same detail programmatically, including each scope's `lastSyncedAt`/`lastRunStatus`/`lastRunSummary`.

**What still depends on manual attention**:
- Rotating both apps' bootstrap admin passwords from their own Account Management pages.
- Keeping `CO_PORTAL_API_KEY` / `MAIN_HRMS_PORTAL_KEY` in sync if either is ever rotated.
- The Co Portal's `CORS_ALLOWED_ORIGINS` and `ALLOWED_HOSTS` would need updating if either app's domain ever changes.
- Any *new* page or feature the Co Portal doesn't currently have would need to be deliberately re-added — nothing beyond the listed page set is wired up, by design.
