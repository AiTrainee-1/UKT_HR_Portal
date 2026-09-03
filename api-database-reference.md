# UKTextiles HRMS — API & Database Reference

Auto-generated reference covering the complete Django REST backend (`backend/api/`): every registered API endpoint (252 routes) and every database table (71 models). This complements `backend.md` (architecture/setup) — that doc explicitly defers the full route list to this one.

**Auth shorthand used below:** `@require_auth` = any valid JWT (HR or employee). `@require_hr` = HR portal account only. `@require_super_admin` / `@require_master_admin` = progressively stricter HR-only tiers. "No auth decorator" is called out explicitly wherever it occurs — in this codebase it's usually deliberate (a public endpoint), but a few spots dispatch auth manually inside the function body instead of via a decorator, which is also noted.

---

# Part 1 — API Endpoints

## Health & Auth (views.py)

- **GET /api/healthz** — Trivial liveness check, returns `{"status": "ok"}`. No auth decorator (public, by design — used for uptime/health probes).
- **POST /api/auth/hr-login** — HR Portal login: validates username/password (bcrypt) against `HRUser`, enforces a per-username lockout (5 failed attempts/15 min via `HrLoginAttempt`) independent of the DRF IP throttle, logs the attempt, and on success issues a 12-hour JWT plus creates a `LoginSession` row (jti-linked, powers the Login Devices page/remote logout). No auth decorator (public login endpoint, as expected) — has `@throttle_classes([ScopedRateThrottle])`.
- **POST /api/auth/employee-login** — Mobile/employee login: looks up `Employee` by phone/email/employee_code, checks bcrypt password hash, stamps `last_mobile_login_at` (feeds the Mobile App Login report), and returns a JWT. No auth decorator (public login endpoint, as expected).
- **POST /api/auth/set-password** — Lets an employee (identified by phone/email/employee_code) set/reset their password hash directly, with only an 8-char minimum-length check — no verification of a prior password or OTP. No auth decorator (public, as expected for a "first-time password setup" flow — worth confirming this is intentionally unauthenticated).
- **GET /api/auth/me** — Returns the caller's identity from the JWT; for an HR role it re-resolves `HRUser`/`Role` fresh from the DB (not trusted from the token) to return live `isSuperAdmin`, `isMasterAdmin`, `permissions`, and branch info. `@require_auth`.
- **POST /api/auth/logout** — Revokes the current session by stamping `revoked_at` on the `LoginSession` matching the JWT's `jti`. `@require_auth`.

## Departments (views.py)

- **GET, POST /api/departments** — GET lists departments (branch-scoped) annotated with active employee counts; POST creates a department, forcing the branch to the caller's scoped branch if they're branch-restricted, and refuses creation with no branch at all. `@require_hr` on the outer view (both methods).
- **GET, DELETE /api/departments/\<pk\>** — GET returns one department (with active employee count) branch-scoped; DELETE hard-deletes it. `@require_hr` on the outer view (both methods).

## Employees (views.py)

- **GET, POST /api/employees** — GET returns the full staff directory (branch-scoped, filterable by department/designation/branch/status/salaryType/employmentType/search-by-name-or-code, with `countOnly` and page/pageSize pagination modes including staff/production count aggregates); POST creates a new employee (auto-resolves department/designation/branch from either an ID or a name string, assigns the next branch unit code, auto-assigns a production shift if applicable). The outer `employees` function itself carries no decorator, but internally dispatches every request through `require_hr(...)` — so both GET and POST are effectively HR-only (the code comment notes this list previously leaked salary/bank/phone data to any logged-in employee).
- **GET, PATCH, DELETE /api/employees/\<pk\>** — GET returns one employee record (an employee token may only fetch their own, same 404 either way to avoid id-probing); PATCH updates any field (re-resolves department/designation/branch, re-mints unit code on branch change, re-runs production-shift auto-assignment); DELETE removes the employee. No decorator on the outer `employee_detail` function; internally GET dispatches via `require_auth`, PATCH and DELETE via `require_hr`.
- **GET /api/employees/\<pk\>/photo** — Streams a data-URI-stored employee photo as a real image response (with 1hr cache header) — the lazy-load counterpart to list responses substituting a photo link. Access: the owning employee token, or branch-scoped HR. `@require_auth`.
- **PATCH /api/employees/\<pk\>/status** — Updates an employee's `status` field (branch-scoped). `@require_hr`.
- **POST /api/employees/bulk-upload** — Multipart Excel upload; validates the header row exactly matches the official template, skips "SAMPLE" rows, creates one new `Employee` per valid row (loosened required-field rules vs. the single Add form), collects per-row errors/warnings. `@require_hr`, `@parser_classes([MultiPartParser, FormParser])`.
- **POST /api/employees/bulk-update** — Companion multipart Excel upload for *existing* employees, matched by Employee Code; only overwrites cells that are both non-blank and actually different, reports not-found codes, unchanged rows, and a per-employee changed-fields summary. `@require_hr`, `@parser_classes([MultiPartParser, FormParser])`.
- **PATCH /api/employees/location-tracking/bulk** — Turns `location_tracking_enabled` on/off for many employees at once (all active employees in scope, or a given `employeeIds` list). `@require_hr`.

## Org Structure (Branches & Designations)

- **GET, POST /api/branches** — `@require_hr`. GET lists active `Branch` rows. POST creates a branch (name, code, location, address, manager name, phone, head-office flag — setting `isHeadOffice=true` unsets it on every other branch, geofence lat/lng/radius).
- **GET, PUT, DELETE /api/branches/\<pk\>** — `@require_hr`. GET/PUT read or update any of the branch fields above; DELETE is a soft-delete (`is_active = False`), not a row removal.
- **GET, POST /api/designations** — `@require_hr`. GET lists designations (scoped to branch via their department, annotated with active employee counts), optionally filtered by `departmentId`. POST creates a designation (title, department, level); a branch-scoped caller must supply a `departmentId` that belongs to their own branch (400/404 otherwise) — an unscoped admin may create one with no department.
- **GET, PUT, DELETE /api/designations/\<pk\>** — `@require_hr`. Branch-scoped via department; GET returns detail plus active employee count, PUT updates title/department/level, DELETE removes the row. A designation outside the caller's branch scope 404s identically to a genuinely missing one, to avoid confirming its existence.

## Shift Management

- **GET, POST /api/shifts** — `@require_hr`. GET lists branch-scoped `ShiftTemplate` rows (filterable by `shiftType`/`departmentId`); POST creates a new shift template (name, type, start/end time, gender rule, grace period, first-half-end/lunch settings for staff, department, default flag), stamped with the creator's branch scope.
- **GET, PUT, DELETE /api/shifts/\<pk\>** — `@require_hr`. Reads, updates any of the shift-template fields listed above, or deletes a branch-scoped shift template.
- **GET, POST /api/shift-assignments** — `@require_auth`, with an inline extra check on POST (`is_hr(request)`, else 403 — so only HR can create assignments even though the route accepts any authenticated caller). GET lists branch-scoped active-employee shift assignments (an employee token forces the results to their own id; otherwise filterable by `employeeId`/`shiftId`/`activeOnly`/`employmentType`). POST creates a new `EmployeeShiftAssignment` (employee, shift, effective dates, optional per-employee custom start/end time override, Saturday-off flag).
- **POST /api/shift-assignments/bulk** — `@require_hr`. Assigns one shift to many employees at once, selected by explicit `employeeIds`, or by `departmentId`/`designationId` + `employmentType`, further filtered by gender rule (caller override or falling back to the shift template's own `gender_rule`); ends each matched employee's currently-open assignment and creates a new one.
- **POST /api/shift-assignments/sync-production** — `@require_hr`. Auto-assigns the branch's default production shift template (effective today) to every active production employee who doesn't already have an open shift assignment; returns synced/skipped counts.
- **PUT, DELETE /api/shift-assignments/\<pk\>** — `@require_hr`. Updates a branch-scoped shift assignment's shift/effective dates/notes/custom times/Saturday-off flag, or deletes it.

## Department Manager Actions — HR CRUD (User Management)

- **GET, POST /api/department-managers** — `@require_hr`. GET lists branch-scoped `DepartmentManager` (HOD) records with their department/employee assignment counts. POST promotes an employee (by `employeeCode` or `employeeId`, branch-scoped, must not already be a manager) into a manager row with per-capability approval flags (leaves, permissions, resignations, attendance, casual leave, on-duty, missing-punch) defaulting to true.
- **GET, PUT, DELETE /api/department-managers/\<pk\>** — `@require_hr`. GET returns full detail including assigned departments/employees; PUT updates any of the `canApprove*`/`isActive`/`notes` flags; DELETE removes the manager row.
- **POST, DELETE /api/department-managers/\<pk\>/departments** — `@require_hr`. Assigns (`departmentId`, must not already be assigned) or unassigns a department from a manager's oversight.
- **POST, DELETE /api/department-managers/\<pk\>/employees** — `@require_hr`. Assigns (`employeeId`/`employeeCode`, must not already be assigned) or unassigns an individual employee directly under a manager's oversight (independent of department-level assignment).

## Department Manager Actions — Mobile Self-Service & Approvals

- **GET /api/manager/me** — `@require_auth`. Returns the calling employee's own manager profile if they are an active `DepartmentManager` (else `{isManager: false, ...}`); when a manager, includes their capability flags plus pending counts broken out per request type (leave, permission, resignation, attendance, casual leave, on-duty, missing-punch) across their department + direct-assignment scope.
- **GET /api/manager/pending-requests** — `@require_auth`. Requires the caller to be an active `DepartmentManager` (else 403). Returns every leave/permission/resignation/attendance-override/casual-leave/on-duty/missing-punch request in that manager's scope, filtered by `status` (default "pending", or "all"), each request type additionally gated by whether that specific `canApprove*` flag is enabled for the manager; also returns a combined `totalPending` count.
- **PATCH /api/manager/leave-requests/\<pk\>/status** — `@require_auth`. Requires active manager status and `can_approve_leaves`; the leave request must be within the manager's scope. Sets status to approved/rejected, stamps `approved_by`/`approver_role="dept_head"`, and notifies the employee.
- **PATCH /api/manager/permissions/\<pk\>/status** — `@require_auth`. Same pattern as above, gated by `can_approve_permissions`, for `EmployeePermission` requests.
- **PATCH /api/manager/attendance-requests/\<pk\>/status** — `@require_auth`. Gated by `can_approve_attendance`; the request must still be `pending`. On approval, writes the requested values onto the employee's `AttendanceDayRecord` for that date (creating it via `compute_day_record` first if it doesn't exist yet) — this record feeds payroll; rejection leaves attendance data untouched. Notifies the employee either way.
- **PATCH /api/manager/casual-leaves/\<pk\>/status** — `@require_auth`. Gated by `can_approve_casual_leave`; delegates to the shared `apply_cl_decision` (same function the HR CL endpoint uses), which also writes the resulting `AttendanceDayRecord` and notifies the employee.
- **PATCH /api/manager/on-duty-sessions/\<pk\>/status** — `@require_auth`. Gated by `can_approve_on_duty`; the session must still be at the `STATUS_PENDING_HOD` stage. This is stage 1 of a two-stage approval — approval moves the session to `pending_hr` (HR must still approve before it goes active), rejection is terminal.
- **PATCH /api/manager/missing-punch-requests/\<pk\>/status** — `@require_auth`. Gated by `can_approve_missing_punch`; the request must still be at `STATUS_PENDING_HOD`. Also stage 1 of a two-stage chain — approval moves it to `pending_hr`, rejection is terminal (HR never sees a dept-head-rejected request).

## Attendance — Legacy (views.py)

- **GET, POST /api/attendance** — GET lists raw legacy `Attendance` rows (filterable by employeeId/year); POST does an `update_or_create` of one day's attendance record (present flag, hours worked, notes) for an employee/date. No decorator on the outer `attendance` function; GET dispatches via `require_auth`, POST via `require_hr`.

## Attendance — Summaries & Dashboards

- **GET /api/attendance/summary** — `@require_hr`. Returns today's company attendance snapshot for a given `date` (default today), optionally filtered by `employmentType` and branch: total/production/staff headcounts, present counts split by biometric vs manual source, not-punched counts, plus a "yesterday" block (present/absent/late/on-leave) computed from the same raw-punch helpers.
- **GET /api/attendance/company-summary** — `@require_hr`. Company-wide "Today's Overview" for the Attendance Search page; unlike `attendance/summary` (which uses cheap raw-punch counting) this bulk-loads punches/assignments/night-shift/permission data for every active employee and runs each through the real `compute_day_record` engine so Present/Half-Shift/Absent/On-Leave/Late and total shifts-earned match exactly what the per-employee search shows.
- **GET /api/dashboard/mobile-home-summary** — `@require_auth`. Mobile Home screen's "today at a glance" card, scoped to the requesting employee's own branch (derived from their own row); returns presentToday/absentToday/lateToday/permissionToday using the same counting helpers as the HR `attendance/summary` endpoint.
- **GET /api/attendance/live-feed** — `@require_auth`. Returns today's punch ticker, self-scoped to the requesting employee only (via token employee id) — each item's IN/OUT label is derived from time-sorted position within that employee's punches for the day, not the raw stored punch type, since biometric devices often record every punch as IN. Capped at 1–50 items via `limit`.
- **GET /api/attendance/monthly-trend** — `@require_hr`. Returns one row per elapsed day of the given `year`/`month` (optionally filtered by `employmentType` and branch) with present/absent counts, taking `max(biometric daily count, manual daily count)` as that day's present figure.

## Attendance — Daily & Employee History

- **GET /api/attendance/daily** — `@require_hr`. Bulk-fetches the day's punch logs, manual attendance rows, and approved-leave employee ids in 3 queries, then returns one row per active employee (optionally filtered by `employmentType`, branch-scoped) with status (present/manual/on_leave/absent), first/last punch, punch source and source label.
- **GET /api/attendance/employee/{pk}** — `@require_auth`, with an inline self-scope check: an employee token may only view its own id (`token_emp_id != pk` → 403). Returns one employee's full month (day-by-day) via `compute_month_records`/`month_summary_from_records` — the same day engine used by payroll and the HR portal — including status, isLate, isHalfShift, punches, leave type, hours worked, and a month summary block.
- **GET /api/attendance/employee-shift-stats** — `@require_auth`; if the caller has no employee token it additionally requires `is_hr(request)` (403 otherwise) and reads `employee_id` from the query string, whereas an employee token always gets its own stats regardless of any passed id. Returns a detailed monthly shift/attendance stats payload (present/absent/leave/half-shift/full-shift day counts, late-morning vs late-return splits, per-day punch logs, and a live permission/late-deduction preview mirroring the payroll formula) for one employee, used by both the mobile "My Shift" page and HR's Manage Shift panel.

