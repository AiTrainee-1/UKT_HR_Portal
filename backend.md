# UKTextiles HRMS -Backend

Django REST API for the HR Portal. This is the single backend for three frontends: the HR Portal (`frontend/`, in this repo), the Employee Web App, and the Employee Mobile App -the latter two live in their own separate repositories and are not part of this one, but every business rule described here applies to them equally since they all call this same API.

---

## 1. Quick Start

**Prerequisites:** Python 3.11+ (dev machines have run on 3.13/3.14 too), PostgreSQL 15+.

```bash
cd backend
python -m venv .venv
      
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

Full detail, including Push and the ADMS path (devices calling `/iclock/...`), the device settings each terminal needs, the **Biometric Connectors -> Biometric Device Status** page (`device_status.py`, `device_status_views.py`, `device_probe.py`, `device_diagnosis.py`, `device_health.py`) and the **Site Connectors** (a Windows program at a factory that reaches devices the cloud cannot: `connector_auth.py`, `connector_views.py`, `connector_admin_views.py`, `device_remote.py`; the program itself is in `D:\Projects\biometric app`) and the **Biometric Connectors -> Device Control** section (`device_client.py`, `device_directory.py`, `device_fetch.py`, `device_control_views.py`; tests use `fake_zk_device.py`): **`biometric-integration.md`**.

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

# Google Gemini API key for the MD portal's AI assistant -.env only, never in the DB, the UI or chat.
# Create one in Google AI Studio. Without it the assistant says it is not set up; every MD page still works.
GEMINI_API_KEY=
# Optional: GEMINI_API_BASE_URL (tests/e2e point it at a fake), DB_TEST_NAME (a private test database for a test run)

# SMS one-time codes (2Factor.in) -.env only, never in the DB, the UI or a log. WhatsApp stays the default channel for codes
# until HR picks SMS on SMS Control. A placeholder value (your_..., demo..., xxx..., changeme..., <...>, ..._here) never sends.
# See Section 4.15 and twofactor-sms-otp-integration.md. Optional: SMS_COUNTRY_CODE (default: WHATSAPP_DEFAULT_COUNTRY_CODE, 91),
# TWOFACTOR_API_BASE (default https://2factor.in/API/V1), NUM_PROXIES (default 1), THROTTLE_RELAXED (e2e stack only).
TWOFACTOR_API_KEY=
TWOFACTOR_TEMPLATE_NAME=UKT_HRMS_OTP
TWOFACTOR_SENDER_ID=UKTHRM
# A development machine (DEBUG=true or runserver) never sends SMS: blank = automatic, true / false forces it.
SMS_ALLOW_SENDING=
```

Everything else -SMTP/email, PF/ESI rules, attendance mode and every threshold in Section 6, company branding, backup destinations, WhatsApp message templates -is configured live in **Settings** from the HR Portal (backed by the `payroll_settings` table and a couple of dedicated tables), not in `.env`. This is deliberate: a Super Admin can repoint the whole system at a different company's policy without touching code or redeploying.

