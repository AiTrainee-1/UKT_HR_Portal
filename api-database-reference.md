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
- **GET, PATCH, DELETE /api/employees/\<pk\>** — GET returns one employee record (an employee token may only fetch their own, same 404 either way to avoid id-probing); PATCH updates any field (re-resolves department/designation/branch, re-mints unit code on branch change, re-runs production-shift auto-assignment; `departmentId` / `designationId` are the HR forms' way, and a plain `department` / `designation` NAME is also accepted and matched, or created when it does not exist, in the employee's branch / department — a null or blank name is ignored; POST /api/employees accepts the same names); DELETE removes the employee. No decorator on the outer `employee_detail` function; internally GET dispatches via `require_auth`, PATCH and DELETE via `require_hr`.
- **GET /api/employees/production**, **POST /api/employees/production/assign** — Employees → Production Employees. GET lists the production employees (`cycle` = all | unassigned | weekly | biweekly | monthly, `status` = active (default) | inactive | all, `search`, `departmentId`, `branchId`) with `payCycle` and the latest period-based payslip, plus `counts` for the tabs (they ignore `cycle`). POST `{employeeIds, cycle}` puts production employees on a cycle (`cycle: null` takes them off it) and answers `{updated, unchanged, skipped, pendingOnOtherCycle, counts}`; a staff employee or an id outside the caller's branch is skipped with a reason. Branch-scoped, `employees` permission module (edit to assign). Payroll already generated keeps the cycle it was generated on.
- **GET /api/employees/\<pk\>/photo** — Streams a data-URI-stored employee photo as a real image response (with 1hr cache header) — the lazy-load counterpart to list responses substituting a photo link. Access: the owning employee token, or branch-scoped HR. `@require_auth`.
- **PATCH /api/employees/\<pk\>/status** — Updates an employee's `status` field (branch-scoped). `@require_hr`.
- **Co Emp and TDS**: Employee JSON carries `coEmpEnabled`, `tdsEnabled` and `tdsPercent`; PF / ESI apply only while `coEmpEnabled` is true, TDS only while `tdsEnabled` is true, and the two exclude each other. See *PF & ESI, TDS and Co Emp* below for the switch, the `/api/tds/employees` endpoints and the coverage numbers.
- **Salary split (`salaryBreakup`)** — Employee JSON carries `salaryBreakup` (`{basic, da, retainingAllowance, otherAllowance, petrolAllowance, hra, specialAllowance, ca}` as numbers, or `null`). `POST /api/employees` and `PATCH /api/employees/<id>` accept `salaryBreakup` (all eight keys, exact decimal text or numbers, ≥ 0, at most 2 decimals) and validate it against `salaryAmount`: Basic + DA + Retaining Allowance must be 50% of the salary, the other five the other 50%, and together they must equal it to the paisa (an odd paisa may sit in either portion) → 400 with the reason, nothing saved. Omitted on create → the automatic split (equal shares, each half shared equally); omitted on PATCH with a *new* `salaryAmount` → the stored split re-scaled to it (or the automatic one if none is stored); unchanged salary → left alone; clearing the salary clears the split, and sending a split with no salary is a 400. `POST /api/increments` moves the split with the new salary too.
- **POST /api/employees/bulk-upload** — Multipart Excel upload; validates the header row exactly matches one of the layouts in `employee_bulk_views.py`: the **Staff** sheet (`category=staff`: Salary Type, Salary Amount and the eight salary-split columns Basic, DA, Retaining Allowance, Other Allowance, Petrol Allowance, HRA, Special Allowance, CA — all blank = automatic split; any filled = blanks count as 0 and it must be a valid 50/50 split, else that row fails), the **Production** sheet (`category=production`: Salary Per Shift, no salary columns), or the older combined sheet with an Employment Type column (27 columns, or plus the split columns). A sheet of the other kind is refused as `invalid_template` with a message naming it; neither new sheet has an Employment Type column, the section decides it. Skips "SAMPLE" rows, creates one new `Employee` per valid row (loosened required-field rules vs. the single Add form). `mode=preview` processes the whole file inside a transaction that is rolled back (nothing, not even audit rows, is written) and returns the same report as `mode=apply` (the default, 201). The response keeps `created`, `failed`, `errors`, `warnings`, `sampleRowsSkipped` and adds `counts` (`created`, `duplicate`, `invalid`, `failed`, `skipped`, ...) and `rows`: one `{row, code, name, status, messages, warnings, changes, notes}` per sheet row, where status is `created`, `duplicate` (code already in the system, or repeated in the file), `invalid` (a value the form would refuse), `failed` (unexpected error) or `skipped` (sample row). **A Department or Designation the row names that does not exist yet is created** (`org_lookup.py`: matched ignoring case and stray spaces, "-"/"N/A"/"nil" mean none, a title over 100 characters is refused for that cell only): the department in the employee's branch, the designation in the employee's department (a designation belongs to a department; the Add/Edit form and a branch login see it through that). What was created is in the row's `notes` ("Created designation 'Tailor' in Stitching") and in the response's `newDepartments` (`[{name, rows}]`) and `newDesignations` (`[{title, department, rows}]`; for a check, what *would* be created). **Limits** (a file must never take the worker down): the sheet is read as a stream (formatting on a million empty rows costs nothing), at most 10 MB and 5,000 employee rows, and the request gives up after `BULK_UPLOAD_TIME_BUDGET` seconds (default 20, below gunicorn's 30 s kill) — any of these returns 413 `{error: "too_large", message}` with **nothing changed**. The whole file is one transaction (a check rolls it back), each row has its own savepoint so one bad row fails alone, the lookups and the next Unit Code / production shift are done once per request, and the audit entries are written in one query (≈ 3–4 queries per row, it was ≈ 15). `@require_hr`, `@parser_classes([MultiPartParser, FormParser])`.
- **POST /api/employees/bulk-update** — Companion multipart Excel upload for *existing* employees, matched by Employee Code; only overwrites cells that are both non-blank and actually different (a new Salary Amount re-scales the stored split; split cells identical to what is stored count as "not edited", so an export re-uploaded with only the amount changed works; changes show as "Salary Split"), reports not-found codes, unchanged rows, and a per-employee changed-fields summary. It accepts the Staff / Production sheets and their `*_export` variants (the same columns plus a trailing **Status** of Active / Inactive, which makes an employee Inactive or active again). With `category` (staff | production) and `employeeStatus` (active | inactive) the file is the list of THAT kind: a row for an employee of another kind or state is `invalid` ("upload it from that section"), the kind cannot be changed from the sheet, and the employees of that list who are **not in the file** come back as `missing` (`{id, code, name, department, designation, branch, joinDate, dataCounts: {attendance, payroll, leaves}, action, result}`) with `scope: {total, inFile}`. They are left alone unless the caller says otherwise: `missingAction` (keep | inactive | delete; `inactive` only for the active list) and per-code overrides `missingDecisions` (a JSON object), and any delete needs `confirmDelete=true` (else 400 — nothing is deleted without confirmation). Decisions are validated before anything is written; a file with no employee rows never lists everyone as missing. `mode=preview` writes nothing at all. The response adds `counts` (`updated`, `unchanged`, `duplicate`, `invalid`, `failed`, `skipped`, `notFound`, `madeInactive`, `deleted`, `kept`, `missing`) and `rows` (as for bulk-upload plus `unchanged`, `updated` with `changes`, `not_found`). Without `category` the older behaviour is unchanged. A Department / Designation named in a row that does not exist yet is created, exactly as for bulk-upload (`notes`, `newDepartments`, `newDesignations`; the old "Designation not found - kept the current one" warning is gone), and the same limits and 413 apply (the message adds "leave *employees not in the file* on Keep for each part" so splitting a file never removes anyone). Employees are fetched in one query without their photo and password hash, and a changed row writes only the fields the sheet changed (`update_fields`), so a password set a moment earlier can never be overwritten. `@require_hr`, `@parser_classes([MultiPartParser, FormParser])`.
- **PATCH /api/employees/location-tracking/bulk** — Turns `location_tracking_enabled` on/off for many employees at once (all active employees in scope, or a given `employeeIds` list). `@require_hr`.

## PF & ESI, TDS and Co Emp (pf_esi.py, pf_esi_views.py, tds_views.py, pf_esi_coverage_export.py)

PF and ESI apply **only to employees whose Co Emp switch is on** (`Employee.co_emp_enabled`), by rule lists the **Super Admin** keeps on Settings → PF & ESI; employees on the **TDS list** (`tds_enabled`, `tds_percent`) have tax deducted at source instead and never PF / ESI; everybody else has neither. Co Emp and TDS are mutually exclusive (the server swaps one for the other in one transaction). Bodies are JSON in camelCase, money is a JSON number with two decimals, and errors are `{ "error": "<message>" }` plus the status (a 403 / 409 adds `message` and a machine code in `error`). The model, the rules and the arithmetic are explained in `backend.md` Section 4.17.

A **rule** is `{ id, label, basis, minAmount, maxAmount, ratePercent }` and matches when `minAmount <= amount <= maxAmount` (both ends included, `maxAmount` 0 = no upper limit), where `amount` is the employee's FULL MONTHLY amount of the rule's `basis`: `basic` (Basic of the salary split, the default), `first_portion` (Basic + DA + Retaining Allowance) or `total` (the whole monthly salary; production: the monthly equivalent of the period's pay). Four independent lists: `staff.pfRules`, `staff.esiRules`, `production.pfRules`, `production.esiRules`; the first matching rule wins, no match means no deduction of that kind.

- **GET `/api/pf-esi-settings?branchId=`**: **any HR login** reads (not gated by a module). A Super Admin: no `branchId` = the global rules, `branchId=N` = that branch (its own set when it has one, else the global rules it follows). Any other login always gets its own scope (its branch's own set if any, else global); naming another branch is `403 { error: "permission_denied" }`, an unknown branch 404. Answers `{ scope: { branchId, branchName, isOverride }, canEdit, version, staff: { pfRules, esiRules }, production: { pfRules, esiRules }, branches: [{ id, name, hasOverride }] (Super Admin only, else `[]`), basisOptions: [{ value, label, description }], limits: { maxRulesPerList: 50, maxAmount, maxRatePercent: 100 } }`. `version` is a content hash of the four lists of that scope.
- **PUT `/api/pf-esi-settings`**: **Super Admin only** (checked live in the database; anybody else `403 { error: "permission_denied", message: "Only the Super Admin can change PF / ESI rules." }`). Body `{ branchId (null = global), expectedVersion (required), staff?: { pfRules?, esiRules? }, production?: { pfRules?, esiRules? } }`; a list that is sent REPLACES that list entirely, a list that is left out is kept, deleting a rule means leaving it out. A rule in the body is `{ id?, label?, basis?, minAmount, maxAmount, ratePercent }` (blank id = the server assigns one, blank label = "Rule N", no basis = `basic`; numbers or numeric text with at most 2 decimals, `0 <= minAmount`, `maxAmount` 0 or at least `minAmount`, `0 <= ratePercent <= 100`, amounts up to 99,999,999.99, at most 50 rules a list, ids unique in a list). Saving a branch for the first time creates its own set (all four lists become the branch's own). `200` = the GET shape of the saved scope; `409 { error: "stale_version", message, currentVersion }` when the rules changed since `expectedVersion`; `400 { error, list, ruleIndex, field, otherRuleIndex? }` for a bad rule (`list` is one of `staff.pfRules` ... `production.esiRules`, `ruleIndex` 0-based, `field` one of `label | basis | minAmount | maxAmount | ratePercent | id | list`; overlapping ranges of one list name both rules), a missing `expectedVersion` or an empty body; 404 unknown `branchId`. Audit: module `settings`, action `update`, old and new lists.
- **DELETE `/api/pf-esi-settings?branchId=`**: Super Admin only; `branchId` is required (the global rules cannot be deleted). Makes the branch follow the global rules again and answers the GET shape for it (`isOverride: false`). 400 without `branchId`, 404 unknown branch, 403 as above. Audited.
- **GET `/api/pf-esi/coverage?type=staff|production|all&branchId=&detail=0|1`**: module `employees` (view); active employees only; a branch login only ever sees its own branch. `{ asOf, filters: { type, branchId }, staff: {...}, production: {...}, employees?: [...] }` (a class that was not asked for is omitted; `employees` only with `detail=1`). Each class has `total`, `coEmp`, `tds`, `notCoEmp`, `withPf`, `withEsi`, `withBoth`, `withAny` (PF and/or ESI), `withNeither` (Co Emp but no rule matched) and `notEvaluated` (production: Co Emp with no generated payroll yet), with `total = coEmp + tds + notCoEmp` and `coEmp = withAny + withNeither + notEvaluated`. A detail row is `{ id, employeeCode, name, employmentType, departmentName, branchId, branchName, category: co_emp | tds | none, pf, esi (true | false | null), pfRatePercent, esiRatePercent, status: pf_esi | pf_only | esi_only | neither | not_evaluated | tds | not_co_emp, tdsPercent }`. Staff are judged on their current salary split, production on the monthly equivalent of their latest generated period. 400 for a bad `type` or a non-numeric `branchId`.
- **GET `/api/pf-esi/coverage/export?format=xlsx|pdf&type=staff|production|all&branchId=`**: the same data as a file (same permission and scope as the counts). Excel: one worksheet per class (`Staff PF-ESI coverage`, `Production PF-ESI coverage`) holding a summary block (the counts above, numeric cells) and one row per employee (code, name, class, department, branch, category, PF and PF %, ESI and ESI %, status, TDS %); PDF: a printable A4 landscape document with the same two sections, repeated table header and "Page X of Y". Response `Content-Type` is `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` or `application/pdf`, `Content-Disposition: attachment; filename="pf_esi_coverage_<type>_<YYYY-MM-DD>.<xlsx|pdf>"`, `Cache-Control: no-store`. Errors are the JSON shape: 400 (`format must be xlsx or pdf`, bad `type` / `branchId`), 413 when a file would have more employees than Excel (30,000) or PDF (5,000) holds (choose a type or branch), 401 / 403 as everywhere. Each file is audit-logged (action `export`, module `employees`). The query parameter is `format` (the Report Center uses `fmt`): this view switches DRF's `?format=` renderer negotiation off, which would otherwise answer 404.
- **GET `/api/tds/employees?type=staff|production|all&search=&status=active|all&branchId=`**: module `employees` (view), branch-scoped. `{ employees: [{ id, employeeCode, name, departmentName, designationTitle, branchId, branchName, employmentType, status, tdsPercent }], counts: { all, staff, production } }` (`counts` ignore `type`, `search` and `status`, so tab badges stay stable). Anything else for `type` / `status` is a 400.
- **POST `/api/tds/employees`**: module `employees` (edit). `{ employeeCode, percent }` (`0 < percent <= 100`, at most 2 decimals, number or numeric text). `201 { employee: <row above>, movedFromPfEsi }` where `movedFromPfEsi` is true when the employee was Co Emp (taken out of Co Emp and put in TDS in one transaction). 404 `{ error, code: "employee_not_found" }` (also for a code of another branch), 400 `employee_inactive` (code) or a bad percentage or a missing code, 409 `{ error: "UK001 is already in TDS (10%). Edit the percentage instead.", code: "already_in_tds" }`. Audited (`create`, `employees`).
- **PATCH `/api/tds/employees/<id>`** `{ percent }` → `200 { employee }`; 404 `not_in_tds` / unknown or out of scope, 400 bad percentage. **DELETE `/api/tds/employees/<id>`** → `200 { employee, removed: true }`; the employee ends up in no category (Co Emp stays off). Both audited.
- **The Co Emp switch** is `PATCH /api/employees/<id> { coEmpEnabled: true | false }` (the existing endpoint, module `employees`): anything but a JSON boolean is `400 "coEmpEnabled must be true or false"`, and turning it **on** for a TDS employee clears `tdsEnabled` / `tdsPercent` in the same transaction. `tdsEnabled` / `tdsPercent` in a PATCH body are ignored: TDS membership only changes through `/api/tds/employees`. The employee JSON carries `coEmpEnabled`, `tdsEnabled` and `tdsPercent` (null unless `tdsEnabled`).
- **Retired settings.** `GET /api/payroll-settings` no longer returns and `PUT` ignores `pfRate`, `esiRate`, `esiApplicableBelow`, `prodPfRate`, `prodEsiRate`, `prodEsiApplicableBelow`, `prodPfEfEnabled`, `prodPfEfRules`, `staffPayrollRulesEnabled` and `prodPayrollRulesEnabled` (the database columns stay, unused; migration 0127 converted what was enabled into rules).
- **Where the rules show up.** Salary slips and payroll rows carry `tdsDeduction` / `tdsPercent`; the payroll insights `rules` lists the real rule lists of the scope (group "Statutory (PF / ESI)", items `pf_rules`, `esi_rules`, `pf_esi_scope`, `tds`, each linked to `/hr/settings?tab=pf_esi#<anchor>`), and their `details` deductions include `pf`, `esi` and `tds` lines (`TDS (10%)`, only for a TDS payroll) that add up to the total. The Report Center has **PF / ESI Coverage** (`pf-esi-coverage`) and **TDS Statement** (`tds-statement`) next to the PF and ESI statements.

## Org Structure (Branches & Designations)

- **GET, POST /api/branches** — `@require_hr`. GET lists active `Branch` rows. POST creates a branch (name, code, location, address, manager name, phone, head-office flag — setting `isHeadOffice=true` unsets it on every other branch, geofence lat/lng/radius).
- **GET, PUT, DELETE /api/branches/\<pk\>** — `@require_hr`. GET/PUT read or update any of the branch fields above; DELETE is a soft-delete (`is_active = False`), not a row removal.
- **GET, POST /api/designations** — `@require_hr`. GET lists designations (scoped to branch via their department, annotated with active employee counts), optionally filtered by `departmentId`. POST creates a designation (title, department, level); a branch-scoped caller must supply a `departmentId` that belongs to their own branch (400/404 otherwise) — an unscoped admin may create one with no department.
- **GET, PUT, DELETE /api/designations/\<pk\>** — `@require_hr`. Branch-scoped via department; GET returns detail plus active employee count, PUT updates title/department/level, DELETE removes the row. A designation outside the caller's branch scope 404s identically to a genuinely missing one, to avoid confirming its existence.

## Shift Management

- **GET, POST /api/shifts** — `@require_hr`. GET lists branch-scoped `ShiftTemplate` rows (filterable by `shiftType`/`departmentId`), each with `assignedCount` (active employees on it now) and `branchId`; POST creates a new shift template (name, type, start/end time, gender rule, grace period, first-half-end/lunch settings for staff, department, default flag), stamped with the creator's branch scope. POST and PUT run `validate_template` (shift_views.py) and answer `400 {error, fieldErrors}`: the name is required, at most 80 characters and unique per branch and type (case-insensitive); type is staff or production; start and end are valid times with **end after start by at least 60 minutes (overnight shifts are refused)**; gender is all/male/female and production is always all; grace 0–60; for staff the first-half end lies strictly inside the shift, lunch 15–120 and lunch grace 0–30 (a production shift stores no first-half end).
- **GET, PUT, DELETE /api/shifts/\<pk\>** — `@require_hr`. Reads, updates (validated as the whole shift it becomes, plus: the type cannot change once any assignment exists, a Male/Female-only rule cannot be set while assigned employees of the other gender are on it, and a shift with active employees cannot be deactivated) or deletes a branch-scoped shift template. DELETE is refused with `409 {code: "shift_in_use", activeAssignments, totalAssignments}` while ANY assignment (current or past) references the shift, because deleting it cascades away the assignments attendance and payroll resolve past days from; deactivate it instead.
- **GET, POST /api/shift-assignments** — `@require_auth`, with an inline extra check on POST (`is_hr(request)`, else 403 — so only HR can create assignments even though the route accepts any authenticated caller). GET lists branch-scoped active-employee shift assignments (an employee token forces the results to their own id; otherwise filterable by `employeeId`/`shiftId`/`activeOnly`/`employmentType`). POST creates a new `EmployeeShiftAssignment` (employee, shift, effective dates, optional per-employee custom start/end time override, Saturday-off flag).
- **POST /api/shift-assignments/plan** and **POST /api/shift-assignments/apply** — `@require_hr`. The Manage Shifts assignment flow (rules in `shift_planner.py`). Body: `shiftId`, `effectiveFrom`, `selection: {includeAll, employees|departments|designations: {include: [ids], exclude: [ids]}}`, optional `customStartTime`/`customEndTime`/`saturdayOff`/`notes`, `onConflict` (`keep` default | `reassign`) and per-employee `decisions: {"<employeeId>": "keep"|"reassign"}`. An active employee (in the caller's branch) is selected when they match ANY include rule (or `includeAll`: everyone of the shift's type); any exclude rule then removes them. Each selected employee is `new` (nothing covers them on the date), `unchanged` (same shift and schedule), `conflict` (another shift, the same shift with another schedule, or a shift scheduled to start later; resolved by `decisions`/`onConflict`), `skipped` (shift type differs from employment type, gender rule, shift of another branch), `blocked` (a shift of theirs already started AFTER the chosen date, so backdating would rewrite history) or `excluded`. `plan` returns `{ok, errors, warnings, shift, effectiveFrom, counts, rows}` and writes nothing; request-level problems (no shift/date/selection, inactive shift, overnight custom hours, Saturday off on a production shift, a date more than a year ahead) are in `errors`, a past date is a warning. `apply` plans again inside a transaction with row locks and writes only that fresh plan (400 with the plan and nothing written when it has errors; 201 when something was assigned, else 200) and adds `applied` counts and a per-row `outcome`. Writing: the assignment in effect is closed the **day before** the date and a new open one starts on it (no overlap, which the Report Center flags); one that already started on the date is changed in place; shifts scheduled for later are cancelled by closing them before they start; `assigned_by` is the signed-in HR user's name. Applying the same request twice changes nothing the second time.
- **POST /api/shift-assignments/end** — `@require_hr`. Takes employees off their shift: `assignmentIds` and `lastDay` (default today). Each assignment is closed with `effective_to = lastDay`, so earlier days keep the shift; one that has not started yet is deleted; a `lastDay` before the start of a shift that has already begun is a 400 and nothing is changed.
- **POST /api/shift-assignments/bulk** — `@require_hr`. Assigns one shift to many employees at once, selected by explicit `employeeIds`, or by `departmentId`/`designationId` + `employmentType`, further filtered by gender rule (caller override or falling back to the shift template's own `gender_rule`); ends each matched employee's currently-open assignment and creates a new one.
- **POST /api/shift-assignments/sync-production** — `@require_hr`. Auto-assigns the branch's default production shift template (effective today) to every active production employee who doesn't already have an open shift assignment; returns synced/skipped counts.
- **PUT, DELETE /api/shift-assignments/\<pk\>** — `@require_hr`. Updates a branch-scoped shift assignment's shift/effective dates/notes/custom times/Saturday-off flag (invalid times or dates are a 400 with `fieldErrors`, never a 500; a new shift must exist, be active and suit the employee's type, gender and branch; custom hours cannot be overnight; the last day cannot precede the start), or deletes it.

## Department Manager Actions — HR CRUD (User Management)

- **GET, POST /api/department-managers** — `@require_hr`. GET lists branch-scoped `DepartmentManager` (HOD) records with their department/employee assignment counts (`departmentCount`, `employeeCount` = employees who really report to the HOD, `overlapCount` = listed but reporting to another HOD, `removedCount` = people carved out of the HOD's departments, see `excluded-employees`). POST promotes an employee (by `employeeCode` or `employeeId`, branch-scoped, must not already be a manager) into a manager row with per-capability approval flags (leaves, permissions, resignations, attendance, casual leave, on-duty, missing-punch) defaulting to true.
- **GET, PUT, DELETE /api/department-managers/\<pk\>** — `@require_hr`. GET returns full detail including assigned departments/employees; PUT updates any of the `canApprove*`/`isActive`/`notes` flags; DELETE removes the manager row.
- **POST, DELETE /api/department-managers/\<pk\>/departments** — `@require_hr`. Assigns (`departmentId`, must not already be assigned) or unassigns a department from a manager's oversight. Assigning clears any carve-outs the manager had in that department; unassigning clears them too (both in one transaction).
- **GET /api/department-managers/\<pk\>/department-employees** — `@require_hr`. Every employee of every department assigned to the manager, grouped by department (`{managerId, departments: [{id, name, counts: {reporting, removed, elsewhere, self}, employees: [{employeeId, employeeCode, name, designation, status, state, individual, manager, via}]}]}`). `state` is `reporting` (really reports to this HOD), `removed` (carved out), `elsewhere` (in the department but reports to a different active HOD; `manager` and `via` say who and how) or `self` (the HOD). A removed person's `manager` is the HOD who picked them up, or null (HR decides). The HOD page lists this the moment a department is added, so new joiners appear on their own.
- **POST, DELETE /api/department-managers/\<pk\>/excluded-employees** — `@require_hr`. POST takes `employeeId` or `employeeIds` and **removes those employees from the HOD's department coverage** (a `ManagerEmployeeExclusion` row each; they stay in the department; their requests go to the next active holder of the department, or to HR). Every id must exist in the caller's branch scope and sit in a department assigned to the manager, and none may be the HOD themselves, otherwise nothing is changed (400/404). An individual assignment of the same person to this HOD is deleted in the same transaction (`alsoUnassigned`). Idempotent (200 when nothing new was made, 201 otherwise). DELETE restores them (404 when none was removed) and returns `reportingElsewhere`: the ids another HOD now holds. Assigning someone individually (`…/employees` POST) also deletes a carve-out for that pair.
- **POST, DELETE /api/department-managers/\<pk\>/employees** — `@require_hr`. Assigns (`employeeId`/`employeeCode`, must not already be assigned) or unassigns an individual employee directly under a manager's oversight (independent of department-level assignment).

## Department Manager Actions — Mobile Self-Service & Approvals

- **GET /api/manager/me** — `@require_auth`. Returns the calling employee's own manager profile if they are an active `DepartmentManager` (else `{isManager: false, ...}`); when a manager, includes their capability flags, the approval pipelines in force (`approvalWorkflows`, same shape as `GET /api/approval-summary`) plus pending counts broken out per request type (`pendingLeavesCount`, `pendingPermissionsCount`, `pendingResignationsCount`, `pendingAttendanceCount`, `pendingCasualLeaveCount`, `pendingOnDutyCount`, `pendingMissingPunchCount`, `pendingCompensationCount`) across their department + direct-assignment scope. The counts include only what this manager can decide **now** under each pipeline, and never the head's own requests. `pendingApprovalsCount` is the badge number: the sum of EVERY kind the manager can decide now, the gate outpass requests included (their own count is the additive key `pendingOutpassCount`), so it always equals `totalPending` of `GET /api/manager/pending-requests`.
- **GET /api/manager/pending-requests** — `@require_auth`. Requires the caller to be an active `DepartmentManager` (else 403). Returns every leave/permission/resignation/attendance-override/casual-leave/on-duty/missing-punch request in that manager's scope, filtered by `status` (default "pending", or "all"), each request type additionally gated by whether that specific `canApprove*` flag is enabled for the manager; also returns a combined `totalPending` count (every kind, `holidayWorkClaims` and `outpassRequests` included; it is the same number as `pendingApprovalsCount` of `/api/manager/me`) and `approvalWorkflows`. With `status=pending` a request appears only while the Department Head can decide it under its pipeline (one already waiting for HR, or not yet at the HOD's step, is left out).
- **PATCH /api/manager/leave-requests/\<pk\>/status** — `@require_auth`. Requires active manager status and `can_approve_leaves`; the leave request must be within the manager's scope, and the pipeline must give the Department Head a turn right now (else 400/403 `{error, code: "not_your_turn" | "role_not_in_pipeline"}`). Records the decision in `approval_trail`; when it completes the pipeline it sets status to approved (deducting the leave balance, whichever role gave the final approval), stamps `approved_by`/`approver_role="dept_head"`, and notifies the employee. A rejection is always terminal.
- **PATCH /api/manager/permissions/\<pk\>/status** — `@require_auth`. Same pattern as above, gated by `can_approve_permissions`, for `EmployeePermission` requests.
- **PATCH /api/manager/attendance-requests/\<pk\>/status** — `@require_auth`. Gated by `can_approve_attendance`; the request must still be `pending`. On approval, writes the requested values onto the employee's `AttendanceDayRecord` for that date (creating it via `compute_day_record` first if it doesn't exist yet) — this record feeds payroll; rejection leaves attendance data untouched. Notifies the employee either way.
- **PATCH /api/manager/casual-leaves/\<pk\>/status** — `@require_auth`. Gated by `can_approve_casual_leave`; delegates to the shared `apply_cl_decision` (same function the HR CL endpoint uses), which also writes the resulting `AttendanceDayRecord` and notifies the employee.
- **PATCH /api/manager/on-duty-sessions/\<pk\>/status** — `@require_auth`. Gated by `can_approve_on_duty`; the session must be pending and the pipeline must give the Department Head a turn (built-in: an optional first step before HR). Approval either finishes the pipeline (the session goes active) or passes it on (status re-projected, e.g. `pending_hr`); rejection is terminal.
- **PATCH /api/manager/missing-punch-requests/\<pk\>/status** — `@require_auth`. Gated by `can_approve_missing_punch`; the request must be pending and the pipeline must give the Department Head a turn (built-in: HOD first, then HR). Approval either finishes the pipeline (the punch is written) or passes it on (`pending_hr`); rejection is terminal (HR never sees a dept-head-rejected request).

## Approval Workflow Control (approval_workflow.py, approval_workflow_views.py)

One engine decides who may approve every kind of request; HR configures it in **User Management → Approval Workflow Control**. Eleven workflows: `leave`, `permission`, `casual_leave`, `missing_punch`, `on_duty`, `on_duty_punch`, `attendance_correction`, `outpass`, `request`, `resignation`, `advance`. A pipeline is 1–2 ordered steps; each step's responsible role is `hod`, `hr` or both (`HOD or HR`, whoever acts first, only as the single step); a step is mandatory or optional (an optional step is skipped when the next step's role decides first; the last step is always mandatory); a role sits in at most one step. Built-in pipelines reproduce the behaviour from before the feature (leave/permission/casual leave/outpass: HOD or HR; missing punch and resignation: HOD then HR, HR may always reject a resignation; on-duty: optional HOD then HR; `on_duty_punch`, `request`, `advance` HR only; `attendance_correction` HOD only). Only the seven staged workflows are editable; every workflow except `on_duty_punch` can be switched OFF.

- **GET /api/approval-workflows** — `@require_hr` (permission `user_management.approval_workflow`). Every workflow with its `purpose`, `requestedBy`, current `steps` and `defaultSteps`, `path` (`Employee → HOD → HR`), `enabled`, `customised`, `editable`, `canDisable`, `allowedRoles`, `fixedNote`, `note`, `onOffEffect`, `hodSwitch` (the per-person switch a Department Head also needs), `warnings` (what HR may want to change) and `hints` (worth knowing), `waiting` (`{total, hod, hr}` requests waiting now and how many each role could decide), and who last changed it.
- **PUT /api/approval-workflows/\<key\>** — `@require_hr` (same permission). Body `{enabled?: bool, steps?: [{roles, mandatory}]}`; validates the steps (400 with a message: at least one, at most two, allowed roles only, a role once, `HOD or HR` only alone, non-editable workflows keep their pipeline), stores the row (deleted again when it equals the built-in pipeline, so `customised` goes false), re-projects the legacy `status` label of requests already waiting (nothing is approved or rejected), and writes an audit log entry (`approval_workflow`). 404 for an unknown key.
- **DELETE /api/approval-workflows/\<key\>** — `@require_hr`. Back to the built-in pipeline and ON.
- **GET /api/approval-summary** — `@require_auth` (any signed-in user, employee tokens included; deliberately outside the permission tree). `{<key>: {label, enabled, requestedBy, steps, path}}`: what the apps use to explain a request's path in words.

**Contract for every client.** Each request of these kinds carries an `approval` block: `{workflow, label, enabled, steps: [{roles, mandatory, label, index, state: approved|skipped|pending|waiting|rejected, by, at, comment, decidedBy}], currentStep, waitingFor, canAct: {hod, hr}, canReject: {hod, hr}}` (`canReject` differs from `canAct` only where a rejection is allowed out of turn: a resignation's HR). Progress lives in the row's `approval_trail` (a list of `{role, decision, by, at, comment, skipped?}`); the request's position is recomputed from it against the pipeline in force, so a pending request follows a changed pipeline from where it is. The legacy `status` strings are unchanged (`pending`, `pending_hod`, `pending_hr`, `dept_approved`, `approved`, `rejected`) but only mean "waiting for X now". While a workflow is OFF, creating a request returns **403** `{error: "<Label> requests are switched off right now. Please contact HR.", code: "workflow_disabled"}`; requests already waiting can still be decided. A decision the pipeline does not allow returns 400/403 `{error, code: "not_your_turn" | "role_not_in_pipeline" | "approval_not_allowed"}`.

## Attendance — Legacy (views.py)

- **GET, POST /api/attendance** — GET lists raw legacy `Attendance` rows (filterable by employeeId/year); POST does an `update_or_create` of one day's attendance record (present flag, hours worked, notes) for an employee/date. No decorator on the outer `attendance` function; GET dispatches via `require_auth`, POST via `require_hr`.

## Attendance — Summaries & Dashboards

- **GET /api/attendance/summary** — `@require_hr`. Returns today's company attendance snapshot for a given `date` (default today), optionally filtered by `employmentType` and branch: total/production/staff headcounts, present counts split by biometric vs manual source, not-punched counts, plus a "yesterday" block (present/absent/late/on-leave) computed from the same raw-punch helpers.
- **GET /api/attendance/company-summary** — `@require_hr`. Company-wide "Today's Overview" for the Attendance Search page; unlike `attendance/summary` (which uses cheap raw-punch counting) this bulk-loads punches/assignments/night-shift/permission data for every active employee and runs each through the real `compute_day_record` engine so Present/Half-Shift/Absent/On-Leave/Late and total shifts-earned match exactly what the per-employee search shows.
- **GET /api/dashboard/mobile-home-summary** — `@require_auth`. Mobile Home screen's "today at a glance" card, scoped to the requesting employee's own branch (derived from their own row); returns presentToday/absentToday/lateToday/permissionToday using the same counting helpers as the HR `attendance/summary` endpoint.
- **GET /api/attendance/live-feed** — `@require_auth`. Returns today's punch ticker, self-scoped to the requesting employee only (via token employee id) — each item's IN/OUT label is derived from time-sorted position within that employee's punches for the day, not the raw stored punch type, since biometric devices often record every punch as IN. Capped at 1–50 items via `limit`.
- **GET /api/attendance/monthly-trend** — `@require_hr`. Returns one row per elapsed day of the given `year`/`month` (optionally filtered by `employmentType` and branch) with present/absent counts, taking `max(biometric daily count, manual daily count)` as that day's present figure.

## Attendance — Arrival timeline (arrival_rules.py, attendance_final.py)

- **Where the first punch falls** (staff): measured from each shift's own start + grace, `arrival_rules.limits_for` gives four limits: on time (start + grace), Late (`arrival_late_window_minutes`, 60), permission window (`arrival_permission_window_minutes`, 60), first half (`arrival_extra_minutes`, 20 more). `zone_of` puts the first punch in one of `on_time` | `late` | `excused` | `quarter` | `second_half`, judged in whole minutes with every limit inclusive. An approved, in-cap Morning Late-In permission turns `late` and the permission window into `excused`; the extra minutes are never covered.
- **What each zone does to the day** (`compute_day_record`, identical in Simple and Strict): `on_time` nothing; `late` a Full Day with `is_late`; `excused` a Full Day, not late; `quarter` a Full Day earns `1 - arrival_quarter_deduction` (0.75) and is NOT also late (a day already cut to a Half Day is not docked twice); `second_half` the first half is missed, so Absent until a punch at/after `half_day_second_half_start_time`, then Half Day. Compensation Days and approved half-day leave are never docked. An employee with no shift has no timeline and keeps the retired fixed `half_day_first_half_end_time`.
- **Stored and returned:** `AttendanceDayRecord.arrival_zone` (blank for manual / older rows), and `arrivalZone` next to `lateReason` in every day payload (calendar, employee history, daily report, payroll breakdown `days`). `half_period(rec, settings)` says which half a Half Shift was worked ("morning" | "evening"). `lateReason` carries the plain-language sentence.
- **Permission Deduction Slabs** (`GET/PUT /api/payroll-settings`, group `settings.late_detection`, staff only, company-wide: a branch login gets 403 `company_wide_rule`): keys `permissionPricingEnabled` (a real boolean; default `false`), `permissionFreeAllowance` (whole number 0-999; default 0) and `permissionDeductionSlabs` (`[{fromPermissions: whole 1-999, deductionShifts: 0-31, at most 2 decimals}]`, at most 50 rows; stored ascending, duplicates removed with the later row winning; default `[]`). Anything else is a 400, never a 500 (plain numbers only: no `1_0`, `1e1`, `nan`, Unicode digits or digit strings beyond Python's int limit); switching ON with an empty table is a 400 `Add at least one permission slab before turning this on.`; the three keys are returned to every login. The employee-shift-stats `summary` gains `permissionPricingEnabled`, `permissionFreeAllowance`, `permissionPricedCount`, `permissionBillableCount`, `lateShiftDeductions`, `permissionShiftDeductions`, `permissionDeductionAmount` and its `policy` gains `permissionPricingEnabled`, `permissionFreeAllowance`, `permissionDeductionSlabs` (all additive; `summary.shiftDeductions` / `salaryDeductionAmount` stay the TOTAL late + permission deduction the installed apps read).
- **Settings** (`GET/PUT /api/payroll-settings`, group `settings.attendance`, company-wide: a branch login gets 403 `company_wide_rule`): `arrivalLateWindowMinutes`, `arrivalPermissionWindowMinutes`, `arrivalExtraMinutes` (whole minutes 0-240) and `arrivalQuarterDeduction` (0-1, at most 2 decimals), else 400. `halfDayFirstHalfEndTime` is retired (still returned and still accepted; ordering against `halfDaySecondHalfStartTime` is only checked when a client sends it). The employee-shift-stats `policy` block gains `lateWindowMinutes`, `permissionWindowMinutes`, `arrivalExtraMinutes`, `arrivalQuarterDeduction`; each payroll breakdown records the `arrivalTimeline` it was generated with. All additive, so the installed apps keep working.
- **WhatsApp** `late_alert` is sent only for `zone == late`, the same verdict as the record.

## Attendance — Daily & Employee History

- **GET /api/attendance/daily** — `@require_hr`. Bulk-fetches the day's punch logs, manual attendance rows, and approved-leave employee ids in 3 queries, then returns one row per active employee (optionally filtered by `employmentType`, branch-scoped) with status (present/manual/on_leave/absent), first/last punch, punch source and source label.
- **Production rows of `GET /api/attendance/daily`** (additive, October 2026): once the production shift rules judge the date, a production employee's row also carries `shiftsEarned`, `isLate`, `isEarlyOut`, `ruleGroup`, `ruleNote` and `lastPunchNextDay`; see "Production shift rules" below.
- **GET /api/attendance/employee/{pk}** — `@require_auth`, with an inline self-scope check: an employee token may only view its own id (`token_emp_id != pk` → 403). Returns one employee's full month (day-by-day) via `compute_month_records`/`month_summary_from_records` — the same day engine used by payroll and the HR portal — including status, isLate, isHalfShift, punches, leave type, hours worked, and a month summary block.
- **GET /api/attendance/employee-shift-stats** — `@require_auth`; if the caller has no employee token it additionally requires `is_hr(request)` (403 otherwise) and reads `employee_id` from the query string, whereas an employee token always gets its own stats regardless of any passed id. Returns a detailed monthly shift/attendance stats payload (present/absent/leave/half-shift/full-shift day counts, late-morning vs late-return splits, per-day punch logs, and a live permission/late-deduction preview mirroring the payroll formula) for one employee, used by both the mobile "My Shift" page and HR's Manage Shift panel.

## Attendance — Manual Entry, Biometric Device Webhook & Sync

- **POST /api/biometric/punch** — **No auth decorator** (`@api_view(["POST"])` only, no `@require_auth`/`@require_hr`). This is the AiFace-Mars device push webhook: authenticated instead by comparing the `X-Device-Key` header (or `apiKey` body field) against `settings.BIOMETRIC_API_KEY` inside the function body — not JWT/user auth at all. Resolves the employee strictly by `employee_code` (never falls back to internal db id, to avoid code/id collisions), creates an `AttendanceLog` row, and upserts the day's `Attendance` summary row to `present=True`.
- **POST /api/attendance/manual** — `@require_hr`. HR manually records attendance for one employee (e.g. after CCTV verification): branch-scoped employee lookup, optionally creates an `AttendanceLog` entry (source="manual") if a punch time is given, and upserts an `Attendance` row with present/hours-worked/notes.
- **GET /api/attendance/sync-status** — `@require_auth`. Employee-facing: tells the app whether today's attendance might still be incomplete because biometric hasn't synced — `pendingSync=true` only when the employee has a non-biometric punch today, no biometric punch yet, and no active device has synced since IST midnight.
- **POST /api/attendance/sync-biometric** — `@require_hr`. Kicks off a biometric device pull (`mode`: day/week/month/all; `deviceId`: specific/env/all) on a background daemon thread (so a slow multi-minute sync can't hold the request open past Gunicorn's timeout) and returns immediately with `started: true`, or `started: false` (202) if a sync is already running (guarded by `sync_progress.try_claim()`).
- **GET /api/attendance/sync-biometric-progress** — `@require_hr`. Polls the live Start → Device → Completed sync pipeline snapshot for the UI to display progress of the background sync started above.

## Attendance — Search, Reports & Shift Recomputation

- **GET /api/attendance/report-log** — `@require_hr`. Three modes off the same query: with `date=YYYY-MM-DD` given, returns one row per active staff employee for that day (the Report Log's **Daily Leave Report** and **Daily Late Report**; optional `department`/`search`): status, `isLate`/`isEarlyOut`, `isInformed`, plus `firstPunch` (the engine's first punch as local `HH:MM`, null with no punch) and the unit block fields `branchId`, `branchName`, `unitLabel` (`HO` for the head office, `U-1` for a branch coded `Unit1`, else the branch code; all null with no branch) — production workers are never listed, a branch-scoped login sees only its branch; with `employeeId` given, returns one employee's full day-by-day month (every punch slot, status, late/half-shift flags, Casual Leave/Permission/Leave for each day) built from `compute_month_records`/`DailyShiftLog`; without either, returns one aggregate summary row per active staff employee for the month (optionally filtered by `department`/`search`), each including CL and Permission counts. View-only except for `compute_month_records`'s own side-effect of persisting `AttendanceDayRecord` rows, same as elsewhere.
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

- **GET/POST /iclock/cdata and /iclock/cdata.aspx → `adms_cdata`** — No auth (device-identified by `SN` only). Single dispatch point for every ADMS request type: a GET is the device handshake/registration (responds with a config block enabling `TransFlag`/`Realtime=1` so the device starts pushing live attendance); a POST with `table=ATTLOG` is the actual attendance push (`_handle_attlog`) — parses tab-separated `UserID\tTimestamp\tStatus` lines, matches each to an `Employee` by `employee_code`, and creates `AttendanceLog`/`Attendance` rows (unmatched codes are recorded via `record_unmatched_punch` so they surface on the HR "Skipped" view instead of vanishing silently); a POST with `table=options` is parsed into the device's own reported settings (`BiometricDevice.reported_config`); any other POST table (OPERLOG, etc.) is logged and acknowledged with a bare "OK" without being parsed. Every request is also recorded as a device heartbeat via `record_device_push`.
- **GET /iclock/getrequest and /iclock/getrequest.aspx → `adms_getrequest`** — No auth. The device polling for server-issued commands; this app never issues any, so it always replies with a bare "OK" (required to exist at all — a 404 here makes the device treat the server as unreachable and stop pushing attendance). Each call is also recorded as the device's heartbeat (`last_heartbeat_at`, remote IP), which is what the Biometric Device Status page judges "connected" by; a serial no configured device has is kept in `biometric_unknown_pushers`.
- **POST /iclock/devicecmd and /iclock/devicecmd.aspx → `adms_devicecmd`** — No auth. The device reporting the result of a command; logged and acknowledged with "OK" (nothing in this app currently issues commands to acknowledge).

## Biometric Device Status (device_status_views.py)

Back the Biometric Connectors -> Biometric Device Status page. All three sit under `/api/attendance/`, so the Attendance module permission applies (GET needs View, POST needs Edit). Reading never contacts a device.

- **GET /api/attendance/biometric-status** — `@require_hr`. The whole picture in one payload: `server` (deployment `railway`/`local`, the address devices must be set to, the firewall/port checklist), `summary` (configured, enabled, connected, disconnected, error, unreachable, neverConnected, punchesToday), `thresholds` (heartbeat freshness, slow latency), `devices[]` (per device: name, IP, port, serial, `status` connected/disconnected/error/disabled, `reach` reachable/unreachable/refused/auth/error/unchecked, last heartbeat / data / successful sync, remote IP, errors, latest check with its steps, push delay, a nine-layer `diagnosis` with a headline, the device's reported settings and read-out) and `unknownPushers[]`.
- **POST /api/attendance/biometric-status/check** — `@require_hr`. Body `{"deviceIds": [..]}` (omit for every device). Runs the connection check (ping, TCP port, ZK handshake, a read of a few device settings, then disconnect; the terminal is never disabled and nothing is changed on it), saves one `BiometricProbe` per device, writes an audit-log entry and returns `{ranDeviceIds, status}` where `status` is the same payload as the GET. 400 for a malformed `deviceIds`, 404 for an unknown id, 409 while another check is running.
- **GET /api/attendance/biometric-status/\<pk\>/history** — `@require_hr`. The latest 30 connection checks of one device, newest first (404 for an unknown device).

## Device Control (device_control_views.py)

Back Biometric Connectors -> Device Control. All sit under `/api/attendance/device-control/`, so the Attendance module permission applies (GET needs View, POST needs Edit); making an employee Inactive also needs Edit on Employees. They open a direct session with each device, so they work only where this server can reach it. Reading the people list never contacts a device.

- **GET .../overview** — `@require_hr`. `summary` (configured, enabled, connected, disconnected, disabled, sendingToServer, peopleOnDevices, linked, deviceOnly, hrmsOnly, inactiveOnDevice), `server.deployment`, and `devices[]`: per device its `connection` (state connected/disconnected/disabled, code, the exact reason, latency), `push` (what the device sends the server by itself), `capacity` (users, faces, punches and their limits, serial, model, firmware, pin width), clock skew and when its users were last read. Opens a short session with every enabled device (parallel, 3 s limit; the answer is reused for 15 s; `?fresh=1` asks again).
- **POST .../users/refresh** — `{"deviceIds": [..]}` (omit for every enabled device). Reads each device's user table into the snapshot. One entry per device (`ok`, `count`, or `code` and `error`).
- **GET .../people** — the people on the devices plus every active employee, with `facets` (counts for the filter cards) and paging. Query: `search`, `devices` (ids), `deviceMode` any/all/none, `link` linked/device_only/hrms_only/inactive_on_device/restricted, `count` single/multiple, `role` admin/user, `employmentType`, `departmentId`, `branchId`, `differs`, `sort` name/code/devices/department, `dir`, `page`, `pageSize` (max 200). Each row: the user ID, the HRMS employee (or null), where the person is (`presence[]`: device, uid, name, role, card, has-password), what differs between devices.
- **POST .../users/push** — `{"deviceIds": [..], "users": [{userId, name?, privilege?, password?, card?, group?, employeeId?}]}`. Adds users the device does not have (users it has are left alone). Returns `rejected[]` (bad input, per user), `results[]` (per device: added, skipped, failed, or why the device could not be used) and `summary`. At most 200 users and 12 devices.
- **POST .../users/update** — same body; changes users the device has and leaves the rest. A field left out is left alone on every device.
- **POST .../users/delete** — `{"userIds": [..], "deviceIds": [..]?, "markInactive": bool}`. Deletes from the named devices (or every device the snapshot says they are on), reads each device back, and when `markInactive` makes the employee Inactive (never deletes them): only if a device really removed them, only with Edit on Employees, and only within the caller's branch. Returns `results[]`, `inactive[]` (what happened to each employee, with the reason when nothing did) and `summary`.
- **POST .../employees/\<id\>/photo** — `{"photo": "data:image/jpeg;base64,..."}`. Keeps a captured photo as the employee's `photo_url` (JPEG/PNG/WebP, 700 KB). Needs Edit on Employees.
- **POST .../fetch/start** — `{"deviceIds": [..], "range": {"preset": today|yesterday|last7|this_month|last_month|all|custom, "from"?, "to"?}, "apply": bool}`. Starts a run on a background thread and returns it (202). `apply` false is a preview (changes nothing). 409 while another run, or the Attendance page's sync, is running.
- **GET .../fetch/runs** and **GET .../fetch/runs/\<id\>** — the history (newest first) and one run: `status` running/done/failed, `results[]` per device (status, counts, unmatched IDs, samples, error) and a `summary`. The page polls the run while it is running.

Every change is audited (`create`, `update`, `delete` on `attendance`; `update` on `employees` for an Inactive or a photo).

## Site Connectors (connector_views.py, connector_admin_views.py)

A Site Connector is a program at a factory that reaches devices the server cannot (see biometric-integration.md -> Site Connectors; the wire contract is the connector project's `docs/PROTOCOL.md`).

**What the connector calls** (`/api/connector/...`, no trailing slash; `Authorization: Bearer <connector token>`, an opaque token checked against `biometric_site_connectors.token_hash` on every call, not an HR JWT; the HR permission middleware lets it through to the view's own auth):

- **POST /api/connector/pair** — no token. `{code, hostname, version, os}` -> `{connectorId, name, token, pollSeconds, protocol}`. The code is one-time, valid 24 hours, compared by SHA-256; every wrong, used or expired code gets the same `400 invalid_code`; 10 attempts per address (60 in all) per 10 minutes, then 429.
- **POST /api/connector/poll** — heartbeat and request for work: `{cfgHash, want, status}` -> `{serverTime, pollSeconds, protocol, config|null, jobs[]}`. Records `last_seen_at`, merges `status` (version, hostname, uptime, outbox, `devices{id: probe}`, `sync{id: last read}`, cut to known fields and the connector's own devices), expires overdue jobs, claims up to `want` (max 4) queued jobs (`select_for_update(skip_locked)`), and sends `config` (its devices with host, port, Comm Key, serial; punch reading interval and window) only when `cfgHash` differs. 401 `invalid_token`; 403 `revoked`.
- **POST /api/connector/jobs/\<id\>/result** — `{ok, code, message, data}` for one of its own running jobs. Closes the job, clears its payload and, if it belonged to an operation, finishes the operation once every job is closed. A result for a job already closed is acknowledged (`accepted: false`) and changes nothing.
- **POST /api/connector/jobs/\<id\>/punches** — a numbered chunk (<= 5000) `{seq, punches[{userId, at, status}]}` of a `read_punches` job's punches; a repeated `seq` is stored once; 409 unless the job is running and is a read.
- **POST /api/connector/punches** — `{deviceId, punches[], invalid, total}` read on the connector's own schedule; written like a manual update (`ingest_from_connector`). Only for a device assigned to the connector (404 otherwise).

**What HR uses** (under `/api/attendance/device-control/`, Attendance permission: GET View, others Edit; adding, changing, re-pairing or removing a connector also needs Edit on Settings):

- **GET .../connectors** — every connector: `state` (online/offline/unpaired/off), `lastSeenAt`, version, hostname, `punchSyncMinutes/Days`, `outbox`, `openJobs`, and its `devices[]` (connected, reason, last punch read). Never a token or a code.
- **POST .../connectors** — `{name, notes?}` -> 201 `{connector, pairingCode, pairingExpiresAt}` (the code is shown once).
- **PATCH .../connectors/\<id\>** — `name`, `notes`, `isActive` (switching off ends its open jobs), `punchSyncMinutes` 0-1440, `punchSyncDays` 1-31. **DELETE** removes it (its devices fall back to direct connection; open jobs are ended first).
- **POST .../connectors/\<id\>/pairing** — a new pairing code (the old token keeps working until the new pairing is done).
- **GET .../operations/\<id\>** — `{id, kind, status running|done|failed, pending[{deviceId, deviceName, connector, state waiting|working}], final, error}`. `final` is the same body the request would have returned. A branch-limited caller sees only their own.

**Changed:** POST .../users/refresh, push, update and delete answer **202 `{"operation": {...}}`** when the request includes a device behind a connector (and 200 with the finished body otherwise). The overview's devices gain `via` (`{id, name, online}` or null) and new connection codes `connector_offline`, `connector_off`, `pending`. **GET, POST /api/biometric-devices** and **PUT .../\<pk\>** carry `connectorId` (null = connected directly). The Attendance page's Sync Biometric and Auto Sync skip devices behind a connector.

## System Settings — Biometric Devices & ID Card Template (system_settings_views.py)

- **GET, POST /api/biometric-devices** — `@require_hr`. GET lists configured `BiometricDevice` rows plus a synthetic read-only entry for the legacy `.env`-configured device (if its host isn't already duplicated by a DB row); POST creates a new device, optionally flipping it to the sole default. Each row carries `serialNumber` (optional; rejected with 400 if another device already has it).
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

## Production shift rules (production_shift_rules_views.py, production_shift_rules.py)

Production employees only (staff are never touched). These endpoints edit the table that turns a production day's punches into `shifts_earned`: shift groups (Day / Night / Sunday or any HR adds), each group's ladder of "leave at this time, earn this many shifts", the unpaid breaks, the grace and a few advanced numbers. The calculation itself is the pure module `api/production_shift_rules.py` (see `backend.md`, "Production shift rules (October 2026)"). All three routes are `@require_hr` and use permission module `settings.attendance` (`permission_registry.py`: view for GET, edit for PUT; `production-shift-rules/preview` is in `READ_ONLY_POST_PATHS`, so a view-only role may POST it). The legacy `/api/production-shift-config` and `/api/production-shift-segments` endpoints above are unchanged and still describe the calculation of every day BEFORE `effectiveFrom`.

- **GET /api/production-shift-rules** — the whole document; never writes (a database with no settings row shows the defaults and no start date, i.e. "legacy"). Body:
  ```json
  { "enabled": true, "effectiveFrom": "2026-10-14", "graceMinutes": 5, "minCredit": 0, "roundingStep": 0.01,
    "roundingMode": "nearest", "fullDayValue": 1, "nightSessionHours": 24,
    "groups": [ { "id": 1, "label": "Day shift", "kind": "day", "appliesOn": "mon_sat", "startTime": "08:30",
                  "firstPunchFrom": "04:00", "firstPunchTo": "16:59", "mainOutTime": "20:00", "mainOutNextDay": false,
                  "enabled": true,
                  "rules": [ { "id": 1, "label": "Leaves at morning tea", "outTime": "10:30", "outNextDay": false,
                               "shiftValue": 0.25, "enabled": true } ] } ],
    "breaks": [ { "id": 1, "label": "Morning tea", "startTime": "10:30", "endTime": "10:45", "enabled": true } ],
    "updatedAt": "2026-10-14T10:00:00+05:30", "updatedBy": "Asha", "warnings": [],
    "legacy": { "punch1Time": "08:30", "punch2Time": "12:45", "punch3Time": "13:30", "punch4Time": "20:00", "graceMinutes": 10 },
    "version": "9f2c41d07a3b5e68" }
  ```
  Times are `"HH:MM"` (24 hour); a time after midnight is the clock time plus `outNextDay` / `mainOutNextDay` (`mainOutTime` may be null). `kind` is `day|night|sunday|custom`, `appliesOn` is `mon_sat|sunday|all`, `roundingStep` is `0.01|0.05|0.25`, `roundingMode` is `nearest|down`. `updatedAt` / `updatedBy` come from the last `update` audit row of module `production_shift_rules` (null before the first save). `legacy` is a read-only echo of the old calculation's punch times and 10-minute grace. `version` is a 16-character fingerprint of everything the PUT can change.
- **PUT /api/production-shift-rules** — saves the document; the answer is the new body (ids of new rows included) with the save's `warnings`. Every top-level key is optional (an omitted one is left alone). `groups` and `breaks`, when sent, REPLACE the whole table: an item with an `id` updates that row, an item without one is created, a stored row whose id is missing from the array is deleted (a deleted group takes its rules with it), and the array order becomes `order`. Inside an item an omitted key keeps the stored value (a group sent without `rules` keeps its rules); a rule can never move to another group. `updatedAt`, `updatedBy`, `warnings`, `legacy` and `version` are ignored when sent back, so the GET body can be PUT as it is (a stale copy simply restores that table). All-or-nothing: any problem is HTTP 400 `{"error": "<one plain sentence>"}` and nothing is saved (415 `{"error"}` for a body that is not JSON). A branch login can GET but gets 403 `{"error": ..., "code": "company_wide_settings"}` on PUT (the rules are company-wide). `expectedVersion` (the `version` the page loaded) that is not what is saved now gives 400 `{"error": ..., "code": "stale_settings"}`; a body without it skips that check. The settings row is read `SELECT ... FOR UPDATE` for the whole save, so two simultaneous saves run one after the other. A save that changes nothing writes nothing and no audit row. A real change writes one `AuditLog` row (module `production_shift_rules`, action `update`, description "Changed production shift rules: ...", old/new values of the parts that changed); the module is in the Audit Logs module list and the MD activity feed rule `production-shift-rules` (area Settings, severity high).
- **Validation (each a plain-sentence 400).** `enabled` is true/false. `effectiveFrom` is a real date `YYYY-MM-DD` (2000..2100), or null while `enabled` is false; switching the rules on with no date named starts them TODAY (IST), so they never reach back over days already judged (an explicit null/empty date while on is refused). `graceMinutes` 0..30; `nightSessionHours` 1..24; `minCredit` 0..9.99 (two decimals) and not above the most any enabled group can pay; `roundingStep` 0.01/0.05/0.25; `roundingMode` nearest/down; `fullDayValue` more than 0 and at most 9.99. A group needs a name, a valid `kind` / `appliesOn`, HH:MM `startTime`, `firstPunchFrom`, `firstPunchTo` (window not ending before it starts), a `mainOutTime` (optional) after `startTime`; enabled groups that can apply on the same days must not have overlapping first-punch windows; an enabled group needs at least one enabled rule; the rules cannot be switched on with no enabled group. The enabled rules of an enabled group: out time after the group's start, strictly increasing in array order (a next-day time is after a same-day one), `shiftValue` more than 0, at most 9.99, at most two decimals and never going down, and no two rules on the same PAID time (12:45 and 13:30 are either side of the same lunch, so only one can have a rule). A break: `startTime` before `endTime` on the same day, enabled breaks must not overlap. Ceilings: 12 groups, 60 rules per group, 30 breaks, 100-character labels; a NUL or lone surrogate in a name, a body nested too deeply and malformed JSON are 400s, never a 500.
- **Warnings (advice; the save has happened).** In the GET body too (mistakes in what is saved): a ladder point inside a break (it counts as the break's start), a weekday no enabled group covers (those days fall back to the old calculation), a full-day value no day of a group can reach. Only in the answer of a save that changes the rules: a start date in the past ("days from <date> are judged by the new table whenever they are recalculated"), production payroll already generated for days these rules judge ("regenerate payroll to apply"), moving the start date LATER over days production payroll already covers (those days are judged by the old calculation again), switching the rules OFF when payroll exists for days they judged, and a group the save touched that has no rule after its standard departure.
- **POST /api/production-shift-rules/preview** — what a made-up day earns with the SAVED rules (unsaved edits are never read); reads, never writes. Body `{"punches": ["08:30", "12:45", "13:30", "20:00"], "date": "2026-10-15"}`: up to 24 plain ASCII `HH:MM` (`H:MM`, `HH:MM:SS`) times in the order they happened (a time not later than the one before it is the next morning, so `["21:00", "05:30"]` is a night; at most two calendar days), `date` optional (default today IST). Answer `{"group": "Day shift", "shifts": 1.5, "status": "present", "isLate": false, "earlyLeave": false, "note": "<one sentence, e.g. Day shift: left 17:50, ...>", "calculation": "rules"}`. `calculation` is `rules`, `legacy` (the date is before `effectiveFrom`, the rules are off, or no group covers that weekday: `group` is "Old calculation" and the note says why) or `none` (no punches: shifts 0, status `absent`). A bad time or date is 400 `{"error"}`.
- **Additive keys on the attendance endpoints** (only for a production employee whose day the new rules judge; nothing changes for staff or for days before `effectiveFrom`). `GET /api/attendance/daily` rows gain `shiftsEarned` (number), `isLate`, `isEarlyOut`, `ruleGroup` (the group's label), `ruleNote` (one sentence) and `lastPunchNextDay` (true when the day's last punch is the next morning's); they are computed by the same pure function as payroll (one extra punch query for the whole roster, nothing stored), and `firstPunch` / `lastPunch` / `totalPunches` are the SHIFT day's, so a night worker's 05:30 punch is shown on the day the night began. The punch lists of `GET /api/attendance/employee/{pk}` (month history), `/api/attendance/search`, `/api/attendance/search/range` and `/api/attendance/employee-shift-stats` carry `nextDay: true` on a closing punch made on the following calendar date, and that punch is not listed again on the date it was made.
- **Reports.** HR Reports → Production Daily Punches (id `production-daily-punches`, module `attendance`) adds the columns Shift, Shifts Earned, Late, Early and Rule applied and lists punches by shift day; HR Reports → Production Shift Rules (id `production-shift-rules`) prints the saved table (see `api/reporting/definitions/hr_reports.py`, `production_judge.py`).

## Geo-Punch & On-Duty Attendance (geo_attendance_views.py)

- **GET /api/attendance/geo-punch/precheck** — `@require_auth`. Read-only check of whether the employee's current lat/lng is inside their branch's geofence radius, before they commit to punching; also reports the next punch number/type and whether an active/pending On-Duty session blocks Office Geo Punch.
- **POST /api/attendance/geo-punch** — `@require_auth`. Records an uncapped "Office Geo Punch" (no photo/approval) immediately via the shared `_ingest_punches()` path, tagged `geo:auto`, only if inside the branch geofence and not GPS-mocked; hard-rejects (403/409) if outside radius, mocked location, or an active/pending On-Duty session exists.
- **GET /api/attendance/geo-punch/status** — `@require_auth`. Returns today's (or a given date's) recorded punches for the employee plus their current On-Duty session snapshot, next punch number/type, and all 4 punch-slot states.
- **POST /api/on-duty-sessions/request** — `@require_auth`. Employee starts an On-Duty session by naming a destination; blocked if one is already in progress; creates the session at the status of the pipeline's first step (`pending_hod` built-in; refused with 403 `workflow_disabled` while On-Duty is switched OFF), notifies the Department Heads when they are first, but responds as immediately "active" so the employee can start punching/tracking without waiting for approval.
- **POST /api/on-duty-sessions/complete** — `@require_auth`. Employee manually ends their own active/pending On-Duty session ("Mark as Done"); a still-provisional (unapproved) session just gets `employee_ended_at` stamped so it stays in HR's queue rather than being marked completed.
- **GET /api/on-duty-sessions/status** — `@require_auth`. Returns the employee's current/most-recent On-Duty session, its punch verifications, and all 4 punch-slot states, for the On-Duty page.
- **POST /api/on-duty-sessions/punch** — `@require_auth`, `@parser_classes([MultiPartParser, FormParser])`. Multipart: captures one of the day's (up to 4) attendance punches with a required selfie photo (JPG/PNG, ≤8MB) + GPS while an On-Duty session is in progress (including one still pending approval); auto-closes the session if this fills the last of 4 slots. Held pending until HR approves both the punch and the parent session.
- **POST /api/live-location/ping** — `@require_auth`. Records one GPS ping for the employee (self-pruning pings older than 72h on each write); accepted only if `location_tracking_enabled` is true or an active/pending On-Duty session exists, else 403 with `code: "TRACKING_DISABLED"`.
- **GET /api/on-duty-sessions** — `@require_hr`. HR's branch-scoped list of On-Duty session requests, filterable by status (default "pending" = both `pending_hod` and `pending_hr`).
- **PATCH /api/on-duty-sessions/\<pk\>/status** — `@require_hr`. HR's approve/reject decision on an On-Duty session, valid whenever the pipeline gives HR a turn (built-in: at either pending stage, the Department Head step being optional); approval that completes the pipeline starts the session (status=active) and auto-approves every punch already captured under it via the shared ingestion path; rejection voids all still-pending punches for that session.
- **GET /api/on-duty-punch-verifications** — `@require_hr`. HR's branch-scoped list of captured on-duty punch photos/GPS records, filterable by status.
- **PATCH /api/on-duty-punch-verifications/\<pk\>/status** — `@require_hr`. HR approves/rejects one captured on-duty punch; approval writes it into `AttendanceLog` via the shared ingestion path (409 if the parent session is still unapproved — a punch can never become attendance before its session is approved); auto-completes the session if this was the day's 4th punch.
- **PATCH /api/on-duty-sessions/\<pk\>/punches** — `@require_hr`. One bulk decision applied to every still-pending punch under an On-Duty request (for punches captured after the request itself was already approved).
- **GET /api/on-duty-punch-verifications/\<pk\>/photo** — `@require_auth` (with additional manual permission checks in the body). Streams the selfie photo for one punch verification; access limited to the owning employee, branch-scoped HR, or a Department Head with that employee in their approval scope.

## Live Location Tracking (geo_attendance_views.py)

- **GET /api/live-location/team** — `@require_hr`. Latest GPS ping per tracking-enabled active employee (branch-scoped), each flagged with whether they're currently on an active/pending On-Duty session, for the Live Map.
- **GET /api/live-location/team/\<employee_id\>/trail** — `@require_hr`. Today-so-far (within the 72h retention window) breadcrumb ping trail for one employee.
- **GET /api/live-location/team/\<employee_id\>/route** — `@require_hr`. Full-day breadcrumb trail for one employee on a specific date (defaults today), ordered for drawing a directional path.
- **GET /api/on-duty-map** — `@require_hr`. Branch-scoped roll-up, per employee with On-Duty activity that day (session opened that day or still active): current position, today's route points, session status, and per-punch status list, for the On-Duty Map tab.

## Request date window (request_window.py)

Which dates an **employee** may put on a request. One rule, applied to the four dated request forms an employee submits: `POST /api/leave-requests` (`startDate` and `endDate`: a single day, a range or a half-day), `POST /api/permissions` (`date`, the Late-In / Early-Out / Middle one-hour form), `POST /api/casual-leaves` (`date`) and `POST /api/missing-punch-requests` (`date`). Not covered, and unchanged: the resignation last working day, outpass, on-duty and geo punch (no date is picked), generic requests/tickets, the Leave-list From/To filters and anything HR does.

- **The rule.** An employee token may request dates in the **current calendar month only** (the 1st to the last day; next month is refused too). On the first `GRACE_DAYS` (2) days of a month, the 1st and the 2nd, **last month is still open as well**, so the window starts on the 1st of last month; from the 3rd it starts on the 1st of this month (January looks back to December of the year before). A **Missing Punch** additionally cannot be after today (`Date cannot be in the future.`; its window is "window start .. today"). Both ends of a leave range must be inside the window and the end may not be before the start. A half-day is one date. "Today" is India time (`api.clock.ist_today`), whatever the device clock says: the apps only use the device clock to guide the user, the server decides.
- **Who is exempt.** Only an **employee token** is limited (`enforce_employee_date` / `enforce_employee_range` return `None` for any other token). HR creating a request on an employee's behalf (a correction, a back-dated entry) is never limited. A Department Head is also an employee token, so they are limited like anyone for their own requests.
- **Where in the request.** Always last of the refusals: after every check below, and after `approval.require_enabled(...)` (a switched-off workflow answers 403 `workflow_disabled` before the window is looked at), immediately before the row is created. Nothing is created and nobody is notified on a refusal. What comes before it differs per endpoint:
  - **Leave** (`leave_request_views.py`): the ownership 403 (a non-numeric or too-big `employeeId` is a 400 `employeeId must be a number`), the required-field 400, the half-day rules (`halfDaySlot`, "must be for a single day") and `require_enabled`; then the window; only then are the days counted.
  - **Permission** (`leave_views.py`): the ownership 403, the required-field 400, the date-parse 400, employee-not-found 404, the `permissionTime` and `type` 400s, the duplicate-request **409** (the same kind of permission already pending/approved for that day) and `require_enabled`; then the window.
  - **Casual Leave** (`casual_leave_views.py`): the ownership 403, the required-field 400, employee-not-found 404, the date-parse 400, **`check_cl_eligibility`** (a 400 carrying the eligibility reason, e.g. under 6 months of service or the month's CL already used) and `require_enabled`; then the window. An employee who is not eligible therefore hears the eligibility reason, not the window sentence, even for a date outside the window.
  - **Missing Punch** (`missing_punch_views.py`): the ownership 403, the required-field 400, the `punchSlot` / `punchType` 400, employee-not-found 404, the date-parse and `punchTime` 400s and `require_enabled`; then the window, which for this form is also the "not in the future" check.
- **The 400 body.** `{error, code: "request_window_closed", earliestDate, latestDate, graceDays}`. `error` is the sentence for the user (old apps print it as it is), for example `You can only request dates in October 2026.`, or on the 1st/2nd `You can only request dates from 1 September 2026 to 31 October 2026. September closes at the end of 2 October.`; the same code also carries `Choose a valid date.`, `Date cannot be in the future.` and `End date must be on or after start date.`. `earliestDate` / `latestDate` (`YYYY-MM-DD`) are the window as the server sees it and `graceDays` is 2, so a client can react without parsing the sentence.
- **One rule, four codebases.** The same logic lives in `backend/api/request_window.py`, the HR portal's `src/lib/request-window.ts`, the Employee Web App and the Mobile App, and all four assert the same 83 shared test vectors (`api/tests_request_window.py` here). Change them together.

## Casual Leave (CL)

- **GET, POST /api/casual-leaves** — `@require_auth`. GET lists CL requests, branch-scoped and self-restricted to the caller's own employee id when an employee token is present (an HR/non-employee caller may filter by `employeeId`/`employeeCode`/`status`/`month`/`year`, capped at 300 rows). POST submits a new CL request for a date — employees may only submit for themselves; enforces `check_cl_eligibility` (staff-only, active, ≥6 months service, one CL per calendar month) before creating the row. For an employee token the `date` must also be inside the [request date window](#request-date-window-request_windowpy) (this month; last month too on the 1st and 2nd), else 400 `request_window_closed`; HR is never limited. The one-per-month rule counts the month of the requested date, so on the 1st/2nd an employee who has used this month's CL may still be eligible for last month's.
- **PATCH, DELETE /api/casual-leaves/\<pk\>** — `@require_hr`. PATCH approves/rejects a pending CL request (`apply_cl_decision`), which also immediately writes the final `AttendanceDayRecord` for that date (approved → present/1.00 shift paid; rejected → on_leave) and notifies the employee; DELETE removes the request outright.
- **GET /api/casual-leaves/eligibility** — `@require_hr`. HR eligibility board: every branch-scoped active staff employee for a given month/year with their service-months, eligibility flag/reason, and whether/how CL was already used that month.
- **GET /api/casual-leaves/my-eligibility** — `@require_auth`. Self-service equivalent for the mobile/web employee apps: eligibility for today plus the employee's yearly CL usage against a 12/year entitlement (reuses the same `check_cl_eligibility` rule as the HR board so the two can't disagree). Every earlier key is unchanged; it also returns **`months`**: one entry per month of the request window (last month ONLY while its grace days are open, then this month), each `{month: "YYYY-MM", label: "September 2026", eligible, reason}` computed with `check_cl_eligibility` for the 1st of that month, so the clients can gate the date picker on it.

## Leave Types & Holidays

- **GET, POST /api/leave-types** — `@require_auth` decorator; POST is internally gated to HR via `is_hr(request)` (403 otherwise) — GET is open to any authenticated user. GET lists active `LeaveType`s; POST creates a new one (name, code, max days/year, carry-forward rules, paid flag, applicable gender), rejecting duplicate codes.
- **PUT, DELETE /api/leave-types/\<pk\>** — `@require_hr`. PUT edits a leave type's fields; DELETE soft-deletes it by setting `is_active=False`.
- **GET /api/leave-balances** — `@require_auth`. Lists `LeaveBalance` rows filtered by employee/year; an employee token is forced to only see their own balances regardless of query params.
- **POST /api/leave-balances/allocate** — `@require_hr`. Creates or updates a `LeaveBalance` allocation for an employee/leave-type/year, recomputing `remaining` from `allocated - used`.
- **GET, POST /api/holidays** — `@require_auth` decorator; POST is internally gated to HR via `is_hr(request)` — GET is open to any authenticated user. GET lists holidays (filterable by year/branch); POST creates a new `Holiday` (name, date, type, branch/department scope, recurring flag).
- **PUT, DELETE /api/holidays/\<pk\>** — `@require_hr`. Edits or deletes one `Holiday`.

## Leave Requests (views.py)

- **GET, POST /api/leave-requests** — GET lists leave requests (branch-scoped via the employee's branch), filterable by employeeId/employeeCode/status; POST creates a leave request for an employee (resolves by employeeCode or ID), computing `total_days` as working days (Mon–Sat) between start/end. No decorator on the outer `leave_requests` function; both GET and POST dispatch via `require_auth`. For an employee token, both `startDate` and `endDate` (which defaults to `startDate`; a half-day is one date) must be inside the [request date window](#request-date-window-request_windowpy) and the end may not be before the start, else 400 `request_window_closed`; HR filing for an employee is never limited. For an employee token the dates are stored (and the days counted, and a half-day's "single day" checked) as the canonical `YYYY-MM-DD` that the window check accepted, so a date-time or padded text (`2026-10-20T00:00:00`, ` 2026-10-20`, `2026-10-20junk`) is stored as `2026-10-20`; HR's text is stored exactly as sent. The days are counted after the workflow-off 403 and the window 400, so a refused range costs nothing. A non-numeric `employeeId` on an employee token, or one too big for an integer such as `1e999`, answers 400 `employeeId must be a number` (it used to be an HTTP 500).
- **PATCH /api/leave-requests/\<pk\>/status** — `@require_hr`. HR approve/reject of a leave request, valid whenever the pipeline gives HR a turn (else 400/403 `not_your_turn` / `role_not_in_pipeline`); the approval that completes the pipeline deducts the days from the matching `LeaveBalance` row(s) for the year (whichever role gave it) and sends the employee a notification; on rejection, just notifies. Re-deciding an already decided request is a revision, allowed only when HR takes part in the pipeline (a comment-only edit is always allowed).
- **DELETE /api/leave-requests/\<pk\>** — `@require_hr`. Hard-deletes a leave request.

## Employee Requests & Permissions

- **GET, POST /api/employee-requests** — The view function itself carries only `@api_view` with no auth decorator — POST enforces auth internally by wrapping the handler in `require_auth(...)`, and GET enforces HR internally via a nested `@require_hr`-decorated inner function (flagged since the outer function has no top-level guard). POST lets an authenticated user submit a generic `EmployeeRequest` (subject/type/description) and notifies HR; GET (HR-only) lists all requests filterable by type/status.
- **PUT /api/employee-requests/\<pk\>/action** — `@require_hr`. HR updates a request's status/notes/handler and notifies the employee if status changed.
- **GET, POST /api/permissions** — `@require_auth`. GET lists `EmployeePermission` (late/early-leave permission) requests, branch-scoped, filterable by employee/status/month/year (employee tokens see only their own); POST creates a new permission request, blocking an employee from submitting on someone else's behalf, and reports how many the employee has used this month against the informational 3-per-month allowance. For an employee token the `date` must be inside the [request date window](#request-date-window-request_windowpy) (this month; last month too on the 1st and 2nd), else 400 `request_window_closed`; HR is never limited.
- **PUT, DELETE /api/permissions/\<pk\>** — `@require_hr`. HR approves/rejects (setting `approved_by`/`approver_role` server-side, never client-trusted) or edits a permission request, notifying the employee on status change; DELETE removes it.

## Missing Punch (missing_punch_views.py)

- **GET, POST /api/missing-punch-requests** — `@require_auth`. GET lists requests (branch-scoped; an employee token sees only their own; HR can filter by employeeId/employeeCode/status/month/year, up to 300 rows); POST submits a new "I forgot to punch" request (date + punch time + reason, resolved to a punch slot/type), self-bound for an employee token (403 if they name a different employee), and notifies eligible Department Head approvers. For an employee token the `date` must be inside the [request date window](#request-date-window-request_windowpy) **and not after today** (400 `request_window_closed`, `Date cannot be in the future.`); HR is never limited.
- **PATCH, DELETE /api/missing-punch-requests/\<pk\>/status** — `@require_hr`. HR's decision under the configured pipeline (built-in: only once the Department Head has approved, so HR cannot short-circuit past an unreviewed HOD stage; with an HR-first or HR-only pipeline HR decides straight away); the approval that completes the pipeline creates one ordinary `AttendanceLog` row tagged `missing_punch:approved` (idempotent via the log's unique constraint) so it flows through the normal payroll engine like a real punch; DELETE removes the request outright.

## Growth: Attendance Monthly View & Manual Overrides

- **GET /api/attendance/employee-monthly** — `@require_auth` (with an internal `is_hr` check when no employee token is present). Returns one employee's month broken into weeks (W1–W5) of computed final attendance-day records (`compute_month_records`), plus assigned shift info and a month summary; an employee token sees only their own data, otherwise the caller must be HR looking up by `employeeId`/`code`.
- **POST /api/attendance/override** — `@require_hr`. HR requests a manual correction to one day's attendance (`status`, `isLate`, `isHalfShift`, punch times, note); `reset=true` immediately reverts to auto-computed values, but any other change instead creates a pending `AttendanceOverrideRequest` that a Department Head must approve before the underlying `AttendanceDayRecord` is actually overwritten.
- **GET /api/attendance/override-requests** — `@require_hr`. Lists submitted `AttendanceOverrideRequest` rows (filterable by employee/code/status) so HR can see approval status of pending overrides.

## Staff Payroll Engine (Settings, Sessions, Attendance Logs, Work Sessions)

- **GET `/api/support-contact`** — **Public, no login**, read-only (a stale Bearer token is ignored, so an app is never signed out by it). The HR and software-support contacts HR entered under Settings → HR Contact, for the Employee Mobile App and Employee Web App: `{ hr, support, note, companyName, configured, updatedAt }`, where `hr` / `support` are `{ label, phone, phoneDial, whatsapp, whatsappNumber, email, hours, hasContact, usesHrFallback }` (`phoneDial` is what a `tel:` link dials, `whatsappNumber` the international digits for `wa.me`; `support` is filled from `hr`, with `usesHrFallback: true`, when nothing is set for it). `hr` is for sign-in and app problems, `support` for the server being down. `Cache-Control: no-store`; the apps keep the last answer for when the server is unreachable. Nothing else from settings is exposed.
- **GET/PUT `/api/payroll-settings`** — Reads/writes the singleton `PayrollSettings` (company profile, attendance mode, late-detection slabs, production period config, SMTP, backup directory, etc.); non-super-admins get a personal overlay instead of the shared row, and PUT is field-by-field permission-checked against `FIELD_GROUPS` (`settings.company`, `settings.payroll`, `settings.late_detection`, etc.) unless the caller is super admin. A key may list more than one group (edit access on any one is enough): `defaultSalaryPerShift` accepts `settings.production_payroll` or `settings.payroll`, and `prodLateDetectionEnabled`, `prodAttendanceMode`, `prodLateFreeAllowance` and `prodLateDeductionSlabs` accept `settings.late_detection` or `settings.production_payroll`. `prodCycles` is judged key by key: `lateFreeAllowance` / `lateSlabs` accept either of those two groups, `weekStart` / `anchorDate` (and any key not known) need `settings.production_payroll`, and a save carrying both kinds needs what each part needs; the 403 body (`permission_denied`, `fields`) is the same as ever. PF / ESI are **not** part of it any more: see *PF & ESI, TDS and Co Emp*. **Auth: `@require_hr`.**
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
- **Staff payslip breakdown, Permission Deduction Slabs (additive, October 2026):** `breakdown_details.deductions` gains `permissionPenalty` (rupees; 0 while the switch is off) and `permissionSummary {enabled, approved, cap, excess, absorbedByLate, priced, freeAllowance, freeUsed, billable, shifts, penalty}`; `excess` is always `max(0, approved - cap)`, with the switch ON `excess == absorbedByLate + priced`. `lateSummary` keeps its keys (with the switch ON its pool counts exclude the excess permissions that are priced on their own: `excessPermissionCount` stays the plain excess count). `permissionPenalty` is part of `deductions.total`, `SalarySlip.other_deductions` and `total_deductions`, like `lateShiftPenalty`. Slips stored earlier have neither key and are never rewritten. The payroll details endpoint answers it as a `permission_penalty` deduction line (`ruleKey` `permission_slabs`), the issues endpoint as the `excess_permission` issue (with the amount and the Settings link `/hr/settings?tab=late_detection#permission-deduction-slabs`), and the rules as the items `permission_pricing`, `permission_free_allowance` and `permission_slabs`.
- **GET `/api/payroll/\<int:pk\>/breakdown`** — Returns the full day-by-day traceability JSON (`breakdown_details`) stored on the matching `SalarySlip` for one payroll record, plus employee/summary info. **Auth: `@require_hr`.**

## Production Payroll

One page per **pay cycle** — Weekly (7 days), BiWeekly (14 days) and Monthly (**four weeks**, 28 days). Every production employee is assigned to one cycle (`Employee.production_pay_cycle`, see *Production Employees* under Employees); every endpoint below works on one cycle and only ever touches the active production employees assigned to it. Periods come from `PayrollSettings.prod_cycles` (one rule per cycle: a start weekday and a first-period-start date); a caller never sends a month, year or week number. Constants and settings rules: `api/production_cycles.py`; period maths: `api/production_period.py` (`resolve_cycle_period`, `next_cycle_period`, `recent_cycle_periods`). Every endpoint is under the `production_payroll` permission module and branch-scoped (a branch login sees, pays and counts only its own branch, including the "next period" pointer).

- **GET `/api/payroll/production/cycles`** — One card per cycle: active employees assigned, whether its period is set up (`configured` / `configError`), its week start and first period start, the next period to generate (`next`) and what is still unpaid (`pending: {records, employees, amount}`); plus `totalProduction` and how many active production employees are `unassigned`. **Auth: `@require_hr`.**
- **GET `/api/payroll/production/next-period?cycle=`** — The period that would be generated next on a cycle (the one right after the latest period generated *for that cycle*, or on a first run the most recent period that has already ended) and whether it has ended. 400 when `cycle` is missing, or when BiWeekly / Monthly have no first period start yet. **Auth: `@require_hr`.**
- **GET `/api/payroll/production/periods?cycle=&back=8&around=YYYY-MM-DD`** — The periods worth choosing from, newest first (the next due one, the ones up to today, `back` earlier ones), each with how many payslips of the cycle exist (`generated`, `paid`) and `isNext`; `around` adds the period holding any date (how an older period is opened). **Auth: `@require_hr`.**
- **GET `/api/payroll/production/period-status?cycle=&periodStart=&periodEnd=`** — The cycle's roster for one period (default: next due): every assigned employee with the payslip they already have, or `blockedReason` (no Salary Per Shift, or the dates overlap payroll already generated), plus `counts` (`generated`, `paid`, `ready`, `blocked`). An explicit period must be exactly one of the cycle's periods (400 otherwise, naming the period that holds the start date). **Auth: `@require_hr`.**
- **GET `/api/payroll/production/skip-check?cycle=&periodStart=&periodEnd=&employeeIds=&regenerate=`** — Dry-run (savepoint-and-rollback) of what Generate would skip and why; employees who already have payroll are counted as `alreadyGenerated`, not as problems. **Auth: `@require_hr`.**
- **POST `/api/payroll/production/generate`** — Body `{cycle, periodStart?, periodEnd?, employeeIds?, regenerate?}`. Runs `_generate_production_payroll(..., pay_cycle=cycle)` for the cycle's roster, or only `employeeIds` of it (an id outside the roster is refused with the reason, e.g. "Not assigned to the Weekly cycle (assigned to BiWeekly)"). Rejects a period that has not ended; **never overwrites**: an employee who already has payroll for the period is left alone (`alreadyGenerated`), a paid payslip is never recomputed, a period that overlaps days already covered by another payslip of the same employee is refused for that employee, and only `regenerate: true` recomputes a payslip that is still pending. Stamps the cycle on the `Payroll` row and the `SalarySlip`; tracks progress and logs an audit entry. **Auth: `@require_hr`.**
- **GET `/api/payroll/production?cycle=&employeeId=&status=&periodStart=&periodEnd=&limit=`** — Lists period-based (`salary_mode="shift"`, `period_start` not null) `Payroll` rows, branch-scoped, enriched with bank/department info for export. With `cycle`: the rows generated on that cycle plus older rows (no cycle stamped) whose employee is assigned to it now; without it, every period-based row as before. **Auth: `@require_hr`.**

**Production PF/ESI and pay cycles.** The production PF / ESI rules are written for monthly pay, so one period's gross is first scaled to a production month (four weeks): Weekly ×4, BiWeekly ×2, Monthly ×1 (`MONTHLY_EQUIVALENT_FACTOR`; BiWeekly keeps the ×2 the engine always used) before the worker's amount on the rule's basis is tested against its range. PF and ESI are then the matched rule's percentage of the first 50% of the period's earned pay, and only for Co Emp workers; TDS (a TDS worker's percentage of the period's gross) replaces them for a worker on the TDS list. The free late days and the late deduction slabs of a payslip are those of its cycle when the cycle has its own (`prod_cycles[cycle].lateFreeAllowance / lateSlabs`), otherwise the shared production values.

## Payroll Insights (read-only)

The redesigned Staff Payroll and Production Payroll pages explain what payroll **already stored**: the `Payroll` row, its `SalarySlip.breakdown_details` (the engine's own day-by-day record), the employee profile and the live settings. Nothing here recomputes a payroll, calls an engine function that persists, or writes anything: every endpoint is a `GET`, and a missing `PayrollSettings` row is read as the model defaults and never created. Staff endpoints live under `/api/payroll` (permission module `payroll`), production endpoints under `/api/payroll/production` (`production_payroll`); the module comes from the URL (longest prefix wins), so a role that only has one of them reaches only that kind, and a staff payroll id sent to a production endpoint (or the reverse) is a **404**. A branch-scoped login only ever gets its own branch. Code: `api/payroll_insights.py` (formatting, issue detection, money lines, Settings deep links, bulk loaders), `api/payroll_insights_rules.py` (the rules), `api/payroll_insights_views.py` (details, issues, rules) and `api/payroll_statement_views.py` (Salary Statement). The JSON shapes are the TypeScript types in `frontend/src/lib/api-client/custom-hooks/payroll-insights.ts` (camelCase); `api/tests_payroll_insights.py` checks every response against that file, every Settings link against the Settings page's own setting ids, that nothing is written and that the number of queries does not grow with the number of employees.

Scope of the list endpoints: staff `month`, `year`; production `cycle` (`weekly` | `biweekly` | `monthly`), `periodStart`, `periodEnd` (read by their exact dates: a period generated under earlier Settings is still a period that exists); optional `departmentId`, `employeeId`, `branchId` and `status` (`paid` | `pending`). A missing or malformed parameter is a 400; a month or period with no payroll is an empty answer.

- **GET `/api/payroll/<int:pk>/details`** (staff) and **GET `/api/payroll/production/<int:pk>/details`** (production; older session-based rows answer as `kind: "legacy_session"` with no day detail) — Everything on one payroll in the shape a details page draws: `employee` (bank account reduced to its last four digits; never the photo, password hash, ID proof or address), `period`, `money` (`gross`, `deductions`, `bonus`, `otAmount`, `net`, `monthlySalary`, `dailyRate`), `summary` (the breakdown's own counts), ordered `earnings` / `deductions` lines (`{key, label, note, amount, kind: earning | deduction | info | subtotal, ruleKey}`, the `note` saying how each was worked out), `rules` (the rules the payroll was generated under: each item has the value in force now, `applied` -what the payroll was generated with, read from the breakdown- and `changed` when they differ, e.g. a late slab table or a PF rule edited since, or the employee moved between Co Emp and TDS; a payroll stored before the PF & ESI redesign records no PF / ESI rule and is never reported as changed), `issues` + `issueCounts`, the normalised `days` (with the issue codes each day raised as `flags`), `advances`, `notes` (what HR typed when adjusting), `history` (the employee's last six other payrolls of the same kind, newest first), `neighbours` (Previous / Next in the same month or period, by employee name) and `context`. `slipId` / `slipNumber` identify the payroll's salary slip for the existing PDF / email / WhatsApp actions (null when none is stored). A payroll with no slip answers with empty days, the profile issues it can still raise and a note saying so. **Auth: `@require_hr`.**
- **GET `/api/payroll/issues`** and **GET `/api/payroll/production/issues`** — Every issue payroll detected in the scope, built from the stored breakdowns. Staff: absent, unpaid leave, late arrival, early leaving, half day, quarter-day cut and missing punch (each on its day), no shift, late deduction, excess permission, advance recovery, overtime pay, manual adjustment (HR changed bonus / deductions after generation) and profile issues (bank details, PF / ESI number: only when PF / ESI was deducted). Production: absent, late, missing punch, half day, no attendance, late deduction, advance, adjustment and profile issues. Each issue has a stable `id`, `severity` (critical | warning | info), `category`, a specific `detail` with the real numbers, the `date` it was detected on (null for a whole-period issue), `detectedAt` (when payroll last computed it), the `impact` (days / shifts / rupees), the `rule` that fired it with its Settings deep link (`/hr/settings?tab=<tab>#<setting-id>`) and raw `facts`; sorted by date, then severity, then employee name (period issues last). `summary` counts by severity, by code and by department. **Auth: `@require_hr`.**
- **GET `/api/payroll/rules`** and **GET `/api/payroll/production/rules`** — `settings`: the Settings page rules this kind of payroll runs on, grouped (staff: Attendance & late detection, Half day & permissions, Statutory (PF / ESI), Pay basis, Overtime / Compensation switch; production: Pay cycle, Attendance mode & late detection, Statutory (PF / ESI), Pay basis), each item with its Settings link (PF / ESI items link to Settings → PF & ESI; the Statutory group lists which rule set applies, the PF and ESI rule lists in words and a TDS note); `employees`: one row per payroll in the scope with short coloured `chips`, the rules in force for that employee now (`groups`: assigned shift and Saturday off, salary basis, the Co Emp / TDS category with the PF and ESI rule that fits the employee (or why none does) and the TDS percentage, production cycle, rate and production shift) and `flags` (`no_shift`, `no_rate`, `no_cycle`, `no_bank`). The chips are `pf`, `esi` (`PF 12%`, `No PF`) and, for a TDS employee, `tds` (`TDS (10%)`); production has a single `statutory` chip. PF / ESI follow the employee's own branch rules, as payroll does. **Auth: `@require_hr`.**
- **GET `/api/payroll/salary-statement`** and **GET `/api/payroll/production/salary-statement`** — The data of the printed Salary Statement: `company`, `title`, `period` (with dd-mm-yyyy `fromLabel` / `toLabel`), `columns` (key, label, alignment, format, relative `weight`, whether it adds up, group), department `groups` (rows in employee-code order, a `subtotal` each), the grand `total`, `counts` and `notes` explaining how each column is worked out. Staff columns: SNO, ID NO, Name, Designation, Basic salary (the first salary-split portion), Total (the monthly salary), Present, CL (approved Casual Leave), LOP, HD (half-shift days), Total Days, PTRL (the Petrol allowance), Others Allow, E salary (earned pay + overtime + HR bonus), T.Advance (the advance balance before this month's recovery), Advance, ESI, PF, TDS (the TDS deducted from an employee on the TDS list, 0 for everybody else), Others (late deduction + HR deductions, never the TDS), Lop& PSAmt (the pay lost to LOP, for information), Total Deduction, NET (the saved payroll figure) and Remarks (`LEFT`, `JOINED dd-mm`); Basic + PTRL + Others Allow = Total. Production columns: SNO, ID NO, Name, Designation, Rate / shift, Days worked, Absent, Late, Shifts, E salary, T.Advance, Advance, ESI / EF, PF, TDS, Others, Total Deduction, NET, Remarks. A statement of hundreds of employees is a fixed number of queries. **Auth: `@require_hr`.**

## Salary Slips (salary_slip_views.py)

- **GET /api/salary-slips** — `@require_hr`. Lists `SalarySlip` rows (branch-scoped) filterable by employeeId/month/year/weekNumber/employmentType/payCycle (`payCycle` = one production pay cycle: the slips generated on it plus older slips whose employee is assigned to it now; correctly distinguishes period-based production slips from staff slips via `employment_type`, not just `week_number`), each enriched with company-branding settings for slip rendering. Every slip row (and `GET /api/salary-slips/<pk>`, `GET /api/my/salary-slips`) carries `pfDeduction`, `esiDeduction`, `tdsDeduction` and `tdsPercent` (null unless the employee was on the TDS list when it was generated); `totalDeductions` includes the TDS. The slip PDF (single and bulk) prints a `TDS (10%)` line only for such a slip, never an empty one.
- **GET /api/salary-slips/bulk-pdf** — `@require_hr`. Combines every salary slip matching the current filters into one PDF (2 slips/page) for printing, tracked via a progress counter.
- **POST /api/salary-slips/bulk-email** — `@require_hr`. Emails every matching slip (as a PDF attachment) to its employee's address using stored SMTP settings; requires SMTP to be configured; tracks per-employee success/failure.
- **GET /api/salary-slips/bulk-progress** — `@require_hr`. Polls the snapshot of an in-progress bulk PDF/email job.
- **POST /api/salary-slips/bulk-whatsapp** — `@require_hr`. Sends every matching slip as a WhatsApp document message via the configured Meta template; fails fast if WhatsApp isn't configured before generating any PDFs.
- **GET /api/salary-slips/bulk-whatsapp-progress** — `@require_hr`. Polls the snapshot of an in-progress bulk WhatsApp send job.
- **GET /api/salary-slips/\<pk\>** — `@require_auth`. Returns one slip's full detail plus company settings; an employee token may only view their own slip (403 otherwise), and HR is branch-scoped to the slip's employee.
- **POST /api/salary-slips/\<pk\>/email** — `@require_hr`. Emails one slip's PDF to the employee (or an explicit `toEmail` override); 400 if SMTP isn't configured.
- **POST /api/salary-slips/\<pk\>/whatsapp** — `@require_hr`. Sends one slip's PDF via WhatsApp to the employee.
- **GET /api/my/salary-slips** — `@require_auth`. The logged-in employee's own salary slip history.

## Compensation — CTC Breakdown (compensation_views.py, ctc.py)

- **GET /api/compensation** — `@require_hr`, branch-scoped. One row per active employee (filters `status`, `departmentId`, `branchId`, `employmentType`, `search`), returned as `{results, count}`. Each row carries the employee's **salary split** — `basic`, `da`, `retainingAllowance` (first portion) and `otherAllowance`, `petrolAllowance`, `hra`, `specialAllowance`, `ca` (second portion), plus `firstPortion`, `secondPortion` and `splitRecorded` — followed by `employerPf`, `employerEsi`, `grossMonthly`, `annualCtc`. `splitRecorded` is `false` when no valid split is saved for the employee (created before the split existed, or the salary has since moved away from the stored split), in which case the automatic 50% + 50% split of the salary is shown; nothing is written. The eight components and both portions are `null` for an employee with no monthly salary. Employer PF = PF rate × the first portion; employer ESI = ESI rate × salary while the salary is within the ESI ceiling; annual CTC = (salary + PF + ESI) × 12. The calculation lives in `ctc.py` (`ctc_figures`) and is shared with the Report Center's `employer-cost-ctc` statement. Display only: payroll generation never reads it. (The former `hra` / `allowances` fields and the Basic % / HRA % settings no longer drive it; `basicPercent` / `hraPercent` are still stored but unused.) Reads always work; the OT / Compensation-Day / credit writes below are refused with 403 while `compensation_feature_enabled` is off.

## Compensation — OT Detection, Compensation Leave, History & Reports, Settings (compensation_*.py, overtime.py, holiday_work_views.py, employee_compensation_views.py)

Staff only (production is never affected). Everything is gated, in this order, by the **master switch** (`PayrollSettings.compensation_feature_enabled`), the feature's **own switch** (`CompensationConfig`) and the feature's **effective-from date** (so a month already paid is never judged again), then `employment_type == "staff"`. Master OFF: every GET still works, every change is refused with 403 `{"error": "The OT / Compensation features are switched off ..."}`. The master switch and the old OT fields it mirrors (`compensationFeatureEnabled`, `otDetectionEnabled`, `otThresholdMinutes`, `otCompensationType`) are ONE company-wide value: a branch login's private overlay never overrides them, and `PUT /api/payroll-settings` from a branch login answers 403 `company_wide_rule`. Errors are `{"error": "<one plain sentence>"}` (+ `code` where named). Dates `YYYY-MM-DD`, times `HH:MM`, shifts `0.25 | 0.5 | 0.75 | 1`. HR endpoints are branch-scoped and use permission module `compensation` (the Settings tab uses `settings.compensation`).

**Settings (`compensation_settings_views.py`)**
- **GET `/api/compensation/settings`** (module `settings.compensation`) and **GET `/api/compensation/config`** (module `compensation`, same body, read-only) — `{masterEnabled, allowance{enabled, effectiveFrom}, shift{enabled, minExtraMinutes (default 150), relaxationEnabled, payEnabled}, windows{enabled}, holidayWork{enabled}, birthday{enabled, effectiveFrom}, allowanceRules[{id, label, enabled, minExtraMinutes, allowanceMinutes, sortOrder}], shiftRules[{id, label, enabled, untilMinutes, shifts, sortOrder}], updatedBy, updatedAt}`. `untilMinutes` = minutes after the OT day's midnight (1260 = 21:00, 1560 = 02:00 next day), `null` = no limit.
- **PUT `/api/compensation/settings`** — same body without `masterEnabled / updatedBy / updatedAt`; every group optional; the two rule arrays REPLACE the table (an id updates, no id creates, a missing id deletes; array order = table order). All-or-nothing: any problem is a 400 with one sentence and nothing is saved. Rules: allowance minutes 0..240, `minExtraMinutes >= 1` and unique among enabled rows, `shifts` one of the four, `untilMinutes` strictly increasing among enabled rows and the last enabled row has none, an enabled feature needs at least one enabled rule (Type 2 also needs relaxation and/or payment on). Switching Allowance or Birthday off → on without a date stamps **today** (IST). The tab stays editable while the master switch is off. A branch login can read but gets 403 `company_wide_settings` on PUT. The save is atomic and reads the settings row `FOR UPDATE` (two saves cannot interleave); it is audited (module `compensation_settings`, action `update`, old and new rule tables); the response carries `warnings` (a dated feature or windows switched off, or switched on again with a later start date than before; one sentence when an allowance row asks for more extra work than where Type 2 starts; one sentence when a Type 2 ladder row can only be earned by a punch the system does not attach to the working day (advice read from the active staff shift templates, never blocking the save). Saving also mirrors detection on/off and the earliest start into the legacy `PayrollSettings.ot_detection_enabled / ot_threshold_minutes` so the Report Center and MD readers of those columns stay true. Defaults (migration 0119): allowance 1 h / 1 h 30 → 30 min, 2 h / 2 h 30 → 60 min; Type 2 ladder until 9:00 PM 0.25, 12:00 AM 0.50, 2:00 AM next day 0.75, no limit 1.00.

**OT Detection (`compensation_views.py`, `overtime.py`)**
- **GET `/api/compensation/ot?month=&year=&status=&type=&departmentId=&employeeId=`** — the month's OT rows (`results`, `count`, `settings`, `config`). Each row: employee, `date`, `shiftEndTime`, `lastPunchOut`, `lastPunchNextDay`, `otMinutes`, `otType` (`allowance` = Type 1, `shift` = Type 2, `legacy` = before the overhaul), `allowanceMinutes`, `suggestedShifts`, `shifts`, `claimDate`, `status` (`auto | detected | announced ("Assigned") | rejected`), `compensationType` (`relaxation | pay`), `allowanceUsed / usedOn / usedMinutes` (Type 1), `allowanceStatus` (Type 1: `used | not_used | pending`, `pending` while the employee's next working day is today or later; null for other rows), `canAssign` (a detected Type 2 row). Type 1 rows are automatic and have no action; nothing is listed for Sundays, holidays or production. Year outside 2000..2100 is a 400. **Detection is not tied to this page:** `overtime_scheduler.py` runs `overtime.run_detection_job` every 15 minutes (re-derives the stored day of staff whose punches arrived after it was last computed, then syncs the month; nothing while the master switch or both OT features are off; not started under the test runner) and `GET /api/employee/compensation` refreshes that employee's own undecided rows. This list only runs detection for a login that may edit Compensation; a view-only login never writes. Detection is an idempotent compare-and-set upsert: a second pass writes nothing, and a row HR decided meanwhile is never overwritten or deleted.
- **POST `/api/compensation/ot/assign`** — `{records:[{employeeId, date, shifts?, claimDate?}], mode:"relaxation"|"pay", shifts?, claimDate?}`. `claimDate` is any date of the same month as the OT date (required for relaxation). Relaxation tops that day's attendance up (never above 1.00, not on a Sunday / holiday / off Saturday) and marks it `relaxation`; payment is picked up by that month's payroll. At most 200 records per call. Answers `{assigned, results, skipped:[{employeeId, date, reason}]}`; 400 when nothing could be assigned; 403 when Type 2 or the chosen mode is switched off. Audited (`assign`).
- **POST `/api/compensation/ot/reject`** `{records:[{employeeId, date}]}` → `{rejected}` (compare-and-set on status `detected`). **POST `/api/compensation/ot/announce`** is the legacy route for old records. Both legacy routes, and the old **POST `/api/compensation/credits/<id>/redeem`**, now work only on staff of the caller's branch, handle each record in a transaction under row locks (employee first, then record) and audit one entry per record; a Type 2 row in `announce` needs Type 2 switched on; the credit redeem refuses (400) a credit already spent through the balance and production employees.
- **GET `/api/compensation/balance[?employeeId=]`** and **POST `/api/compensation/balance/redeem`** `{employeeId, date, shifts}` — the compensation balance (ledger credits + still-available legacy credits − redemptions) and taking part of it as a paid day off (refused above the balance, on a Sunday / holiday / full day).
- Pay: an assigned Type 2 `pay` record adds **shifts × the employee's daily rate** to that month's payslip (`earnings.otShifts`; `otDays` stays the number of pay records). Type 1 is never paid.

**Compensation Leave**
- **A. Windows** — **GET/POST `/api/compensation/windows`**, **DELETE `/api/compensation/windows/<id>`** (`compensation_windows_views.py`). POST `{date, kind:"late_in"|"early_out", time, reason, branchId?, departmentId?, employeeIds?}`: today or later (max 180 days), one window of a kind per person per date, only a future date can be deleted. For that date the announced time replaces the shift's start/end **and grace**, but only for an employee whose own shift it RELAXES (a late-in later than the shift's start + grace, an early-out earlier than the shift's end - grace); for anyone else it is ignored (no verdict change, no marker). No late-in / early-out is detected for the announced period. GET `?kind=windows|late_in|early_out|day|all&month=&year=&date=&upcoming=1`. The older `/api/compensation/leave-days` routes still handle whole-day exemptions.
- **B. Sunday / holiday work** (`holiday_work_views.py`): **POST `/api/compensation/holiday-work`** `{employeeId | employeeIds | items:[{employeeId, shifts}], workDate, shifts, reason}` (a Sunday or declared holiday, not in the future, active staff who worked, one pending-or-approved claim per person per date; 201 `{created, warnings, claims}`); **GET `/api/compensation/holiday-work?status=&month=&year=&employeeId=&departmentId=&branchId=&limit=&anyMonth=`** (+ `summary`, `enabled`; `anyMonth=1` without an explicit month / year lists every month, e.g. everything still pending, and answers `month` / `year` null); **GET `.../<id>`**; **GET `.../eligible?date=`** (who worked that day, with punch summary and why somebody is not eligible); **DELETE `.../<id>`** withdraws a still-pending claim. Needs the Settings switch **and** the `holiday_work` approval workflow ON. The claim goes to the employee's Department Head (who gets a notification of type `holiday_work`; a head is never notified about their own claim, because nobody can decide it, and HR gets a `warnings` sentence instead): **PATCH `/api/manager/holiday-work/<id>/status`** `{status:"approved"|"rejected", comment?}` (employee token; needs `can_approve_compensation`). Approval adds the shifts **once** to the balance (`CompensationLedger` credit, source `holiday_work`; guarded by a unique index) and notifies the employee; the decision is audited (module `compensation`, action `approve` / `reject`, with the ledger entry id). `GET /api/manager/me` gains `canApproveCompensation` and `pendingCompensationCount`; `GET /api/manager/pending-requests` gains `holidayWorkClaims`; `/api/department-managers` carries `canApproveCompensation`; `/api/hr-requests` has the kind `holiday_work` (HR → HOD, link to the Compensation page).
- **C. Birthdays** — **GET `/api/compensation/birthdays?period=today|week|month&date=&departmentId=&branchId=`** (`compensation_birthday_views.py`): active staff with a birthday in the period, whether they benefit (master + Birthday switch + effective date + a working day, not before joining) and what the day record says. The leave itself is automatic in the attendance engine: Present, 1.00 shift, every flag off, whatever the punches or leave; 29 Feb is the 28th in other years; no birth year is returned.

**History & Reports (`compensation_reports_views.py`)** — **GET `/api/compensation/reports?period=today|week|month&date=&type=&departmentId=&branchId=`**: sections in this order, each with `summary` and `rows` (every row has the same `rowKeys`, unused ones `null`, so one export serves all; `extraMinutes` = minutes worked past the shift end on the Type 1 / Type 2 rows, `allowanceMinutes` = the allowance earned on the Type 1 rows): `ot_allowance` (used / not used / pending), `ot_shift_relaxation` (applied / scheduled / not applied), `ot_shift_pay` (in payroll / pending payroll, amount = shifts × daily rate), `window_late_in`, `window_early_out` (who used them), `holiday_work` (claims by status + `redemptions`), `birthday`. Pre-overhaul records are not included. A constant number of queries whatever the number of employees.

**Employee apps (employee token; production gets `isStaff:false`)**
- **GET `/api/employee/compensation`** — `{isStaff, enabled{master, allowance, shift, relaxation, pay, windows, holidayWork, birthday, any}, balanceShifts, items[], todayAllowance, tomorrowAllowance, askHr{title, text, points, contact}, message}` (`message` is null for staff; a production employee gets the same shape with everything off, `askHr: null` and a sentence in `message`). Employee token only. Item kinds: `ot_allowance`, `ot_shift`, `ot_shift_relaxation`, `ot_shift_pay`, `holiday_work`, `redemption`, `window_late_in`, `window_early_out`, `birthday`; groups `detected | assigned | company | birthday | balance`. **Item** `{key, kind, group, date, title, detail, status, statusLabel, shifts, minutes, minutesUsed, used}` plus, only where they apply: `workDate` (`YYYY-MM-DD`, only on `ot_shift_relaxation`, `ot_shift_pay` and `holiday_work`: the day the work was done, which can differ from `date` when HR granted the relaxation / pay for a later day), `time` (`HH:MM`, only on the two window kinds: the announced time) and `legacy` (only on `ot_shift_relaxation` / `ot_shift_pay`; true for a record from before the OT overhaul, which counts one shift). `shifts` is null where no shift amount applies, including a paid birthday (it never touches the balance). `status` is one of `detected | assigned | applied | scheduled | not_applied | used | not_used | available | pending | pending_hod | approved | rejected | taken | upcoming | today | not_applicable` and `statusLabel` is the sentence to print. `ot_allowance`: `used` (a day carries its marker), `not_used` (a worked day in its window did not need it, or its window has passed), `available` (nothing used it yet and the window is still open). `holiday_work`: `pending_hod`, `approved`, `rejected`; when NOBODY can decide a waiting claim (no active Department Head, the employee is their own head, or their head's `can_approve_compensation` is off) the status stays `pending_hod` but `statusLabel` is "No Department Head can decide this yet: contact HR" and `detail` says which case it is (the Settings switches are not such a case: a waiting claim can still be decided while they are off). `redemption` detail is always built from the formatted date ("HR used 0.25 shift of your compensation balance for Monday 12 Oct 2026."), never from HR's ledger note. **todayAllowance / tomorrowAllowance** are null or `{date, minutes, workDate, onTimeUntil, note}`: `date` is the day the allowance applies on (`tomorrowAllowance` is the next WORKING day of the employee's shift, not always tomorrow), `workDate` the OT day that earned it, `onTimeUntil` the latest on-time arrival `HH:MM` (null without a shift), `note` the sentence to print. **askHr.contact** is Settings → HR Contact: `{label, phone, phoneDial, whatsapp, whatsappNumber, email, hours, hasContact, usesHrFallback}` (`usesHrFallback` is always false here). `dayKind` differs by source, so never share one mapping: a holiday-work claim (`/api/manager/pending-requests` `holidayWorkClaims[].dayKind`) is `sunday | holiday`, an attendance day record (`/api/attendance/employee/<id>`, employee-shift-stats `dailyLogs`) is `holiday | weekly_off | null`.
- **GET `/api/employee/hod`** — the employee's one Department Head (name, phone, `photoUrl` (a URL or an embedded image), designation, department, branch, email), the `approvals` that head can give (`leave, permission, casual_leave, missing_punch, on_duty, attendance_correction, resignation, outpass, holiday_work`, each with `canApprove` and a `reason`), `hrContact`, `contactNote`, `message`; `employeeId` and `employeeCode` (the head's own, only when `assigned`); `assigned:false` with a message and an empty `approvals` when there is none, `isSelf:true` (present only then) for a Department Head who is their own head: their message says that a head never approves their own requests, that who decides them depends on the approval path HR set for each kind, and that a request only a Department Head can decide (holiday-work compensation) needs another head. Each approval is `{key, label, canApprove, reason, requestedBy, path}`; `holiday_work` with the Settings → Compensation switch (or the master switch) OFF is `canApprove: true` with a `reason` that says no new claims can be raised but waiting ones can still be decided, because the manager endpoints never look at that switch for a claim that already exists (the apps print `reason` only for `canApprove: false`).

**The day marker.** Every attendance JSON that shows a day (employee history, monthly, shift stats, search range, report log + sheet (a sheet cell carries the keys only when it has a marker), daily list for birthday / relaxation days, payroll breakdown days) carries `compensationKind` (`null | ot_allowance | window_late_in | window_early_out | birthday | relaxation`; when several apply: birthday > relaxation > window_late_in > window_early_out > ot_allowance), `compensationMinutes` (allowance minutes the arrival used) and `compensationNote` (one sentence). Stored on `AttendanceDayRecord.compensation_kind / compensation_minutes / compensation_note` (+ `ot_extra_minutes`, the plain fact of minutes past the shift end).

**Type 1 rule.** The previous working day's extra minutes → the allowance row with the most extra work reached (only up to `shift.minExtraMinutes`; more is Type 2's) → the first punch is judged from shift start + allowance, the shift's grace on top; the marker is written only when the allowance was actually used. Automatic, never paid.

**Type 2 rule.** More than `shift.minExtraMinutes` (150) past the shift end → HR assigns shifts (suggested from the last punch-out via the ladder), as relaxation or payment, for a date of the same month.

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
- **PATCH /api/recruitment/resignations/\<pk\>/action** — `@require_hr`. HR's approve/reject action under the configured pipeline (built-in: approval only once the Department Head has approved, i.e. status `dept_approved`; rejecting is allowed from any non-final status, out of turn too). Only the approval that completes the pipeline deactivates the employee (`status="inactive"`) and notifies them; an earlier approval just records HR's step.
- **DELETE /api/recruitment/resignations/\<pk\>/delete** — `@require_hr`. Branch-scoped hard delete of a resignation request.
- **GET /api/recruitment/resignations/\<pk\>/pdf** — `@require_hr`. Generates and streams the resignation-acceptance-letter PDF for an approved resignation (400 if not yet approved).
- **POST /api/recruitment/resignations/\<pk\>/email** — `@require_hr`. Emails the resignation-acceptance letter (HTML body + PDF attachment) to the employee's (or an overriding `toEmail`) address via the configured SMTP settings; 400 if SMTP isn't configured or the resignation isn't approved.
- **POST /api/recruitment/resignations/\<pk\>/whatsapp** — `@require_hr`. Sends the same resignation-acceptance PDF via WhatsApp using `whatsapp_service`; 400 if WhatsApp isn't configured or the resignation isn't approved.
- **GET/POST /api/my/resignation** — `@require_auth`. GET returns the calling employee's most recent resignation request (or `null`); POST lets the employee submit a new one, blocked while one is pending/dept_approved, and notifies the relevant dept-head managers.
- **GET /api/manager/resignations** — `@require_auth`. Department-head mobile view of resignation requests within that manager's scope (department + direct employee assignments), filterable by `status` (default "pending").
- **PATCH /api/manager/resignations/\<pk\>/action** — `@require_auth`. Department head's mobile approve/reject action (requires `can_approve_resignations` on their `DepartmentManager` row and the resignation to be in their scope and still `pending`); approve either completes the pipeline or passes it on (built-in: status `dept_approved`, awaiting HR), reject is terminal and notifies the employee either way.

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

## One-time codes: sign in, forgot password, first-time password (otp_views.py, otp_service.py)

Public endpoints for the Employee Web App and the mobile app (no login; throttled per client IP: `otp_request` 300/min, `otp_verify` 600/min, `NUM_PROXIES` says who the client is). The code goes by **WhatsApp or SMS (2Factor)**, whichever HR chose on SMS Control (`SmsSettings.otp_channel`, default `whatsapp`). The SMS side is set up as described in `twofactor-sms-otp-integration.md`. A throttled call answers 429 `{ error, retryAfterSeconds }` with a `Retry-After` header; a non-text code or password, a NUL byte or a non-object body is a clean 400.

- **GET `/api/auth/login-options`** — `{ otpLogin, otpReset, otpActivate, passwordLogin, otpChannel, codeLength }`. A code method is `true` only when its switch is on and the active channel is configured and allowed to send; `passwordLogin` is `true` whenever code sign-in cannot work. `otpChannel` (`"sms"` | `"whatsapp"`) and `codeLength` (`4` for SMS, `6` for WhatsApp: how many digits a code issued now has) are additive.
- **POST `/api/auth/otp/request`** — `{ employeeCode, purpose: "login" | "reset" | "activate" }` (the mobile app sends `identifier`). Makes a code (4 digits by SMS, 6 by WhatsApp; only a salted HMAC is stored, the length is stored as `employee_otp.code_length`), sends it to the employee's registered number and returns `{ message, maskedPhone, expiresInSeconds, resendAfterSeconds, channel, codeLength }` (`channel` and `codeLength` are additive). 400 no valid mobile number, 403 purpose switched off or account inactive, 404 not registered, 409 already has a password (activate), 429 resend wait / hourly allowance / (SMS only) 10 codes in 24 hours (with `retryAfterSeconds` for a wait) / per-number cap / per-IP throttle, 502 the send failed (the code is discarded), 503 SMS not available or temporarily unavailable.
- **POST `/api/auth/otp/login`** `{ employeeCode, otp }` returns `{ token, role, employeeId, name }`; **POST `/api/auth/otp/reset-password`** and **POST `/api/auth/otp/activate`** `{ employeeCode, otp, password }` (password at least 8 characters) return `{ message }`. A code works once, expires (default 5 minutes), is bound to its purpose and allows a limited number of wrong tries; every verify failure is the same "incorrect or expired" sentence.

## SMS Control (sms_control_views.py, sms_service.py, twofactor_client.py)

All `@require_hr`, module `sms_control` (GET needs view, PUT / POST need edit). A branch login reads its own branch's rows and gets 403 `company_wide_settings` on a change or a test. The 2Factor API key is never accepted, stored in the database, returned or logged: it lives in the server environment only.

- **GET `/api/sms-control/overview`** — `{ provider: "twofactor", channel, configured, sendingAllowed, sendingNote, env: { authKey, senderId, templateName, apiBase }, balance, today: { sent, failed, blocked }, last7Days: [{ date, sent, failed }], lastSentAt, limits: { hourlyCap, dailyCap, hourUsed, dayUsed }, circuit: { paused, until } }`. `env.authKey` says only whether the key is set (a boolean, never the key); `senderId` / `templateName` are plain strings (empty when unset or still a placeholder); `balance` is a note ("look at the balance in the 2Factor panel": 2Factor documents no balance call).
- **GET, PUT `/api/sms-control/settings`** — `{ otpChannel, otpLoginEnabled, otpResetEnabled, otpActivateEnabled, otpExpiryMinutes (1-15), resendCooldownSeconds (30-600), maxRequestsPerHour (1-20), maxAttemptsPerCode (3-5), maxPerPhonePerHour (1-20), hourlyCap (1-10000), dailyCap (1-10000), version, updatedAt, updatedBy, warnings }`. PUT is all-or-nothing (any problem is a 400 `{ error }` and nothing is saved; an hourly cap above the daily one is a 400), takes any subset of the keys, honours `expectedVersion` (400 code `stale_settings`), and **refuses `otpChannel: "sms"` (400, "SMS cannot be selected until 2Factor is configured on the server: missing: ...") until 2Factor is configured on the server**. Audited (module `sms_control`, action `update`).
- **GET `/api/sms-control/messages`** — newest first. Filters `status` (`sent` | `failed` | `blocked`), `purpose` (`login` | `reset` | `activate` | `test`), `search`, `dateFrom`, `dateTo` (YYYY-MM-DD), `page`, `pageSize` (at most 200). `{ items: [{ id, at, employeeId, employeeName, employeeCode, maskedPhone, purpose, status, error, providerMessageId, ip }], total, page, pageSize, statusCounts }`. Never a code or a full number.
- **POST `/api/sms-control/test`** — `{ phone }`: sends one real SMS through the real template with the dummy code `1234`. `200 { ok, message }` for everything about the send itself (accepted, refused by 2Factor, not configured, a limit), 400 for a bad number, 429 after 3 tests an hour per HR user. Audited (action `test`, masked number only).

## Endpoint Sharing (shared_endpoint_views.py, shared_endpoint_admin_views.py, shared_datasets.py)

Settings → Endpoint Sharing: the **super administrator** publishes chosen HR data to other applications as read-only addresses. The rules and the security model are in `backend.md` Section 4.16.

**Public call (no HR login, no auth decorator by design; `shared/` is exempt from the permission middleware and `/api/shared/` from the global CORS)**

- **GET `/api/shared/<slug>`** (and the browser preflight **OPTIONS**) — read-only JSON. Auth: `Authorization: Bearer <key>` or `X-API-Key: <key>` (never the query string); a key belongs to exactly one endpoint. Checks in order: endpoint exists and is enabled (404 `not_found`), `Origin` (403 `origin_not_allowed` / `origin_required`), key (401 `invalid_key`), per-key rate limit (429 `rate_limited` + `Retry-After`), parameters (400 `invalid_parameter`, with `parameter`). Query: the dataset's declared filters (an unknown or repeated name is a 400), `page`, `pageSize`. 200: `{ data: [ {selected fields only} ], meta: { endpoint, dataset, fields, page, pageSize, total, hasMore, generatedAt } }` with `Cache-Control: no-store`. An allowed origin gets `Access-Control-Allow-Origin: <that origin>` on every response (never `*`, never credentials). Other methods: 405.

**Management (`require_company_super_admin`: an active super administrator not tied to a branch; everyone else 403, no token 401; audited, module `shared_endpoints`)**

- **GET `/api/shared-endpoints/catalog`** — the datasets with their fields (`key`, `label`, `type`, `sensitivity`, `description`) and filters, the plain-text list of what can never be shared, the sensitivity levels and the limits.
- **GET, POST `/api/shared-endpoints`** — list (`{ endpoints, limits }`, each with live keys, calls in the last 24 h, last call, `sensitiveFields`) and create (`slug`, `dataset`, `name`, `description`, `fields`, `lockedFilters`, `origins`, `allowNoOrigin`, `pageSizeDefault`, `pageSizeMax`, `rateLimitPerMinute`, `enabled`; 201). Selecting a personal or financial field needs `acknowledgeSensitive: true` (else 400 code `sensitive_confirmation_required`).
- **GET, PUT, DELETE `/api/shared-endpoints/<id>`** — one endpoint; `PUT` replaces its settings all-or-nothing (the slug and dataset can never change; `expectedVersion` stale guard, 400 code `stale_settings`; a save that changes nothing writes nothing); `DELETE` removes it with its keys and origins (the access log is kept).
- **GET, POST `/api/shared-endpoints/<id>/keys`** and **DELETE `/api/shared-endpoints/<id>/keys/<kid>`** — list keys (never a key or hash), create one (`{ label, expiresAt? }`, 201: the plaintext key is returned **once**, at most 10 live keys), revoke (immediate; repeating it is a no-op).
- **POST `/api/shared-endpoints/<id>/preview`** — `{ limit ≤ 5, filters? }`: the first rows exactly as the public call would shape them; no key, no log row.
- **GET `/api/shared-endpoints/<id>/activity`** and **GET `/api/shared-endpoints/activity`** — the access log (`page`, `pageSize` ≤ 200, `status` = `ok` | `error` | an HTTP code; the second form takes `endpointId`).
- **GET `/api/shared-endpoints/<id>/guide`** — the generated integration guide data for that endpoint (address, headers, parameters, response schema, error table, example code in six languages).

**Datasets** (a field is shared only if it is in the endpoint's saved list **and** in this catalog; sensitivity in brackets):

| Dataset | Fields | Filters |
|---|---|---|
| `employees` | employeeCode, firstName, lastName, fullName, status, employmentType, department, designation, branch, joinDate (basic); phone, email, gender, dateOfBirth, address (personal); salaryAmount, salaryPerShift, salaryType (financial) | status (`active` default, `inactive`, `all`), employmentType, departmentId, branchId, employeeCode, visibleToExternal |
| `departments`, `branches`, `designations` | id, name, branch / id, name, code / id, title, department, level (all basic) | none |
| `attendance-days` | employeeCode, employeeName, date, status, firstPunch, lastPunch, shiftsEarned, isLate, earlyLeave, isHalfShift, compensationKind (basic) | **dateFrom and dateTo required (at most 31 days)**, employeeCode, departmentId, branchId, employmentType |
| `attendance-punches` | employeeCode, date, time, source (basic; the source is a kind, never a device id) | **dateFrom and dateTo required (at most 7 days)**, employeeCode, departmentId |
| `leave-requests` | employeeCode, employeeName (basic); leaveType, startDate, endDate, days, status, reason (personal) | dateFrom, dateTo (at most 366 days), status, employeeCode |
| `holidays` | date, name, type (basic) | year |
| `payroll-summary` | employeeCode, employeeName, month, year, periodStart, periodEnd (basic); paidDays, grossPay, totalDeductions, netPay (financial) | **month (YYYY-MM) required**, employmentType |

Never shareable: password hashes, tokens, OTPs, device secrets and API keys; Aadhaar, PAN and any government ID; bank names, account numbers and IFSC; PF / ESI / UAN numbers; photographs; biometric and device ids; HR user accounts, roles and sessions; any column not in the catalog. Money is rupees as a number with two decimals, dates `YYYY-MM-DD`, times `HH:MM:SS`, date-times ISO 8601 with the +05:30 offset.
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

## Reports (api/reporting/)

The Report Center. All endpoints are `@api_view(["GET"])` + `@require_hr`, branch-scoped through `ReportContext.emp_q()`, and sit under `/api/reports/` (module `reports`).

- **GET /api/reports/catalog** — Every report the caller may run (id, title, description, category, icon, tags, family/variant, filters with resolved defaults, columns, export formats) plus the department/designation/branch option lists and the categories with counts. Reports whose owning modules the role lacks, and admin-only reports for non-super-admins, are omitted.
- **GET /api/reports/run/\<id\>?\<filters\>** — Runs one report: `{ id, title, category, generatedAt, generatedBy, filters[] (echo), columns[], rows[], totals, summary[], notes[], rowCount, truncated, limit }`. Filter parameters: `period=YYYY-MM`, `year`, `dateFrom`/`dateTo`, `departmentIds`/`designationIds`/`branchIds`/`employeeIds` (comma lists), `employmentType`, `employeeStatus`, plus report-specific select/boolean/number/text filters. Errors: 400 `invalid_filter` (with `field`), 403 `report_forbidden`, 404 `not_found`, 500 `report_failed`.
- **GET /api/reports/export/\<id\>?fmt=xlsx|pdf&\<filters\>** — The same data as a file (`Cache-Control: no-store`, audited). 413 `too_many_rows` when the result exceeds the format's limit (PDF 5,000, Excel 30,000).
- **GET /api/reports/options/employees?q=&ids=&departmentIds=** — Employee picker search (max 40 hits; `ids` resolves chips). Refused for roles that can open no report with an employee filter.
- **Legacy (deprecated, unused)** — `/api/reports/attendance-log`, `attendance-summary`, `leave`, `leave-balance`, `payroll`, `pf-esi`, `employees`, `headcount`, `settlement`, `new-joinings` (`reports_views.py`) remain for one release only.

## MD Portal & AI Assistant (api/md_portal/)

Everything is for the one account with `HRUser.is_md`. Every `/api/md/*` view is GET-only, `@require_md` (re-reads the database each request) and runs inside `read_only_db()`: the database refuses writes there. Anyone else gets 401 (no token) or 403. Common query parameters: `period` (`today`, `last_7_days`, `last_30_days`, `this_month`, `last_month`, `last_90_days`, `last_12_months`, `this_year`, `this_financial_year`, `custom` with `from`/`to`), and the scope `branch` (unit id), `department` (name), `type` (`staff`/`production`). Every answer is an envelope: `{ ...data, generatedAt, period, scope, provenance[] (id, title, dataset, definition, formula, rows, filters, caveats), notes[], tookMs }`; a bad parameter is a 400 with a readable message.

- **GET /api/md/me, /api/md/org** — who the MD is and which pages they have (the same list the assistant may suggest); units, departments and their unit for the filter bar.
- **GET /api/md/dashboard/overview, trends, briefing** — the first screen: up to 8 headline cards (each module's own `headline()`), merged exceptions (`insights()` of every page), today's attendance by unit, a plain-words briefing; the three trend charts; the briefing alone. A module that fails shows as an error entry, never takes the page down.
- **GET /api/md/attendance/summary, trend, departments, weekday, heatmap, exceptions, overtime, leave, day** — attendance %, absenteeism, late, overtime, half days, missing punches with the previous period; trend by day/week; ranking by department/unit/type; weekday pattern; department-by-day heat map; chronic absentees, late-comers, long absences, absences after a day off; overtime; leave; one day's roster. Today is provisional and never part of a rate.
- **GET /api/md/employees/summary, composition, movement, attrition, insights, milestones, directory, employee/\<id\>** — headcount, joiners, leavers, attrition, tenure; composition by type/unit/department/designation/age/gender and planned vs actual staff; monthly movement; attrition by group, reasons, time served, early leavers; milestones; a searchable directory (no salary or contact details); one person's story.
- **GET /api/md/visitors/summary, trend, visitors, outpass, units, exceptions, activity, day** and **GET /api/md/tea-break/summary, trend, departments, shifts, offenders, heatmap, rule, attention** — gate, visitor, outpass and tea-break analytics (visitors have no check-out, so nobody is shown as "inside").
- **GET /api/md/payroll/summary, trend, bridge, departments, distribution, components, advances, exceptions, status, attention** — gross/net/cost per head from salary slips, the month-on-month cost bridge, cost by department/unit/type, take-home distribution (counts only), earnings and deductions by head, advances outstanding, exceptions, whether the month is generated and paid.
- **GET /api/md/recruitment/summary, positions, funnel, joiners, resignations, sources, trend, attention** and **GET /api/md/activity/summary, trend, heatmap, users, modules, sensitive, sign-ins, after-hours, feed, attention** — hiring pipeline, open positions, resignations; what people did in the system and what looks unusual.
- **Reports:** the MD reads the Report Center through the ordinary `/api/reports/*` endpoints (read-only; the `md_only` executive reports appear only for the MD).
- **POST /api/md/assistant/ask** — `{ question, conversationId?, inputMode: "text"|"voice", language?, pageContext? }` stores the question and starts the answer as a background job; returns the two message ids. **GET /api/md/assistant/messages/\<id\>** polls it (status `pending|running|done|error`, live `progress[]`, then `answer`, `spokenSummary`, `explanation` {what I did, data used, assumptions, confidence}, `suggestedPages[]`, `followUps[]`). **POST /api/md/assistant/messages/\<id\>/cancel** stops a running job. **GET /api/md/assistant/status** says whether it is set up (key present, enabled, today's usage, models). **GET, DELETE /api/md/assistant/conversations** and **GET, DELETE .../conversations/\<id\>** list, read and delete the MD's own history. **POST /api/md/assistant/transcribe** (audio upload) turns a spoken question into text with Gemini when the browser cannot.
- **GET, PUT /api/hr-users/md-assistant** and **POST /api/hr-users/md-assistant/test** — `@require_super_admin`. Read/change the assistant's settings (enabled, model, fallback models, thinking level, privacy mode, lookup rounds, requests per minute; the API key is never accepted or returned) and test the connection with one tiny request. **POST /api/hr-users** and **PUT /api/hr-users/\<pk\>** accept `isMd` (and `replaceMd` to move the identity from the current MD); the change is audited.

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
- `is_md` — BooleanField, default False; the one Managing Director account (partial unique index `uniq_single_md` on `is_md` where true, so at most one). Only a super admin sets it, never on a super admin or a branch-scoped account. Grants `/api/md/*` and nothing else (migration `0111`)
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
- `production_pay_cycle` — TextField, `choices=CYCLE_CHOICES` (weekly/biweekly/monthly), nullable, indexed; the production pay cycle the employee is paid on (null = not assigned yet, so no cycle's payroll includes them); set on Employees → Production Employees
- `salary_basic`, `salary_da`, `salary_retaining_allowance` (first portion) and `salary_other_allowance`, `salary_petrol_allowance`, `salary_hra`, `salary_special_allowance`, `salary_ca` (second portion) — nullable DecimalField(10,2), the mandatory **50% + 50% split** of `salary_amount` (`salary_split.py`, migration `0106_salary_split`). All null = no split recorded (no salary amount, or created before the split existed). Descriptive only: payroll, attendance and salary slips never read them. Weekly and monthly salaries are split alike (`salary_type` only says how often the amount is paid). **Names:** these were first called `salary_retention_allowance` / `salary_rha` (typos: Retention -> Retaining, RHA -> HRA); migration `0110_salary_split_component_names` renames the model attributes only, so the two DATABASE COLUMNS are still `salary_retention_allowance` and `salary_rha` (`db_column`), nothing was moved or rewritten, and the previous release keeps working during a rollout. The API/JSON keys are `retainingAllowance` and `hra`; a submitted split or a bulk sheet that still uses the old names (`retentionAllowance`, `rha`, headers `Retention Allowance`, `RHA`) is understood (`salary_split.LEGACY_JSON_KEYS` / `LEGACY_LABELS`), only the new names are ever produced. A physical column rename can follow in a later release. This `hra` is unrelated to payroll's own HRA (`Payroll.hra`, `hra_percent`).
- `initial_salary` — DecimalField, baseline for increment tracking
- `status` — TextField, default `"active"`
- `password_hash` — TextField, nullable; bcrypt hash for mobile self-service login
- `last_mobile_login_at` — DateTimeField, nullable
- `location_tracking_enabled` — BooleanField, default False (Geo Attendance opt-in)
- `co_emp_enabled`: BooleanField, default False. Two meanings on one switch: visible to the CoPortal, and **PF / ESI apply to this employee** (and to nobody else)
- `tds_enabled`: BooleanField, default False (`db_default` False); `tds_percent`: DecimalField(5,2), nullable (migration 0126). The employee has TDS (that percentage of the period's earned pay) and no PF / ESI; mutually exclusive with `co_emp_enabled`; stays visible in the CoPortal
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

### ManagerEmployeeExclusion
**Table name:** `manager_employee_exclusions`

HR took one employee **out of** a department an HOD covers, without un-assigning the department. The employee stays in the department but no longer reports to this HOD (`hod_scope.py`: department coverage skips the pair, so the employee falls to the next active holder of the department or to nobody, i.e. HR). An individual `ManagerEmployeeAssignment` still beats it. New joiners to the department are not affected.

**Key fields:**
- `manager` — ForeignKey → `DepartmentManager`, `on_delete=CASCADE`, related_name `employee_exclusions`
- `employee` — ForeignKey → `Employee`, `on_delete=CASCADE`, related_name `hod_exclusions`
- `created_at` — DateTimeField
- `unique_together`: (`manager`, `employee`)

### ApprovalWorkflowConfig
**Table name:** `approval_workflow_configs`

HR's override of one approval workflow's pipeline and ON/OFF switch (User Management → Approval Workflow Control). A workflow with no row runs its built-in pipeline; a row is deleted again when it equals the built-in pipeline and the workflow is ON.

**Key fields:**
- `key` — CharField(40), unique (`leave`, `permission`, `casual_leave`, `missing_punch`, `on_duty`, `on_duty_punch`, `attendance_correction`, `outpass`, `request`, `resignation`, `advance`)
- `enabled` — BooleanField, default true, `db_default=True` (OFF = new requests are refused with 403 `workflow_disabled`)
- `steps` — JSONField, nullable (`[{roles: ["hod"|"hr", ...], mandatory: bool}]`; NULL = the built-in pipeline)
- `updated_by` — TextField; `updated_at` — DateTimeField

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

An employee's leave application spanning a date range, approved by HR and/or the Department Head as the leave pipeline in Approval Workflow Control says.

**Key fields:**
- `employee` — ForeignKey → `Employee`, `on_delete=CASCADE`, related_name `leave_requests`
- `leave_type_ref` — ForeignKey → `LeaveType`, `on_delete=SET_NULL`, null/blank, related_name `requests`
- `start_date`, `end_date` — TextField (stored as text, not DateField)
- `total_days` — DecimalField(4,1)
- `status` — TextField, default `"pending"` (pending/approved/rejected convention)
- `approver_role` — TextField, nullable (`"hr"` | `"dept_head"`)
- `approval_trail` — JSONField, nullable. The approvals recorded under the approval pipeline (`[{role, decision, by, at, comment, skipped?}]`); `[]` for a request made under the pipeline, NULL for a row from before it (its progress is then derived from the older per-role stamps). See Approval Workflow Control.
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
- `approval_trail` — JSONField, nullable. The approvals recorded under the approval pipeline (`[{role, decision, by, at, comment, skipped?}]`); `[]` for a request made under the pipeline, NULL for a row from before it (its progress is then derived from the older per-role stamps). See Approval Workflow Control.
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
- `approval_trail` — JSONField, nullable. The approvals recorded under the approval pipeline (`[{role, decision, by, at, comment, skipped?}]`); `[]` for a request made under the pipeline, NULL for a row from before it (its progress is then derived from the older per-role stamps). See Approval Workflow Control.
- `created_at`, `updated_at` — DateTimeField

### ResignationRequest
**Table name:** `resignation_requests`

An employee's resignation with an exit survey. Built-in it flows through `pending → dept_approved → approved` (or rejection at either stage); the statuses mean "awaiting the Department Head" / "awaiting HR" whatever order Approval Workflow Control gives the pipeline.

**Key fields:**
- `employee` — ForeignKey → `Employee`, `on_delete=CASCADE`, related_name `resignation_requests`
- `dept_head` — ForeignKey → `Employee`, `on_delete=SET_NULL`, null/blank, related_name `resignation_reviews`
- `last_working_date` — DateField, nullable
- `survey_q1_answer`, `survey_q2_answer`, `survey_q3_answer` — TextField
- `status`, `dept_head_status` — TextField (pending/dept_approved/approved/rejected convention)
- `dept_head_approved_at`, `approved_at` — DateTimeField
- `approval_trail` — JSONField, nullable. The approvals recorded under the approval pipeline (`[{role, decision, by, at, comment, skipped?}]`); `[]` for a request made under the pipeline, NULL for a row from before it (its progress is then derived from the older per-role stamps). See Approval Workflow Control.
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
- `approval_trail` — JSONField, nullable. The approvals recorded under the approval pipeline (`[{role, decision, by, at, comment, skipped?}]`); `[]` for a request made under the pipeline, NULL for a row from before it (its progress is then derived from the older per-role stamps). See Approval Workflow Control.
- `created_at` — DateTimeField

### MissingPunchRequest
**Table name:** `missing_punch_requests`

An employee's self-service "I forgot to punch" request for a specific punch slot on a date, approved by the Department Head then HR (built-in; the order is configurable); on final approval it is written as an ordinary `AttendanceLog` row rather than directly editing the day's record.

**Key fields:**
- `employee` — ForeignKey → `Employee`, `on_delete=CASCADE`, related_name `missing_punch_requests`
- `date` — DateField
- `punch_time` — TimeField
- `punch_type` — TextField, `choices=AttendanceLog.PUNCH_CHOICES` (IN/OUT)
- `punch_slot` — TextField, `choices=PUNCH_SLOT_CHOICES` (morning_in/lunch_out/lunch_in/evening_out), nullable
- `status` — TextField, `choices=STATUS_CHOICES` (pending_hod/pending_hr/approved/rejected)
- `hod_reviewed_by`, `hr_reviewed_by` — TextField
- `approval_trail` — JSONField, nullable. The approvals recorded under the approval pipeline (`[{role, decision, by, at, comment, skipped?}]`); `[]` for a request made under the pipeline, NULL for a row from before it (its progress is then derived from the older per-role stamps). See Approval Workflow Control.
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
- `last_heartbeat_at` — DateTimeField, nullable; last time the device polled the ADMS listener (about every 10 s while online). The "connected" signal.
- `last_data_at`, `last_punch_date`, `last_punch_time` — when an ATTLOG push last arrived and the newest punch in it (the device's clock)
- `last_remote_ip` — TextField (db default `""`); the public address the last contact came from
- `last_error`, `last_error_at` — what last went wrong receiving from it (e.g. unreadable attendance lines)
- `reported_config`, `reported_config_at` — JSONField (nullable); the device's own options upload (IP, firmware, time zone...)
- `last_sync_error`, `last_sync_error_at`, `last_reachable_at` — the pull direction: why the last attempt failed and when it last got through
- `users_read_at`, `users_read_error`, `capacity` (JSONField, nullable) — Device Control: when its user table was last read, why the last read failed, and what the device reported (users, faces, punches and their limits, serial, model, firmware, pin width)
- `connector` — ForeignKey to `BiometricSiteConnector` (SET_NULL), nullable, `related_name="devices"` (migration `0115`): the Site Connector that reaches this device, when the server cannot; null = the server connects itself
- ordering `["-is_default", "name"]`

All columns added by migration `0113_biometric_device_status` are nullable or carry a database default, so a release still running the previous code keeps working.

### BiometricProbe
**Table name:** `biometric_device_probes`

One connection check of one device, run from the server. Kept as a short history (the latest 30 per device) so the status page can show a slow or flapping device, not only its last state.

**Key fields:**
- `device` — ForeignKey to `BiometricDevice` (CASCADE), `related_name="probes"`
- `checked_at` — DateTimeField; `status` — TextField (reachable / timeout / refused / unreachable / dns / auth / error)
- `latency_ms`, `icmp_ms` — FloatField, nullable (TCP connect time and ping time)
- `error` — TextField; `detail` — JSONField (what the device reported about itself); `steps` — JSONField (`[{key, label, ok, ms, note}]`)
- `checked_from` — TextField, the host the check ran on
- ordering `["-checked_at"]`; index (`device`, `-checked_at`)

### BiometricUnknownPusher
**Table name:** `biometric_unknown_pushers`

A device that contacts the ADMS listener under a serial number no configured device carries: a new machine nobody added, or a configured one whose serial was mistyped.

**Key fields:**
- `serial_number` — TextField, unique
- `first_seen_at`, `last_seen_at` — DateTimeField; `last_remote_ip` — TextField
- `contact_count`, `punch_count` — IntegerField
- ordering `["-last_seen_at"]`

### BiometricDeviceUser
**Table name:** `biometric_device_users`

One user as a device holds it, as last read (Device Control -> Data Push). A snapshot so the page can filter every device at once; the device is the source of truth. The device password is never stored, only whether there is one.

**Key fields:**
- `device` — ForeignKey to `BiometricDevice` (CASCADE), `related_name="device_users"`
- `uid` — IntegerField, the device's own record number; `unique_together` (`device`, `uid`)
- `user_id` — TextField, indexed; the PIN on the device, which is the Employee Code
- `name`, `group` — TextField; `privilege` — IntegerField (0 user, 2 enroller, 6 administrator, 14 super admin); `card` — BigIntegerField; `has_password` — BooleanField
- `read_at` — DateTimeField, when this row was last confirmed on the device

### BiometricFetchRun
**Table name:** `biometric_fetch_runs`

One manual fetch of punches (Device Control -> Data Fetch), kept as a history. A background thread fills it in device by device; the page polls it.

**Key fields:**
- `mode` — `preview` or `update`; `status` — `running`, `done` or `failed`
- `started_by`, `range_label`, `date_from`, `date_to`, `device_ids` (JSON)
- `results` — JSONField, one entry per device; `summary` — JSONField, nullable; `error`
- `created_at`, `updated_at`, `finished_at`; a run with no update for 20 minutes is marked failed so it cannot block the next one

### BiometricSiteConnector
**Table name:** `biometric_site_connectors`

A Site Connector: the program at a factory. Created in the HRMS (which makes a pairing code), then paired.

**Key fields:**
- `name` — TextField, unique; `notes`; `is_active` — BooleanField (off = locked out at its next call)
- `token_hash` — CharField(64), indexed; SHA-256 of the token, empty until paired. `pairing_hash`, `pairing_expires_at` — the one-time code (SHA-256) and its expiry; `paired_at`
- `punch_sync_minutes` (default 15, 0 = never), `punch_sync_days` (default 2) — how it reads punches on its own
- `last_seen_at`, `last_remote_ip`, `version`, `hostname`, `os_info`; `status` — JSONField (`reportedAt`, `uptimeSeconds`, `outbox`, `devices{id: probe}`, `sync{id: last read}`); `created_by`, `created_at`
- online = heard from in the last 45 seconds

### BiometricDeviceOperation
**Table name:** `biometric_device_operations`

A read or change of devices that includes a device behind a connector, which cannot be answered inside the request.

**Key fields:**
- `kind` — refresh / apply / delete; `status` — running / done / failed
- `params` — JSONField (what was asked, without any device password); `actor` — JSONField (`jwtUser`, `branchScope`, `remoteAddr`: who asked, for the branch rules and the audit entry when it is finished later)
- `results` — JSONField (`{device id: result}`), `final` — JSONField (the answer the request would have returned), `error`
- `created_at`, `updated_at`, `finished_at`; finished operations older than 7 days can be pruned (`device_remote.prune_operations`)

### BiometricConnectorJob
**Table name:** `biometric_connector_jobs`

One thing a connector is asked to do on one device. The connector asks for work; nothing is pushed to it.

**Key fields:**
- `connector` — ForeignKey (CASCADE), `related_name="jobs"`; `device` — ForeignKey to `BiometricDevice` (CASCADE); `operation` — ForeignKey, nullable (CASCADE)
- `kind` — probe / read_users / apply_users / delete_users / read_punches; `payload` — JSONField (includes `target` = host, port, Comm Key; emptied when the job ends)
- `status` — queued / running / succeeded / failed / expired / cancelled; `result` — JSONField; `error_code`, `error_message`
- `attempts`; `last_seq` (the last punch chunk stored); `created_at`, `claimed_at`, `finished_at`, `expires_at` (probe 90 s, read users 4 min, writes 7 min, punches 30 min; a running job is given up on 3 minutes after it)
- indexes (`connector`, `status`) and (`operation`)

### BiometricConnectorPunch
**Table name:** `biometric_connector_punches`

Punches a connector read for a `read_punches` job, held until the manual fetch has processed them, then deleted. `job` — ForeignKey (CASCADE), `user_id`, `punch_date`, `punch_time`, `status`.

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
- `total_shifts`, `shift_deductions` — DecimalField(5,2); `shift_deductions` is the TOTAL shifts cut (the late pool plus, with Permission Deduction Slabs ON, the excess permissions priced on their own) and `salary_deduction_amount` the matching rupees, both worked out by `payroll_views.late_pool_pricing`, the same function payroll uses
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
- `shifts_earned` note: from the production shift rules' start date (`ProductionShiftConfig.rules_effective_from`) a production day is worth up to its group's top ladder value (3.00 with the default Day table), not 1.50; production `first_punch` / `last_punch` are the resolved shift day's (a night's closing punch is the next morning's clock time)
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
- `rules_enabled` — BooleanField, default true: the master switch of the production shift rules (October 2026)
- `rules_effective_from` — DateField, nullable: the first day the new rules judge (the migration sets the IST day it ran; a fresh row created later starts today; NULL = legacy only). Every earlier day keeps the calculation of `punch1_time`…`punch4_time`, `grace_minutes` (10) and `ProductionShiftSegment`, byte for byte
- `rules_grace_minutes` — IntegerField, default 5 (0..30); `rules_min_credit` — DecimalField(4,2), default 0.00; `rules_rounding_step` — DecimalField(4,2), default 0.01 (0.01/0.05/0.25); `rules_rounding_mode` — TextField, default `nearest` (or `down`); `rules_full_day_value` — DecimalField(4,2), default 1.00 (a day below it is `half_shift`)
- `rules_night_session_hours` — IntegerField, default 24 (1..24): the longest gap between an open "in" punch and the next day's first punch for that punch to close the night session
- All eight columns were added by an additive migration (`0121_production_shift_rules`) with Python and database defaults; no `AttendanceDayRecord`, payroll or salary-slip row is touched

### ProductionShiftSegment
**Table name:** `production_shift_segments`

An ordered, editable list of shift-value segments (time window → fractional shift credit) that together define the production 1.50-shift day, e.g. 4 × 0.25 plus a 0.50 overtime segment.

**Key fields:**
- `start_time`, `end_time` — TimeField
- `shift_value` — DecimalField(4,2)
- `order`, `is_active` — IntegerField / BooleanField
- ordering `["order", "id"]`

### ProductionShiftGroup
**Table name:** `production_shift_groups` (migration `0121_production_shift_rules`)

One kind of production day: where it starts, which first punches it takes, and its ladder of `ProductionShiftRule` rows.

**Key fields:**
- `label` — TextField; `kind` — TextField (day/night/sunday/custom, default custom); `applies_on` — TextField (mon_sat/sunday/all, default mon_sat)
- `start_time` — TimeField, the reference in-time (08:30 Day, 21:00 Night)
- `first_punch_from`, `first_punch_to` — TimeField: a day whose FIRST punch (clock time) falls in this window uses the group
- `main_out_time` — TimeField, nullable, with `main_out_next_day` BooleanField: the standard departure, used only for the early-leave flag
- `enabled` — BooleanField (default true), `order` — IntegerField, `created_at`, `updated_at`
- ordering `["order", "id"]`. Seed: Day shift (day, mon_sat, 08:30, first punch 04:00-16:59:59, main out 20:00), Night shift (night, all, 21:00, first punch 17:00-23:59:59, main out 05:30 next day), Sunday shift (sunday, sunday, 08:30, first punch 04:00-16:59:59, main out 17:00)

### ProductionShiftRule
**Table name:** `production_shift_rules`

One ladder point of a group: "a worker who leaves at `out_time` earned `shift_value`". Between two points the value grows in proportion to PAID time (breaks excluded). One out time appears once per group among the enabled rows (checked by the API, not by a database constraint).

**Key fields:**
- `group` — ForeignKey → `ProductionShiftGroup`, `on_delete=CASCADE`, related_name `rules`, column `group_id`
- `label` — TextField, blank allowed; `out_time` — TimeField; `out_next_day` — BooleanField (the next morning)
- `shift_value` — DecimalField(4,2); `enabled`, `order`, `created_at`, `updated_at`
- ordering `["order", "id"]`. Seed (11 rows): Day 10:30 0.25, 12:45 0.50, 15:30 0.75, 17:45 1.00, 20:00 1.50, 22:30 2.00, 00:30 next day 2.50, 05:30 next day 3.00; Night 00:00 next day 0.50, 05:30 next day 1.50; Sunday 17:00 1.00

### ProductionBreak
**Table name:** `production_breaks`

An UNPAID same-day window (tea, lunch, dinner), the same for every group on every day; nobody has to punch for it.

**Key fields:**
- `label` — TextField, blank allowed; `start_time`, `end_time` — TimeField (start before end); `enabled`, `order`, `created_at`, `updated_at`
- ordering `["order", "id"]`. Seed (5 rows): Morning tea 10:30-10:45, Lunch 12:45-13:30, Afternoon tea 15:30-15:45, Evening tea 17:45-18:00, Night dinner 20:00-21:00

## Geo Attendance & On-Duty

### OnDutySession
**Table name:** `on_duty_sessions`

An employee's declared day working away from the branch (field visit, driver, offsite work), provisionally active immediately but subject to the On-Duty approval pipeline (built-in: optional Department Head, then HR) before its captured punches become real attendance.

**Key fields:**
- `employee` — ForeignKey → `Employee`, `on_delete=CASCADE`, related_name `on_duty_sessions`
- `branch` — ForeignKey → `Branch`, `on_delete=SET_NULL`, null/blank (snapshot of assigned branch at request time)
- `status` — TextField, `choices=STATUS_CHOICES` (pending_hod/pending_hr/active/completed/rejected)
- `completion_reason` — TextField, `choices=COMPLETION_CHOICES` (manual/auto_4th_punch/auto_day_end), nullable
- `started_at`, `employee_ended_at`, `completed_at` — DateTimeField, nullable
- `approval_trail` — JSONField, nullable. The approvals recorded under the approval pipeline (`[{role, decision, by, at, comment, skipped?}]`); `[]` for a request made under the pipeline, NULL for a row from before it (its progress is then derived from the older per-role stamps). See Approval Workflow Control.
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
- `pf_deduction`, `esi_deduction`, `tds_deduction`: DecimalField(10,2), default 0; `tds_percent`: DecimalField(5,2), nullable, the percentage the TDS was taken at (a snapshot; null for an employee not on the TDS list). `total_deductions = pf + esi + tds + advance + late`
- `breakdown_details` — JSONField, nullable (full day-by-day traceability)
- `period_start`, `period_end` — DateField, nullable
- `pay_cycle` — TextField, `choices=CYCLE_CHOICES`, nullable; same meaning as `Payroll.pay_cycle`
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
- `tds_deduction`: DecimalField(10,2), default 0, and `tds_percent`: DecimalField(5,2), nullable: the TDS part of `deductions` and the percentage it was taken at (same meaning as on `SalarySlip`)
- `period_start`, `period_end` — DateField, nullable (configurable-period production payroll)
- `pay_cycle` — TextField, `choices=CYCLE_CHOICES`, nullable; the production pay cycle the row was generated on (null for staff rows and for production rows generated before the cycles existed, which follow their employee's cycle)
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

## SMS OTP Channel (api/models/sms.py; migration 0123)

Codes can go by SMS (2Factor) instead of WhatsApp; HR chooses on SMS Control. Setup and behaviour: `twofactor-sms-otp-integration.md`. The code table `employee_otp` (`EmployeeOtp`, shared by both channels) keeps only a salted HMAC of each code with its purpose, expiry, attempts counter, requesting IP and the number it was sent to.

### SmsSettings
**Table name:** `sms_settings` — singleton (pk=1, `SmsSettings.get()`). While `otp_channel` is `whatsapp` the three switches below do nothing and WhatsApp behaves exactly as before.

**Key fields:**
- `otp_channel` — CharField, `whatsapp` (default) | `sms`
- `otp_login_enabled`, `otp_reset_enabled`, `otp_activate_enabled` — BooleanField, default True (they apply while the channel is SMS)
- `otp_expiry_minutes` (5, range 1–15), `resend_cooldown_seconds` (60, 30–600), `max_requests_per_hour` (5, 1–20, per employee), `max_attempts_per_code` (5, 3–10), `max_per_phone_per_hour` (5, 1–20, per mobile number across employee records) — PositiveSmallIntegerField
- `hourly_cap` (default 300), `daily_cap` (default 1500) — PositiveIntegerField, 1–10000, the hourly cap never above the daily one
- `updated_at` (null until somebody saves), `updated_by` — ForeignKey → `HRUser`, `on_delete=SET_NULL`

### SmsMessageLog
**Table name:** `sms_message_log`

One row per SMS attempt, written as `sent` before the call and corrected to `failed` afterwards, or `blocked` when a cap or the circuit breaker stopped it. It never holds the code, the message text, the auth key or a full phone number.

**Key fields:**
- `employee` — ForeignKey → `Employee`, `on_delete=SET_NULL`, related_name `sms_messages` (null for a test); `sent_by` — ForeignKey → `HRUser`, `SET_NULL` (who sent a test)
- `phone_masked` (`••••••3210`), `phone_hash` (keyed HMAC-SHA256 of the normalised number, so the per-number cap can count without storing the number)
- `purpose` — `login` | `reset` | `activate` | `test`; `provider` (`twofactor`); `status` — `sent` | `failed` | `blocked`
- `provider_message_id` (2Factor's session id), `error` (one plain sentence, at most 300 characters), `error_code` (`ip`, `auth`, `template`, `balance`, `number`, `timeout`, `hourly_cap`, `daily_cap`, `phone_cap`, `paused` ...), `requested_ip`, `created_at`
- Indexes on `(status, created_at)`, `(phone_hash, created_at)` and `(created_at)`; ordering `["-created_at", "-id"]`

## Endpoint Sharing (api/models/shared_endpoints.py; migration 0122)

Four new tables behind Settings → Endpoint Sharing (super administrator only). What an endpoint may serve is the code catalog in `shared_datasets.py`; these tables hold the owner's choices. See `backend.md` Section 4.16.

### SharedEndpoint
**Table name:** `shared_endpoints`

**Key fields:**
- `slug` — unique, 3–60 lower-case letters, digits and hyphens, immutable (it is the public address `/api/shared/<slug>`); `name`, `description`
- `dataset` — key in the catalog (immutable); `fields` — JSON list of field keys, the only fields ever returned (the order is the response order)
- `locked_filters` — JSON object of filters a caller can never override
- `allow_no_origin` — BooleanField, default True (accept calls with no `Origin` header, such as servers); `enabled` — BooleanField, default True (a new endpoint serves nothing until it has a key)
- `page_size_default` (50), `page_size_max` (200, never above the dataset's), `rate_limit_per_minute` (60, 1–6000) — PositiveIntegerField
- `created_by`, `created_at`, `updated_at`

### SharedEndpointOrigin
**Table name:** `shared_endpoint_origins` — `endpoint` ForeignKey (CASCADE), `origin` (lower-case `scheme://host[:port]`, http only for localhost); unique `(endpoint, origin)`; at most 20 per endpoint.

### SharedEndpointKey
**Table name:** `shared_endpoint_keys` — `endpoint` ForeignKey (CASCADE), `label`, `prefix` (the 8 characters after `uks_`; not secret), `key_hash` (unique SHA-256 of the full key; **the key itself is never stored**), `created_by`, `created_at`, `expires_at`, `revoked_at`, `last_used_at`, `last_used_ip`; at most 10 live keys per endpoint.

### SharedEndpointAccessLog
**Table name:** `shared_endpoint_access_logs` — `endpoint` ForeignKey (`SET_NULL`, so deleting an endpoint keeps its history), `endpoint_slug`, `key` ForeignKey (`SET_NULL`), `at`, `status` (HTTP code), `rows`, `origin`, `ip`, `duration_ms`, `error` (a short code such as `invalid_key`, `origin_not_allowed`, `rate_limited`). Kept 90 days. Indexes on `(endpoint, at)`, `(key, at)` and `(at)`.
## Email (Gmail Control)

Every email the HRMS sends goes through `email_service.send_email()` and is logged. Full write-up, setup and switch defaults: `gmail-integration.md`. The Gmail account itself stays in `PayrollSettings.smtp_*` (Settings → SMTP).

### EmailMessageLog
**Table name:** `email_message_log`

One row per email attempt (salary slip, offer letter, ID card, resignation letter, visitor arrival, rejection / interview invite, test email), success or not.

**Key fields:**
- `employee` — ForeignKey → `Employee`, `on_delete=SET_NULL`, null/blank, related_name `email_messages` (empty for candidates and other outside recipients)
- `recipient_name`, `recipient_email` — TextField (kept when the employee is deleted)
- `email_type` — TextField (a key of `email_catalog.TYPES`); `related_module` — TextField; `ref_id` — IntegerField null (SalarySlip.id, ScreeningCandidate.id, ...)
- `subject`, `message_text` (plain-text wording that went out), `attachment_name` — TextField
- `status` — TextField: `sent` (the mail server accepted it) | `failed` (an attempt that could not complete) | `blocked` (deliberately not attempted: switched off, dev machine, daily limit, SMTP not set up); `error_message` — TextField
- `sent_by` — ForeignKey → `HRUser`, `on_delete=SET_NULL`, null/blank, related_name `emails_sent`
- Indexes on `(employee, email_type)`, `(status, -created_at)`, `(email_type, -created_at)`; ordering `["-created_at"]`

### EmailSettings
**Table name:** `email_settings` — singleton (pk=1) of the Gmail Control switches: `emails_enabled` (master), `document_emails_enabled`, `visitor_emails_enabled`, `recruitment_emails_enabled` (all default True) and `daily_send_limit` (0 = no limit).

### EmailMessageTemplate
**Table name:** `email_message_template` — per-type `email_type` (unique), `subject`, `message_body` (blank = the catalog default) and `is_enabled`.

## Gmail Control (HR page)

All `@require_hr`, module `gmail_control` (view to read, edit to change or send). A branch login sees its own branch's rows.

- **GET `/api/gmail-control/overview?days=`** — totals, today / this month, per-module and per-type counts, daily series, recent failures, and the read-only Gmail configuration (password never included).
- **GET `/api/gmail-control/messages`** — history, newest first. Filters: `status`, `category`, `type`, `employeeId`, `search`, `dateFrom`, `dateTo`; `page` / `pageSize` for the paged shape.
- **GET `/api/gmail-control/employees`** — employee-wise email counts (`search`, paged).
- **GET / PUT `/api/gmail-control/settings`** — the switches and `dailySendLimit` (0-5000). Non-boolean switches or out-of-range limits are a 400 and nothing is saved.
- **GET `/api/gmail-control/templates`** — every email type with its subject, wording, defaults, variables, details table, a rendered preview (text and HTML), switch state and usage.
- **PUT `/api/gmail-control/templates/<type>`** — `subject`, `messageBody`, `isEnabled`. Unknown `{{placeholders}}`, an over-long subject (200) or text (5,000) are a 400.
- **POST `/api/gmail-control/templates/<type>/preview`** — renders unsaved wording with sample values.
- **POST `/api/gmail-control/test-email`** — `{ toEmail }`. Answers 200 with `ok` / `status` / `error` whether or not it went out (a missing address is a 400).

The senders behind the Documents, Visitors and Resume Screening pages keep their endpoints and response shapes; each now sends through the service, so a failure carries the service's reason (400 for a request that can't be done: no address, switched off, SMTP not set up; 502 when the mail server said no).

## Compensation — OT & Compensation Leave (api/models/payroll.py, attendance.py, core.py; migrations 0118, 0119)

### CompensationConfig
**Table:** `compensation_config` — singleton (pk=1, `CompensationConfig.get()`): `allowance_enabled`, `allowance_effective_from`, `shift_enabled`, `shift_min_extra_minutes` (150), `relaxation_enabled`, `pay_enabled`, `windows_enabled`, `holiday_work_enabled`, `birthday_enabled`, `birthday_effective_from`, `updated_by`, `updated_at`. The master switch stays `PayrollSettings.compensation_feature_enabled`. Migration 0119 seeds it (Type 2 on when the old `ot_detection_enabled` was on; a customised old threshold T becomes `shift_min_extra_minutes` = max(1, T-1), the default 60 becomes the owner's 150). Migration 0120 adds three partial unique indexes (additive, no column changes; it stops with a message naming the rows first if any row already violates one): one open (pending or approved) holiday-work claim per employee and work date, one ledger credit per claim, one `ot_shift` credit per OT record.

### CompensationRule
**Table:** `compensation_rules` — editable rule rows. `kind` `allowance | shift`, `label`, `enabled`, `sort_order`; allowance: `min_extra_minutes`, `allowance_minutes`; shift: `until_minutes` (minutes after the OT day's midnight, null = no limit), `shifts`.

### HolidayWorkClaim
HR-raised claim for work on a Sunday or declared holiday: `employee`, `work_date`, `shifts`, `reason`, `status` (`pending | approved | rejected`), `requested_by`, `reviewed_by / review_comment / reviewed_at`, approval trail; one pending-or-approved claim per employee per date (enforced in code under a row lock).

### CompensationLedger
The compensation balance: `employee`, `entry_type` (`credit | debit`), `shifts`, `date`, `source` (`holiday_work | ot_shift | legacy_credit | redemption`), `claim` (FK to the claim, one credit per claim), `note`, `created_by`. Balance = credits + still-available legacy `CompensationLeaveCredit` rows − debits.

### Changed models
- **OvertimeRecord** — gained `ot_type` (`legacy | allowance | shift`), `allowance_minutes`, `suggested_shifts`, `shifts`, `claim_date`, status `auto` (Type 1); an assigned Type 2 record keeps status `announced` (+ `compensation_type` `relaxation | pay`).
- **CompensationDayAnnouncement** — gained `kind` (`day` legacy exemption | `late_in` | `early_out`) and `allowed_time`.
- **AttendanceDayRecord** — gained `compensation_kind`, `compensation_minutes`, `compensation_note`, `ot_extra_minutes` (all with DB defaults).
- **DepartmentManager** — `can_approve_compensation` (default true), the eighth approval switch.
- **PayrollSettings** — `ot_detection_enabled` / `ot_threshold_minutes` are legacy mirrors of the Compensation tab (see above); the master switch is unchanged.

## Settings & Configuration

### PayrollSettings
**Table name:** `payroll_settings`

Singleton (pk=1) holding essentially all org-wide configurable business rules: company profile/branding, the PF / ESI rule lists of staff and production, production payroll period definition, attendance calculation mode (strict/simple), late-detection policy and deduction slabs (staff and production, plus a separate "without permission" pool), default new-shift timings, cross-midnight punch reattribution windows, production attendance window times, PF/EF salary-range rules, feature toggles, database backup directory, SMTP credentials, and portal theme.

**Key fields:**
- `staff_pf_rules`, `staff_esi_rules`, `prod_pf_rules`, `prod_esi_rules`: JSONField, default `list` (migration 0126): the PF and ESI rule lists, `[{ id, label, basis (basic | first_portion | total), minAmount, maxAmount (0 = no limit), ratePercent }]`; the only PF / ESI configuration there is; a branch can carry its own copy of all four in `BranchSettingsOverride.overrides`
- **Retired, never read or written any more** (kept because the schema is additive-only; migration 0127 converted what was enabled into the rule lists): `pf_rate`, `esi_rate`, `esi_applicable_below`, `prod_pf_rate`, `prod_esi_rate`, `prod_esi_applicable_below`, `prod_pf_ef_enabled`, `prod_pf_ef_rules`, `staff_payroll_rules_enabled`, `prod_payroll_rules_enabled`
- `prod_cycles` — JSONField, nullable; `{weekly|biweekly|monthly: {weekStart: monday|tuesday|…|sunday, anchorDate, lateFreeAllowance, lateSlabs}}` (`weekStart` is the weekday the cycle's 7-day weeks start on; the first release's `mon_sat` / `sun_sat` are still read, and saved, as `monday` / `sunday`), the period rule and late rules of each production pay cycle (Settings → Production Payroll → Weekly / BiWeekly / Monthly). A cycle with no late rules of its own uses the shared `prod_late_*` values. Validated by `production_cycles.merge_prod_cycles`; written through `PUT /api/payroll-settings` key `prodCycles` under the `settings.production_payroll` group, merged per cycle and key (a null late value hands the cycle back to the shared rules)
- `prod_period_frequency` — TextField, `choices=PERIOD_FREQ_CHOICES` (weekly/2weeks/3weeks/monthly); the five `prod_period_*` columns are the old single production schedule, no longer used by production payroll
- `prod_period_style` — TextField, `choices=PERIOD_STYLE_CHOICES` (calendar_month/weekday_anchored/custom_recurring)
- `prod_period_weekday_anchor` — TextField, `choices=WEEKDAY_ANCHOR_CHOICES` (mon_sat/sun_sat), nullable
- `prod_attendance_mode` — TextField, `choices=[("simple","Simple"),("strict","Strict")]`
- `attendance_mode` — TextField, default `"strict"` (strict | simple)
- `late_deduction_slabs`, `without_permission_deduction_slabs`, `prod_late_deduction_slabs` — JSONField (threshold tables)
- `permission_pricing_enabled`: BooleanField, default `False`, `db_default=False` (migration 0128). Staff only, company-wide. OFF: an excess permission (approved beyond `permission_monthly_cap`) is one mark in the late pool. ON: excess permissions leave the pool and are priced by the two fields below
- `permission_free_allowance`: IntegerField, default 0, `db_default=0`: excess permissions a month that cost nothing (0-999)
- `permission_deduction_slabs`: JSONField, default `list`, `db_default=[]`: `[{"fromPermissions": N, "deductionShifts": D}]`, ascending, the highest row reached wins and the last row holds beyond itself (looked up by `payroll_views.permission_shift_deduction`, which feeds `late_shift_deduction`'s `slabs=` hook). All three are in `user_settings.COMPANY_WIDE_FIELDS`
- `prod_bonus_percent`: DecimalField(5,2), default 8.33, `db_default` (migration 0128); `prod_bonus_wage_ceiling`: DecimalField(10,2), default 7000; `prod_bonus_eligibility_ceiling`: DecimalField(10,2), default 21000. The PRODUCTION twins of `bonus_percent` / `bonus_wage_ceiling` / `bonus_eligibility_ceiling` (which stay the staff values; `bonus_fy_start_month` stays one value for both classes and is not enforced company-wide: the bonus engine reads the employee's branch value, the reports and the MD portal the company row, so set it from the company login). Branch-overridable. Both sets are applied per payslip: the ceiling to each payslip's `basic` over the financial year, the eligibility limit to the latest payslip. Migration 0129 copied the then-current staff values into them (universal row and every branch override setting a bonus key), idempotently
- `theme_custom` — JSONField, default `dict`
- `smtp_password` — TextField (plaintext, per codebase convention)
- `hr_contact_name` / `_phone` / `_whatsapp` / `_email` / `_hours`, `support_contact_name` / `_phone` / `_whatsapp` / `_email` / `_hours`, `contact_note` — TextField (Settings → HR Contact; migration `0105_hr_contact_details`). Written through `PUT /api/payroll-settings` under the `settings.hr_contact` permission group and validated by `support_contact_views.clean_updates` (one phone number of 6-15 digits, a valid email, length limits of 80 / 30 / 120 / 120 / 500). **Company-wide only**: a branch login gets `403 company_wide_contact`, so no private branch copy can exist. Published through `GET /api/support-contact`.
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

## MD Portal Assistant (api/models/md_assistant.py)

None of this is company data: it is the assistant's own bookkeeping. The Gemini API key is **never** stored (environment only).

### MdAssistantSettings
**Table name:** `md_assistant_settings`

Singleton (pk=1), edited by the super admin in Account Management → MD profile.

**Key fields:**
- `enabled` — BooleanField, default True
- `model`, `fallback_models` — TextField (comma list); defaults `gemini-3.5-flash-lite` and `gemini-3.1-flash-lite,gemini-3.8-flash`
- `thinking_level` — TextField, default `low`
- `privacy_mode` — BooleanField, default True (employee names become tokens before anything leaves the server)
- `max_tool_rounds` (5), `requests_per_minute` (8) — IntegerField
- `updated_at`, `updated_by`

### MdConversation
**Table name:** `md_conversations`

A conversation of the MD with the assistant. `user` → `HRUser` (CASCADE), `title`, `created_at`, `updated_at`; index on (`user`, `-updated_at`). Only the owner can read it.

### MdMessage
**Table name:** `md_messages`

One question or answer. `conversation` → `MdConversation` (CASCADE), `role` (`user`/`assistant`), `status` (`pending`/`running`/`done`/`error`), `content` (the text), `payload` (JSON: spoken summary, explanation, suggested pages, follow-ups, progress, confidence), `input_mode` (`text`/`voice`), `language`, `page_context` (JSON: what page and filters were on screen), `model_used`, `error`, `created_at`, `started_at`, `finished_at`.

### MdAssistantUsage
**Table name:** `md_assistant_usage`

Gemini requests per model per **Pacific** day (when Google resets the free quota). `day`, `model` (unique together), `requests`, `prompt_tokens`, `output_tokens`, `rate_limited`, `daily_limit_hit`.
