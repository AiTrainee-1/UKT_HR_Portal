# UKTextiles HRMS -Mobile App Integration Guide
_Backend snapshot: 7 July 2026 · Django REST · Base URL: `http://<server>:8000/api`_

## 1. Authentication

Token-based. Send `Authorization: Bearer <token>` on every request after login.

| Endpoint | Method | Body | Response |
|---|---|---|---|
| `/auth/hr-login` | POST | `{ "username", "password" }` | `{ "token", "role": "hr", "name" }` |
| `/auth/employee-login` | POST | `{ "employeeCode", "password" }` | `{ "token", "role": "employee", "employeeId", "name" }` |
| `/auth/set-password` | POST | `{ "employeeCode", "password" }` | sets first-time password |
| `/auth/me` | GET | -| current identity `{ role, employeeId?, name }` |

Errors are `{ "error": "<message>" }` with 4xx status. `401` ⇒ token invalid/expired → re-login.

## 2. Employee model (key fields)

`GET /employees` (HR) / `GET /employees/<id>`:

```json
{
  "id": 12, "employeeCode": "2670", "firstName": "…", "lastName": "…",
  "gender": "male|female|other", "employmentType": "staff|production",
  "departmentId": 1, "departmentName": "…", "designationId": 2,
  "salaryType": "monthly|weekly", "salaryAmount": 18000.0,
  "salaryPerShift": 450.0,          // production only -pay per shift
  "status": "active|inactive", "biometricDeviceId": "2670",
  "photoUrl": "…", "joinDate": "2024-01-05", …
}
```

**Two employee classes drive everything:**
- **Staff** -monthly salary, leave/permission/CL apply, Sunday off, 1 shift/day max.
- **Production** -paid per shift (`salaryPerShift`), max **1.5 shifts/day**, **no** leave/permission/CL, **Sunday is a working day**, bi-weekly pay periods.

Create/update: `POST /employees`, `PATCH /employees/<id>` (same camelCase keys). For production employees send `salaryPerShift` (not `salaryAmount`).

## 3. Attendance

### 3.1 Data flow
```
Biometric device(s) ─┐
Manual entry ────────┼─► attendance_logs (raw punches)
Excel upload ────────┘          │
                                ▼
                    AttendanceDayRecord (per employee per day)
                    = SINGLE SOURCE OF TRUTH for payroll
                    status: present | half_shift | absent | on_leave | holiday
                    shiftsEarned: 0 … 1.50
```
`source: "auto"` records recompute automatically; `source: "manual"` (HR override) is never recomputed.

### 3.2 Shift calculation rules

**Staff (strict 4-punch mode, default)** -all times come from the assigned `ShiftTemplate` (+ optional per-employee `customStartTime`/`customEndTime` on the assignment):
- Late: first punch > `startTime + gracePeriodMinutes`
- Lunch-return late: punch3 > punch2 + `lunchDurationMinutes`
- Full shift (1.00): morning punch + lunch-return + evening punch; otherwise 0.50
- Typical templates: start 09:00; end 20:00 (male) / 19:00 (female)

**Production (segment engine)** -config in `ProductionShiftConfig` + ordered `ProductionShiftSegment` rows:
- Reference punches: 08:30 / 12:45 / 13:30 / 20:00, grace in minutes
- Default segments: 08:30–10:30 (0.25), 10:30–12:45 (0.25), 13:30–15:30 (0.25), 15:30–17:30 (0.25), 17:30–20:00 (0.50)
- 4 punches → morning span (p1→p2) + afternoon span (p3→p4); each segment fully covered (within grace) is credited
- Full day to 20:00 = **1.50**, stop at 17:30 = **1.00**, morning only = **0.50**
- Sunday = normal working day; zero punches ⇒ `absent`