**Moving the database to a managed/cloud Postgres later** works with these same env vars -no code change needed, provided the `DB_USER` has owner privileges on the `public` schema (needed for Backup → Restore's schema-reset step) and `pg_dump`/`psql` client tools are present wherever Django itself runs. See `deployment-guide.md` and `clouddeployment.md`.

---

## 4. Modules & Features

Every module is gated per-role by the hierarchical permission system (Section 4.11) -`hidden`/`view`/`edit`, cascading from parent to child modules.

### 4.1 Dashboard
Live attendance summary, pending-action tiles (leave/permission/casual leave/missing punch/resume screening/documents), recruitment snapshot, monthly salary totals, on-demand biometric sync.

### 4.2 Employees
Directory with search/filters/Excel-like bulk view; add/edit; **Production** (daily/weekly wage, segment attendance) vs **Staff** (monthly salary, Strict/Simple attendance); Bulk Upload (separate Staff/Production sheets, a check-first preview, a per-row result report, and an Update-existing-by-code flow for the active and inactive lists of each kind with explicit handling of employees missing from the file); per-employee Documents checklist; Branch/Department/Designation sub-pages; the **Co Emp** tab (the PF / ESI switch, the TDS list and the PF / ESI coverage numbers with Excel / PDF downloads, Section 4.17).

### 4.3 Attendance & Shift Management
The most heavily-configurable area -see Section 6 for full mechanics.
- **Staff:** Strict Mode (all 4 punches, plus lunch-break policing) or Simple Mode (first/last punch only) -both share the same Full/Half-Shift decision.
- **Production:** separate segment-based engine; Sunday is a normal working day (unlike staff).
- **Manage Shift:** validated templates (no overnight shifts, unique names, a shift in use cannot be deleted), a planner (`shift_planner.py`) that previews and applies an assignment for any mix of included/excluded employees, departments and designations with keep-or-reassign for people already on a shift, ending people off a shift from a chosen day, Assigned/Unassigned views, per-employee time overrides.
- **Late Detection & Without Permission policy:** fully HR-configurable free-allowance + slab-table deduction rules (Section 6).
- **Geo Attendance & On-Duty:** geofenced punch-in/out, destination-based field-work sessions with department-head approval and live location tracking.
- **Missing Punch:** employee-submitted forgotten-punch correction (4 slots), HOD/HR approval (Section 4.13).
- **Manual Punch Import:** bulk Excel import for device outages/backfill.
- **Auto Sync Rules, Attendance Search, Report Log, Night Shift Relaxation.** Report Log has three sub-tabs: Monthly Report, Daily Leave Report (absent staff + Informed / Not informed) and Daily Late Report (staff the engine marked late, with shift start, grace, punch-in and minutes late after grace); the daily ones read `GET /api/attendance/report-log?date=`, which carries `firstPunch`, `shiftStart`, `graceMinutes`, `lateDeadline`, `minutesAfterStart`, `minutesLate`, `branchId`, `branchName` and `unitLabel` per row.

### 4.4 Leave & Holiday
Configurable leave types, per-employee/year balances with carry-forward, request approval (HR and/or department head as the approval pipeline says, attributed), Permission requests (also feed the Late Detection pool), Holiday calendar, automatic attendance reflection.

**Request date window** (`api/request_window.py`): on Leave, Permission, Casual Leave and Missing Punch an *employee token* may only request dates in the current month (plus last month on the 1st and 2nd; a Missing Punch never in the future), enforced server-side in India time with a 400 `request_window_closed`, never for HR; the same rule and 83 shared vectors live in the web/mobile clients (`tests_request_window.py`).

### 4.5 Casual Leave (CL)
Paid, staff-only, one per calendar month, eligible after 6 months of service. Separate table/flow from Leave/Permission. Approving/rejecting writes the attendance record directly -payroll picks it up automatically.

### 4.6 Recruitment
New Joinees (offer letter + email/WhatsApp), Resignations (department-head then HR approval by default, configurable), Required Roles, Interviews, Resume Screening (spaCy NLP scoring against an HR-defined rule set, explainable per-candidate scoring, 4-stage pipeline; uploaded resumes for non-selected candidates are **auto-purged after 10 days** -see Section 7), Documents (Company Documents theming + per-employee Employee Documents checklist).

### 4.7 Payroll, Salary & Settlement
Full engine for both employment types:
- **Staff:** monthly salary ÷ working days × effective present days (Full/Half Shift), plus Late Detection and Without Permission deduction pools (Section 6).
- **Production:** shift-based, paid on one of three **pay cycles** -Weekly (7 days), BiWeekly (14 days) or Monthly (four weeks, 28 days)- chosen per employee on Employees → Production Employees (`Employee.production_pay_cycle`; an unassigned employee is in no payroll). Each cycle has its own Production Payroll page, period rule and late rules (Settings → Production Payroll). **Not** tied to calendar months, so a given month can span more than one still-unpaid pay period. This is why any "how many employees are pending" figure for Production must count **distinct employees**, not raw Payroll rows -a fix applied to the Payslip list query and the Production Payroll page's KPI card after exactly this miscount was found (August 2026).
- **Skipped Employees:** a dry-run preview (before generating) of exactly which employees would be skipped and why (no Salary Amount / no Salary Per Shift / zero working days in the period) -surfaced as a KPI card on both Staff and Production Payroll pages. Staff's check runs automatically on page load (~14s for ~120 employees); Production's is click-triggered instead, since its equivalent check is measurably slower (~84s for ~114 employees, since the production engine's per-employee work is heavier) and firing it automatically on every page visit would be a bad tradeoff.
- Deductions: PF and ESI (Co Emp employees only, by the rules of Settings → PF & ESI), TDS (employees on the TDS list only), advances, Late Attendance penalty, Without Permission penalty (PF, ESI and TDS: Section 4.17).
- Full day-by-day breakdown drawer per payroll record.
- **Payroll insights (read-only, October 2026):** the Staff and Production Payroll pages explain what payroll already stored without touching it: `GET /payroll/<id>/details` (one payroll on its own page: profile, money, how each earning and deduction was worked out, the rules it was generated under and whether they changed since, its issues, days, history, Previous / Next), `/payroll/issues` (every issue detected for a month or period, each with the day it was detected on and a specific detail), `/payroll/rules` (the Settings rules plus each employee's own shift, Co Emp / TDS category, PF / ESI / TDS and pay cycle) and `/payroll/salary-statement` (the printed Salary Statement by department). Production has the same four under `/payroll/production/...`. All are `GET`, built from `Payroll` + `SalarySlip.breakdown_details` + the profile + the live settings (never recomputed; a missing settings row is read as defaults, not created), gated by the URL's own permission module (`payroll` / `production_payroll`) and branch-scoped. Code: `payroll_insights*.py` and `payroll_statement_views.py`; response contract: `frontend/src/lib/api-client/custom-hooks/payroll-insights.ts`; tests: `tests_payroll_insights.py`.
- **Compensation overhaul (October 2026), staff only:** `/hr/compensation` has four tabs (CTC Breakdown, OT Detection, Compensation Leave, History & Reports) and Settings has a Compensation tab; every rule is editable there. The master switch (`PayrollSettings.compensation_feature_enabled`) sits above per-feature switches and effective-from dates in the singleton `CompensationConfig`, and the editable rule tables are `CompensationRule` rows, so nothing already paid is ever judged again. **Type 1** is an automatic, never-paid late-in allowance for the next working day after extra work (default 60 / 90 min → 30, 120 / 150 min → 60 minutes); **Type 2** (more than 150 minutes past the shift end) is assigned by HR by hand, as relaxation (an alternative day in the same month) or payment (shifts x the daily rate, `earnings.otShifts`), by the last punch-out (default until 9 PM 0.25, 12 AM 0.50, 2 AM 0.75, later 1.00). Compensation Leave: A. company-announced late-in / early-out windows (the announced time replaces the shift edge and grace for that date), B. Sunday / holiday work claims raised by HR and approved by the Department Head (new approval workflow `holiday_work`, HOD switch `can_approve_compensation`) into a compensation balance (`CompensationLedger`), C. paid birthday leave (automatic, Present, 1.00). The attendance engine (`compute_day_record`) applies all of it and writes the day marker (`compensation_kind / _minutes / _note`, `ot_extra_minutes`) that every attendance screen and the employee apps draw. Code: `compensation_rules.py` (pure rules), `compensation_engine.py` (database context for the engine), `compensation_apply.py` (relaxation top-up, balance), `overtime.py` (detection), `compensation_views.py`, `compensation_settings_views.py`, `compensation_windows_views.py`, `holiday_work_views.py`, `compensation_birthday_views.py`, `compensation_reports_views.py`, `employee_compensation_views.py` (employee apps), `overtime_scheduler.py` (background detection every 15 minutes), migrations 0118, 0119 and 0120; endpoints in `api-database-reference.md` (Compensation sections); tests `tests_compensation_*.py`, `tests_holiday_work.py`, `tests_employee_compensation.py`, `tests_comp_fix_*.py`.
- **Production shift rules (October 2026), production only:** a production day's `shifts_earned` is now worked out from the owner's table "leave at this time, earn this many shifts" (Day: 10:30 0.25, 12:45 0.50, 15:30 0.75, 17:45 1.00, 20:00 1.50, 22:30 2.00, 00:30 next day 2.50, 05:30 next day 3.00; Night from 21:00: 00:00 next day 0.50, 05:30 next day 1.50; Sunday 17:00 1.00; unpaid breaks tea, lunch, dinner) instead of the four punch times and the 10-minute grace. Staff paths are untouched. It is edited in Settings → Production Shifts (`GET/PUT /production-shift-rules`, `POST /production-shift-rules/preview`, see `api-database-reference.md`; audit module `production_shift_rules`). **Effective-date rule (safety):** the new calculation judges only days on or after `ProductionShiftConfig.rules_effective_from` and only while `rules_enabled`; every earlier day keeps the legacy calculation (`_compute_production` with `punch1..4_time`, the 10-minute `grace_minutes` and `ProductionShiftSegment`) byte for byte, so nothing already paid is re-judged. Migration `0121_production_shift_rules` is additive (eight `rules_*` columns with defaults on `production_shift_config`, tables `production_shift_groups`, `production_shift_rules`, `production_breaks`, an idempotent seed) and seeds `rules_effective_from` as the IST day it ran; NULL means "legacy". **The algorithm** (pure module `production_shift_rules.py`, exact `Fraction` arithmetic, no database inside the calculation): (1) the day's group is chosen by weekday (Sunday: groups for Sunday or every day, otherwise Monday-Saturday or every day) and by the first-punch window that holds the day's FIRST punch, with the nearest start time (circular clock distance) when none does. (2) Each ladder row is a point "left at T, earned V"; between two rows the value grows pro rata with PAID time, where the enabled break windows (tea, lunch, dinner; same for every group) are cut out, so a break is flat, nobody has to punch for it, and the day is capped at the last row's value. (3) The grace (`rules_grace_minutes`, default 5) lets a first punch at or before start + grace count as the start, while a later one loses value at that band's rate and sets `is_late`; an out punch less than the grace before a ladder row snaps up to that row (17:42 earns the 17:45 value, 17:40 does not). (4) The day's punches are grouped by shift day and paired in order (in, out, in, out), the day is the sum of value(out) minus value(in) over the pairs, an odd count ignores the last open punch, one punch earns 0 (`half_shift`, unpaid like the legacy rule), none is `absent`, and punches under 300 seconds after the previous kept one (double taps) are dropped first; the total is then rounded (`rules_rounding_step` / `rules_rounding_mode`), limited to the group's top value, lifted to `rules_min_credit` when there is a complete pair, and a total below `rules_full_day_value` is `half_shift`. (5) **Night sessions:** a night worker's closing punch is made the next calendar morning, so the next day's first punch is added to day d as +24 h and removed from d+1 only when ALL hold: d's resolved list has an odd count, the punch is at or before the close-by time (the latest next-day out time among all groups' rows and standard departures plus 90 minutes, 07:00 with the default tables, derived, no setting), it is within `rules_night_session_hours` (default 24) of d's open punch in whole minutes, both days are judged by the new rules (on or after the effective date), and neither is a manual override day (`source == "manual"`, kept as HR entered it). (6) The chain is resolved by walking back from the asked day to the first sync point (a day whose first punch cannot have been consumed) and resolving forward from there, at most 62 days back; callers read a 7-day window with their one punch query and add ONE more query only when no sync point lies inside it, so one day, a range and a month always agree. Flags: late = first punch later than start + grace; early leave = last punch earlier than the standard departure minus grace; the result also carries `rule_group` and `rule_note` (returned to reports and the daily list, never stored). **Where it plugs in:** `attendance_final.compute_day_record` / `compute_month_records` / `compute_range_records` (production branch; the pure `production_day_result` and `production_prefetch_for_day` / `production_prefetch_for` serve reports and roster days), so payroll generation (`_generate_production_payroll` reads `compute_range_records`, pay stays sum(`shifts_earned`) x `salary_per_shift` and a period that spans the date mixes both calculations correctly); `payroll_views._production_late_days` (days on or after the date use the day record's own `is_late` / `early_leave`, i.e. group start + grace, earlier days keep the Manage-Shift template check); `attendance_views` (daily list gains `shiftsEarned`, `isLate`, `isEarlyOut`, `ruleGroup`, `ruleNote`, `lastPunchNextDay`; history and search punch lists mark a closing punch `nextDay`); `growth_views` manual override (a production day may reach the table's top value instead of 1.50); the MD portal attendance analytics and `reporting/definitions/attendance_core_data.py` (late / early minutes through `judge_day`); and the Report Center: HR Reports → Production Daily Punches (punches by shift day, columns Shift, Shifts Earned, Late, Early, Rule applied) and Production Shift Rules, both through `reporting/definitions/production_judge.py` (reads only; a report never writes). The legacy `/production-shift-config` and `/production-shift-segments` endpoints stay and describe the days before the date. Tests: `tests_production_shift_rules.py` (engine, hand-computed bands, a random differential test against an independent implementation, query counts), `tests_production_legacy_snapshot.json` (about 900 patterns recorded from the unmodified legacy code), `tests_production_shift_rules_api.py`, `tests_production_consumers.py`, `tests_reporting_production_shift.py`. **Known behaviours:** a stored night day depends on the NEXT morning's punch (`compute_day_record` recomputes auto rows, but a reader of stored rows only can show a night day until it is recomputed), and payroll generated for a period that ends today can miss that night's closing punch.
- Salary Slip: PDF generation, single/bulk download/email/**WhatsApp** (Section 8), Excel export.
- Settlement: advance/loan records with auto-generated repayment schedules, deducted from payroll automatically each cycle.

### 4.8 Digital ID Card
Template-driven generator (colors/fonts/corner style/logo, configurable in Settings), separate staff (vertical) / production (horizontal) layouts with a QR-code back face (public verification, no login required), bulk generate/print/ZIP-download, single/bulk email and **WhatsApp** send (Section 8) using a dedicated server-side image renderer (`backend/api/idcard_render.py`, Pillow-based -a clean single-image card, not a pixel replica of the print layout).

### 4.9 Promotions, Increments & Bonus
Department/designation change history, salary increment tracking against each employee's initial-salary baseline, bonus tracking.

**Statutory bonus is set separately for staff and production (October 2026).** Staff use `bonus_percent` / `bonus_wage_ceiling` / `bonus_eligibility_ceiling` (API `bonusPercent` / `bonusWageCeiling` / `bonusEligibilityCeiling`, group `settings.payroll`); production use `prod_bonus_percent` / `prod_bonus_wage_ceiling` / `prod_bonus_eligibility_ceiling` (API `prodBonusPercent` / `prodBonusWageCeiling` / `prodBonusEligibilityCeiling`, group `settings.production_payroll`, the same validation ranges, branch-overridable like the staff ones). `growth_views.bonus_rules_for(emp, settings)` picks the set by `Employee.employment_type` and is the only place that decides it: the bonus preview (`/api/bonus/calculate`), the generated register (`/api/bonus/generate`, including the stored `bonus_percent_applied`) and the demo data all use it. `bonus_fy_start_month` / `bonusFyStartMonth` stays ONE value shared by staff and production, but it is NOT enforced company-wide: it is in neither `COMPANY_WIDE_RULE_KEYS` nor `user_settings.COMPANY_WIDE_FIELDS`, so a branch login with `settings.payroll` can save its own (a `BranchSettingsOverride`), and the bonus engine reads it per employee through `settings_for_employee` while the Report Center (`payroll_core_common`) and the MD portal (`md_portal/common.py`) read only the universal row; the value is meant to be set from the company (admin) login. **The ceilings are per payslip:** `_calculate_bonus_for_employee` sums `min(slip.basic, wage ceiling)` over every payslip of the financial year (matched on the slip's month / year, which for production is the month the period ENDS in) and judges eligibility on the latest payslip; a production payslip puts the whole period gross in `basic`, so a year is 52 Weekly, 26 BiWeekly or 13 Monthly (four-week) payslips (pinned by `ProductionBonusPerPayslipTests` in `tests_prod_bonus.py`). Migration 0128 adds the columns (with database defaults) and 0129 **copies** the current staff values into the production twins, for the universal row and for every branch override that sets one of the three keys, so no bonus changes until HR edits a production value; it never invents a value and is safe to run twice.

### 4.10 Reports (Report Center)
A registry-driven reporting system (`backend/api/reporting/`, developer guide in its `README.md`). Every report is one `ReportSpec` -metadata, filters, columns and a `run(ctx)` function -and the catalog, filter form, on-screen table, **Excel** and **PDF** export are all generated from it, so adding a report needs no frontend work. Categories: Payroll & Salary, Attendance, Leave & Requests, Gate & Visitors, Employees, HR Reports, Loans & Bonus, Administration. *HR Reports* (`definitions/hr_reports.py`) holds cross-module HR lists; today those are **Production Daily Punches** (every punch of each production employee with its exact time, listed by SHIFT DAY, for one date or date-wise for a week / month up to 31 days, a total line per employee: from the date the production shift-table rules start a night worker's closing punch made the next morning is shown on the day the shift began as `05:30:12 (+1)`; the columns Shift (rule group: Day / Night / Sunday / Legacy rules / Manual entry), Total Punch Count, Shifts Earned, Late, Early and Rule applied come from the same pure calculation payroll uses, `attendance_final.production_day_result`, never saved; permission module `attendance`, no pay is printed), **Production Shift Rules** (the saved shift table as printable rows: every enabled group's ladder of out times and shift values, the unpaid breaks, grace, start date and the legacy-calculation note; permission module `attendance`) and **Employee Confo Details** (code, name, department, designation, salary with its unit, assigned HOD, date of joining, current shift; filter by employee type Staff / Production / Other). It prints salary, so it needs the `salary` or `payroll` module, not `employees` alone. Every other report that shows a production day's late / early / punches reads the stored day record or the shared `definitions/production_judge.py` helper (group start + the rules' grace, main out, night-session punches) for days on/after the shift-table start date and keeps the legacy punch-1 / punch-4 / 10-minute judgement for earlier days.

- **Endpoints (all GET, under `/api/reports/`, so a View Only role can use them):** `catalog` (what the user may run + department/designation/branch option lists), `run/<id>?<filters>` (rows, totals, summary cards), `export/<id>?fmt=xlsx|pdf&<filters>`, `options/employees?q=` (employee picker search). `fmt` (not `format`) because DRF reserves `?format=`.
- **Access:** the middleware still gates `/api/reports/*` on the `reports` module; on top of that each report names the permission modules that own its data (`modules=`), and the user needs "view" on at least one -a role with Reports but not Payroll cannot read salary data here. Audit trail / user-account reports are super-admin only. Branch isolation is applied inside `ReportContext.emp_q()`. Every export is written to the audit log (`action=export, module=reports`).
- **Exports:** Excel via openpyxl in streaming mode (typed cells, Indian digit grouping, frozen header, autofilter, print setup, text never becomes a formula); PDF via reportlab with the bundled DejaVu Sans (`reporting/fonts/`, so the ₹ sign prints on Railway too), letterhead from Company settings, KPI strip, repeating header, totals row, "Page X of Y". Limits: screen 10,000 rows, PDF 5,000, Excel 30,000 -an export over the limit is refused with a "narrow the filters" message, never silently truncated (Railway kills a request after 30 s).
- **Rules for report authors:** reports are read-only (a GET never writes), use the values the payroll/attendance engines already stored, parse text-typed dates safely, convert aware datetimes to IST, and never leak Aadhaar (masked), password hashes or photos.
- `reports_views.py` (the old ten endpoints) is deprecated and unused; delete it with its routes next release.

### 4.11 Account Management & RBAC
**Account Management** creates HR users and assigns roles from a hierarchical module tree (a parent module cascades its permission level to children unless a child overrides it). Role names are unique, case-insensitively: creating or renaming onto a taken name is a 400 (`Role already exists`), a blank name is a 400. The page itself (`frontend/src/pages/hr/AccountManagement.tsx` + `account-management/`) is search/filter/sort and a role editor with module search, set-all, copy-from and sub-module overrides; its rules are in `account-management/logic.ts`. **User Management** has two tabs: HOD Assignment assigns employees as department-level approvers for the mobile app's Approvals tab (Leave/Permission/Casual Leave/Missing Punch/Resignation/On-Duty, independently toggled), and Approval Workflow Control decides how every kind of request is approved (Section 4.13). Plus Activity Logs, Login Devices (active-session view + remote revoke), Chat, Notifications.

### 4.12 Settings
Tabbed, each tab independently permissioned: Company, Attendance (Staff/Production sub-tabs), Production Shifts, Late Detection, Devices, Company Documents, Payroll, Production Payroll, Salary Slip, **WhatsApp** (Section 8 -credential status is read-only here, message-template selection is editable), SMTP/Email, Backup.

### 4.13 Approval Workflow Control
One engine, `backend/api/approval_workflow.py`, decides who may approve every request; HR configures it in **User Management → Approval Workflow Control** (`approval_workflow_views.py`, table `approval_workflow_configs`, permission `user_management.approval_workflow`). The full contract (endpoints, the per-request `approval` block, `workflow_disabled`) is in `api-database-reference.md`; the rules in short:

- **Pipeline:** 1–2 ordered steps; a step's responsible role is `hod`, `hr` or both (whoever acts first, only as the single step); mandatory or optional (an optional step is skipped when the next role decides first; the last step is always mandatory); a role appears once. Built-in pipelines reproduce the old behaviour, so nothing changes until HR edits one. Eleven workflows (`DEFINITIONS`); `leave, permission, casual_leave, outpass, missing_punch, on_duty, resignation` are editable, the HR-only ones and `attendance_correction` are fixed; each can be switched OFF (no new requests; requests already waiting can still be decided).
- **Deciding:** modules never route on their own any more. Each module's resolver (`resolve_leave`, `resolve_permission`, `resolve_casual_leave`, `resolve_outpass_request`, `resolve_missing_punch`, `resolve_on_duty_session`, `resolve_resignation`) calls `approval.decide(key, obj, role, decision, actor=...)`, which checks the request is pending and that this role has a turn (`check_can_act`), appends to `approval_trail` and returns an `Outcome` (`advanced` / `approved` / `rejected`); the module then stamps its own fields, saves, and runs its side effects exactly once when the outcome is final, whichever role gave the last approval. Creation endpoints call `approval.require_enabled(key)` (403 `workflow_disabled`); `ApprovalError` + `approval.refusal(exc)` is the one error shape.
- **Position is derived, not stored:** progress lives in `approval_trail` (`None` = a row from before the feature, derived from the old HOD/HR stamps; `[]` = a real empty trail) and the request's position is recomputed against the pipeline in force, so a pending request follows an edited pipeline from where it is. `resync_pending(key)` re-projects the legacy `status` label after an edit (`pending`, `pending_hod`, `pending_hr`, `dept_approved` only mean "waiting for X now") and never approves or rejects anything.
- **Lists and counts** (HOD pending lists and counts, HR dashboards, sidebar badges) use `filter_actionable` / `can_act`, so each role sees a count of what it can decide now. Configs are memoized per request (thread-local) and cleared on `request_started` and on any config save/delete.
- **Behaviour changes to know about:** the leave balance is deducted at the final approval whichever role gives it (the HOD path used to skip it); HR can no longer re-decide a decided outpass; re-deciding a decided leave/permission is a revision that needs HR in the pipeline (comment-only edits always allowed).
- **Tests:** `api/tests_approval_workflow.py` (rule tables, step validation, catalog, config API + permissions, one scenario class per workflow, resync and cache). Browser coverage: `frontend/e2e/approval-workflow.spec.ts` (the page) and `approval-screens.spec.ts` (the HR screens).

### 4.14 MD Portal & AI Assistant
A separate, read-only executive portal for **one** account, the Managing Director (`HRUser.is_md`, partial unique index `uniq_single_md`, migration `0111`), assigned by the super admin in Account Management (never the super admin themselves, always company-wide). Everything lives under `api/md_portal/` and `/api/md/*`; the full design, rules and build map are in **`md-portal.md`**. In short:

- **Identity & safety:** every `/api/md/*` view is `@md_get` (GET only, `@require_md`, and the whole request runs inside `common.read_only_db()`, so the *database* refuses any write) and `permission_middleware` locks the `/md/` prefix as well (it fails open for unmapped paths). `tests_md_identity.py` walks the URL table.
- **Pages:** Dashboard, Attendance, Employees, Outpass & Visitors, Tea Break, Payroll, Reports (executive reports `reporting/definitions/md_*.py` plus the whole Report Center, read-only), Recruitment, Activity Logs. One analytics module per page (`analytics/<page>.py`, pure read-only functions that return an `envelope` with `provenance` and `notes`), one thin route module (`routes/<page>.py`); each also exports the assistant's `TOOLS`, company-wide `insights()` and `headline()` for the Dashboard.
- **AI assistant** (`api/md_portal/assistant/`): Google Gemini over raw REST (`gemini.py`), a tool loop (`engine.py`) that can only call the analytics tools, a whitelisted `query_data` language (`query_dsl.py`) and `find_reports`, and finishes with a structured `submit_answer`. Employee names become `@emp-<id>` tokens before anything leaves the server (`privacy.py`); the "How I got this" explanation is built by the server from the lookups that really happened (`xai.py`); answers run as a background thread the browser polls (`jobs.py`); voice questions fall back to server transcription (`/api/md/assistant/transcribe`). Tables `md_assistant_settings`, `md_conversations`, `md_messages`, `md_assistant_usage` (migration `0112`). Settings (model, privacy mode, limits, usage) are super-admin only at `/api/hr-users/md-assistant`; the key is read from `GEMINI_API_KEY` only.
- **Gate QR codes (Outpass exit, Outpass return, tea break):** the QR text is a SHORT signed code from `gate_qr.py` (about 40 characters, uppercase letters, digits and dots, e.g. `R.<request>.<generated>.<expiry>.<signature>`; HMAC-SHA256 under a key derived from `JWT_SECRET` for this purpose only, cut to 96 bits), not the old 220-character JWT that some scanners cut after the last dot (the signature never arrived, so the gate refused it). `gate_scanner_views.resolve_gate_scan` accepts the short code and still the old JWT (a pass already open on a phone), matching is case-insensitive, a cut-off JWT gets "read incompletely, please scan it again", and the pass state (approved, already used, newest return code) is still decided from the database. Tests: `tests_gate_qr.py`.
- **Demo company:** `python manage.py seed_md_demo` loads a realistic garment manufacturer (units, ~240 people, 120 days of attendance, tea breaks, visitors, outpasses, six payroll months, recruitment, an activity trail) into a throwaway database whose name ends in `_e2e` (it refuses anything else); `--purge` removes exactly what it created.
- **Tests:** `api/tests_md_*.py` (one per module plus the assistant, query language, tool contract, consistency between pages and identity). Run one with its own database: `DB_TEST_NAME=test_uktex_<name> python manage.py test api.tests_md_<name> --noinput`.

### 4.15 SMS OTP Channel & SMS Control
Sign-in, forgot-password and first-time activation codes can be delivered by **SMS through 2Factor.in** instead of WhatsApp; WhatsApp (WAClient) stays the channel for every other message. HR picks the channel on **SMS Control** (`/hr/sms-control`, permission module `sms_control`); the default is WhatsApp, so nothing changes until HR switches. The full setup (2Factor account, the approved template `UKT_HRMS_OTP` / sender `UKTHRM`, API key, environment, test) is in **`twofactor-sms-otp-integration.md`**. In short:

- **One flow, two carriers.** `otp_service.resolve()` returns the active channel's switches and limits (`SmsSettings` for SMS, `WhatsAppSettings` plus constants for WhatsApp); generation (random digits, salted HMAC, never stored), expiry, single use, attempt limit and purpose binding are shared. The code has **4 digits by SMS** (the 2Factor template says `XXXX`) and **6 by WhatsApp** (`otp_service.CODE_LENGTH`); the length is stored on the row (`EmployeeOtp.code_length`, migration 0125, additive with a database default of 6), so a code issued before HR flips the channel still verifies with the length it was issued with, and verification checks the row's length (a wrong length is a counted wrong guess with the generic sentence, so it reveals nothing about whether a code is live). Four digits are only 10 000 combinations, so the SMS channel is held tighter: at most 5 wrong guesses per code (the SMS Control page allows 3 to 5; a larger saved value is clamped) and at most 10 codes per employee and purpose in any 24 hours (`SMS_MAX_REQUESTS_PER_DAY`, SMS only), on top of the 5 codes an hour: at most 5 x 10 = 50 guesses a day against one account (0.5 %). `GET /auth/login-options` gains `otpChannel` and `codeLength`, and `POST /auth/otp/request` gains `channel` and `codeLength` (additive: old clients ignore them). A code method is advertised only when its switch is on and the active channel is configured **and** allowed to send, and password login is never locked out. The new code row is created first and the earlier codes are consumed only after the send succeeded: a failed or blocked send deletes the new row and leaves the employee's previous code valid. The cooldown / hourly check and the creation run under a lock on the employee row, so simultaneous requests send one SMS. Password sign-in is never refused (and `login-options` keeps `passwordLogin: true`) while SMS cannot send for the moment (a company cap used up or the breaker paused: `sms_service.temporarily_unavailable()`).
- **Files.** `sms_service.py` (the pipeline: configuration and the placeholder rule, number validation, caps, circuit breaker, the log row), `twofactor_client.py` (the one HTTP call: 2Factor's custom-OTP call `GET {TWOFACTOR_API_BASE}/{api_key}/SMS/+{phone}/{otp}/{template_name}`; 5 s / 10 s timeouts, one attempt, redirects not followed, answer streamed up to 20,000 bytes, https only; **the key is in the URL, so it is redacted from every exception, log line (a filter on the urllib3 loggers), log row and answer**), `sms_control_views.py` (the HR API), `models/sms.py`, `otp_views.py`.
- **Environment** (`.env` only, never the database, the UI or a log): `TWOFACTOR_API_KEY`, `TWOFACTOR_TEMPLATE_NAME` (`UKT_HRMS_OTP`), `TWOFACTOR_SENDER_ID` (`UKTHRM`, informational), `TWOFACTOR_API_BASE`, `SMS_COUNTRY_CODE` and `SMS_ALLOW_SENDING`. A value that is empty, starts with `your_` / `your-` / `demo`, contains `yourkey` / `replace_me` / `changeme` / `xxx` / `todo`, is wrapped in `<...>` or contains `_here` / `-here` / `here_` / `...here` counts as not set (a real key that merely contains the letters "here" does not). A development machine (`DEBUG` or `runserver`) never sends SMS unless `SMS_ALLOW_SENDING=true`; `manage.py test` blanks the credentials.
- **Protections** (counted from `sms_message_log`, so they hold across workers and restarts; each send is reserved under a `SELECT ... FOR UPDATE` on the settings row): a circuit breaker (3 provider-side failed sends in 10 minutes pause SMS for 10 minutes; a refused number or one odd refusal does not count), company hourly (default 300) and daily (default 1,500, IST day) caps, a per-number cap (5 an hour), a per-employee resend wait (60 s) and hourly allowance (5), and wrong tries per code (5). All are editable on SMS Control within validated ranges (the hourly cap cannot exceed the daily one). **Selecting the SMS channel is refused (400) until 2Factor is configured on the server.** A refused request writes at most one `blocked` log row per employee per reason per minute.
- **Per-IP throttles.** `api/throttles.py` provides `@throttle("<scope>")` (placed under `@api_view`): the old `request.throttle_scope = ...` lines inside the views ran after DRF had checked its throttles, so nothing was ever throttled. The rates are now real: `login` 30/min, `employee_login` 300/min, `otp_request` 300/min and `otp_verify` 600/min per client IP (generous on purpose: a whole shop floor shares one address at shift start). A throttled answer is `{"error", "retryAfterSeconds"}` plus a `Retry-After` header. The client IP follows the `NUM_PROXIES` environment variable (default 1: the last `X-Forwarded-For` hop, the one Railway's proxy appends).
- **Tables** (migrations `0123_sms_otp_channel` and `0124_sms_default_caps` (the cap defaults 300 / 1500), additive, nothing seeded): `sms_settings` (singleton) and `sms_message_log` (never the code, the text, the key or a full number: the masked number, a keyed HMAC of the number, 2Factor's session id and one plain-sentence reason). Audit module `sms_control` (`update`, `test`).
- **Apps.** The mobile app needs a **new APK build** and the Employee Web App a **separate Vercel deploy** to word their screens "SMS" (they read `otpChannel` / `channel`); older apps keep working and only keep saying "WhatsApp". They also only know 6-digit codes, so an old build cannot enter an SMS code (4 digits) until it is updated; WhatsApp codes are unchanged.
- **Tests.** `api/tests_twofactor.py`, `api/tests_sms_otp.py`, `api/tests_sms_control.py`, `api/tests_throttles.py` (2Factor is always mocked); browser: `frontend/e2e/sms-control.spec.ts`.

### 4.16 Endpoint Sharing (Settings → Endpoint Sharing)
The **super administrator** can publish chosen HR data to the company's other applications as read-only web addresses, `GET /api/shared/<slug>`. Everything is managed in **Settings → Endpoint Sharing** (group "Messages & data"); the sidebar is unchanged. It is **not** a role permission (no permission module): the backend gate `require_company_super_admin` looks the account up in the database on every call (active, `is_super_admin`, not tied to a branch) and refuses everybody else (an HR role with every permission, a branch login, an employee token: 403; no token: 401), and the Settings page does not list the tab for anyone else (`SUPER_ADMIN_ONLY_TABS`).

- **Files.** `models/shared_endpoints.py` (migrations `0122_shared_endpoints`, `0131_shared_endpoint_key_category`), `shared_datasets.py` (the catalog: a code whitelist), `shared_endpoint_views.py` (the public call), `shared_endpoint_admin_views.py` (the management API).
- **Datasets and fields.** `employees`, `departments`, `branches`, `designations`, `attendance-days` (stored daily verdicts; `dateFrom` and `dateTo` required, at most 31 days), `attendance-punches` (raw punches; required range of at most 7 days), `leave-requests`, `holidays`, `payroll-summary` (`month` required). A field is a catalog definition (key, label, type, **sensitivity**, columns, getter), never a model attribute named by a client; the row query loads only the columns of the selected fields (`.only()`), so an unshared column is not even read. Sensitivity levels: `basic` (organisation data), `personal` (phone, email, gender, date of birth, address, leave type / dates / reason) and `financial` (salary and payroll amounts). Saving an endpoint that newly selects a personal or financial field needs `acknowledgeSensitive: true` (otherwise 400 `sensitive_confirmation_required`, naming the fields); the change is audited with the field names. **Hard-excluded, never selectable** (a start-up error if a catalog name matches an excluded word): password hashes, tokens, OTPs, device secrets and API keys; Aadhaar, PAN and any government ID; bank names, account numbers and IFSC; PF / ESI / UAN numbers; photographs; biometric and device ids; HR user accounts, roles and sessions; every column that is not listed. An endpoint can **lock** filters (for example `status = active`, or `visibleToExternal = true` on employees) that a caller can never override.
- **The public call** (no HR login; `shared/` is in `EXEMPT_PREFIXES` of the permission middleware and `/api/shared/` is skipped by the global CORS via `CORS_URLS_REGEX`, because this route does its own CORS). Checks in order: the endpoint exists and is enabled (404 `not_found`, the same for unknown and disabled); the `Origin` header, if present, must be on this endpoint's list (403 `origin_not_allowed`), if absent the endpoint must allow server-to-server calls (403 `origin_required`); the key from `Authorization: Bearer <key>` or `X-API-Key` (never the query string) (401 `invalid_key`, the same answer for missing, unknown, revoked, expired and another endpoint's key); a per-key rate limit (429 `rate_limited` with `Retry-After`; default 60 a minute, 1-6000); filters, `page` and `pageSize` (400 `invalid_parameter` naming the parameter; an unknown or repeated parameter is a 400; `pageSize` is capped by the endpoint and the dataset). The answer is `{"data": [...selected fields only], "meta": {endpoint, dataset, category, fields, page, pageSize, total, hasMore, generatedAt}}` with `Cache-Control: no-store` (`meta.category` is `"staff"`, `"production"`, or `null` for an older key made before categories existed). A preflight `OPTIONS` from an allowed origin is answered 204 without a key; an allowed origin gets `Access-Control-Allow-Origin: <that origin>` on every response (never `*`, never credentials). **Origins protect browsers only: any non-browser caller can send any `Origin`, so the key is what protects the data.** The caller's address (log, failed-key limiter) is the last `X-Forwarded-For` hop.
- **Keys.** `uks_<8-character prefix>_<43 url-safe characters>`; only the SHA-256 is stored (the prefix is shown so a key can be recognised) and the plaintext is returned **once**, in the create response. At most 10 live keys per endpoint, 20 origins and 100 endpoints; revoking is immediate. After a failed key the caller's address is counted, so a key-guessing loop turns into 429. A key is made with `POST /api/shared-endpoints/<id>/keys` and a body of `{label, category, permanent | expiresAt}`:
  - **`category`** is required and is exactly `"staff"` or `"production"` (`""`, `"all"`, any other text or type is a 400). It is stored in `shared_endpoint_keys.category`. It is refused (400) when it contradicts the endpoint's locked `employmentType` filter (such a key would read nothing).
  - **The expiry is explicit**: exactly one of `permanent: true` (a real boolean; stored as `expires_at = NULL`, the key works until it is revoked) or `expiresAt` (a date `YYYY-MM-DD` = the end of that day in factory time, or an ISO date-time; a date-time without an offset is factory time IST). It must be in the future and at most 10 years away. Neither or both is a 400 ("Choose when the key expires, or make it a permanent key."). A string `"true"` for `permanent` is a 400.
  - The key JSON (create answer and list) carries `category` (`"staff"` / `"production"` / `null`) and `permanent` (true when there is no expiry). The audit row (`key_create`) records the category and `permanent` next to the label and prefix, never the key.
  - **Older keys** (made before categories existed) have `category = ""`: they keep working exactly as before and see **both** kinds of data (`category: null` in the JSON; the UI shows "All data (older key)"). They cannot be re-scoped: revoke and create a new key. New keys can no longer be made without a category.
- **Data categories, strictly enforced.** Category = `Employee.employment_type` (`staff` | `production`). After the key is accepted, `shared_datasets.apply_category(dataset, queryset, key.category)` narrows the dataset's queryset as one more `.filter()`, **before** `meta.total` is counted and before the page is cut, so nothing can widen it: not a query parameter (`employmentType=production` on a staff key is ANDed with it and returns zero rows, never the other category), not a locked filter, not `page` / `pageSize`, not which fields are selected; `meta.total` never counts the other category. An unrecognised stored category returns nothing (fail closed). Every dataset must declare how the category applies (`Dataset.category_scope` function **or** `category_neutral=True`); a dataset that declares neither (or both) is a start-up error, and a test pins it, so a new dataset cannot be added unscoped by accident. The admin preview (`POST .../preview`) takes an optional `category` and applies the same function.

  | Dataset | How the category applies |
  |---|---|
  | `employees` | the employee's own `employment_type` |
  | `attendance-days`, `attendance-punches`, `leave-requests`, `payroll-summary` | the `employment_type` of the row's employee (`employee__employment_type`; an inner join, so a row without an employee never matches) |
  | `departments`, `branches`, `designations` | only the rows that have at least one employee of that category (an `EXISTS` subquery, so no row is duplicated and paging stays exact), whatever that employee's status, so every `departmentId` / `branchId` in the category's employee rows resolves |
  | `holidays` | **neutral**: the company calendar holds no employee data, so a staff key and a production key both see every holiday |

  Payroll follows the employee's *current* type (the same rule as every other dataset): an employee moved from production to staff takes their old production payroll rows to the staff key.
- **Management API** (`/api/shared-endpoints...`, listed in `api-database-reference.md`): catalog, list / create / get / update (`PUT`, all-or-nothing, `expectedVersion` stale guard) / delete, keys (create, list, revoke), a preview (the first rows exactly as the public call shapes them; no key, no log row), activity, and a generated integration guide per endpoint (example code in six languages).
- **Access log and audit.** One row per call to a known endpoint (status, rows, origin, IP, duration, error code) in `shared_endpoint_access_logs`, kept 90 days (purged at most hourly); failure rows are capped per endpoint per minute. Audit module `shared_endpoints` (`create`, `update`, `delete`, `key_create`, `key_revoke`) with old and new values, never a key; `key_create` records the key's category and whether it is permanent. The access log has no category column (a call is attributed to its key, and the key carries the category).
- **Tables** (migration `0122_shared_endpoints`, additive): `shared_endpoints`, `shared_endpoint_origins`, `shared_endpoint_keys`, `shared_endpoint_access_logs`. Migration `0131_shared_endpoint_key_category` adds one column, `shared_endpoint_keys.category` (`varchar(12)`, default and `db_default` `''`, so the previous release can still insert keys during a rolling deploy; existing keys become `''` = unscoped).
- **Tests.** `api/tests_shared_endpoints.py`, `api/tests_shared_datasets.py` (the catalog, and that no excluded name can exist in it), `api/tests_shared_categories.py` (every dataset x both categories with staff and production seed data, adversarial query strings, locked filters, legacy and corrupted keys, the key-creation validation matrix, permanent and expiring keys against a moved clock, the preview); browser: `frontend/e2e/endpoint-sharing.spec.ts`.

### 4.17 PF, ESI & TDS (Co Emp, rules, TDS, coverage)
PF and ESI are no longer company-wide. They apply only to the employees HR switches on as **Co Emp** (Employees → Co Emp tab, `Employee.co_emp_enabled`), by rules the **Super Admin** keeps on **Settings → PF & ESI**; a separate **TDS** list holds the employees who have tax deducted at source instead. The whole model is one module, `api/pf_esi.py`, shared by both payroll engines, the Compensation page's employer cost, the coverage report and the settings API, so they cannot disagree. (Redesign of 2026-10-24; the API shapes are in `api-database-reference.md`, "PF & ESI, TDS and Co Emp".)

- **Categories (exactly one per employee).** *Co Emp* (`co_emp_enabled`): PF and ESI can apply; the employee is also visible in the CoPortal, exactly as before. *TDS* (`tds_enabled` plus `tds_percent`, above 0 and at most 100): TDS only, never PF or ESI; a TDS employee **stays visible in the CoPortal** (`pf_esi.COPORTAL_Q`, Co Emp OR TDS, is the scope of every CoPortal and "visible to an external application" query). *Neither*: nothing is deducted, ever. Co Emp and TDS exclude each other and the server enforces it in one transaction with the employee row locked: adding an employee to TDS (`POST /tds/employees`) switches Co Emp off, turning Co Emp on (`PATCH /employees/<id> {coEmpEnabled: true}`) takes the employee out of TDS, and removing from TDS leaves the employee in neither. If bad data ever carried both flags, TDS wins in the engine.
- **Rules.** Four independent lists: staff PF, staff ESI, production PF, production ESI (`PayrollSettings.staff_pf_rules`, `staff_esi_rules`, `prod_pf_rules`, `prod_esi_rules`, JSON, migration 0126). A rule is `{id, label, basis, minAmount, maxAmount, ratePercent}` and matches when `minAmount <= amount <= maxAmount` (both ends included, `maxAmount` 0 = no upper limit), where `amount` is the employee's FULL MONTHLY amount of the rule's `basis`: `basic` (the Basic component of the salary split, the default), `first_portion` (Basic + DA + Retaining Allowance) or `total` (the whole monthly salary; production: the monthly equivalent of the period's pay). The first matching rule in list order wins and no match means no deduction of that kind. Ranges of one list may not overlap (rules of different bases are not compared). Submitted lists are validated strictly by `clean_rule_list` (at most 50 rules a list, amounts 0 to 99,999,999.99 with at most two decimals, a percentage 0 to 100, unique ids) and a bad one is a 400 naming the list, the rule and the field.
- **Scopes.** *Global*: the four lists on the universal `payroll_settings` row, read by every login. *Unit-wise*: a branch can have a set of its own, a copy of all four lists inside `BranchSettingsOverride.overrides`, written only by `PUT /pf-esi-settings` (the generic settings API never touches them and `user_settings.persist_overlay` keeps them exactly as stored). A branch without its own set follows the global one; payroll resolves rules from the EMPLOYEE's branch (`settings_for_employee`), the settings page from the login's branch, so a branch login sees, read-only, exactly the rules its employees are paid under. **Only the Super Admin can write** (checked live in the database); `PUT` needs the `expectedVersion` content hash (409 `stale_version` when somebody saved first), `DELETE ?branchId=` returns a unit to the global rules, and every save is audit-logged (module `settings`) with the old and new lists.
- **Amounts.** PF or ESI = the matched rule's percentage x the FIRST 50% portion (Basic + DA + Retaining Allowance) of the period, prorated by attendance exactly as payroll prorates `basic`. **ESI uses the same base as PF now** (it used to be a percentage of all the pay earned). Staff are judged on their full monthly salary split (the recorded split, else the automatic one) and never on a part-month figure, so a short month cannot flip eligibility. **The automatic split gives Basic only one sixth of the salary** (the first half is shared equally by three components), so a rule "Basic below 25,000" covers salaries up to 150,000 unless HR records a split; for "salary below X" the rule's *Range based on* must be *Full monthly salary*. Production: eligibility is judged on the monthly equivalent of the period's earnings (Weekly x4, BiWeekly x2, Monthly x1, `production_cycles.MONTHLY_EQUIVALENT_FACTOR`) times the worker's split share of the chosen basis, and the deduction is the percentage of the first 50% of the period's earned pay. **TDS** = the employee's `tds_percent` of the EARNED GROSS of the period (staff: the pay earned plus overtime pay; production: the period's gross), rounded to 2 places, only for a TDS employee whose percentage is above 0. Worked examples: salary 20,000, Co Emp, PF 12% and ESI 0.75% rules that fit: full month PF 1,200 + ESI 75 (of the first portion, 10,000), net 18,725; 22 of 24 days paid: PF 1,100.00 + ESI 68.75. Salary 30,000 on TDS at 10%: TDS 3,000, no PF or ESI, net 27,000.
- **Payroll output.** `SalarySlip` and `Payroll` gained `tds_deduction` and `tds_percent` (the percentage used: a snapshot, so changing it later never rewrites an old slip). Staff `total_deductions = PF + ESI + TDS + advance + late` and `net = gross + OT - total_deductions`; production `net = gross - (PF + ESI + TDS + advance + late)`. A slip's `breakdown_details.deductions` keeps `pf, pfRate, esi, esiRate, advances, ...` and adds `tds`, `tdsPercent` and `statutory` (category, PF wages, the rule that matched with the amount it was tested on, the three eligibility amounts, rules scope, the TDS base and a reason). The old keys `esiApplicableBelow` and `pfEfRule` are no longer written; every reader (insights, Report Center, MD portal) also copes with slips stored before the redesign, which have no `statutory` block and no TDS (PF wages = `basic`, ESI wages = `gross_salary`). Any code that works out "late / other deductions" as `total - PF - ESI - advance` must also subtract TDS (`payroll_core_common.derive`, the Salary Statement and the MD analytics do).
- **Where TDS shows, and where it does not.** A **`TDS (10%)` line** appears only on documents of TDS employees: the salary slip (single PDF and the combined 2-per-page PDF; every other employee's slip has no TDS line at all) and the payroll Details page. Register-style outputs carry a **TDS column** that is 0 or blank for everybody else, so totals add up: the Salary Statement (staff and production, `others = total deduction - PF - ESI - TDS - advance`), the Report Center payroll registers, `GET /salary-slips` (`tdsDeduction`, `tdsPercent`), `GET /reports/payroll`. The Rules view of the insights pages lists the real PF and ESI rule lists of the scope (group "Statutory (PF / ESI)", linked to Settings → PF & ESI) plus a TDS note.
- **Report Center and MD portal.** The statutory statements read the stored slips and tell old slips from new ones: the **PF Statement** and **ESI Statement** take their wages from `deductions.statutory.pfWages` (PF and ESI now share the first-portion base) and fall back to `basic` / `gross_salary` for a slip stored before the redesign; the ESI Statement's coverage column says *Covered*, *Co Emp, no rule matched*, *TDS employee* or *Not Co Emp* (there is no "above the ESI ceiling" any more); the **PF / ESI Coverage Register** has a Category and a TDS % column and a category filter; the new **TDS Statement** (`tds-statement`) lists, per month, the employees with TDS on a slip (TDS %, TDS base, TDS deducted, totals); **PF / ESI Coverage** (`pf-esi-coverage`) is the live counterpart of the coverage endpoint. The salary registers, wage sheet, deduction summary, annual earnings statement and department cost carry a TDS column (0 for everybody else), and `payroll_core_common.derive()` / `LATE_SQL` subtract TDS before working out late and other deductions. The Payroll Controls check reads "total deductions = PF + ESI + TDS + advance + late". The employee **Statutory & KYC** report asks only Co Emp employees for PF, ESI and UAN numbers (nobody else can be charged them); numbers that are filled in are still format- and duplicate-checked for everyone. The MD portal's payroll pages show TDS as its own deduction line (never inside "other deductions" and not part of "statutory due", which stays PF + ESI + the employer shares), take the employer PF / ESI estimate bases from the stored `statutory.pfWages` (old slips: `basic` / `gross_salary`), and the AI assistant's `salary_slips` dataset has `tds_deduction` and `tds_percent` measures. The MD demo data (`seed_md_demo`) and the dev seed (`seed_data`) create Co Emp, TDS and plain employees whose slips are worked out with the real `pf_esi` functions.
- **Coverage: how many employees have PF / ESI deductions and how many do not.** `GET /pf-esi/coverage?type=staff|production|all&branchId=&detail=1` counts, per class, the active employees: total, Co Emp, with PF, with ESI, with both, with PF and/or ESI, Co Emp but no deduction (no rule matched), TDS, not Co Emp, and (production) not evaluated yet (`pf_esi.coverage_rows` / `coverage_counts`; staff are judged on their current salary split, production on the monthly equivalent of the latest generated period). `GET /pf-esi/coverage/export?format=xlsx|pdf&type=...&branchId=` downloads the same numbers (`pf_esi_coverage_export.py`): per class a summary block and one row per employee, one worksheet per class in Excel and one printable section per class in the PDF, as `attachment; filename="pf_esi_coverage_<type>_<YYYY-MM-DD>.<ext>"`. The Report Center has the same report as **PF / ESI Coverage** (`pf-esi-coverage`). Permission is the `employees` module and a branch login only ever gets its own branch. (DRF reads `?format=` as a renderer suffix and would answer 404 for `xlsx` / `pdf`, so the export view switches content negotiation off.)
- **Employer cost.** `ctc.ctc_figures` (Compensation page, CTC statement) uses the same rules: employer PF / ESI = the matched rule's percentage x the monthly first portion, 0 for an employee who is not Co Emp.
- **Data migration and rollout.** Migration 0127 converted whatever was enabled of the retired methods (flat rates, the ESI ceiling, the production salary bands, the "payroll rules" switches) into rules on the `total` basis and invented nothing where nothing was enabled; the old columns and the old `BranchSettingsOverride` keys stay in the database but nothing reads or writes them. **Rollout note: until HR switches Co Emp on for them, employees who used to get PF / ESI get none on the next generation. Stored payroll is never recomputed** (regenerating a month under the new rules is a separate, deliberate step).
- **Files and tests.** `pf_esi.py` (model, rules, arithmetic, coverage), `pf_esi_views.py` (`/pf-esi-settings`, `/pf-esi/coverage`), `tds_views.py` (`/tds/employees`), `pf_esi_coverage_export.py` (Excel / PDF), `reporting/definitions/pf_esi_coverage.py`, migrations `0126_pf_esi_tds_schema` and `0127_pf_esi_rules_data`. Tests: `api/tests_pf_esi.py` (rules, API, categories, engine, CoPortal, migration), `api/tests_pf_esi_outputs.py` (slips, coverage export, Report Center twin), `api/tests_payroll_insights.py` (details lines, Salary Statement, rules, settings links), `api/tests_reporting_payroll_statutory.py` / `tests_reporting_payroll_core.py` (statements and registers), `api/tests_md_payroll.py` / `tests_md_demo_seed.py` (MD analytics, demo data, dev seed).

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
│   ├── production_shift_rules.py       # Production shift rules: pure engine (groups, ladder, paid-time breaks, grace, night-session resolver, judge_day) + load_ruleset(); no database inside the calculation
│   ├── production_shift_rules_views.py # Settings -> Production Shifts API: GET/PUT /production-shift-rules (one document, all-or-nothing, version guard, audited) and POST /production-shift-rules/preview
│   ├── reporting/definitions/production_judge.py   # How the Report Center reads a production day under the rules (ProductionJudge, shift_day_punches, history helpers); used by hr_reports.py and attendance_core_data.py
│   ├── payroll_progress.py             # In-memory bulk-generation progress tracker
│   ├── payroll_insights.py / payroll_insights_rules.py   # Read-only explanations of stored payroll: issue detection, money lines, rules (applied vs current), Settings deep links, bulk loaders
│   ├── compensation_rules.py / compensation_engine.py / compensation_apply.py   # OT / Compensation: pure rules, database context for the attendance engine, relaxation top-up and balance
│   ├── overtime.py / overtime_scheduler.py / compensation_views.py / compensation_settings_views.py   # OT detection (idempotent upsert + 15-minute background pass), OT list / assign / reject / balance, Settings -> Compensation API
│   ├── compensation_windows_views.py / holiday_work_views.py / compensation_birthday_views.py / compensation_reports_views.py   # Compensation Leave A / B / C and History & Reports
│   ├── employee_compensation_views.py  # /employee/compensation and /employee/hod for the employee apps
│   ├── payroll_insights_views.py / payroll_statement_views.py   # GET details / issues / rules and the printed Salary Statement (staff under /payroll, production under /payroll/production)
│   ├── salary_slip_views.py / salary_slip_bulk_pdf.py / salary_slip_bulk_progress.py
│   ├── whatsapp_service.py / whatsapp_views.py / whatsapp_bulk_progress.py / idcard_render.py
│   ├── email_catalog.py / email_service.py / email_control_views.py   # Every email goes through email_service; Gmail Control page (gmail-integration.md)
│   ├── otp_service.py / otp_views.py   # One-time codes (login / reset / activation), the WhatsApp-or-SMS channel switch, auth/login-options + auth/otp/* (Section 4.15)
│   ├── sms_service.py / twofactor_client.py / sms_control_views.py   # SMS codes through 2Factor: send pipeline, caps, circuit breaker; the one HTTP call; the SMS Control API (Section 4.15, twofactor-sms-otp-integration.md)
│   ├── throttles.py                    # @throttle("scope"): real per-IP limits on the public sign-in / code / gate endpoints; NUM_PROXIES says who the client is
│   ├── shared_datasets.py / shared_endpoint_views.py / shared_endpoint_admin_views.py   # Endpoint Sharing: the dataset catalog (whitelist), the public GET /api/shared/<slug>, the super-admin management API (Section 4.16)
│   ├── salary_split.py                 # The mandatory 50% + 50% salary split (Basic/DA/Retaining | Other/Petrol/HRA/Special/CA); descriptive, payroll ignores it
│   ├── ctc.py                          # Employer PF / ESI / annual CTC from the salary split; shared by the Compensation page and the Report Center CTC statement
│   ├── pf_esi.py                       # PF, ESI and TDS in one place: Co Emp / TDS categories, the four rule lists (validation, matching), the arithmetic, the coverage rows and counts (Section 4.17)
│   ├── pf_esi_views.py / tds_views.py / pf_esi_coverage_export.py   # /pf-esi-settings (Super Admin writes), /pf-esi/coverage, /tds/employees, and the coverage Excel / PDF export
│   ├── approval_workflow.py            # Approval pipelines: the 11 workflows, step rules, decide()/can_act(), per-request `approval` block, ON/OFF guard (Section 4.13)
│   ├── approval_workflow_views.py      # Approval Workflow Control API: GET/PUT/DELETE /approval-workflows, GET /approval-summary
│   ├── arrival_rules.py                # The morning arrival timeline (on time / Late / excused / quarter shift / second half) from each shift's start + grace; pure, shared by the engine, the WhatsApp late alert and the Settings preview
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
│   ├── reporting/                      # Report Center: registry, filters, Excel/PDF exporters, definitions/ (one module per domain; md_*.py are the MD's executive reports)
│   ├── md_portal/                      # The MD portal (Section 4.14, md-portal.md): common.py contract, analytics/ + routes/ per page, assistant/ (Gemini, tools, privacy, XAI)
│   ├── reports_views.py (deprecated) / chat_views.py / growth_views.py
│   ├── audit_utils.py                  # Activity Logs
│   ├── apps.py                         # APScheduler startup (biometric sync, backups, retention)
│   ├── urls.py                         # All URL routing -source of truth for the full route list
│   └── migrations/
├── management/commands/
│   ├── seed_md_demo.py (+ md_demo/)    # Demo company for the MD portal; throwaway *_e2e databases only
│   ├── sync_biometric.py
│   ├── restore_backup.py
│   └── purge_screening_documents.py
└── config/settings.py
```

---

## 6. Attendance Engine In-Depth

Lives in `shift_engine.py` and `attendance_final.py`; every threshold below is HR-editable in Settings → Attendance/Late Detection (`PayrollSettings` model) -none of it is hardcoded, so the same codebase serves any company's policy without a code change.

**Current staff arrival rules (supersede the older punctuality-window text below where they differ):** the first punch is placed on the *arrival timeline* of the employee's own shift (`arrival_rules.py`): on time to start + grace, **Late** for `arrivalLateWindowMinutes` (60, Full Day + one late-pool occurrence), then the permission window (`arrivalPermissionWindowMinutes`, 60: an approved in-cap Morning Late-In permission excuses up to here, otherwise a **quarter shift**), then `arrivalExtraMinutes` (20: quarter shift, never covered by a permission), and after that the first half is missed: **Absent until a punch at/after Second Half Start, then Half Day**. A quarter-shift arrival earns `1 - arrivalQuarterDeduction` (0.75), is not also Late, and is not docked twice if the day is already a Half Day. All four numbers are Settings → Attendance; the fixed First Half End time is retired. See `attendance_final.compute_day_record`.

**Full vs Half Shift (staff, both modes):** Full only when a first *and* distinct last punch both fall within the **Shift Punctuality Window** (`shiftPunctualityWindowMinutes`, default 60 min) of the assigned shift's start/end. Anything else with ≥1 punch is Half Shift; zero punches (and not on leave/holiday) is Absent. No assigned shift ⇒ no reference, so no late flag either.

- **Half Shift Late Reference:** on a Half Shift day, "Late" is decided purely by whether the first punch is after a separate configured time (`halfShiftLateReferenceTime`, default 2:30 PM).
- **Night Shift Relaxation:** can upgrade a punctuality-caused Half Shift back to Full for employees who worked late the previous night.
- **Cross-midnight punch reattribution:** a forgotten evening exit punched after midnight is reattributed back to the correct shift-day within a configurable grace window, instead of corrupting the next day's punch order.

**Strict vs Simple (staff):** both share the Full/Half decision above. Strict additionally tracks lunch-return lateness (a first-half-end window locates the lunch punches). Simple only looks at first/last punch.

**Late Detection pool (Settings → Late Detection → Late Attendance):** plain lates + Half-Shift-day lateness + strict-mode lunch-return lateness + approved Permissions all feed **one shared monthly pool**. First `lateFreeAllowance` (default 3) are free; every occurrence past that is billable, priced by an HR-editable slab table. Empty table = no penalty.

**Permission Deduction Slabs (Settings → Late Detection → Staff; staff only, switch OFF by default, added October 2026):** by default an *excess* permission (an approved one beyond `permissionMonthlyCap`, counted over the whole calendar month and all three types together) is one mark in the late pool above. With `permissionPricingEnabled` ON the excess permissions **leave** the late pool (the pool is then Morning Late-In + Evening Early-Out only) and are priced on their own, the way the late pool is: the first `permissionFreeAllowance` (0-999) of them are free, the rest are *billable permissions*, priced by `permissionDeductionSlabs` (`[{fromPermissions: whole 1-999, deductionShifts: 0-31 with at most 2 decimals}]`, at most 50 rows, stored ascending with duplicate thresholds removed; the highest row reached wins, the last row holds beyond itself, an empty table deducts nothing). The lookup is the late slabs' own: `payroll_views.permission_shift_deduction` plugs the table into `late_shift_deduction`'s `slabs=` hook with `fromPermissions` handed over as `fromLates` for that call only (the stored settings are never changed). Penalty = shifts x daily rate, rounded half-up. A new payslip carries it as its own line, `deductions.permissionPenalty` plus `deductions.permissionSummary {enabled, approved, cap, excess, absorbedByLate, priced, freeAllowance, freeUsed, billable, shifts, penalty}`, and it is added to total deductions, `SalarySlip.other_deductions` and the net exactly like `lateShiftPenalty` (all additive keys; stored slips are never touched). **Never twice for one incident:** a day that is late (or early) AND carries an excess permission on the same edge stays ONE incident, counted in the late pool (`late_in` / `early_out` then include it), and that permission is *absorbed*: it is not priced again. So `excess == absorbedByLate + priced`, and (late pool total + priced permissions) is always the pool total the OFF formula would give. Only present / half-shift days on payroll working days can absorb a permission (a flagged Sunday absorbs nothing, its permission stays priced); the excess count itself stays the whole month, as it always was. The ONE shared pair of functions is `attendance_final.late_pool_summary` (the counts) and `payroll_views.late_pool_pricing` (shifts and rupees); payroll, `MonthlyShiftSummary` (its `shift_deductions` / `salary_deduction_amount` hold the TOTAL late + permission, which is all the installed My Shift screens read), the employee shift-stats preview (additive `permission*` keys in `summary` and `policy`), the late and permission reports, the payroll insights (`permission_penalty` deduction line, `excess_permission` issue, three rule items) and the MD demo data all call them, so they cannot disagree. OFF (the default) reproduces the old numbers to the paisa (pinned against a verbatim copy of the old formula in `tests_permission_slabs.py`). Production permissions are never priced. The three keys are company-wide (`COMPANY_WIDE_RULE_KEYS`: a branch login gets 403 `company_wide_rule`; `user_settings.COMPANY_WIDE_FIELDS` also makes the settings overlay ignore a stray branch value) and belong to the `settings.late_detection` permission group; switching ON with an empty table is refused (400 "Add at least one permission slab before turning this on."). **Production is never priced by any caller:** `shift_engine.compute_monthly_shift_summary` prices permissions only for `employment_type == "staff"` (a production summary is the same with the switch ON or OFF), the shift-stats preview reports pricing OFF with an empty slab table for production, and the reports build no pool for production. The HR recompute (`POST /api/attendance/compute-shifts`) works on staff only and passes payroll's ROUNDED daily rate (`_d2(salary / working days)`), so the recomputed `salary_deduction_amount` equals the payslip to the paisa. **Slab input is validated, never a 500:** `clean_permission_slabs`, the staff and production late slabs (`payroll_views._clean_late_slab_rows`) and the per-cycle late rules (`production_cycles.clean_slabs` / `merge_prod_cycles`) accept only plain numbers (text such as `1_0`, `1e1`, `nan`, `inf`, Unicode digits or a digit string beyond Python's int limit, true / false, 1e999 and 2.5 lates are refused with a 400 and nothing is saved); late slabs also stop at 999 lates and 31 shifts.

**Without Permission detection (Settings → Late Detection → Without Permission):** a separate, independent pool covering the narrow zone between the shift's grace period and the wider punctuality window (morning late-in and evening early-out, mirrored). An approved Permission near the relevant shift boundary suppresses it; without one, the day is flagged "Without Permission." Ships with **0 free allowance and an empty slab table** (zero payroll impact until HR explicitly configures it) -deliberately independent from the Late Attendance pool so nothing double-counts.

**Production attendance:** a separate segment-based engine (`ProductionShiftConfig`/`ProductionShiftSegment`) -each configurable punch window earns its own shift fraction. Sunday is a normal working day.

**Production shift rules (October 2026):** from `ProductionShiftConfig.rules_effective_from` a production day is judged by the groups, ladders, unpaid breaks and 5-minute grace of `production_shift_rules.py` (Day / Night / Sunday, night sessions closed by the next morning's punch, up to 3.00 shifts a day); earlier days keep the segment engine above. See the "Production shift rules (October 2026)" bullet in 4.7.

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
| Employees | `GET/POST /employees`, `GET/PUT/DELETE /employees/<id>`, `PATCH /employees/<id>/status`; the Co Emp switch is `PATCH /employees/<id> {coEmpEnabled}` |
| PF & ESI, TDS, Co Emp | `GET/PUT/DELETE /pf-esi-settings` (rules; Super Admin writes), `GET /pf-esi/coverage`, `GET /pf-esi/coverage/export?format=xlsx\|pdf`, `GET/POST /tds/employees`, `PATCH/DELETE /tds/employees/<id>` |
| Attendance | `GET /attendance/summary`, `/daily`, `/monthly-trend`, `/employee/<id>`; `POST /attendance/manual`, `/attendance/sync-biometric`, `/biometric/punch` |
| Leave & Holiday | `GET/POST /leave-types`, `/leave-requests`, `/permissions`, `/holidays`; `PATCH /leave-requests/<id>/status` |
| Payroll | `GET/POST /payroll`, `GET /payroll/<id>/breakdown`, `POST /payroll/skip-check`, `GET/PUT /payroll-settings`; read-only insights: `GET /payroll/<id>/details`, `/payroll/issues`, `/payroll/rules`, `/payroll/salary-statement` |
| Production Payroll | `GET /payroll/production?cycle=`, `POST /payroll/production/generate` (`cycle`, optional period / `employeeIds`), `GET /payroll/production/skip-check`, `/next-period`, `/periods`, `/period-status`, `/cycles`; read-only insights: `GET /payroll/production/<id>/details`, `/payroll/production/issues`, `/payroll/production/rules`, `/payroll/production/salary-statement` |
| Production Employees | `GET /employees/production`, `POST /employees/production/assign` |
| Salary Slip | `GET/POST /salary-slips`, `/<id>/email`, `/<id>/whatsapp`, `/bulk-email`, `/bulk-whatsapp` |
| WhatsApp | `GET /whatsapp/status`, `GET/PUT /whatsapp/templates` |
| HR / support contact | `GET /support-contact` (public, read-only; edited under Settings → HR Contact via `PUT /payroll-settings`) |
| Gmail Control | `GET /gmail-control/overview`, `/messages`, `/employees`, `/settings`, `/templates`; `PUT /gmail-control/settings`, `/templates/<type>`; `POST /gmail-control/templates/<type>/preview`, `/test-email` |
| One-time codes (OTP) | Public: `GET /auth/login-options` (`otpChannel`, `codeLength`), `POST /auth/otp/request` (`channel`, `codeLength`), `/auth/otp/login`, `/auth/otp/reset-password`, `/auth/otp/activate` (WhatsApp or SMS, per SMS Control) |
| SMS Control | `GET /sms-control/overview`, `/settings`, `/messages`; `PUT /sms-control/settings`; `POST /sms-control/test` (module `sms_control`) |
| Endpoint Sharing | Public, API key: `GET /shared/<slug>`. Super admin only: `GET/POST /shared-endpoints`, `GET/PUT/DELETE /shared-endpoints/<id>`, `/shared-endpoints/catalog`, `/activity`, `/<id>/keys`, `DELETE /<id>/keys/<kid>` (revoke), `/<id>/preview`, `/<id>/activity`, `/<id>/guide` |
| ID Card | `GET /idcard`, `POST /idcard/email`, `/idcard/whatsapp` |
| Department Managers | `GET/POST /department-managers`, `POST/DELETE .../departments`, `.../employees` |
| Manager Approvals (mobile) | `GET /manager/me`, `/manager/pending-requests`, `PATCH /manager/leave-requests/<id>/status` |
| Dashboard | `GET /dashboard/hr-summary`, `/dashboard/employee-summary` |
| Backup | `GET/POST /backup`, `POST /backup/restore/validate`, `/backup/restore/run`, `GET /backup/restore/status` |

---

## 11. Database Schema (selected tables)

| Group | Tables |
|---|---|
| Core | `branches`, `departments`, `designations`, `employees` (`co_emp_enabled`; `tds_enabled`, `tds_percent` since 0126) |
| Attendance | `attendance`, `attendance_logs`, `attendance_day_records` (final per-day verdict, payroll's source of truth), `daily_shift_log`, `night_shift_relaxations`, `on_duty_sessions`/`on_duty_punch_verifications`, `biometric_devices`, `auto_sync_rules`, `missing_punch_requests` |
| Leave | `leave_types`, `leave_balances`, `leave_requests`, `employee_permissions`, `casual_leaves`, `holidays` |
| Shift & Payroll | `shift_templates`, `employee_shift_assignments`, `production_shift_config`/`production_shift_segments`/`production_shift_groups`/`production_shift_rules`/`production_breaks`, `payroll`, `payroll_settings` (PF / ESI rule lists `staff_pf_rules` ... `prod_esi_rules`), `salary_slips` (`tds_deduction`, `tds_percent`), `branch_settings_overrides`, `whatsapp_message_log`, `whatsapp_message_template`, `email_message_log`, `email_settings`, `email_message_template` |
| Settlement | `advances`, `advance_repayments` |
| User Management & Auth | `department_managers`, `manager_department_assignments`, `manager_employee_assignments`, `manager_employee_exclusions`, `hr_users`, `roles`, `login_sessions`, `audit_logs` |
| Recruitment & Documents | `jobs`/`applicants`, `hiring_rule_sets`/`screening_candidates`, `company_document_settings`, `employee_documents` |
| SMS codes & Endpoint Sharing | `sms_settings`, `sms_message_log` (migration 0123); `shared_endpoints`, `shared_endpoint_origins`, `shared_endpoint_keys`, `shared_endpoint_access_logs` (migration 0122; `shared_endpoint_keys.category`, migration 0131) |
| Other | `notifications`, `employee_requests`, `backup_schedules`/`backup_drive_configs`, `chat_messages` |

---

## 12. Known Limitations

- **Weekly-off is hardcoded to Sunday** for staff -not configurable per branch/unit yet.
- **Legacy leftovers:** `SessionConfig`/`WorkSession` models, `prod_first_half_*` `PayrollSettings` fields, and the "Legacy Session Config" panel on Staff Payroll exist only to keep old session-based records viewable. Safe to remove once those old records no longer need viewing.
- **Legacy `SalaryRecord` auto-calc** (`÷26` monthly / `÷6` weekly, in `views.py`) is superseded by the real payroll engine -a removal candidate.
- **Production employees without `salary_per_shift` are skipped at generation**, by design -reported clearly in the Skipped Employees list.
- **Biometric device Comm Key** can't be validated against the device itself from the UI -a wrong value is only caught when a sync actually fails.
- **PF / ESI coverage for production is a prediction.** A production worker's pay changes every period, so the coverage report judges a Co Emp worker on the monthly equivalent of their latest generated period (no payroll yet = "not evaluated"); the real deduction is decided when each period is generated.
- **Slips stored before the PF & ESI redesign keep their old basis** (ESI as a percentage of all earned pay, PF from `basic`, no TDS) and are never recomputed; the Report Center statements show both kinds side by side.

---

## Contributing / Development Notes

- Employee Code is the **primary human identifier** across every module; numeric DB IDs are internal only.
- POST endpoints accept both camelCase and snake_case field names (React Native compatibility).
- `GET /api/dashboard/employee-summary` is the single source of truth for what an employee can do in the mobile/web app (`isManager`, `canSubmitLeave`).
- APScheduler runs inside Django's `ready()` -in dev with autoreload, Django starts twice; every scheduler module checks `RUN_MAIN` to avoid double-scheduling.
- Never bulk-mutate payroll/financial data as a side effect of a code fix -a verified-safe query/display fix and an actual data correction are always separate, explicitly-approved steps.