## Attendance — Manual Entry, Biometric Device Webhook & Sync

- **POST /api/biometric/punch** — **No auth decorator** (`@api_view(["POST"])` only, no `@require_auth`/`@require_hr`). This is the AiFace-Mars device push webhook: authenticated instead by comparing the `X-Device-Key` header (or `apiKey` body field) against `settings.BIOMETRIC_API_KEY` inside the function body — not JWT/user auth at all. Resolves the employee strictly by `employee_code` (never falls back to internal db id, to avoid code/id collisions), creates an `AttendanceLog` row, and upserts the day's `Attendance` summary row to `present=True`.
- **POST /api/attendance/manual** — `@require_hr`. HR manually records attendance for one employee (e.g. after CCTV verification): branch-scoped employee lookup, optionally creates an `AttendanceLog` entry (source="manual") if a punch time is given, and upserts an `Attendance` row with present/hours-worked/notes.
- **GET /api/attendance/sync-status** — `@require_auth`. Employee-facing: tells the app whether today's attendance might still be incomplete because biometric hasn't synced — `pendingSync=true` only when the employee has a non-biometric punch today, no biometric punch yet, and no active device has synced since IST midnight.
- **POST /api/attendance/sync-biometric** — `@require_hr`. Kicks off a biometric device pull (`mode`: day/week/month/all; `deviceId`: specific/env/all) on a background daemon thread (so a slow multi-minute sync can't hold the request open past Gunicorn's timeout) and returns immediately with `started: true`, or `started: false` (202) if a sync is already running (guarded by `sync_progress.try_claim()`).
- **GET /api/attendance/sync-biometric-progress** — `@require_hr`. Polls the live Start → Device → Completed sync pipeline snapshot for the UI to display progress of the background sync started above.

## Attendance — Search, Reports & Shift Recomputation