### 3.3 Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/attendance/summary?date=YYYY-MM-DD&employmentType=staff\|production` | GET | day counts (present/absent/late/leave) |
| `/attendance/daily?date=` | GET | per-employee day rows |
| `/attendance/employee/<id>?month=&year=` | GET | one employee's month history |
| `/attendance/employee-monthly?employeeId=&month=&year=` | GET | day records + summary (`totalShifts`, `effectiveDays`) |
| `/attendance/manual` | POST | `{ employeeId, date, punchTime?, punchType, notes? }` |
| `/attendance/override` | POST | HR day override (creates `source:"manual"` record / approval request) |
| `/attendance/sync-biometric` | POST | `{ "mode": "today\|days3\|days7\|month\|prevmonth\|all" }` → pulls from the `.env` device + all enabled Settings devices; response `{ ok, created, syncedAt, unmatchedDeviceIds[] }` (502 body has `{ ok:false, error }`) |
| `/attendance-logs?month=&year=&employeeId=` | GET | raw punches |
| `/biometric/punch` | POST | push-webhook for AiFace-type devices (header `X-Api-Key`) |

### 3.4 Biometric devices (HR settings)
- `GET/POST /biometric-devices`, `GET/PUT/DELETE /biometric-devices/<id>`
- Device JSON: `{ id, name, deviceType, host, port, connectionConfig: {password}, isActive, lastSyncedAt }`
- ZKTeco comm password must be **numeric**; invalid config is reported per-device, never crashes the sync.

## 4. Shifts

| Endpoint | Method | Purpose |
|---|---|---|
| `/shifts` / `/shifts/<id>` | GET/POST/PUT/DELETE | ShiftTemplates (`shiftType: staff\|production`, `startTime`, `endTime`, `gracePeriodMinutes`, staff-only `firstHalfEnd`, `lunchDurationMinutes`) |
| `/shift-assignments?employeeId=` | GET/POST | assignment history; supports `customStartTime`/`customEndTime`, `saturdayOff` |
| `/shift-assignments/bulk` | POST | assign to many (dept/designation/type) |
| `/shift-assignments/sync-production` | POST | auto-assign the production shift to unassigned production employees |
| `/production-shift-config` | GET/PUT | `{ punch1Time…punch4Time, graceMinutes, segments[] }` |
| `/production-shift-segments` (+`/<id>`) | GET/POST/PUT/DELETE | `{ label, startTime, endTime, shiftValue, order, isActive }` |

## 5. Payroll

### 5.1 Generate
`POST /payroll/generate` -body:
```json
{ "month": 7, "year": 2026, "runType": "monthly" | "biweekly" | "all", "weekNumber": 1 }
```
- `monthly` → all staff. `biweekly` → production for `weekNumber` 1 (days 1–15) or 2 (days 16–end). `all` → both weeks + staff.
- Response: `{ generated, skipped, skippedDetails: [{employeeId, name, reason}] }`. Production employees without `salaryPerShift` are skipped with that reason.
- Regeneration is idempotent (upserts by employee+month+year+week) and recomputes attendance for the period.

### 5.2 Read
`GET /payroll?month=&year=&employeeId=&status=` → rows:
```json
{
  "id": 17, "employeeId": 12, "employeeName": "…",
  "salaryMode": "monthly" | "shift" | "session(legacy)",
  "month": 7, "year": 2026, "weekNumber": 1,
  "presentDays": 7.5,          // = TOTAL SHIFTS for salaryMode "shift"
  "baseSalary": 3375.0, "grossSalary": 3375.0, "deductions": 0,
  "bonus": 0, "finalSalary": 3375.0, "status": "pending|paid"
}
```
`PATCH /payroll/<id>` → `{ bonus?, deductions?, status?, notes? }`.

### 5.3 Breakdown (full traceability)
`GET /payroll/<id>/breakdown` → `{ employee, summary, breakdown }` where production breakdown is:
```json
{
  "type": "production", "weekNumber": 1,
  "dateFrom": "2026-07-01", "dateTo": "2026-07-15",
  "salaryPerShift": 450.0,
  "days": [{ "date", "day", "firstPunch", "lastPunch", "shiftsEarned": 1.5, "status", "isLate" }],
  "summary": { "totalDays": 15, "daysWorked": 6, "daysAbsent": 1, "totalShifts": 7.5 },
  "earnings": { "totalShifts": 7.5, "salaryPerShift": 450.0, "grossSalary": 3375.0 },
  "deductions": { "pf", "esi", "advances", "advanceDetails": [], "total" },
  "netSalary": 3375.0
}
```
(Staff breakdown has `shift`, working-day lists, leave/late detail instead. Legacy records use `sessionConfigs`/`totalSessions` -detect by presence of `salaryPerShift`.)

### 5.4 Salary slips
`GET /salary-slips?month=&year=&employmentType=` · `GET /my/salary-slips` (employee self-service) · `POST /salary-slips/<id>/email`.

## 6. Leave / Permission / Requests (STAFF ONLY)

- Leave: `/leave-types`, `/leave-balances`, `/leave-requests` (+ `/<id>/status` approve/reject)
- Casual Leave (1/month, paid): `/casual-leaves`, `/casual-leaves/eligibility?employeeId=`
- Hour permissions: `/permissions`
- Generic requests: `/employee-requests` (+ `/<id>/action`)
- Manager approvals: `/manager/pending-requests`, `/manager/*/<id>/status`
- Night-shift relaxation (auto-detected late-night workers): `/night-shift/dashboard`, `/night-shift/rules`

**Production employees have none of these** -hide these screens for `employmentType === "production"`.

## 7. Settings (HR)

`GET/PUT /payroll-settings` -one JSON with: company profile/branding, staff PF/ESI, production PF/ESI, `payDay`, `productionPayType`, **`defaultSalaryPerShift`** (new -prefill for new production employees), attendance mode (`strict|simple`) + simple-mode cutoff/grace, salary-slip header/signature images, SMTP.
Also: `/idcard-settings`, `/biometric-devices`, `/production-shift-config`.

## 8. Other modules

- Dashboards: `/dashboard/hr-summary`, `/dashboard/employee-summary`
- Promotions `/promotions`, Increments `/increments*`, Advances `/advances*`
- ID card: `/idcard?employeeId=`, public QR verify `/verify-employee/<code>`
- Reports (Excel-oriented): `/reports/*` with `employmentType` filters
- Recruitment & resignations: `/jobs`, `/applicants`, `/recruitment/*`, employee self-service `/my/resignation`

## 9. Recent DB changes (migrations 0020–0025)

| Migration | Change |
|---|---|
| 0020 | `BiometricDevice`, `IdCardSettings`, company-profile fields |
| 0021 | `NightShiftRule`, `NightShiftRelaxation` |
| 0022 | `ProductionShiftConfig`, `ProductionShiftSegment`, `Employee.salary_per_shift` |
| 0023 | Seeded the 5 default production segments |
| 0024 | `Payroll.salary_mode` choice `"shift"` added |
| 0025 | `PayrollSettings.default_salary_per_shift` |

## 10. Mobile implementation notes

1. **Branch every employee-facing screen on `employmentType`** (staff vs production): different pay display (monthly vs per-shift), no leave UI for production, Sunday handling.
2. Poll `/attendance/employee-monthly` for the self-service attendance calendar; `shiftsEarned` is the number to display per day (production shows 0.25 granularity).
3. All money values are numbers (float) in JSON; render with ₹ and Indian digit grouping client-side.
4. Timestamps: dates are `YYYY-MM-DD` strings; times are `HH:MM` (or `HH:MM:SS`) strings; no timezones (server local time is factory time).
5. Write operations use camelCase JSON bodies exactly as shown; unknown keys are ignored.
6. On 502 from sync-biometric show the returned `error` verbatim -it names the failing device.