- **GET /api/attendance/report-log** — `@require_hr`. Two modes off the same query: with `employeeId` given, returns one employee's full day-by-day month (every punch slot, status, late/half-shift flags, Casual Leave/Permission/Leave for each day) built from `compute_month_records`/`DailyShiftLog`; without it, returns one aggregate summary row per active staff employee for the month (optionally filtered by `department`/`search`), each including CL and Permission counts. View-only except for `compute_month_records`'s own side-effect of persisting `AttendanceDayRecord` rows, same as elsewhere.
- **GET /api/attendance/search** — `@require_hr`. Looks up up to 25 branch-scoped active employees by Employee Code or name (`query`) and returns each one's shift plus all punch slots (padded to 4) for a given `date` (default today), each punch tagged with its source (Biometric/Geo Punch/On-Duty/HR Entry/Manual Entry); IN/OUT is derived by time-sorted position, not raw stored punch type.
- **GET /api/attendance/search/range** — `@require_hr`. Given one `employeeId` and a `startDate`/`endDate` range (capped at 100 days), returns that employee's full day-by-day attendance picture across the range — punches, computed status/late flag, and any approved Leave/Permission/Casual-Leave for each date — via `compute_range_records`.
- **POST /api/attendance/compute-shifts** — `@require_hr`. Recomputes `DailyShiftLog`/`MonthlyShiftSummary` rows: body `{date}` recomputes all staff for that single day (`recompute_date`); body `{month, year[, employeeId]}` recomputes the whole month (bulk-fetches a month's punches once, branch-scoped, optionally narrowed to one employee) and then recomputes each employee's monthly summary.
- **GET /api/attendance/late-summary** — `@require_hr`. Returns each branch-scoped staff employee's `MonthlyShiftSummary` for a given month/year (total shifts, half-shift day count derived from `DailyShiftLog`, total/billable late counts, permission overage, shift deductions, salary deduction amount).

## Punch/Attendance Marking (Skipped Punches, Punch View, Sync)

- **GET /api/attendance/skipped-punches** — Lists `UnmatchedPunch` rows (device user IDs that punched but match no `Employee`), with unresolved count and total discarded-punch count; `?includeResolved=1` also shows resolved ones. **Auth: `@require_hr`.**
- **POST /api/attendance/skipped-punches/\<pk\>/resolve** — Marks one unmatched device ID as resolved (kept, not deleted — it un-resolves itself if that ID punches again) and logs the action. **Auth: `@require_hr`.**
- **GET /api/attendance/punches** — Paged, branch-scoped list of raw `AttendanceLog` punches, filterable by date range/employee/employment type/punch type/source/search, sorted person-wise then chronologically. **Auth: `@require_hr`.**
- **GET /api/attendance/punches/export** — Exports the current filtered punch list as an `.xlsx` file (with a Punch ID column enabling later re-import matching); logs the export. **Auth: `@require_hr`.**
- **POST /api/attendance/punches/import** — Re-imports an edited punch export: rows with a Punch ID update that punch, blank-ID rows create new punches, nothing is ever deleted; validates column headers, employee codes, date/time formats, and unique-constraint clashes, then also upserts the day's `Attendance` presence row. **Auth: `@require_hr`** (multipart upload via `@parser_classes([MultiPartParser, FormParser])`).
- **GET /api/attendance/sync-status-live** — Returns live device-health info (from `device_health()`) plus today's punch count, latest punch timestamp, and unresolved-skipped count, for the Sync indicator/Errors view — reads only the database, never contacts a device. **Auth: `@require_hr`.**

## Manual Attendance Import (Excel)

- **GET /api/attendance/manual-import/export** — `@require_hr`. Read-only: pulls raw punches directly off one or more biometric devices (`deviceId` may repeat; omitted = all enabled devices) for a given `mode` (day/week/month/all) and returns them as rows for HR to review/export to Excel; never writes to the database. With `includeAllEmployees=1`, appends one "no punch" marker row per active branch-scoped employee who had zero matched punches, purely for visibility (not importable).
- **POST /api/attendance/manual-import/upload** — `@require_hr`. Accepts the Excel file downloaded from the export endpoint above (multipart, key `file`), validates its header row matches exactly, parses each punch row (Employee Code/Date/Punch Time/Punch Type), silently skips "no punch" marker rows, and ingests valid punches through the same `_ingest_punches()` used by live biometric sync (tagged `source="biometric:excel-import"`), returning created/skipped counts plus any per-row errors and unmatched employee codes.

## Biometric Device Push (ADMS)

These four routes are registered in `config/urls.py` at the bare root (`/iclock/...`, no `/api/` prefix and no DRF `@api_view`) because that is the fixed path ZKTeco ADMS-mode devices are hardcoded to call. Authentication is **not JWT-based at all**: devices identify themselves only by a `SN` (serial number) query parameter, which is not a secret — there is no shared-device-key check like `biometric_punch` has, so (per the module's own docstring) this endpoint is reachable by anyone who knows the URL, bounded only by the fact that the worst outcome is spurious `AttendanceLog` rows for real employee codes.

- **GET/POST /iclock/cdata and /iclock/cdata.aspx → `adms_cdata`** — No auth (device-identified by `SN` only). Single dispatch point for every ADMS request type: a GET is the device handshake/registration (responds with a config block enabling `TransFlag`/`Realtime=1` so the device starts pushing live attendance); a POST with `table=ATTLOG` is the actual attendance push (`_handle_attlog`) — parses tab-separated `UserID\tTimestamp\tStatus` lines, matches each to an `Employee` by `employee_code`, and creates `AttendanceLog`/`Attendance` rows (unmatched codes are recorded via `record_unmatched_punch` so they surface on the HR "Skipped" view instead of vanishing silently); any other POST table (options, OPERLOG, etc.) is logged and acknowledged with a bare "OK" without being parsed. Every request is also recorded as a device heartbeat via `record_device_push`.
- **GET /iclock/getrequest and /iclock/getrequest.aspx → `adms_getrequest`** — No auth. The device polling for server-issued commands; this app never issues any, so it always replies with a bare "OK" (required to exist at all — a 404 here makes the device treat the server as unreachable and stop pushing attendance).
- **POST /iclock/devicecmd and /iclock/devicecmd.aspx → `adms_devicecmd`** — No auth. The device reporting the result of a command; logged and acknowledged with "OK" (nothing in this app currently issues commands to acknowledge).

## System Settings — Biometric Devices & ID Card Template (system_settings_views.py)

- **GET, POST /api/biometric-devices** — `@require_hr`. GET lists configured `BiometricDevice` rows plus a synthetic read-only entry for the legacy `.env`-configured device (if its host isn't already duplicated by a DB row); POST creates a new device, optionally flipping it to the sole default.
- **GET, PUT, DELETE /api/biometric-devices/\<pk\>** — `@require_hr`. GET/PUT/DELETE one device; PUT can partially merge `connectionConfig`, only overwrites `apiKey` if a non-empty value is sent, and can reassign the "default" device.
- **GET, PUT /api/idcard-settings** — `@require_auth`. GET returns the singleton ID card template config (colors, font, background, logo position, footer text) — open to any authenticated user since employees need it to render their own ID card; PUT edits it but is manually gated to HR only (403 for a plain employee token) despite the `@require_auth` decorator.

## Auto Biometric Sync

- **GET, POST /api/auto-sync-rules** — `@require_hr`. GET lists all `AutoSyncRule` background-sync-timing rules; POST creates a new rule (time, days of week, device selection, mode) and immediately wires it into the live APScheduler via `auto_sync.apply_rule_to_scheduler`.
- **GET, PUT, PATCH, DELETE /api/auto-sync-rules/\<pk\>** — `@require_hr`. Reads, updates (re-applying to the scheduler on save), or deletes one rule (removing it from the scheduler first).

## Night Shift Relaxation

- **GET /api/night-shift/dashboard** — `@require_hr`. Returns night-shift relaxation records: either for one `date` (default today, auto-running overnight detection for the previous night via `detect_night_for_date`) or for a whole `month`/`year`, optionally filtered by `employeeId`/`departmentId` (capped at 400 rows); refreshes each record's "reported" status against actual punches before returning, and includes a status-bucketed summary (reportedWithin/reportedLate/waiting/noReport).
- **POST /api/night-shift/recompute** — `@require_hr`. Body `{date}` re-runs night detection for one night; body `{month, year}` re-runs it for every past night in that month.
- **GET, POST /api/night-shift/rules** — `@require_hr`. GET lists all `NightShiftRule` rows (ensuring defaults exist first); POST creates a new rule (`name`, `workedUntil`, `crossesMidnight`, `allowedFirstPunch`, `order`, `isActive`).
- **PUT, DELETE /api/night-shift/rules/\<pk\>** — `@require_hr`. Updates the given fields on one rule, or deletes it.

## System Settings — Production Shift Workflow (system_settings_views.py)

- **GET, PUT /api/production-shift-config** — `@require_hr`. GET returns the singleton punch1-4 target times + grace-minutes config plus all shift segments; PUT updates the punch times/grace minutes.
- **GET, POST /api/production-shift-segments** — `@require_hr`. GET lists all shift segments (label/start/end/shiftValue/order/active); POST creates one (requires label, start/end time, and shiftValue).
- **PUT, DELETE /api/production-shift-segments/\<pk\>** — `@require_hr`. Updates or deletes one shift segment.

## Geo-Punch & On-Duty Attendance (geo_attendance_views.py)

- **GET /api/attendance/geo-punch/precheck** — `@require_auth`. Read-only check of whether the employee's current lat/lng is inside their branch's geofence radius, before they commit to punching; also reports the next punch number/type and whether an active/pending On-Duty session blocks Office Geo Punch.
- **POST /api/attendance/geo-punch** — `@require_auth`. Records an uncapped "Office Geo Punch" (no photo/approval) immediately via the shared `_ingest_punches()` path, tagged `geo:auto`, only if inside the branch geofence and not GPS-mocked; hard-rejects (403/409) if outside radius, mocked location, or an active/pending On-Duty session exists.
- **GET /api/attendance/geo-punch/status** — `@require_auth`. Returns today's (or a given date's) recorded punches for the employee plus their current On-Duty session snapshot, next punch number/type, and all 4 punch-slot states.
- **POST /api/on-duty-sessions/request** — `@require_auth`. Employee starts an On-Duty session by naming a destination; blocked if one is already in progress; creates the session at `pending_hod`, notifies eligible Department Heads, but responds as immediately "active" so the employee can start punching/tracking without waiting for approval.
- **POST /api/on-duty-sessions/complete** — `@require_auth`. Employee manually ends their own active/pending On-Duty session ("Mark as Done"); a still-provisional (unapproved) session just gets `employee_ended_at` stamped so it stays in HR's queue rather than being marked completed.
- **GET /api/on-duty-sessions/status** — `@require_auth`. Returns the employee's current/most-recent On-Duty session, its punch verifications, and all 4 punch-slot states, for the On-Duty page.
- **POST /api/on-duty-sessions/punch** — `@require_auth`, `@parser_classes([MultiPartParser, FormParser])`. Multipart: captures one of the day's (up to 4) attendance punches with a required selfie photo (JPG/PNG, ≤8MB) + GPS while an On-Duty session is in progress (including one still pending approval); auto-closes the session if this fills the last of 4 slots. Held pending until HR approves both the punch and the parent session.
- **POST /api/live-location/ping** — `@require_auth`. Records one GPS ping for the employee (self-pruning pings older than 72h on each write); accepted only if `location_tracking_enabled` is true or an active/pending On-Duty session exists, else 403 with `code: "TRACKING_DISABLED"`.
- **GET /api/on-duty-sessions** — `@require_hr`. HR's branch-scoped list of On-Duty session requests, filterable by status (default "pending" = both `pending_hod` and `pending_hr`).
- **PATCH /api/on-duty-sessions/\<pk\>/status** — `@require_hr`. HR's approve/reject decision on an On-Duty session, valid at either pending stage; approval starts the session (status=active) and auto-approves every punch already captured under it via the shared ingestion path; rejection voids all still-pending punches for that session.
- **GET /api/on-duty-punch-verifications** — `@require_hr`. HR's branch-scoped list of captured on-duty punch photos/GPS records, filterable by status.
- **PATCH /api/on-duty-punch-verifications/\<pk\>/status** — `@require_hr`. HR approves/rejects one captured on-duty punch; approval writes it into `AttendanceLog` via the shared ingestion path (409 if the parent session is still unapproved — a punch can never become attendance before its session is approved); auto-completes the session if this was the day's 4th punch.
- **PATCH /api/on-duty-sessions/\<pk\>/punches** — `@require_hr`. One bulk decision applied to every still-pending punch under an On-Duty request (for punches captured after the request itself was already approved).
- **GET /api/on-duty-punch-verifications/\<pk\>/photo** — `@require_auth` (with additional manual permission checks in the body). Streams the selfie photo for one punch verification; access limited to the owning employee, branch-scoped HR, or a Department Head with that employee in their approval scope.

## Live Location Tracking (geo_attendance_views.py)

- **GET /api/live-location/team** — `@require_hr`. Latest GPS ping per tracking-enabled active employee (branch-scoped), each flagged with whether they're currently on an active/pending On-Duty session, for the Live Map.
- **GET /api/live-location/team/\<employee_id\>/trail** — `@require_hr`. Today-so-far (within the 72h retention window) breadcrumb ping trail for one employee.
- **GET /api/live-location/team/\<employee_id\>/route** — `@require_hr`. Full-day breadcrumb trail for one employee on a specific date (defaults today), ordered for drawing a directional path.
- **GET /api/on-duty-map** — `@require_hr`. Branch-scoped roll-up, per employee with On-Duty activity that day (session opened that day or still active): current position, today's route points, session status, and per-punch status list, for the On-Duty Map tab.

## Casual Leave (CL)

- **GET, POST /api/casual-leaves** — `@require_auth`. GET lists CL requests, branch-scoped and self-restricted to the caller's own employee id when an employee token is present (an HR/non-employee caller may filter by `employeeId`/`employeeCode`/`status`/`month`/`year`, capped at 300 rows). POST submits a new CL request for a date — employees may only submit for themselves; enforces `check_cl_eligibility` (staff-only, active, ≥6 months service, one CL per calendar month) before creating the row.
- **PATCH, DELETE /api/casual-leaves/\<pk\>** — `@require_hr`. PATCH approves/rejects a pending CL request (`apply_cl_decision`), which also immediately writes the final `AttendanceDayRecord` for that date (approved → present/1.00 shift paid; rejected → on_leave) and notifies the employee; DELETE removes the request outright.
- **GET /api/casual-leaves/eligibility** — `@require_hr`. HR eligibility board: every branch-scoped active staff employee for a given month/year with their service-months, eligibility flag/reason, and whether/how CL was already used that month.
- **GET /api/casual-leaves/my-eligibility** — `@require_auth`. Self-service equivalent for the mobile/web employee apps: eligibility for today plus the employee's yearly CL usage against a 12/year entitlement (reuses the same `check_cl_eligibility` rule as the HR board so the two can't disagree).

## Leave Types & Holidays

- **GET, POST /api/leave-types** — `@require_auth` decorator; POST is internally gated to HR via `is_hr(request)` (403 otherwise) — GET is open to any authenticated user. GET lists active `LeaveType`s; POST creates a new one (name, code, max days/year, carry-forward rules, paid flag, applicable gender), rejecting duplicate codes.
- **PUT, DELETE /api/leave-types/\<pk\>** — `@require_hr`. PUT edits a leave type's fields; DELETE soft-deletes it by setting `is_active=False`.
- **GET /api/leave-balances** — `@require_auth`. Lists `LeaveBalance` rows filtered by employee/year; an employee token is forced to only see their own balances regardless of query params.
- **POST /api/leave-balances/allocate** — `@require_hr`. Creates or updates a `LeaveBalance` allocation for an employee/leave-type/year, recomputing `remaining` from `allocated - used`.
- **GET, POST /api/holidays** — `@require_auth` decorator; POST is internally gated to HR via `is_hr(request)` — GET is open to any authenticated user. GET lists holidays (filterable by year/branch); POST creates a new `Holiday` (name, date, type, branch/department scope, recurring flag).
- **PUT, DELETE /api/holidays/\<pk\>** — `@require_hr`. Edits or deletes one `Holiday`.

## Leave Requests (views.py)

- **GET, POST /api/leave-requests** — GET lists leave requests (branch-scoped via the employee's branch), filterable by employeeId/employeeCode/status; POST creates a leave request for an employee (resolves by employeeCode or ID), computing `total_days` as working days (Mon–Sat) between start/end. No decorator on the outer `leave_requests` function; both GET and POST dispatch via `require_auth`.
- **PATCH /api/leave-requests/\<pk\>/status** — `@require_hr`. HR approve/reject of a leave request: on approval, deducts the days from the matching `LeaveBalance` row(s) for the year and sends the employee a notification; on rejection, just notifies.
- **DELETE /api/leave-requests/\<pk\>** — `@require_hr`. Hard-deletes a leave request.

## Employee Requests & Permissions

- **GET, POST /api/employee-requests** — The view function itself carries only `@api_view` with no auth decorator — POST enforces auth internally by wrapping the handler in `require_auth(...)`, and GET enforces HR internally via a nested `@require_hr`-decorated inner function (flagged since the outer function has no top-level guard). POST lets an authenticated user submit a generic `EmployeeRequest` (subject/type/description) and notifies HR; GET (HR-only) lists all requests filterable by type/status.
- **PUT /api/employee-requests/\<pk\>/action** — `@require_hr`. HR updates a request's status/notes/handler and notifies the employee if status changed.
- **GET, POST /api/permissions** — `@require_auth`. GET lists `EmployeePermission` (late/early-leave permission) requests, branch-scoped, filterable by employee/status/month/year (employee tokens see only their own); POST creates a new permission request, blocking an employee from submitting on someone else's behalf, and reports how many the employee has used this month against the informational 3-per-month allowance.
- **PUT, DELETE /api/permissions/\<pk\>** — `@require_hr`. HR approves/rejects (setting `approved_by`/`approver_role` server-side, never client-trusted) or edits a permission request, notifying the employee on status change; DELETE removes it.

## Missing Punch (missing_punch_views.py)

- **GET, POST /api/missing-punch-requests** — `@require_auth`. GET lists requests (branch-scoped; an employee token sees only their own; HR can filter by employeeId/employeeCode/status/month/year, up to 300 rows); POST submits a new "I forgot to punch" request (date + punch time + reason, resolved to a punch slot/type), self-bound for an employee token (403 if they name a different employee), and notifies eligible Department Head approvers.
- **PATCH, DELETE /api/missing-punch-requests/\<pk\>/status** — `@require_hr`. HR's stage-2 decision (only valid once a request is already at `pending_hr` — HR cannot short-circuit past an unreviewed Department Head stage); approval creates one ordinary `AttendanceLog` row tagged `missing_punch:approved` (idempotent via the log's unique constraint) so it flows through the normal payroll engine like a real punch; DELETE removes the request outright.

## Growth: Attendance Monthly View & Manual Overrides

- **GET /api/attendance/employee-monthly** — `@require_auth` (with an internal `is_hr` check when no employee token is present). Returns one employee's month broken into weeks (W1–W5) of computed final attendance-day records (`compute_month_records`), plus assigned shift info and a month summary; an employee token sees only their own data, otherwise the caller must be HR looking up by `employeeId`/`code`.
- **POST /api/attendance/override** — `@require_hr`. HR requests a manual correction to one day's attendance (`status`, `isLate`, `isHalfShift`, punch times, note); `reset=true` immediately reverts to auto-computed values, but any other change instead creates a pending `AttendanceOverrideRequest` that a Department Head must approve before the underlying `AttendanceDayRecord` is actually overwritten.
- **GET /api/attendance/override-requests** — `@require_hr`. Lists submitted `AttendanceOverrideRequest` rows (filterable by employee/code/status) so HR can see approval status of pending overrides.

## Staff Payroll Engine (Settings, Sessions, Attendance Logs, Work Sessions)

- **GET/PUT `/api/payroll-settings`** — Reads/writes the singleton `PayrollSettings` (company profile, PF/ESI rates, attendance mode, late-detection slabs, production period config, SMTP, backup directory, etc.); non-super-admins get a personal overlay instead of the shared row, and PUT is field-by-field permission-checked against `FIELD_GROUPS` (`settings.company`, `settings.payroll`, `settings.late_detection`, etc.) unless the caller is super admin. **Auth: `@require_hr`.**
- **GET/POST `/api/session-configs`** — GET lists all `SessionConfig` rows (production session time windows/pay amounts); POST creates one. **Auth: GET has no auth decorator at all (unauthenticated/open); POST is routed through `require_hr(_create_session_config)(request)` internally, so only POST actually enforces HR.** Flagging this because GET truly has no guard at all.
- **PATCH/DELETE `/api/session-configs/\<int:pk\>`** — Updates or deletes one `SessionConfig` row. **Auth: `@require_hr`.**
- **GET/POST `/api/attendance-logs`** — GET lists raw punch-in/out `AttendanceLog` rows filtered by employee/date/month/year (capped at 500); POST manually creates a punch log entry with `source="manual"`. **Auth: `@require_hr`.**
- **POST `/api/attendance-logs/process-sessions`** — Legacy no-op endpoint; does nothing but return a message pointing callers at `POST /api/payroll/generate` since the engine now handles session processing automatically. **Auth: `@require_hr`.**
- **POST `/api/attendance-logs/seed`** — Dev/staging helper that generates realistic fake `Attendance`+`AttendanceLog` records (configurable late/absent days) for all active employees for a given month, skipping days that already have records. **Auth: `@require_hr`.**
- **GET `/api/work-sessions`** — Lists `WorkSession` rows (production session pay records) filtered by employee/month/year, capped at 500. **Auth: `@require_hr`.**
- **PATCH/DELETE `/api/work-sessions/\<int:pk\>`** — Edits (check-in/out time, session amount/name, notes, recomputing hours worked) or deletes one `WorkSession`. **Auth: `@require_hr`.**
- **GET `/api/payroll`** — Lists `Payroll` records (branch-scoped) filtered by employee/month/year/status, each row enriched with bank details/employee code/department for Excel export use. **Auth: `@require_hr`.**
- **GET `/api/payroll/skip-check`** — Dry-run preview (via rolled-back savepoints) of which active STAFF employees `generate_payroll` would currently skip for a given month/year, and the exact reason (no salary set, no working days, etc.), without writing anything. **Auth: `@require_hr`.**
- **POST `/api/payroll/generate`** — Runs the staff monthly payroll engine (`_generate_staff_payroll`) for every active STAFF employee for the given month/year, upserting `Payroll`+`SalarySlip` records, tracking live progress via `payroll_progress`, and logging an audit entry. **Auth: `@require_hr`.**
- **GET `/api/payroll/generate-progress`** — Polls the live in-memory progress snapshot for an in-flight `generate_payroll` run. **Auth: `@require_hr`.**
- **PATCH `/api/payroll/\<int:pk\>`** — Updates a `Payroll` row's status/bonus/deductions/notes and recomputes `final_salary = gross_salary + bonus - deductions`. **Auth: `@require_hr`.**
- **GET `/api/payroll/\<int:pk\>/breakdown`** — Returns the full day-by-day traceability JSON (`breakdown_details`) stored on the matching `SalarySlip` for one payroll record, plus employee/summary info. **Auth: `@require_hr`.**

## Production Payroll

- **GET `/api/payroll/production/next-period`** — Computes (without writing) what the next production payroll period (start/end dates) would be, based on live `PayrollSettings.prod_period_*` config, and whether that period has already ended. **Auth: `@require_hr`.**
- **GET `/api/payroll/production/skip-check`** — Dry-run (savepoint-and-rollback) preview of which active PRODUCTION employees would be skipped for a period (explicit `periodStart`/`periodEnd` or the next due period) and why. **Auth: `@require_hr`.**
- **POST `/api/payroll/production/generate`** — Runs `_generate_production_payroll` (bi-weekly/period-based, session-earned-shifts model) for every active PRODUCTION employee for an explicit or auto-resolved period; rejects periods that haven't ended yet; tracks progress and logs an audit entry. **Auth: `@require_hr`.**
- **GET `/api/payroll/production`** — Lists period-based (`salary_mode="shift"`, `period_start` not null) `Payroll` rows, branch-scoped, filterable by employee/status, enriched with bank/department info for export. **Auth: `@require_hr`.**

## Salary Slips (salary_slip_views.py)

- **GET /api/salary-slips** — `@require_hr`. Lists `SalarySlip` rows (branch-scoped) filterable by employeeId/month/year/weekNumber/employmentType (correctly distinguishes period-based production slips from staff slips via `employment_type`, not just `week_number`), each enriched with company-branding settings for slip rendering.
- **GET /api/salary-slips/bulk-pdf** — `@require_hr`. Combines every salary slip matching the current filters into one PDF (2 slips/page) for printing, tracked via a progress counter.
- **POST /api/salary-slips/bulk-email** — `@require_hr`. Emails every matching slip (as a PDF attachment) to its employee's address using stored SMTP settings; requires SMTP to be configured; tracks per-employee success/failure.
- **GET /api/salary-slips/bulk-progress** — `@require_hr`. Polls the snapshot of an in-progress bulk PDF/email job.
- **POST /api/salary-slips/bulk-whatsapp** — `@require_hr`. Sends every matching slip as a WhatsApp document message via the configured Meta template; fails fast if WhatsApp isn't configured before generating any PDFs.
- **GET /api/salary-slips/bulk-whatsapp-progress** — `@require_hr`. Polls the snapshot of an in-progress bulk WhatsApp send job.
- **GET /api/salary-slips/\<pk\>** — `@require_auth`. Returns one slip's full detail plus company settings; an employee token may only view their own slip (403 otherwise), and HR is branch-scoped to the slip's employee.
- **POST /api/salary-slips/\<pk\>/email** — `@require_hr`. Emails one slip's PDF to the employee (or an explicit `toEmail` override); 400 if SMTP isn't configured.
- **POST /api/salary-slips/\<pk\>/whatsapp** — `@require_hr`. Sends one slip's PDF via WhatsApp to the employee.
- **GET /api/my/salary-slips** — `@require_auth`. The logged-in employee's own salary slip history.

## Company Documents: Salary Slip & Document Theming Settings

- **GET `/api/document-settings`** — Lists the per-document-type `CompanyDocumentSettings` theming rows (colors, heading style, watermark, footer tagline) for every doc type. **Auth: `@require_auth`.**
- **GET/PUT `/api/document-settings/\<str:doc_type\>`** — GET returns one doc type's theming settings; PUT updates them (primary/accent color, heading style, watermark, footer tagline, logo override) but is internally gated to HR only (`is_hr(request)` check returns 403 otherwise, even though the decorator is `@require_auth`). **Auth: `@require_auth` decorator, with an internal `is_hr` check restricting PUT to HR.**
- **GET `/api/document-settings/\<str:doc_type\>/preview`** — Renders a sample PDF (offer letter, experience letter, resignation letter, or salary slip) using a synthetic dummy employee/slip, so HR can preview theme changes without touching real records. **Auth: `@require_hr`.**
- **GET `/api/salary-slips/\<int:pk\>/pdf`** — Renders the full reportlab Salary Slip PDF for one `SalarySlip`, enforcing that an employee-token caller can only fetch their own slip and that the slip's employee is within the caller's branch scope. **Auth: `@require_auth`** (with employee-ownership and branch-scope checks inside).

## Company Documents: Offer Letter

- **GET `/api/employees/\<int:employee_id\>/offer-letter/pdf`** — Renders a reportlab-generated Offer Letter PDF for a real employee record, using query-param overrides (`joiningDate`, `probationMonths`, `workingHours`, `ctcNote`) merged with employee/company data; returns inline or attachment depending on `?preview`. **Auth: `@require_hr`.**
- **POST `/api/employees/\<int:employee_id\>/offer-letter/email`** — Builds the same offer letter PDF and emails it (via configured SMTP) to the employee's email or an explicit `toEmail`; fails with 400 if SMTP isn't configured. **Auth: `@require_hr`.**
- **POST `/api/employees/\<int:employee_id\>/offer-letter/whatsapp`** — Sends the offer letter PDF as a WhatsApp document via `whatsapp_service.send_document`, logging the send under the requesting HR user. **Auth: `@require_hr`.**

## Company Documents: Experience Letter

- **GET `/api/employees/\<int:employee_id\>/experience-letter/pdf`** — Renders a Work Experience Certificate PDF, with optional overrides for last working date/certificate number/nature of work/performance note. **Auth: `@require_hr`.**
- **POST `/api/employees/\<int:employee_id\>/experience-letter/whatsapp`** — Sends the experience letter PDF via WhatsApp. (Note: there is no experience-letter/email endpoint in this codebase.) **Auth: `@require_hr`.**

## Growth: Promotions

- **GET/POST `/api/promotions`** — GET lists `Promotion` history rows (filterable by employee/code); POST records a promotion (new department/designation, effective date) and immediately applies the change to the `Employee` record itself. **Auth: `@require_hr`.**
- **DELETE `/api/promotions/\<int:pk\>`** — Deletes one promotion history record (does not revert the employee's department/designation). **Auth: `@require_hr`.**

## Growth: Salary Increments

- **GET `/api/increments/summary`** — Returns one employee's salary picture: current salary, initial salary (baseline before first increment), total increment amount, and full `SalaryIncrement` history. **Auth: `@require_hr`.**
- **POST `/api/increments`** — Adds a salary increment by percent or flat amount, updates `emp.salary_amount`, and preserves `initial_salary` as the baseline on first use. **Auth: `@require_hr`.**
- **GET `/api/increments/dashboard`** — Company-wide increment analytics: total increments/employees incremented, average percent, department-wise breakdown, and top/recent increments. **Auth: `@require_hr`.**

## Growth: ID Cards & Public Verification

- **GET `/api/idcard`** — Returns ID-card payload data (photo, blood group, DOB, company branding, ID-card template styling) for one employee (by `employeeId`/`code`) or a bulk list (`?ids=1,2,3`); an employee token can only ever fetch their own card regardless of query params, while bulk/other-employee lookups require HR. **Auth: `@require_auth`**, with an internal `is_hr` check gating the HR-only paths.
- **GET `/api/verify-employee/\<str:code\>`** — Public QR-code verification lookup returning whether an employee code is valid/active plus basic public-safe employee and company info. **Auth: no auth decorator at all — explicitly a public/unauthenticated endpoint per its docstring.**
- **POST `/api/idcard/email`** — Renders a backend PNG of the employee's ID card (`idcard_render.render_idcard_png`) with an embedded QR verification link and emails it via configured SMTP. **Auth: `@require_hr`.**
- **POST `/api/idcard/whatsapp`** — Renders the same ID card PNG and sends it as a WhatsApp document. **Auth: `@require_hr`.**

## Settlements (Advances & Repayments)

- **GET/POST `/api/advances`** — GET lists `Advance` records (employees restricted to their own via token), filterable by employee/type/status; POST creates a new advance (general single-deduction or term/EMI-based), auto-computing EMI from months if not given. **Auth: `@require_auth` decorator; POST is internally gated to HR via `is_hr(request)` (403 otherwise).**
- **GET/PUT/DELETE `/api/advances/\<int:pk\>`** — GET/PUT/DELETE one `Advance`; approving it for the first time (`status="approved"` with no prior `approved_at`) triggers `_auto_create_repayments`, which auto-generates the full monthly repayment schedule (single deduction for "general" advances, EMI schedule for term advances). **Auth: `@require_hr`.**
- **GET `/api/advances/\<int:pk\>/repayments`** — Lists the repayment schedule (`AdvanceRepayment` rows) for one advance, ordered chronologically. **Auth: `@require_hr`.**

## Recruitment — Dashboard, New Joinees & Resignations

- **GET /api/recruitment/dashboard** — `@require_hr`. Branch-scoped recruitment KPIs: total active staff, department count, leave requests in the last 30 days, new joinees in 30 days, open job count, pending/dept-approved resignation counts, a per-department current-vs-required headcount/vacancy breakdown, plus recent-joinee and recent-leave detail lists (10 each).
- **GET /api/recruitment/new-joinees** — `@require_hr`. Lists branch-scoped active employees who joined within the last `days` (default 30), with contact/department/designation/branch info.
- **GET/POST /api/recruitment/resignations** — No single auth decorator on the view itself — `resignations()` is a plain dispatcher (`@api_view(["GET", "POST"])`, no `@require_hr`/`@require_auth`) that internally wraps GET with `require_hr(_resignations_list)` (HR-only branch-scoped list, optionally filtered by `status`) and POST with `require_auth(_resignation_submit)` (an employee token submits their own resignation, blocked if one is already pending/dept_approved; notifies the relevant dept-head managers).
- **PATCH /api/recruitment/resignations/\<pk\>/action** — `@require_hr`. HR's final approve/reject action; approval is only allowed once status is already `dept_approved` (department head must review first) — approving deactivates the employee (`status="inactive"`) and notifies them; rejecting is allowed from any non-final status.
- **DELETE /api/recruitment/resignations/\<pk\>/delete** — `@require_hr`. Branch-scoped hard delete of a resignation request.
- **GET /api/recruitment/resignations/\<pk\>/pdf** — `@require_hr`. Generates and streams the resignation-acceptance-letter PDF for an approved resignation (400 if not yet approved).
- **POST /api/recruitment/resignations/\<pk\>/email** — `@require_hr`. Emails the resignation-acceptance letter (HTML body + PDF attachment) to the employee's (or an overriding `toEmail`) address via the configured SMTP settings; 400 if SMTP isn't configured or the resignation isn't approved.
- **POST /api/recruitment/resignations/\<pk\>/whatsapp** — `@require_hr`. Sends the same resignation-acceptance PDF via WhatsApp using `whatsapp_service`; 400 if WhatsApp isn't configured or the resignation isn't approved.
- **GET/POST /api/my/resignation** — `@require_auth`. GET returns the calling employee's most recent resignation request (or `null`); POST lets the employee submit a new one, blocked while one is pending/dept_approved, and notifies the relevant dept-head managers.
- **GET /api/manager/resignations** — `@require_auth`. Department-head mobile view of resignation requests within that manager's scope (department + direct employee assignments), filterable by `status` (default "pending").
- **PATCH /api/manager/resignations/\<pk\>/action** — `@require_auth`. Department head's mobile approve/reject action (requires `can_approve_resignations` on their `DepartmentManager` row and the resignation to be in their scope and still `pending`); approve moves status to `dept_approved` (awaiting HR), reject is terminal and notifies the employee either way.

## Recruitment — Department Headcount

- **GET/POST /api/recruitment/department-headcount** — `@require_hr`. GET returns every branch-scoped department's current active-staff count vs. its required headcount and resulting vacancy. POST creates/updates (`get_or_create`) the `DepartmentHeadcount` row for a department (`requiredCount`, `notes`).
- **PATCH /api/recruitment/department-headcount/\<pk\>** — `@require_hr`. Updates `requiredCount`/`notes` on one branch-scoped headcount row and returns the recomputed vacancy.

## Recruitment — Jobs & Applicants (views.py)

- **GET, POST /api/jobs** — GET lists all job postings with department name + applicant count, with **no auth check at all** (public careers-page listing); POST creates a job posting. No decorator on the outer `jobs` function; GET is dispatched with no wrapper, POST dispatches via `require_hr`.
- **GET, PATCH, DELETE /api/jobs/\<pk\>** — GET returns one job's detail with **no auth check** (public); PATCH/DELETE are HR-only. No decorator on the outer `job_detail` function; GET has no auth wrapper at all, PATCH/DELETE dispatch via `require_hr`.
- **GET, POST /api/applicants** — GET (HR-only) lists applicants filterable by jobId/status; POST is the **public** job-application submission form (validates the job is open, requires name/email/phone, creates an `Applicant` row) with **no auth decorator at all**. No decorator on the outer `applicants` function; GET dispatches via `require_hr`, POST (`_applicants_submit`) is called directly with no auth wrapper.
- **PATCH /api/applicants/\<pk\>/status** — `@require_hr`. Updates an applicant's status/interviewDate/notes.

## Resume Screening (ATS)

- **GET, POST /api/recruitment/resume-screening/rule-sets** — `@require_hr`. GET lists `HiringRuleSet` rows (filterable by `departmentId`/`isActive`); POST creates a new rule set (required skills/soft skills, education, min experience, preferred city, other requirements) for a department.
- **GET, PATCH, DELETE /api/recruitment/resume-screening/rule-sets/\<pk\>** — `@require_hr`. GET/PATCH read or partially update a rule set; DELETE is refused (409) if the rule set has screened candidates attached (must be deactivated instead) — otherwise deletes it.
- **POST /api/recruitment/resume-screening/upload-single** — `@require_hr`. Multipart upload of one resume file (`file` + `ruleSetId`); runs `resume_screening_ml.screen_resume` against the active rule set's vocabulary and creates a `ScreeningCandidate` with status `screened`.
- **POST /api/recruitment/resume-screening/candidates/\<pk\>/shortlist** — `@require_hr`. Manually promotes a candidate (from uploaded/screened/not_shortlisted) to `shortlisted`.
- **POST /api/recruitment/resume-screening/upload-bulk** — `@require_hr`. Multipart bulk upload (`files`, repeated) plus `ruleSetId` and `topN`; screens every file against the ML scorer with live progress tracking, ranks the batch by match score, and marks the top `topN` as `shortlisted` and the rest `not_shortlisted`; returns counts and any per-file failures.
- **GET /api/recruitment/resume-screening/upload-bulk-progress** — `@require_hr`. Polls the live progress snapshot for the bulk upload above.
- **GET /api/recruitment/resume-screening/candidates** — `@require_hr`. Branch-scoped (via department) candidate list ordered by match score, filterable by `status`, `ruleSetId`, `departmentId`, and a name/email/phone `search`.
- **PATCH, DELETE /api/recruitment/resume-screening/candidates/\<pk\>** — `@require_hr`. PATCH validates the requested status transition against an explicit allow-list (`_ALLOWED_TRANSITIONS`, e.g. shortlisted→selected/rejected) and, when moving to `rejected`, deletes the stored resume binary while keeping all extracted candidate data; can also update `notes`. DELETE removes the candidate row and its resume file entirely.
- **GET /api/recruitment/resume-screening/candidates/\<pk\>/resume** — `@require_hr`. Streams the candidate's stored resume file (inline, or as an attachment with `?download`).
- **POST /api/recruitment/resume-screening/candidates/\<pk\>/interview-invite** — `@require_hr`. Sends an interview-invite email (requires the candidate to be `selected`, have an email on file, SMTP configured, and a valid `interviewDateTime`); records `interviewDatetime`/`interviewInvitedAt`.
- **POST /api/recruitment/resume-screening/candidates/reject-email-all** — `@require_hr`. Bulk-sends the rejection-notice email to every `rejected` candidate who hasn't been emailed yet; returns sent/failed counts (failures include candidates with no email on file).
- **POST /api/recruitment/resume-screening/candidates/interview-invite-bulk** — `@require_hr`. Bulk-sends the interview-invite email (with one shared `interviewDateTime`) to every `selected` candidate not yet invited; returns sent/failed counts.

## Employee Documents (employee_documents_views.py)

- **GET /api/recruitment/employee-documents/\<employee_id\>** — `@require_hr`. Lists every uploaded document (PAN/Aadhaar/education/bank passbook/etc.) for one employee, branch-scoped.
- **POST /api/recruitment/employee-documents/\<employee_id\>/upload** — `@require_hr`, `@parser_classes([MultiPartParser, FormParser])`. Multipart upload of one document into a required category (PDF/JPG/PNG, ≤10MB); records the uploading HR user's name.
- **DELETE /api/employee-documents/\<pk\>** — `@require_hr`. Deletes one document's file and DB row, branch-scoped to the owning employee.
- **POST /api/employee-documents/\<pk\>/whatsapp** — `@require_hr`. Sends an already-uploaded document file as-is via WhatsApp (no PDF generation step, unlike offer/experience letters).
- **GET /api/employee-documents/\<pk\>/file** — `@require_auth`. Streams the actual file (inline or as an attachment via `?download=1`); access limited to the owning employee or branch-scoped HR — flagged in the code comments as the single most important check in this feature given the sensitivity (PAN/Aadhaar/bank details).
- **GET /api/recruitment/employee-documents/completion-stats** — `@require_hr`. Counts branch-scoped active employees (by employment type) as "uploaded" only once every required document category for their type is present, else lists what's missing, for the Documents dashboard.
- **GET /api/my/documents** — `@require_auth`. The logged-in employee's own uploaded documents.

## Notifications (views.py)

- **GET, POST /api/notifications** — GET returns the caller's own notifications if an employee token, else HR's branch-scoped view of all employees' notifications (unscoped admins see everything), with an `unreadOnly` filter; POST creates an arbitrary notification for any employee but is explicitly blocked for employee tokens (403) so only HR/server-side logic can plant one. `@require_auth` on the outer view (POST further gated internally to HR-only).
- **PATCH /api/notifications/\<pk\>/read** — `@require_auth`. Marks one notification read; an employee token may only mark its own (403 otherwise).
- **PATCH /api/notifications/mark-all-read** — `@require_auth`. Marks all of the calling employee's unread notifications as read; requires an employee token specifically (403 for an HR token).
- **POST /api/my/push-token** — `@require_auth`. Upserts an Expo push token for the calling employee, keyed by token value (so re-registration or a different employee on the same device just reassigns it).

## Company Chat (chat_views.py)

- **GET /api/chat/channels** — `@require_auth`. Returns the caller's available channels: the branch-wide company channel plus (for an employee with a department) their department's private channel; an HR portal user (no Employee row) gets only their branch's company channel.
- **GET, POST /api/chat/channels/\<pk\>/messages** — `@require_auth`. GET polls recent messages (paginated via `before`/`after` cursors, up to 200) with reply/reaction data; POST posts a text message (optionally as a reply). Enforces that a department channel is only readable/writable by members of that department, that a channel belongs to the caller's own branch, and that an HR portal user may only use the company channel (never a department channel).
- **POST, DELETE /api/chat/messages/\<pk\>/reactions** — `@require_auth`. Adds or removes an emoji reaction from the caller on one message, gated by the same department-membership check as the parent channel.

## Backup & Restore

- **GET `/api/backup`** — Returns backup status: configured backup directory, `pg_dump` availability, list of existing backups, backup schedule config, and Google Drive configured flag. **Auth: `@require_hr`.**
- **POST `/api/backup/run`** — Builds a full application backup (DB + uploaded files) into the given/saved directory, updates the saved directory if changed, prunes old backups per retention count, and logs the action. **Auth: `@require_hr`.**
- **GET `/api/backup/download/\<str:filename\>`** — Streams a specific backup file's bytes (fetched from the database first, falling back to local disk for pre-existing backups) as a `.zip` download. **Auth: `@require_hr`.**
- **GET/PUT `/api/backup/schedule`** — GET returns the `BackupSchedule` singleton; PUT updates enabled flag/time/days-of-week/retention count and immediately re-applies the schedule to the live APScheduler. **Auth: `@require_hr`.**
- **GET/PUT `/api/backup/drive`** — GET returns Google Drive backup config (folder ID, whether a service-account key is set, last upload status) without ever echoing the stored key; PUT updates enabled/folder/service-account JSON (only overwrites the key if a new one is actually supplied). **Auth: `@require_hr`.**
- **POST `/api/backup/drive/test`** — Tests a Google Drive connection using either the supplied or the saved folder ID/service-account JSON. **Auth: `@require_hr`.**
- **POST `/api/backup/restore/validate`** — Uploads and validates a backup file (multipart), stages it, and returns its manifest, media file count, size, warnings, staleness info, and a guided-restore script — read-only with respect to the live app. **Auth: `@require_hr`** (multipart upload).
- **POST `/api/backup/restore/run`** — Takes an already-staged backup path and kicks off a fully-automated restore as a detached OS process (`manage.py restore_backup`) after first taking a pre-restore safety backup of current state; writes a maintenance-lock marker and status file. This is the destructive, irreversible-in-place operation. **Auth: `@require_super_admin`** (the strictest guard in this file, layered on top of the normal HR-level access).
- **GET `/api/backup/restore/status`** — Polls the restore progress status file. **Auth: no auth decorator at all — deliberately, per its docstring, because during an active restore the DB (and therefore any auth check) may be briefly unreachable and this endpoint must keep working through that window.**

## Mobile Login (Mobile App Access Management)

- **GET `/api/mobile-app-logins`** — Lists STAFF employees (production excluded) with mobile-app access state (`hasPassword`, `lastMobileLoginAt`, registered device count) plus summary counts, filterable by access tier/status/search, branch-scoped. **Auth: `@require_hr`.**
- **GET `/api/mobile-app-logins/export`** — Exports the currently-filtered staff list (name, code, phone, department) as an `.xlsx` file using the exact same filters as the list endpoint, and logs the export. **Auth: `@require_hr`.**
- **POST `/api/mobile-app-logins/\<int:employee_id\>/reset-password`** — Sets a new bcrypt-hashed mobile-app password for an employee, or clears it entirely (`{"clear": true}`) forcing them to re-run Set Password; never returns the stored/plaintext password since bcrypt hashes are one-way, and deliberately does not touch `last_mobile_login_at`. **Auth: `@require_hr`.**

## WhatsApp (Settings → WhatsApp)

- **GET `/api/whatsapp/status`** — Read-only credential status: whether WhatsApp is configured (from `.env`/Django settings), a masked (last-4) phone number ID, and API version — never exposes the actual credentials. **Auth: `@require_hr`.**
- **GET `/api/whatsapp/templates`** — Lists one row per document type (`WhatsAppMessageTemplate` if configured, else a default empty placeholder row) so the Settings UI always renders a full fixed set of rows. **Auth: `@require_hr`.**
- **PUT `/api/whatsapp/templates/\<str:document_type\>`** — Creates/updates the Meta template name, language code, variable note, and enabled flag for one document type's WhatsApp message template. **Auth: `@require_hr`.**

## Themes (theme_views.py)

- **GET /api/theme-settings** — `@require_auth`. Returns the org's active theme name plus any custom CSS-variable color overrides; open to any signed-in user so the theme applies immediately on load.
- **PUT /api/theme-settings/update** — `@require_hr`. Updates the theme name (strict `[a-z0-9_-]` pattern) and/or up to 40 custom HSL-triple color-token overrides (both the CSS variable name and the HSL value are validated by strict regex before being accepted, since they're injected straight into inline styles); logs the change to the audit trail.

## Salary Records — Legacy (views.py)

- **GET, POST /api/salary-records** — GET returns salary history for one `employeeId` (optionally filtered by month/year), preferring `Payroll` rows and falling back to legacy `SalaryRecord` rows if none exist; POST creates a raw `SalaryRecord`. No decorator on the outer `salary_records` function; GET dispatches via `require_auth`, POST via `require_hr`.
- **POST /api/salary-records/calculate** — `@require_hr`. Batch-computes a simple per-day-rate `SalaryRecord` (26-day basis for monthly, 6-day for weekly) for every active employee based on raw `Attendance` present/total-day counts for the given month/year, upserting per employee.
- **PATCH /api/salary-records/\<pk\>** — `@require_hr`. Updates amount/status/notes on one legacy `SalaryRecord`.

## HR User Management — Roles & Users (hr_user_views.py)

- **GET, POST /api/roles** — `@require_super_admin`. GET lists all `Role`s with their permission JSON; POST creates a new role (rejects duplicate names).
- **GET, PUT, DELETE /api/roles/\<pk\>** — `@require_super_admin`. GET/PUT/DELETE one role; DELETE refuses on system roles.
- **GET, POST /api/hr-users** — `@require_super_admin`. GET lists HR portal accounts (branch-scoped, hidden accounts excluded unless the requester is the master admin AND passes `includeHidden=1`); POST creates a new HR account (bcrypt-hashed password).
- **GET, PUT, DELETE /api/hr-users/\<pk\>** — `@require_super_admin`. GET/PUT one HR account (email, fullName, role, department, branch, isActive, and optionally a new password); DELETE refuses to remove a super admin account.
- **GET /api/hr-users/master** — `@require_master_admin`. Every HR account including hidden ones, for the Master admin page — a structurally separate endpoint from `/hr-users` so the stricter guard can't be bypassed by a query param.
- **PATCH /api/hr-users/\<pk\>/master-flags** — `@require_master_admin`. The sole writer of `is_hidden` and `master_features` (a small explicit allow-list, currently just the inert `"co"` key); cannot touch role/branch/password/isActive.

## Audit Logs (hr_user_views.py)

- **GET /api/audit-logs** — `@require_super_admin`. Paginated, filterable (module/action/userName/date range) audit trail; branch-scoped for rows that carry a branch (older rows without one stay admin-only-visible).
- **GET /api/audit-logs/stats** — `@require_super_admin`. Today/this-week/total audit log counts, breakdowns by module and action, and the 5 most recent acting users, using the same branch scope as the log list.

## Login Sessions

- **GET /api/login-sessions** — `@require_hr`. Lists every currently non-revoked `LoginSession` (HR portal login sessions) across all HR accounts, with device label, IP, created/last-seen timestamps, and an `isCurrent` flag comparing each session's JWT `jti` against the caller's own.
- **POST /api/login-sessions/\<session_id\>/revoke** — `@require_super_admin` (stricter than most endpoints — only a super admin may force-revoke another account's session). Sets `revoked_at` on the session if it isn't already revoked (404 if not found or already revoked).

## Dashboard (views.py)

- **GET /api/dashboard/hr-summary** — `@require_hr`. Aggregates a large branch-scoped snapshot for the HR dashboard: employee counts (total/active/inactive), pending leaves, unread notifications, department count, monthly/weekly salary totals, open jobs, pending applicants, gender breakdown, today's geo-punch count, on-duty pending/active/completed-today counts, pending punch verifications, live-tracking-enabled count, and pending production payroll count.
- **GET /api/dashboard/employee-summary** — `@require_auth`. Per-employee mobile-home dashboard: working/present/half-shift/absent/late/leave days for the current month (sourced from the shared `attendance_final.compute_month_records` engine so it agrees with the Attendance tab and HRMS), leave balance total, pending leave+permission counts, last 6 salary records (Payroll-first, SalaryRecord fallback), and manager/approval-queue flags if the employee is also a Department Manager.
- **GET /api/dashboard/interview-summary** — `@require_hr`. Applicant funnel counts by status (attended/selected/rejected/pending=applied) across all applicants.
- **GET /api/dashboard/salary-trends** — `@require_hr`. Last 12 months of total salary paid, preferring `Payroll.final_salary` sums and falling back to legacy `SalaryRecord.amount` sums if no payroll rows exist.

## Reports (reports_views.py)

All ten endpoints return `{ count, results, ... }` JSON and are branch-scoped via `scope_to_branch`; all are `@api_view(["GET"])` with `@require_hr`.

- **GET /api/reports/attendance-log** — Raw `AttendanceLog` punch rows (up to 2000), filterable by date range/department/employee/employment type, each tagged with a human-readable source label (Biometric/Geo Punch/On-Duty/Missing Punch/HR Entry).
- **GET /api/reports/attendance-summary** — Per-employee monthly attendance + payroll snapshot for a month/year, preferring precomputed `SalarySlip` fields (present/absent/late/OT/gross/net) and falling back to a raw `AttendanceLog` IN-day count if no slip exists.
- **GET /api/reports/leave** — Leave request history filterable by year/month/department/employee/status, including leave type name, dates, days, reason, status, and approver.
- **GET /api/reports/leave-balance** — Per-employee, per-leave-type balance snapshot (allocated/used/remaining/carried-forward) for a given year, active employees only.
- **GET /api/reports/payroll** — Salary register from `SalarySlip` for a month/year (filterable by dept/employee/employmentType/weekNumber), full breakdown of basic/HRA/allowances/OT/deductions/net plus bank details, with aggregate totals.
- **GET /api/reports/pf-esi** — PF/ESI statutory compliance report: aggregates gross salary and PF/ESI deductions per employee across all their salary slips for a month/year, flags PF/ESI eligibility.
- **GET /api/reports/employees** — Employee master list export (filterable by department/branch/employmentType/status/employeeId) with full personal/bank/statutory fields.
- **GET /api/reports/headcount** — Headcount/strength breakdown by department (staff/production/gender split), overall by-type and by-gender totals, and a list of new joiners this calendar month.
- **GET /api/reports/settlement** — Loan/advance register with computed overdue-months count per advance (comparing repayment schedule against actual `AdvanceRepayment` rows), filterable by status/type/department/employee/overdueOnly, with disbursed/repaid/outstanding totals.
- **GET /api/reports/new-joinings** — Employees whose `join_date` falls in a given month/year, filterable by department/employmentType.

---

# Part 2 — Database Tables

## Core & Organization Structure

### Branch
**Table name:** `branches`

Represents one physical company unit/factory location (e.g. Head Office, Unit1). It is the top-level scoping entity for branch-isolated multi-tenancy — departments, employees, shifts, settings overrides, and chat channels all key off it — and also carries the geofence center used by the Geo Attendance feature.

**Key fields:**
- `code` — TextField, `unique=True`, nullable
- `is_head_office`, `is_active` — BooleanField
- `next_employee_seq` — IntegerField, auto-incrementing counter behind the per-branch employee "Unit Code" (HO-1, HO-2, …)
- `geofence_lat`, `geofence_lng` — DecimalField(9,6), nullable geofence center for location-based attendance
- `geofence_radius_m` — IntegerField, default 200
- `created_at` — DateTimeField (auto_now_add)

### Department
**Table name:** `departments`

A department within a branch (e.g. ADMIN, CUTTING, PRODUCTION). Deliberately unique per-branch rather than globally, since two branches legitimately run their own same-named department as separate staffing units.

**Key fields:**
- `branch` — ForeignKey → `Branch`, `on_delete=SET_NULL`, null/blank, related_name `departments`
- `name` — TextField (unique together with `branch` via `UniqueConstraint uniq_department_name_per_branch`)
- `created_at` — DateTimeField (auto_now_add)

### Designation
**Table name:** `designations`

A job title/role level within a department (e.g. Tailor, Supervisor, Manager), used for org-chart and promotion tracking.

**Key fields:**
- `department` — ForeignKey → `Department`, `on_delete=SET_NULL`, null/blank, related_name `designations`
- `title` — TextField
- `level` — TextField, default `"staff"` (junior/mid/senior/manager/executive convention)
- `created_at` — DateTimeField (auto_now_add)

## User Management, RBAC & Auth

### Role
**Table name:** `roles`

An HR-portal role (e.g. HR Admin, HR Executive, Payroll Officer) that bundles a set of module-level permissions assigned to `HRUser` accounts.

**Key fields:**
- `name` — TextField, `unique=True`
- `permissions` — JSONField, default `dict`; `{module_key: "hidden"|"view"|"edit"}` per sidebar module
- `is_system` — BooleanField, protects built-in roles
- `created_at`, `updated_at` — DateTimeField

### HRUser
**Table name:** `hr_users`

An HR-portal login account (as opposed to an `Employee`, who uses the mobile self-service app). Carries RBAC assignment, branch/department scoping, and per-account capability overrides.

**Key fields:**
- `username` — TextField, `unique=True`
- `password_hash` — TextField (bcrypt hash)
- `role` — ForeignKey → `Role`, `on_delete=SET_NULL`, null/blank, related_name `users`
- `department` — ForeignKey → `Department`, `on_delete=SET_NULL`, null/blank, related_name `hr_users`
- `branch` — ForeignKey → `Branch`, `on_delete=SET_NULL`, null/blank, related_name `hr_users`
- `is_active`, `is_super_admin`, `is_hidden` — BooleanField (`is_hidden` only affects the Account Management list, never auth/permissions)
- `master_features` — JSONField, default `dict`; grant-only per-account capability flags (e.g. `{"co": true}`)
- `last_login`, `created_at`, `updated_at` — DateTimeField

### LoginSession
**Table name:** `login_sessions`

One row per HR-portal login, making an otherwise-stateless JWT into a revocable, listable session (matched by the token's `jti` claim). Powers the Login Devices page and logout/revocation.

**Key fields:**
- `hr_user` — ForeignKey → `HRUser`, `on_delete=CASCADE`, related_name `login_sessions`
- `jti` — TextField, `unique=True`, indexed
- `device_label`, `user_agent`, `ip_address` — TextField
- `created_at`, `last_seen_at`, `revoked_at` — DateTimeField
- Index on `(hr_user, revoked_at)`

### HrLoginAttempt
**Table name:** `hr_login_attempts`

One row per HR-portal login attempt (success or failure), kept separate from `AuditLog` to keep brute-force lockout queries fast and simple.

**Key fields:**
- `username` — TextField, indexed
- `ip_address` — TextField, nullable
- `success` — BooleanField, default False
- `created_at` — DateTimeField
- Index on `(username, created_at)`

### AuditLog
**Table name:** `audit_logs`

A generic, cross-module audit trail entry (login/logout/create/update/delete/approve/reject/export/lock) recording who did what to which record, with before/after JSON snapshots.

**Key fields:**
- `branch` — ForeignKey → `Branch`, `on_delete=SET_NULL`, null/blank, related_name `audit_logs`
- `user_type` — TextField, default `"hr"` (hr/employee/erp)
- `action` — TextField, `choices=ACTION_CHOICES` (login, logout, create, update, delete, approve, reject, export, lock)
- `module`, `record_description` — TextField
- `record_id`, `user_id` — IntegerField, nullable bare references (no FK)
- `old_values`, `new_values` — JSONField, nullable
- `ip_address` — TextField
- `created_at` — DateTimeField, ordering `-created_at`

## Employees

### Employee
**Table name:** `employees`

The central record for a person employed by the company — staff or production floor worker — covering identity, org placement, salary basis, statutory IDs, bank details, mobile self-service login, and geo-tracking opt-in. Nearly every other domain table hangs off this one.

**Key fields:**
- `employee_code` — TextField, `unique=True`
- `unit_code` — TextField, `unique=True`, nullable; auto-generated from `Branch.code` + `Branch.next_employee_seq`
- `gender` — TextField, `choices=GENDER_CHOICES` (male/female/other)
- `employment_type` — TextField, `choices=EMPLOYMENT_TYPES` (production/staff), default staff
- `department` — ForeignKey → `Department`, `on_delete=SET_NULL`, null/blank, related_name `employees`
- `designation` — ForeignKey → `Designation`, `on_delete=SET_NULL`, null/blank, related_name `employees`
- `branch` — ForeignKey → `Branch`, `on_delete=SET_NULL`, null/blank, related_name `employees`
- `reporting_manager` — ForeignKey → `"self"`, `on_delete=SET_NULL`, null/blank, related_name `subordinates`
- `salary_type`, `salary_amount`, `salary_per_shift` — TextField / DecimalField, basis for payroll computation
- `initial_salary` — DecimalField, baseline for increment tracking
- `status` — TextField, default `"active"`
- `password_hash` — TextField, nullable; bcrypt hash for mobile self-service login
- `last_mobile_login_at` — DateTimeField, nullable
- `location_tracking_enabled` — BooleanField, default False (Geo Attendance opt-in)
- `bank_name`, `bank_account`, `bank_ifsc`, `pf_number`, `esi_number`, `uan_number` — TextField
- `created_at`, `updated_at` — DateTimeField

## Shift Management

### ShiftTemplate
**Table name:** `shift_templates`

A reusable shift definition (timing, gender restriction, grace periods, staff 4-punch half/lunch structure) that employees are assigned to via `EmployeeShiftAssignment`. Branch- and department-scoped.

**Key fields:**
- `branch` — ForeignKey → `Branch`, `on_delete=SET_NULL`, null/blank, related_name `shift_templates`
- `department` — ForeignKey → `Department`, `on_delete=SET_NULL`, null/blank, related_name `shifts`
- `shift_type` — TextField, `choices=SHIFT_TYPES` (production/staff)
- `gender_rule` — TextField, `choices=GENDER_RULES` (all/male-only/female-only)
- `start_time`, `end_time`, `first_half_end` — TimeField
- `grace_period_minutes`, `lunch_duration_minutes`, `lunch_grace_minutes` — IntegerField
- `is_default`, `is_active` — BooleanField
- `created_at` — DateTimeField

### EmployeeShiftAssignment
**Table name:** `employee_shift_assignments`

Assigns one employee to one shift template for a date range, with optional per-employee timing overrides and a Saturday-off flag.

**Key fields:**
- `employee` — ForeignKey → `Employee`, `on_delete=CASCADE`, related_name `shift_assignments`
- `shift` — ForeignKey → `ShiftTemplate`, `on_delete=CASCADE`, related_name `assignments`
- `effective_from`, `effective_to` — DateField
- `custom_start_time`, `custom_end_time` — TimeField, nullable per-employee overrides
- `saturday_off` — BooleanField, default False
- `created_at` — DateTimeField

## Department Managers & Approval Delegation

### DepartmentManager
**Table name:** `department_managers`

Marks an employee as a department-level approver (created via User Management), with individually toggleable approval capabilities across leave, permission, resignation, attendance, casual leave, and on-duty/missing-punch workflows.

**Key fields:**
- `employee` — OneToOneField → `Employee`, `on_delete=CASCADE`, related_name `manager_profile`
- `can_approve_leaves`, `can_approve_permissions`, `can_approve_resignations`, `can_approve_attendance`, `can_approve_casual_leave`, `can_approve_on_duty`, `can_approve_missing_punch` — BooleanField, default True
- `is_active` — BooleanField, default True
- `created_at` — DateTimeField

### ManagerDepartmentAssignment
**Table name:** `manager_department_assignments`

Links a `DepartmentManager` to one department they approve for (many-to-many via explicit through table).

**Key fields:**
- `manager` — ForeignKey → `DepartmentManager`, `on_delete=CASCADE`, related_name `department_assignments`
- `department` — ForeignKey → `Department`, `on_delete=CASCADE`, related_name `manager_assignments`
- `created_at` — DateTimeField
- `unique_together`: (`manager`, `department`)

### ManagerEmployeeAssignment
**Table name:** `manager_employee_assignments`

Links a `DepartmentManager` directly to an individual employee they approve for, independent of department membership.

**Key fields:**
- `manager` — ForeignKey → `DepartmentManager`, `on_delete=CASCADE`, related_name `employee_assignments`
- `employee` — ForeignKey → `Employee`, `on_delete=CASCADE`, related_name `direct_manager_assignments`
- `created_at` — DateTimeField
- `unique_together`: (`manager`, `employee`)

## Leave & Holiday

### LeaveType
**Table name:** `leave_types`

A category of leave (CL, SL, EL, ML, PL) with its annual entitlement, carry-forward, paid/unpaid, and gender-applicability rules.

**Key fields:**
- `code` — TextField, `unique=True`
- `max_days_per_year`, `max_carry_forward_days` — IntegerField
- `carry_forward`, `is_paid`, `is_active` — BooleanField
- `applicable_gender` — TextField, default `"all"`
- `created_at` — DateTimeField

### LeaveBalance
**Table name:** `leave_balances`

An employee's allocated/used/remaining leave balance for one leave type in one calendar year.

**Key fields:**
- `employee` — ForeignKey → `Employee`, `on_delete=CASCADE`, related_name `leave_balances`
- `leave_type` — ForeignKey → `LeaveType`, `on_delete=CASCADE`, related_name `balances`
- `year` — IntegerField
- `allocated`, `used`, `remaining`, `carried_forward` — DecimalField(5,1)
- `unique_together`: (`employee`, `leave_type`, `year`)

### Holiday
**Table name:** `holidays`

A company/national/regional holiday date, optionally scoped to a branch and/or department, with a recurrence flag.

**Key fields:**
- `holiday_type` — TextField, `choices=HOLIDAY_TYPES` (national/regional/company)
- `branch` — ForeignKey → `Branch`, `on_delete=SET_NULL`, null/blank, related_name `holidays`
- `department` — ForeignKey → `Department`, `on_delete=SET_NULL`, null/blank, related_name `holidays`
- `date` — DateField
- `is_recurring` — BooleanField
- `created_at` — DateTimeField

### LeaveRequest
**Table name:** `leave_requests`

An employee's leave application spanning a date range, with HR/department-head approval workflow.

**Key fields:**
- `employee` — ForeignKey → `Employee`, `on_delete=CASCADE`, related_name `leave_requests`
- `leave_type_ref` — ForeignKey → `LeaveType`, `on_delete=SET_NULL`, null/blank, related_name `requests`
- `start_date`, `end_date` — TextField (stored as text, not DateField)
- `total_days` — DecimalField(4,1)
- `status` — TextField, default `"pending"` (pending/approved/rejected convention)
- `approver_role` — TextField, nullable (`"hr"` | `"dept_head"`)
- `created_at` — DateTimeField

### CasualLeaveRequest
**Table name:** `casual_leave_requests`

A staff-only Casual Leave request for a single day, entirely independent of `LeaveRequest`/permissions — limited to one per calendar month and only after 6 months of service (enforced in views). Approval marks that date's attendance Present; rejection marks it Leave.

**Key fields:**
- `employee` — ForeignKey → `Employee`, `on_delete=CASCADE`, related_name `casual_leaves`
- `date` — DateField
- `status` — TextField, `choices=STATUS_CHOICES` (pending/approved/rejected)
- `reviewer_role` — TextField, nullable (hr | dept_head)
- `reviewed_by`, `reviewed_at` — TextField / DateTimeField
- `created_at` — DateTimeField

## Employee Self-Service & Approval Requests

### EmployeeRequest
**Table name:** `employee_requests`

A generic support ticket raised by an employee from the mobile app (leave, salary enquiry, shift correction, advance, permission, or general query), tracked through an HR review pipeline.

**Key fields:**
- `employee` — ForeignKey → `Employee`, `on_delete=CASCADE`, related_name `requests`
- `request_type` — TextField, `choices=REQUEST_TYPES` (leave/salary_enquiry/shift_correction/advance/permission/general)
- `status` — TextField, `choices=STATUS_CHOICES` (pending/in_review/approved/rejected/more_info), default pending
- `handled_by`, `handled_at` — TextField / DateTimeField
- `created_at`, `updated_at` — DateTimeField

### EmployeePermission
**Table name:** `employee_permissions`

A request for short-notice permission time on a given date (e.g. arriving late/leaving early with prior notice), which feeds into the payroll late-detection "free allowance" pool.

**Key fields:**
- `employee` — ForeignKey → `Employee`, `on_delete=CASCADE`, related_name `permissions`
- `date` — DateField
- `permission_time` — TimeField, nullable
- `status` — TextField, `choices=STATUS_CHOICES` (pending/approved/rejected)
- `approver_role` — TextField, nullable (hr | dept_head)
- `created_at`, `updated_at` — DateTimeField

### ResignationRequest
**Table name:** `resignation_requests`

An employee's resignation with an exit survey, flowing through a two-stage `pending → dept_approved → approved` (or rejection at either stage) workflow.

**Key fields:**
- `employee` — ForeignKey → `Employee`, `on_delete=CASCADE`, related_name `resignation_requests`
- `dept_head` — ForeignKey → `Employee`, `on_delete=SET_NULL`, null/blank, related_name `resignation_reviews`
- `last_working_date` — DateField, nullable
- `survey_q1_answer`, `survey_q2_answer`, `survey_q3_answer` — TextField
- `status`, `dept_head_status` — TextField (pending/dept_approved/approved/rejected convention)
- `dept_head_approved_at`, `approved_at` — DateTimeField
- `created_at` — DateTimeField

### AttendanceOverrideRequest
**Table name:** `attendance_override_requests`

HR's proposed manual edit to an `AttendanceDayRecord`, held for Department Head approval before being applied, preventing unaccountable silent edits.

**Key fields:**
- `employee` — ForeignKey → `Employee`, `on_delete=CASCADE`, related_name `attendance_override_requests`
- `date` — DateField
- `previous_values`, `requested_values` — JSONField, default `dict` (before/after snapshots)
- `status` — TextField, `choices=STATUS_CHOICES` (pending/approved/rejected)
- `requested_by`, `reviewed_by`, `reviewed_at` — TextField / DateTimeField
- `created_at` — DateTimeField

### MissingPunchRequest
**Table name:** `missing_punch_requests`

An employee's self-service "I forgot to punch" request for a specific punch slot on a date, approved by Department Head then HR; on final approval it is written as an ordinary `AttendanceLog` row rather than directly editing the day's record.

**Key fields:**
- `employee` — ForeignKey → `Employee`, `on_delete=CASCADE`, related_name `missing_punch_requests`
- `date` — DateField
- `punch_time` — TimeField
- `punch_type` — TextField, `choices=AttendanceLog.PUNCH_CHOICES` (IN/OUT)
- `punch_slot` — TextField, `choices=PUNCH_SLOT_CHOICES` (morning_in/lunch_out/lunch_in/evening_out), nullable
- `status` — TextField, `choices=STATUS_CHOICES` (pending_hod/pending_hr/approved/rejected)
- `hod_reviewed_by`, `hr_reviewed_by` — TextField
- `created_at` — DateTimeField

## Attendance & Biometric — Punch Capture

### Attendance
**Table name:** `attendance`

A simple legacy present/absent record per employee per day with hours worked; superseded in practice by `AttendanceDayRecord` but retained.

**Key fields:**
- `employee` — ForeignKey → `Employee`, `on_delete=CASCADE`, related_name `attendance_records`
- `date` — TextField
- `present` — BooleanField, default True
- `hours_worked` — DecimalField(4,2), nullable
- `unique_together`: (`employee`, `date`)

### AttendanceLog
**Table name:** `attendance_logs`

The raw, individual punch-in/punch-out events for an employee — the ground truth that the shift engine, payroll, and every override/approval workflow ultimately write into or read from.

**Key fields:**
- `employee` — ForeignKey → `Employee`, `on_delete=CASCADE`, related_name `attendance_logs`
- `date` — DateField
- `punch_time` — TimeField
- `punch_type` — TextField, `choices=PUNCH_CHOICES` (IN/OUT)
- `source` — TextField, default `"manual"` (also carries values like `on_duty:approved`, `missing_punch:approved`)
- `unique_together`: (`employee`, `date`, `punch_time`, `punch_type`); ordering `["date", "punch_time"]`

### BiometricDevice
**Table name:** `biometric_devices`

Configuration for a physical biometric attendance terminal (AiFace-Mars, ZKTeco, eSSL, generic HTTP, etc.), including connection details for pull-based sync and identification for ADMS push ingestion.

**Key fields:**
- `device_type` — TextField, `choices=DEVICE_TYPE_CHOICES` (aiface_mars/zkteco/essl/generic_http/other)
- `connection_config` — JSONField, default `dict`
- `is_active`, `is_default` — BooleanField
- `serial_number` — TextField, identifies device on ADMS push (auto-filled on first push)
- `last_synced_at`, `last_push_at` — DateTimeField, nullable
- ordering `["-is_default", "name"]`

### UnmatchedPunch
**Table name:** `unmatched_punches`

An aggregated (not per-punch) record of a device user ID that doesn't match any `Employee` — surfacing attendance that would otherwise be silently discarded, so HR can reconcile it.

**Key fields:**
- `device_user_id` — TextField, indexed
- `device_serial`, `device_label` — TextField
- `punch_count` — IntegerField
- `resolved`, `resolved_note` — BooleanField / TextField
- `unique_together`: (`device_user_id`, `device_serial`)

### AutoSyncRule
**Table name:** `auto_sync_rules`

An HR-configurable schedule (time + days-of-week + device selection + sync mode) driving a background APScheduler job that pulls punches from biometric devices automatically.

**Key fields:**
- `time` — TimeField
- `days_of_week` — TextField, default `"*"` (cron-style)
- `device_selection` — JSONField, default `list`
- `mode` — TextField, `choices=MODE_CHOICES` (day/week/month/all)
- `is_enabled` — BooleanField
- `last_run_at`, `last_run_status`, `last_run_summary` — DateTimeField / TextField
- ordering `["time"]`

## Attendance — Computed Engine

### DailyShiftLog
**Table name:** `daily_shift_logs`

The computed 4-punch result for one staff employee on one day (P1–P4 morning-in/lunch-out/lunch-in/evening-out), derived from `AttendanceLog`, including lateness flags and fractional shift value.

**Key fields:**
- `employee` — ForeignKey → `Employee`, `on_delete=CASCADE`, related_name `daily_shift_logs`
- `shift` — ForeignKey → `ShiftTemplate`, `on_delete=SET_NULL`, null/blank, related_name `daily_logs`
- `punch1`–`punch4` — TimeField, nullable
- `shifts_completed` — DecimalField(3,2)
- `first_half`, `second_half`, `late_morning`, `late_return` — BooleanField
- `unique_together`: (`employee`, `date`)

### MonthlyShiftSummary
**Table name:** `monthly_shift_summaries`

Per-employee, per-month aggregation of lateness and shift totals, feeding the payroll late-deduction formula (combined pool of lates + permission overages minus a free allowance).

**Key fields:**
- `employee` — ForeignKey → `Employee`, `on_delete=CASCADE`, related_name `monthly_shift_summaries`
- `total_shifts`, `shift_deductions` — DecimalField(5,2)
- `total_late_count`, `permission_overage_count`, `permissions_used`, `billable_late_count` — IntegerField
- `salary_deduction_amount` — DecimalField(10,2)
- `unique_together`: (`employee`, `year`, `month`)

### AttendanceDayRecord
**Table name:** `attendance_day_records`

The single authoritative, final attendance verdict for one employee on one day — auto-computed from punches (strict or simple mode) and optionally HR-overridden. Payroll and salary generation always read from this table first.

**Key fields:**
- `employee` — ForeignKey → `Employee`, `on_delete=CASCADE`, related_name `attendance_day_records`
- `status` — TextField, `choices=STATUS_CHOICES` (present/absent/half_shift/on_leave/holiday)
- `is_late`, `is_half_shift`, `early_leave`, `late_in_without_permission`, `early_out_without_permission` — BooleanField
- `shifts_earned` — DecimalField(3,2) (0.50 per half; staff max 1.00, production max 1.50)
- `first_punch`, `last_punch` — TimeField, nullable
- `source` — TextField, default `"auto"` (auto | manual — manual is authoritative)
- `primary_source` — TextField, nullable, display-only (Biometric/On-Duty/Geo Punch/HR Entry)
- `unique_together`: (`employee`, `date`); ordering `["date"]`

### SessionConfig
**Table name:** `session_configs`

Defines a named work "session" window (e.g. Morning, Afternoon) with its own pay amount, used by session-based (non-monthly) salary employees.

**Key fields:**
- `start_time`, `end_time`, `minimum_checkout_time` — TimeField
- `pay_amount` — DecimalField(8,2)
- `is_overtime` — BooleanField
- `order` — IntegerField, ordering `["order"]`

### WorkSession
**Table name:** `work_sessions`

One employee's completed session on a given date (check-in/out against a `SessionConfig`), with computed hours and pay for that session — used to build session-based `Payroll` rows.

**Key fields:**
- `employee` — ForeignKey → `Employee`, `on_delete=CASCADE`, related_name `work_sessions`
- `session_config` — ForeignKey → `SessionConfig`, `on_delete=SET_NULL`, null/blank, related_name `work_sessions`
- `check_in`, `check_out` — TimeField
- `hours_worked`, `session_amount` — DecimalField
- `is_overtime` — BooleanField
- ordering `["date", "check_in"]`

## Night Shift Relaxation

### NightShiftRule
**Table name:** `night_shift_rules`

A DB-driven relaxation rule: if an employee's last night punch-out is at or before `worked_until`, their allowed next-morning punch-in is relaxed to `allowed_first_punch` without triggering late/half-shift.

**Key fields:**
- `worked_until`, `allowed_first_punch` — TimeField
- `crosses_midnight` — BooleanField, marks early-morning `worked_until` values as belonging to the previous night
- `order` — IntegerField, `is_active` — BooleanField
- ordering `["order", "id"]`

### NightShiftRelaxation
**Table name:** `night_shift_relaxations`

One row per employee per night they worked late, auto-detected from `AttendanceLog`, recording which `NightShiftRule` applied and whether the next day's arrival stayed within the allowance.

**Key fields:**
- `employee` — ForeignKey → `Employee`, `on_delete=CASCADE`, related_name `night_relaxations`
- `rule` — ForeignKey → `NightShiftRule`, `on_delete=SET_NULL`, null/blank, related_name `relaxations`
- `night_date`, `relaxation_date` — DateField
- `last_punch_out`, `allowed_until`, `reported_at` — TimeField
- `within_allowance` — BooleanField, nullable
- `unique_together`: (`employee`, `relaxation_date`)

## Production Shift Workflow

### ProductionShiftConfig
**Table name:** `production_shift_config`

Singleton holding the reference punch times (arrival, lunch out, lunch return, departure) and grace window for the production-floor 4-punch day, gender-agnostic across all production employees.

**Key fields:**
- `punch1_time`…`punch4_time` — TimeField (defaults 08:30/12:45/13:30/20:00)
- `grace_minutes` — IntegerField, default 10
- `updated_at` — DateTimeField

### ProductionShiftSegment
**Table name:** `production_shift_segments`

An ordered, editable list of shift-value segments (time window → fractional shift credit) that together define the production 1.50-shift day, e.g. 4 × 0.25 plus a 0.50 overtime segment.

**Key fields:**
- `start_time`, `end_time` — TimeField
- `shift_value` — DecimalField(4,2)
- `order`, `is_active` — IntegerField / BooleanField
- ordering `["order", "id"]`

## Geo Attendance & On-Duty

### OnDutySession
**Table name:** `on_duty_sessions`

An employee's declared day working away from the branch (field visit, driver, offsite work), provisionally active immediately but subject to a two-stage Department-Head-then-HR approval chain before its captured punches become real attendance.

**Key fields:**
- `employee` — ForeignKey → `Employee`, `on_delete=CASCADE`, related_name `on_duty_sessions`
- `branch` — ForeignKey → `Branch`, `on_delete=SET_NULL`, null/blank (snapshot of assigned branch at request time)
- `status` — TextField, `choices=STATUS_CHOICES` (pending_hod/pending_hr/active/completed/rejected)
- `completion_reason` — TextField, `choices=COMPLETION_CHOICES` (manual/auto_4th_punch/auto_day_end), nullable
- `started_at`, `employee_ended_at`, `completed_at` — DateTimeField, nullable
- ordering `["-created_at"]`

### OnDutyPunchVerification
**Table name:** `on_duty_punch_verifications`

One of an on-duty employee's 4 daily punches, captured with a selfie + GPS instead of going straight to `AttendanceLog` — only becomes a real punch once HR approves it (the fraud check unsupervised offsite punching needs).

**Key fields:**
- `session` — ForeignKey → `OnDutySession`, `on_delete=CASCADE`, related_name `punch_verifications`
- `employee` — ForeignKey → `Employee`, `on_delete=CASCADE`, related_name `on_duty_punch_verifications`
- `punch_type` — TextField, `choices=AttendanceLog.PUNCH_CHOICES`
- `latitude`, `longitude` — DecimalField(9,6); `accuracy_m` — FloatField, nullable
- `is_mocked` — BooleanField (fake-GPS detection)
- `photo` — FileField
- `status` — TextField, `choices=STATUS_CHOICES` (pending/approved/rejected)
- ordering `["-created_at"]`

### LiveLocationPing
**Table name:** `live_location_pings`

An append-only GPS sample from an employee with `location_tracking_enabled=True`, used to draw a live breadcrumb trail on the HR map; pruned to the last 24h on write.

**Key fields:**
- `employee` — ForeignKey → `Employee`, `on_delete=CASCADE`, related_name `location_pings`
- `latitude`, `longitude` — DecimalField(9,6); `accuracy_m` — FloatField, nullable
- `is_mocked` — BooleanField
- `recorded_at` — DateTimeField (auto_now_add)
- Index on `(employee, -recorded_at)`; ordering `["-recorded_at"]`

## Payroll — Runs & Line Items (Enterprise)

### PayrollRun
**Table name:** `payroll_runs`

A single execution of the payroll process for a given month/year (or bi-weekly week), moving through draft → processing → approved → locked, aggregating totals across all employees processed in it.

**Key fields:**
- `run_code` — TextField, `unique=True`
- `run_type` — TextField, `choices=RUN_TYPES` (monthly/biweekly)
- `status` — TextField, `choices=STATUS_CHOICES` (draft/processing/approved/locked)
- `total_gross`, `total_deductions`, `total_net` — DecimalField(12,2)
- `approved_at`, `locked_at` — DateTimeField, nullable
- `updated_at` — DateTimeField

### EarningItem
**Table name:** `earning_items`

One earning line (basic, HRA, allowance, incentive, bonus, overtime, session pay) attributed to one employee within one `PayrollRun`.

**Key fields:**
- `payroll_run` — ForeignKey → `PayrollRun`, `on_delete=CASCADE`, related_name `earnings`
- `employee` — ForeignKey → `Employee`, `on_delete=CASCADE`, related_name `earnings`
- `item_type` — TextField, `choices=ITEM_TYPES` (basic/hra/allowance/incentive/bonus/ot/session)
- `amount` — DecimalField(10,2)

### DeductionItem
**Table name:** `deduction_items`

One deduction line (PF, ESI, advance recovery, loan recovery, penalty, other) attributed to one employee within one `PayrollRun`.

**Key fields:**
- `payroll_run` — ForeignKey → `PayrollRun`, `on_delete=CASCADE`, related_name `deductions`
- `employee` — ForeignKey → `Employee`, `on_delete=CASCADE`, related_name `deductions`
- `item_type` — TextField, `choices=ITEM_TYPES` (pf/esi/advance/loan/penalty/other)
- `amount` — DecimalField(10,2)

### SalarySlip
**Table name:** `salary_slips`

The generated payslip document data for one employee for one payroll period — full breakdown of earnings, deductions, attendance-derived day counts, and a JSON day-by-day audit trail.

**Key fields:**
- `employee` — ForeignKey → `Employee`, `on_delete=CASCADE`, related_name `salary_slips`
- `payroll_run` — ForeignKey → `PayrollRun`, `on_delete=SET_NULL`, null/blank, related_name `salary_slips`
- `slip_number` — TextField, `unique=True`
- `gross_salary`, `net_salary`, `total_deductions` — DecimalField(10,2)
- `breakdown_details` — JSONField, nullable (full day-by-day traceability)
- `period_start`, `period_end` — DateField, nullable
- `unique_together`: (`employee`, `month`, `year`, `week_number`); plus a conditional `UniqueConstraint uniq_salary_slip_employee_period` on (`employee`, `period_start`, `period_end`) when `period_start` is set

## Payroll — Per-Employee Records (Legacy/Simple)

### Payroll
**Table name:** `payrolls`

A computed payroll record for one employee for one period (monthly, session-based, or shift-based/production), holding attendance-derived totals and the final salary figure — the simpler, per-employee counterpart to the `PayrollRun`/`SalarySlip` enterprise flow.

**Key fields:**
- `employee` — ForeignKey → `Employee`, `on_delete=CASCADE`, related_name `payrolls`
- `salary_mode` — TextField, `choices=MODE_CHOICES` (monthly/session/shift)
- `status` — TextField, `choices=STATUS_CHOICES` (pending/paid)
- `base_salary`, `gross_salary`, `final_salary`, `deductions`, `bonus` — DecimalField
- `period_start`, `period_end` — DateField, nullable (configurable-period production payroll)
- `unique_together`: (`employee`, `month`, `year`, `week_number`); plus conditional `UniqueConstraint uniq_payroll_employee_period` on (`employee`, `period_start`, `period_end`)

### SalaryRecord
**Table name:** `salary_records`

An older/simpler salary payment record per employee per month, independent of `Payroll`/`PayrollRun`.

**Key fields:**
- `employee` — ForeignKey → `Employee`, `on_delete=CASCADE`, related_name `salary_records`
- `amount` — DecimalField(10,2)
- `type` — TextField, default `"monthly"`
- `status` — TextField, default `"pending"`
- `created_at` — DateTimeField

## Settlement — Advances & Loans

### Advance
**Table name:** `advances`

An employee's advance or term loan request, tracking disbursement, EMI schedule, and running repayment/outstanding balance.

**Key fields:**
- `employee` — ForeignKey → `Employee`, `on_delete=CASCADE`, related_name `advances`
- `advance_type` — TextField, `choices=ADVANCE_TYPES` (general/term)
- `status` — TextField, `choices=STATUS_CHOICES` (pending/approved/rejected/closed)
- `amount`, `emi_amount`, `total_repaid`, `outstanding` — DecimalField(10,2)
- `repayment_start_month`, `repayment_start_year`, `repayment_months` — IntegerField, nullable
- `approved_at`, `disbursed_at` — DateTimeField, nullable

### AdvanceRepayment
**Table name:** `advance_repayments`

One repayment installment against an `Advance`, for a specific month/year, optionally linked to the `PayrollRun` that processed it as a deduction.

**Key fields:**
- `advance` — ForeignKey → `Advance`, `on_delete=CASCADE`, related_name `repayments`
- `payroll_run` — ForeignKey → `PayrollRun`, `on_delete=SET_NULL`, null/blank, related_name `advance_repayments`
- `payment_method` — TextField, `choices=PAYMENT_METHODS` (cash/gpay/payroll)
- `amount` — DecimalField(10,2)
- `is_processed` — BooleanField

## Promotion & Increment

### Promotion
**Table name:** `promotions`

A record of an employee's department/designation change (promotion or transfer), preserving both the previous and new placement.

**Key fields:**
- `employee` — ForeignKey → `Employee`, `on_delete=CASCADE`, related_name `promotions`
- `previous_department`, `new_department` — ForeignKey → `Department`, `on_delete=SET_NULL`, null/blank, `related_name="+"`
- `previous_designation`, `new_designation` — ForeignKey → `Designation`, `on_delete=SET_NULL`, null/blank, `related_name="+"`
- `effective_date` — DateField
- ordering `["-effective_date", "-created_at"]`

### SalaryIncrement
**Table name:** `salary_increments`

A record of an employee's salary change, storing the before/after amount and computed percentage.

**Key fields:**
- `employee` — ForeignKey → `Employee`, `on_delete=CASCADE`, related_name `increments`
- `previous_salary`, `new_salary` — DecimalField(10,2)
- `percent` — DecimalField(6,2)
- `effective_date` — DateField
- ordering `["-effective_date", "-created_at"]`

## Recruitment

### Job
**Table name:** `jobs`

An open (or closed) job posting for a department, with description, requirements, and salary range, that applicants apply against.

**Key fields:**
- `department` — ForeignKey → `Department`, `on_delete=SET_NULL`, null/blank, related_name `jobs`
- `status` — TextField, default `"open"`
- `created_at` — DateTimeField

### Applicant
**Table name:** `applicants`

A candidate's application to a specific `Job`, including cover letter, experience, and interview scheduling.

**Key fields:**
- `job` — ForeignKey → `Job`, `on_delete=CASCADE`, related_name `applicants`
- `status` — TextField, default `"applied"`
- `interview_date` — TextField, nullable
- `created_at` — DateTimeField

### DepartmentHeadcount
**Table name:** `department_headcounts`

The required staffing level for a department, compared against actual headcount to drive hiring decisions.

**Key fields:**
- `department` — OneToOneField → `Department`, `on_delete=CASCADE`, related_name `headcount`
- `required_count` — IntegerField, default 0
- `updated_at` — DateTimeField

## Resume Screening (ATS)

### HiringRuleSet
**Table name:** `hiring_rule_sets`

Department-scoped hiring criteria (required/soft skills, education, min experience, preferred city) used to automatically score uploaded resumes. Multiple rule sets can exist per department for different roles.

**Key fields:**
- `department` — ForeignKey → `Department`, `on_delete=CASCADE`, related_name `hiring_rule_sets`
- `required_skills`, `soft_skills` — JSONField, default `list`
- `min_experience_years` — DecimalField(4,1)
- `is_active` — BooleanField
- `created_at`, `updated_at` — DateTimeField

### ScreeningCandidate
**Table name:** `screening_candidates`

One uploaded resume, its ML-extracted fields, its computed match score against the `HiringRuleSet` it was screened with, and its position in the shortlist → selected/rejected pipeline.

**Key fields:**
- `rule_set` — ForeignKey → `HiringRuleSet`, `on_delete=PROTECT`, related_name `candidates` (protected so historical scoring records survive rule-set edits)
- `department` — ForeignKey → `Department`, `on_delete=SET_NULL`, null/blank, related_name `screening_candidates` (denormalized snapshot)
- `resume_file` — FileField
- `source` — TextField, default `"single"` (single | bulk)
- `extracted_skills`, `extracted_soft_skills` — JSONField, default `list`
- `match_score` — DecimalField(5,2), nullable; `score_breakdown` — JSONField, nullable
- `status` — TextField, default `"uploaded"` (uploaded → screened → shortlisted/not_shortlisted → selected/rejected)
- `screened_at`, `interview_invited_at`, `interview_datetime`, `rejection_emailed_at` — DateTimeField, nullable

## Documents & File Storage

### EmployeeDocument
**Table name:** `employee_documents`

One uploaded file (image/PDF) attached to an employee's record — identity documents, certificates, or scanned letters — distinct from on-demand generated PDFs. Multiple files per category are allowed, deleted individually.

**Key fields:**
- `employee` — ForeignKey → `Employee`, `on_delete=CASCADE`, related_name `documents`
- `category` — TextField, `choices=CATEGORY_CHOICES` (pan_card, aadhaar_card, educational_certificate, voter_id_or_birth_certificate, bank_passbook, offer_letter, experience_letter, resignation_letter, staff_letter, production_employee_documents)
- `file` — FileField
- ordering `["-uploaded_at"]`

### FileBlob
**Table name:** `file_blobs`

Backing store for the application's custom `HybridFileStorage`, holding uploaded file bytes directly in Postgres (rather than local disk, which is wiped on redeploy). Only new uploads go here; pre-existing on-disk files continue to be served via fallback.

**Key fields:**
- `name` — TextField, `unique=True` (relative path, matches FileField's `.name`)
- `content` — BinaryField
- `content_type` — TextField
- `size` — BigIntegerField, default 0

### CompanyDocumentSettings
**Table name:** `company_document_settings`

Per-document-type styling configuration (colors, heading style, watermark, footer tagline, logo override) for generated Offer Letter / Experience Letter / Salary Slip / Resignation Letter PDFs.

**Key fields:**
- `doc_type` — TextField, `unique=True`, `choices=DOC_TYPES` (offer_letter/experience_letter/salary_slip/resignation_letter)
- `show_watermark` — BooleanField
- `updated_at` — DateTimeField

### IdCardSettings
**Table name:** `idcard_settings`

Singleton (pk=1) holding the visual template settings for generated employee ID cards (colors, font, background style, logo position, corner style, QR code toggle).

**Key fields:**
- `background_style`, `logo_position`, `corner_style` — TextField (informal choice conventions: gradient/solid/pattern, left/center, rounded/sharp)
- `show_qr_on_back` — BooleanField
- `updated_at` — DateTimeField

## Notifications & Push

### Notification
**Table name:** `notifications`

An in-app notification message sent to an employee (mobile app), with a read/unread flag.

**Key fields:**
- `employee` — ForeignKey → `Employee`, `on_delete=CASCADE`, related_name `notifications`
- `type` — TextField, default `"general"`
- `is_read` — BooleanField, default False

### PushToken
**Table name:** `push_tokens`

An Expo push notification token for one of an employee's mobile devices; an employee may have several (one per device), and re-registering the same token reassigns it.

**Key fields:**
- `employee` — ForeignKey → `Employee`, `on_delete=CASCADE`, related_name `push_tokens`
- `token` — TextField, `unique=True`
- `platform` — TextField, default `"expo"`
- `created_at`, `updated_at` — DateTimeField

## Staff Chat

### ChatChannel
**Table name:** `chat_channels`

Either the single company-wide channel for a branch (`department=None`) or a per-department channel, created lazily on first access. Company channels are unique per branch; department channels are unique per department.

**Key fields:**
- `channel_type` — TextField, `choices=CHANNEL_TYPES` (company/department)
- `department` — ForeignKey → `Department`, `on_delete=CASCADE`, null/blank, related_name `chat_channels`
- `branch` — ForeignKey → `Branch`, `on_delete=CASCADE`, null/blank, related_name `chat_channels`
- `UniqueConstraint`s: one department channel per department; one company channel per branch; one legacy (pre-branch) company channel

### ChatMessage
**Table name:** `chat_messages`

One message in a `ChatChannel`, sent either by an `Employee` or (when `sender` is null) an HR-portal user identified by `sender_label`. Supports threaded replies.

**Key fields:**
- `channel` — ForeignKey → `ChatChannel`, `on_delete=CASCADE`, related_name `messages`
- `sender` — ForeignKey → `Employee`, `on_delete=CASCADE`, null/blank, related_name `chat_messages`
- `reply_to` — ForeignKey → `"self"`, `on_delete=SET_NULL`, null/blank, related_name `replies`
- ordering `["created_at"]`

### ChatReaction
**Table name:** `chat_reactions`

An emoji reaction by one employee on one chat message.

**Key fields:**
- `message` — ForeignKey → `ChatMessage`, `on_delete=CASCADE`, related_name `reactions`
- `employee` — ForeignKey → `Employee`, `on_delete=CASCADE`, related_name `chat_reactions`
- `emoji` — TextField
- `unique_together`: (`message`, `employee`, `emoji`)

## WhatsApp Integration

### WhatsAppMessageLog
**Table name:** `whatsapp_message_log`

One row per WhatsApp document-send attempt (salary slip, ID card, offer/experience/resignation letter), success or failure, centralizing "was this ever sent via WhatsApp" tracking that would otherwise need a column on every document type.

**Key fields:**
- `employee` — ForeignKey → `Employee`, `on_delete=CASCADE`, related_name `whatsapp_messages`
- `sent_by` — ForeignKey → `HRUser`, `on_delete=SET_NULL`, null/blank, related_name `whatsapp_messages_sent`
- `document_type` — TextField, `choices=DOCUMENT_TYPES` (salary_slip/id_card/offer_letter/experience_letter/resignation_letter/other)
- `status` — TextField, default `"sent"` (sent | failed)
- Index on `(employee, document_type)`; ordering `["-created_at"]`

### WhatsAppMessageTemplate
**Table name:** `whatsapp_message_template`

Per-document-type configuration of which pre-approved Meta WhatsApp Business template name/language to use (Meta requires business-initiated messages to use a reviewed template); editable from Settings → WhatsApp.

**Key fields:**
- `document_type` — TextField, `unique=True`
- `meta_template_name`, `meta_language_code` — TextField
- `is_enabled` — BooleanField, default False
- `updated_at` — DateTimeField

## Settings & Configuration

### PayrollSettings
**Table name:** `payroll_settings`

Singleton (pk=1) holding essentially all org-wide configurable business rules: company profile/branding, staff and production PF/ESI rates and thresholds, production payroll period definition, attendance calculation mode (strict/simple), late-detection policy and deduction slabs (staff and production, plus a separate "without permission" pool), default new-shift timings, cross-midnight punch reattribution windows, production attendance window times, PF/EF salary-range rules, feature toggles, database backup directory, SMTP credentials, and portal theme.

**Key fields:**
- `pf_rate`, `esi_rate`, `esi_applicable_below` — DecimalField (staff)
- `prod_pf_rate`, `prod_esi_rate`, `prod_esi_applicable_below` — DecimalField (production)
- `prod_period_frequency` — TextField, `choices=PERIOD_FREQ_CHOICES` (weekly/2weeks/3weeks/monthly)
- `prod_period_style` — TextField, `choices=PERIOD_STYLE_CHOICES` (calendar_month/weekday_anchored/custom_recurring)
- `prod_period_weekday_anchor` — TextField, `choices=WEEKDAY_ANCHOR_CHOICES` (mon_sat/sun_sat), nullable
- `prod_attendance_mode` — TextField, `choices=[("simple","Simple"),("strict","Strict")]`
- `attendance_mode` — TextField, default `"strict"` (strict | simple)
- `late_deduction_slabs`, `without_permission_deduction_slabs`, `prod_late_deduction_slabs` — JSONField (threshold tables)
- `prod_pf_ef_rules` — JSONField, default `list`
- `theme_custom` — JSONField, default `dict`
- `smtp_password` — TextField (plaintext, per codebase convention)
- `updated_at` — DateTimeField
- Access pattern: `PayrollSettings.get()` classmethod (`get_or_create(pk=1)`)

### BranchSettingsOverride
**Table name:** `branch_settings_overrides`

One branch's overrides layered on top of the universal `PayrollSettings` row — stores only the fields that branch has actually changed, as a JSON map, so untouched settings continue tracking the universal default automatically.

**Key fields:**
- `branch` — OneToOneField → `Branch`, `on_delete=CASCADE`, related_name `settings_override`
- `overrides` — JSONField, default `dict` ({field_name: value})
- `updated_at` — DateTimeField

## Backup

### BackupSchedule
**Table name:** `backup_schedule`

Singleton (pk=1) controlling the automated full-application backup job: schedule, retention, and last-run status.

**Key fields:**
- `is_enabled` — BooleanField, default False
- `time` — TimeField, default 02:00
- `days_of_week` — TextField, default `"*"`
- `retention_count` — IntegerField, default 14
- `last_run_at`, `last_run_status`, `last_run_summary` — DateTimeField / TextField

### BackupDriveConfig
**Table name:** `backup_drive_config`

Singleton holding optional Google Drive offsite-copy configuration for backups (local storage remains primary).

**Key fields:**
- `is_enabled` — BooleanField, default False
- `folder_id` — TextField
- `service_account_json` — TextField (plaintext service-account key, per codebase convention)
- `last_upload_at`, `last_upload_status`, `last_upload_summary` — DateTimeField / TextField
</content>
