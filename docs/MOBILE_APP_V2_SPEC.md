# UKTextiles Mobile App — v2 Implementation Spec

_Backend snapshot: 2026-07-08, last revised 2026-07-08 (post punch-list items 1-4) · Django REST + PostgreSQL, shared 1:1 with the HR Portal · Base URL: `http://<server>:8000/api`_

This document is self-contained — it supersedes `docs/MOBILE_INTEGRATION.md` and `EMPLOYEE_MOBILE_APP_PROMPT.md` for anything it covers, because those two docs disagree with each other in places (e.g. the login field name) and predate several backend fixes made since. Every endpoint/field/model below was re-verified directly against the current backend source, not copied from the older docs. Where something the app needs **does not exist yet**, it is marked 🔧 **NEW BACKEND WORK** with the exact model/endpoint to build. Where something exists but has a gap that will bite you, it's marked ⚠️. Where something was flagged as a gap and has since been fixed, it's marked ✅ **FIXED**.

**Status since the original snapshot:** Punch-list items 1-4 (§6) are done — `/notifications` self-scoping, the 6 missing notification triggers, `uanNumber` in the employee serializer, and self-service auth on `idcard_data`, `idcard_settings_view` (GET), `employee_monthly_attendance`, and `employee_shift_monthly_stats`. Items 5-10 (new endpoints: mobile home summary, live feed, salary slip PDF, my-shift-summary, Shift Approval, Chat) are **not started yet** — still exactly as designed below.

---

## 0. Architecture (unchanged, restated for completeness)

The mobile app and HR Portal hit the exact same Django backend and PostgreSQL database. No separate backend, no separate DB, no mirrored logic. A leave request submitted on mobile appears in the HR Portal instantly and vice versa.

## 1. Auth — corrected

```
POST /api/auth/employee-login
Body: { "identifier": "30020", "password": "..." }   ← "identifier", NOT "employeeCode"
Response: { "token", "role": "employee", "employeeId", "name" }
```
`identifier` matches against `phone`, `email`, OR `employee_code` (views.py:100-105) — any of the three works. (`docs/MOBILE_INTEGRATION.md` incorrectly says the body key is `employeeCode` — ignore that, `EMPLOYEE_MOBILE_APP_PROMPT.md`'s `identifier` was correct.)

```
POST /api/auth/set-password   Body: { "identifier", "password" }   (min 8 chars)
GET  /api/auth/me             Header only → { role, employeeId, name }
```

**There is no separate "manager" role or login.** A Department Head is a normal employee (`role: "employee"` in the JWT) who additionally has an active `DepartmentManager` row. The Approval tab's visibility and the `manager/*` endpoints are gated by that DB row, not by JWT role — check `GET /manager/me` on login/app-start; if it 404s/403s ("Not a department manager"), hide the Approval tab entirely. If it succeeds, show it.

`Authorization: Bearer <token>` on every subsequent request.

---

## 2. Navigation map (as currently built)

**Bottom tabs:** Home · Leave · Alerts · Profile · Approval
**Side drawer:** Home · Profile · Attendance · Salary Slip · Leave · Permission · My Shift · ID Card · Holidays · Advance Notification · Chat · My Profile · Resignation

Note "Profile" and "My Profile" both appear in your side-nav list — treat these as the same screen (§3.4) unless you intend one to be a shortcut and the other a deeper edit view; the backend has exactly one profile data source (`GET /employees/<id>`) either way. "Attendance" in the side-nav is the calendar/history view already covered by `docs/MOBILE_INTEGRATION.md` §3 — unchanged by this spec, kept for completeness in Appendix A.

---

## 3. Page-by-page spec

### 3.1 Home

| Widget | Endpoint | Status |
|---|---|---|
| Present / Absent count (today, company-wide) | — | 🔧 **NEW BACKEND WORK** |
| Leave count (today, company-wide) | — | 🔧 **NEW BACKEND WORK** |
| Pending Requests count | `GET /dashboard/employee-summary` → `pendingApprovalsCount` (self) or new field (company-wide) | ⚠️ see below |
| Quick Actions | (static, already built) | ✅ no change |
| Digital ID Card | `GET /idcard?employeeId=` | ✅ **FIXED** — self-service auth added, see §3.8 |
| Live Attendance Ticker | — | 🔧 **NEW BACKEND WORK** |

**The critical gap:** no existing endpoint returns "today's Present/Absent/Leave/Pending counts, company-wide, on an employee-scoped auth token." I checked all three candidates:
- `GET /dashboard/employee-summary` (`@require_auth`) — scoped to **one employee's own current month**, not company-wide, not "today."
- `GET /dashboard/hr-summary` (`@require_hr`) — company-wide but headcount/salary totals, no today's-attendance breakdown, and **HR-only** (an employee JWT gets 403).
- `GET /attendance/summary?date=` (`@require_hr`) — exactly the today's present/absent/notPunched breakdown you want, company-wide, but **HR-only** and has no leave-count or pending-requests field.

**🔧 NEW BACKEND WORK — `GET /dashboard/mobile-home-summary`** (new view, `@require_auth`, any employee token):
```jsonc
{
  "date": "2026-07-08",
  "presentToday": 142,
  "absentToday": 8,
  "onLeaveToday": 3,
  "pendingRequestsCount": 5   // for a Department Head: their manager/me.pendingApprovalsCount;
                              // for a regular employee: their own pending leave+permission+CL+resignation count
}
```
Implementation: reuse the exact query logic already in `attendance_views.py::attendance_summary` for the present/absent numbers (just drop the `@require_hr` requirement or add a lighter-weight variant), add a same-day `AttendanceDayRecord.objects.filter(date=today, status="on_leave").count()` for `onLeaveToday`, and reuse `employee_dashboard_summary`'s existing `pendingApprovalsCount` logic for the requester's own pending count (or `manager/me`'s count if the caller is a Department Head).

**Digital ID Card on Home** — see §3.8 for the full design spec; same data, just rendered smaller/compact here.

**🔧 NEW BACKEND WORK — Live Attendance Ticker.** No endpoint currently exposes a rolling feed of "who punched in/out just now" — `attendance-logs` (payroll_views.py) is HR-only and month-scoped, not a live feed. Build `GET /attendance/live-feed?limit=20` (`@require_auth`):
```jsonc
{
  "items": [
    { "employeeName": "Jane Roe", "department": "Weaving", "event": "in", "time": "09:02", "date": "2026-07-08" },
    { "employeeName": "John Doe", "department": "Production", "event": "out", "time": "08:58", "date": "2026-07-08" }
  ]
}
```
Source table: `AttendanceLog` (`punch_time`, `punch_type`, `employee`), filtered to today, ordered by `id` descending, limited to N. Poll this every 15-30s (or wrap in a lightweight WebSocket/SSE later — REST polling is fine for v2). Render as a horizontally-scrolling marquee (`react-native-reanimated` translateX loop, or a simple `Animated.loop` on a `ScrollView` with `pointerEvents="none"`). Mix in recent `Notification` rows of type `"leave"`/`"resignation"` for the "attendance-related notifications" part of the ticker, or keep the ticker purely punch-based and let the Alerts tab own notifications — recommend the latter for a cleaner separation of concerns.

**Suggested additional Home widgets** (not requested but worth considering, since you asked):
- **Upcoming holiday strip** — next holiday date/name, from the same `GET /holidays?year=` data used by §3.9 (zero new backend work).
- **"My attendance this month" mini ring** — present days / working days so far, from `GET /dashboard/employee-summary` (`presentDays` already returned).
- **Birthday/anniversary banner** — you have `date_of_birth` and `join_date` on `Employee` already; a same-day company-wide "Wish John Doe 🎂" banner is a nice low-effort win but is 🔧 new (needs a small `GET /dashboard/today-birthdays` query).
- **Weather-independent "shift starts in Xh" countdown** using the employee's own `assignedShift.startTime` (from §3.7's new endpoint) — helps night/rotating-shift staff at a glance.

---

### 3.2 Leave

Replace "Balance Leave" — there genuinely is no leave-balance feature in this codebase (confirmed: `LeaveBalance` model exists but is a simple allocated/used counter tied to `LeaveType`, not a "balance bank" concept the old mobile screen implied). Two tabs as requested:

| Tab | Meaning | Source |
|---|---|---|
| **Live Requests** | `status == "pending"` | `GET /leave-requests?employeeId=&status=pending` |
| **Confirmed Requests** | `status in ["approved","rejected"]` | `GET /leave-requests?employeeId=&status=approved` and `...&status=rejected` (call twice, or fetch all and split client-side — no combined `status=confirmed` value exists server-side) |

✅ Endpoint exists and works exactly as needed: `GET /leave-requests` (`views.py`), query params `employeeId`/`employeeCode`, `status`. Table: `leave_requests` (model `LeaveRequest`: `employee`, `type`, `start_date`, `end_date`, `total_days`, `status`, `reason`, `hr_comment`, `created_at`).

Submit: `POST /leave-requests` body `{ employeeId, startDate, endDate, type, reason }` (also accepts `type`/`leave_type` interchangeably — see views.py:661). Leave types for the dropdown: `GET /leave-types`.

**"Today's leave data"** — no server-side "today" filter exists on `/leave-requests`; filter client-side on `start_date <= today <= end_date` after fetching, or add `?date=` support server-side if the list will be large (recommend client-side filtering first; it's cheap at this data volume).

**Summary cards** (Total Leaves Taken / Submitted / Approved / Rejected) — no dedicated summary endpoint exists. Compute client-side from the same `GET /leave-requests?employeeId=` full list (count by status; sum `total_days` where `status="approved"` for "Total Leaves Taken"). This avoids a new endpoint since the list is per-employee and small.

**Filtering options** — add client-side filters (date range, leave type) over the same list call; no new backend work needed since `/leave-requests` already returns everything for the employee in one call.

---

### 3.3 Alerts

**Table:** `Notification` (`notifications`) — fields `employee` (FK, recipient), `type` (free text), `message`, `is_read`, `created_at`.

**Endpoint:** `GET /notifications` (`@require_auth`). ✅ **FIXED** — `views.py::notifications` now force-filters to `employee_id=get_token_employee_id(request)` whenever the caller is an employee token, exactly mirroring the pattern already used by `employee_permissions`/`casual_leaves`. HR tokens still see everything (unchanged, used for admin/debug). No further work needed here.

**"Only today's latest notifications"** — add `?date=today` server-side filter, or filter client-side on `createdAt` — either is fine given per-employee volume will be low.

**The bigger gap — most of the actions you listed do NOT currently create a notification at all.** I exhaustively grepped every `Notification.objects.create(...)` call site in the backend. Here's exactly what exists today vs. what's missing:

| Action | Notifies employee today? |
|---|---|
| HR approves/rejects a Leave Request (`views.py` `update_leave_status`) | ✅ Yes |
| Resignation submitted / dept-head approves / dept-head rejects / HR approves / HR rejects | ✅ Yes (all 5 stages) |
| Employee submits a generic `EmployeeRequest` | ✅ **FIXED** — `employee_request_action` (HR's response) now fires a notification to the employee with the new status, in addition to the pre-existing submission-time one |
| HR approves/rejects an **Employee Permission** request | ✅ **FIXED** — `leave_views.py::employee_permission_detail` |
| Manager approves/rejects an **Employee Permission** request | ✅ **FIXED** — `manager_views.py::manager_update_permission_status` |
| HR or Manager approves/rejects a **Casual Leave** request | ✅ **FIXED** — `casual_leave_views.py::apply_cl_decision` (shared function, so both paths covered in one change) |
| Manager approves/rejects an **Attendance Override** request | ✅ **FIXED** — `manager_views.py::manager_update_attendance_status` |
| **Manager-path** (Department Head) leave approval | ✅ **FIXED** — `manager_views.py::manager_update_leave_status` |
| Employee-request HR action outcome (approved/rejected/more-info) | ✅ **FIXED** — see above |

All 7 workflows now notify the employee. No further backend work needed for this section — the Alerts page can be built directly against `GET /notifications` as originally specced below.

---

### 3.4 Profile

**Table:** `Employee` only — there are **no** separate `EmployeeFamily`/`EmployeeBank`/`EmployeeCompliance`/`EmployeeAddress` tables; everything is flat columns on one `employees` table.

**Endpoint:** `GET /employees/<id>` (`@require_auth`, any authenticated user can fetch **any** employee id — there's no self-only restriction on this endpoint today, unlike `/permissions` or `/casual-leaves`. For a mobile self-service profile screen this is fine as long as the app only ever requests its own `employeeId` from the JWT — just don't build a "view other employee" feature on top of it without adding a server-side check first).

Card header fields (all present today): `firstName`, `lastName`, `employeeCode`, `departmentName`, `designationTitle`, `phone`, `joinDate`, `photoUrl`.

Section-by-section field mapping (all from the same `GET /employees/<id>` response):

| Section | Fields (camelCase JSON keys) |
|---|---|
| Personal Information | `firstName`, `lastName`, `gender`, `dateOfBirth`, `email`, `phone`, `bloodGroup`, `emergencyContact` |
| Family Information | `fatherName`, `motherName` |
| Employee Information | `employeeCode`, `employmentType`, `role`, `departmentName`, `designationTitle`, `joinDate`, `status` |
| Bank Information | `bankName`, `bankAccount`, `bankIfsc` |
| Compliance Information | `pfNumber`, `esiNumber`, `uanNumber` — ✅ **FIXED**, all three now serialized |
| Address Information | `address` (single free-text field — not split into line1/city/state/pincode; render as one multi-line block) |

**Change Password** → `POST /auth/set-password`, body `{ identifier, password }` (identifier = the employee's own code/phone/email — pre-fill from the logged-in session, don't make the user retype it).

**Submit Resignation** → see §4 recruitment flow: `GET/POST /my/resignation`.

**Logout** → clear stored token client-side only, no backend call needed.

---

### 3.5 Salary Slip

Keep existing design. List: `GET /my/salary-slips` (self-scoped automatically from JWT, no params needed). Detail: `GET /salary-slips/<id>`.

**Download** — 🔧 **NEW BACKEND WORK.** No PDF generation exists for salary slips today (confirmed: `reportlab` — already a project dependency — is used only for resignation letters, `recruitment_views.py`). `salary_slip_views.py::_render_slip_html` already builds the full HTML for a slip; the missing piece is converting that HTML to PDF bytes and returning it as a file response, mirroring the existing pattern in `recruitment_views.py::resignation_pdf`. Add:
```
GET /salary-slips/<pk>/pdf   → generates + returns application/pdf (reuse _render_slip_html + reportlab, same recipe as resignation_pdf)
```

**Share** — once the PDF endpoint exists, "Share" on mobile is just: download the PDF to a temp file, then call React Native's `Share.share()` / `expo-sharing`'s `shareAsync()` on it. No additional backend work beyond the PDF endpoint above. (The existing `POST /salary-slips/<pk>/email` endpoint is a *different* feature — HR emailing a slip on the employee's behalf, HTML-only body, no PDF attachment currently — leave that as-is for HR's use; it's not what mobile "Share" needs.)

---

### 3.6 Permission

**Two separate "permission" concepts exist in this codebase under confusingly overlapping names — read this before wiring the UI:**

1. **`EmployeePermission`** — the employee-submitted hour-permission *request* (e.g. "I need to leave early Tuesday"). Table `employee_permissions`. This is what `GET/POST /permissions` operates on.
2. **The payroll "free permissions" allowance** — a *late-arrival forgiveness* counter computed from biometric punches (`total_late` count from `DailyShiftLog`/`MonthlyShiftSummary`), completely disconnected from #1's table. This is what actually drives the ¼-shift deduction.

**The business rule you described already exists in the backend** — split across these two mechanisms, which is exactly why the UI needs to pull from *both* endpoints and label the numbers correctly:

| What to show | Source | Existing? |
|---|---|---|
| Permissions Used / Remaining (out of 3/month) | `GET /permissions?employeeId=&month=&year=` → response includes `"monthlyUsed"` and `"monthlyLimit": 3` on every call | ✅ Yes, `MONTHLY_PERMISSION_LIMIT = 3` is enforced server-side (`leave_views.py:312`) — a 4th request in the same month is rejected with HTTP 400 automatically. No new work. |
| Late Count | `MonthlyShiftSummary.total_late_count`, surfaced via `attendance/employee-shift-stats?employee_id=&month=&year=` → `totalLateCount` | ✅ Yes |
| Shift Deductions (in shifts, e.g. "0.25") | same endpoint → `summary.shiftDeductions` | ✅ Yes, computed as `floor(billable_late / 3) * 0.25` where `billable_late = max(0, total_late - 3)` |
| Salary Deduction Amount (₹) | same endpoint → `summary.salaryDeductionAmount` | ✅ Yes |

✅ **FIXED — auth gap closed:** `attendance/employee-shift-stats` now self-scopes — an employee token gets their own stats automatically (query param `employee_id` is ignored/overridden for employee callers), HR still passes `employee_id` explicitly. `attendance/late-summary` (the all-staff list variant) is unchanged/still HR-only, but the mobile app doesn't need it — `employee-shift-stats` is the one this page uses.

**Layout** — same tab structure as Leave (§3.2): Live Requests (`status=pending`) / Confirmed Requests (`status=approved|rejected`), same `GET /permissions?employeeId=&status=` call. Submit: `POST /permissions` body `{ employeeId, date, permissionTime, reason }` — will auto-reject with a clear 400 error once the monthly cap is hit, so the client just needs to surface that error message; no client-side cap-counting logic required (though showing "Remaining: 0" proactively based on `monthlyUsed`/`monthlyLimit` before they even try is better UX).

**Do not build a NEW deduction rule** — the ¼-shift-per-3-late formula you described is already live and already feeding real payroll breakdowns (`payroll_views.py`); this page is a read+submit UI over two existing, correct backend calculations, not a new business-logic feature.

---

### 3.7 My Shift

No single existing endpoint returns everything on your list. 🔧 **NEW BACKEND WORK (recommended) — one consolidated endpoint**, `GET /my-shift-summary?month=&year=` (`@require_auth`, self-scoped), assembling data that today lives in 4 separate places:

```jsonc
{
  "assignedShift": { "name": "General Shift", "startTime": "09:15", "endTime": "19:00", "gracePeriodMinutes": 15 },
  "lateCount": 5,
  "halfShiftCount": 2,
  "casualLeaveApprovals": 1,
  "totalWorkingShifts": "20.50",
  "absentCount": 2,
  "dailyLogs": [ /* same per-day array shape as employee-shift-stats.dailyLogs */ ]
}
```
Implementation recipe (all pieces already exist, just not merged):
- `assignedShift` → the exact same `_get_shift_for_date()` call already used in `growth_views.py::employee_monthly_attendance` (this project's own shift-resolution helper — same one that was just fixed to never fall back to a global default; reuse it here rather than re-deriving shift logic a third time).
- `lateCount`, `halfShiftCount`, `totalWorkingShifts`, `absentCount`, `dailyLogs` → identical to `attendance_views.py::employee_shift_monthly_stats`'s existing computation (`totalLateCount`, `halfShiftDays`, `totalEffectiveShifts`, `absentDays`, `dailyLogs`).
- `casualLeaveApprovals` → `CasualLeaveRequest.objects.filter(employee=emp, status="approved", date__month=month, date__year=year).count()`.

If you'd rather avoid a new endpoint right now, the app can instead make 3 calls and merge client-side — and this is now fully viable: `employee_monthly_attendance` and `employee_shift_monthly_stats` **both already have self-service auth** (✅ fixed), and `casual-leaves?status=approved&month=&year=` was already self-scoped. **The single consolidated endpoint (`/my-shift-summary`) is still the better long-term choice** since it's one round trip instead of three, but it's no longer a blocker — you can ship this page today with the 3-call approach and swap in the consolidated endpoint later without any client-side auth changes.

**Grace Period / Shift Timing correctness note:** as of the most recent backend fix, shift start/end/grace are *always* resolved from the employee's currently-assigned `EmployeeShiftAssignment` → `ShiftTemplate` (with per-employee `customStartTime`/`customEndTime` overrides applied) — there is no global default anywhere in this calculation anymore. This page is a good place to make that visible to the employee, exactly like the HR Portal's Attendance Search panel now does.

---

### 3.8 Digital ID Card

**Must match the HR Portal pixel-for-pixel.** The web version has **two** ID card components in the codebase — use `frontend/src/components/idcard/IdCardViews.tsx` as your reference; `EmployeeIdCard.tsx` (used inside the web Profile page) is an older, unrelated design with no QR code and should be ignored.

**Data:** `GET /idcard?employeeId=<id>` — ✅ **FIXED**, self-service scoping added: an employee token always gets their own card regardless of query params; `?ids=` bulk lookup and lookup-by-other-employee remain HR-only. **Template/theme:** `GET /idcard-settings` — ✅ **FIXED**, GET is now open to any authenticated user (read-only); `PUT` remains HR-only.

Response shape (single employee):
```jsonc
{
  "id", "code", "name", "designation", "department", "employmentType",
  "photoUrl", "bloodGroup", "dateOfBirth", "emergencyContact", "address", "phone", "email", "joinDate", "status",
  "company": { "name", "address", "logo", "signature" },
  "template": {
    "primaryColor": "#006496", "secondaryColor": "#4FB8F0", "textColor": "#0f172a",
    "fontFamily": "Hanken Grotesk", "backgroundStyle": "gradient", "logoPosition": "left",
    "cornerStyle": "rounded", "showQrOnBack": true, "footerText": ""
  }
}
```

**Two card families — pick by `employmentType`:**

**Staff card** — vertical, 240×380px canvas:
- Header: horizontal gradient bar (`primaryColor` → `secondaryColor`), 32×32px circular logo (white bg) on the left + company name (bold, 13px) and address (8px) beside it in white text.
- Sub-header strip: light blue (`#eaf6fd`) band, "EMPLOYEE IDENTITY CARD" label (8px, bold, letter-spaced, colored `primaryColor`).
- Body: 96×112px photo (3px `secondaryColor` border, rounded), name (15px black), designation pill (light `primaryColor` tint background), then a full-width gradient strip showing "EMPLOYEE CODE" + the code in monospace white text, then dashed key/value rows for Department and Joined Date.
- Footer: 12px tri-color gradient bar (`primaryColor` → `secondaryColor` → `primaryColor`).
- **Back face:** dashed rows for Blood Group / DOB / Emergency Contact / Address, then (if `template.showQrOnBack`) an 80×80px QR code centered with "SCAN TO VERIFY EMPLOYEE" caption, a 3-line instructions block, and an authorized-signature image + "Authorised Signatory" caption at the bottom.

**Production card** — horizontal, 380×240px canvas (same visual language, landscape layout): photo+name+designation+3 info rows side-by-side on the front; QR (96×96px) + info columns side-by-side on the back.

**QR code:** encodes `https://<web-app-origin>/verify/<employeeCode>` (a frontend URL, not the raw API path) as a PNG via the `qrcode` library — width 160px, dark `#0f172a` / light `#ffffff`, no special error-correction override. In React Native, use `react-native-qrcode-svg` (or similar) generating the **same URL string** so scanning either the web or mobile card opens the identical public verification page (`GET /verify-employee/<code>` — public, no auth, already built, don't touch).

**Known dead fields — don't waste time trying to make these do something:** `template.textColor`, `template.backgroundStyle`, and `template.logoPosition` are stored in `IdCardSettings` but are **not actually consumed** by the live web card component (`IdCardViews.tsx`) — all its text colors and layout are hardcoded regardless of those three settings values. Match what the web app *actually renders* (as described above), not what the settings schema implies is configurable, or your mobile card will visually diverge from the "same as web" requirement you asked for.

---

### 3.9 Holiday

**Table:** `Holiday` (`holidays`) — `name`, `date`, `holiday_type` (national/regional/company), `branch`, `department`, `is_recurring`, `description`.

**Endpoint:** `GET /holidays?year=` — ⚠️ **only `year` and `branchId` filters exist server-side; there is no `month` param and no "upcoming" filter.** For "holidays this month" / "total this month" / "upcoming holidays," fetch the full year's list once and derive all three client-side:
```
thisMonth = holidays.filter(h => month(h.date) === currentMonth)
totalThisMonth = thisMonth.length
upcoming = holidays.filter(h => h.date >= today).sort(by date).slice(0, N)
```
This needs no new backend work — the full-year list is small (a few dozen rows at most) and cheap to fetch once and cache/refetch on year change. "Automatically sync with holidays created by HR" is already true by construction — it's the same table HR writes to via the web portal's Holiday settings, no extra plumbing needed.

---

## 4. New Features

### 4.1 CL (Casual Leave) Approval — already fully built, just needs mobile wiring

Employee side: `GET/POST /casual-leaves?employeeId=&status=&month=&year=` (self-scoped automatically). Eligibility check before showing "Apply": `GET /casual-leaves/eligibility?employeeId=` — staff-only, requires 6+ months of service, one CL per calendar month; the eligibility response tells you exactly why an employee can't apply if they can't.

Approval side (Department Head, on the Approval tab): `PATCH /manager/casual-leaves/<pk>/status` body `{ "status": "approved"|"rejected", "comment": "..." }` — gated by `DepartmentManager.can_approve_casual_leave`. **Approving or rejecting a CL automatically writes the attendance record** (`AttendanceDayRecord`) for that date — approved ⇒ full present day (1.00 shift, paid); rejected ⇒ marked as unpaid leave. No extra step needed after the PATCH call; attendance/payroll pick it up automatically on the next calculation.

### 4.2 Shift Approval — 🔧 entirely NEW, does not exist in any form today

I confirmed `EmployeeShiftAssignment` has no `status`/`approved`/`pending` field, and no shift-assignment approval endpoint exists anywhere in the backend. This needs to be designed and built from scratch, following the exact pattern the other four approval workflows in this codebase already use (submit → pending → manager/employee decides → write-through):

**New model field(s)** on `EmployeeShiftAssignment` (or a new lightweight join model if you'd rather not touch the existing table — recommend adding fields directly since assignment rows are already versioned by `effective_from`/`effective_to`):
```python
requires_approval = models.BooleanField(default=False)
approval_status = models.TextField(choices=[("pending","Pending"),("approved","Approved"),("rejected","Rejected")], null=True, blank=True)
approved_by = models.TextField(null=True, blank=True)
approved_at = models.DateTimeField(null=True, blank=True)
approval_comment = models.TextField(null=True, blank=True)
```
**New endpoints:**
```
GET  /shift-assignments/pending-approval           (HR/manager list, filtered to requires_approval=True, approval_status="pending")
PATCH /shift-assignments/<pk>/approve               body: { "action": "approve"|"reject", "comment": "" }
```
**Decision confirmed:** Department Head countersigns — same as your other four approval types, gated by a `can_approve_shifts` flag on `DepartmentManager` (User Management page), not by employee self-acknowledgment. Build:
- `DepartmentManager.can_approve_shifts` — new boolean field, mirroring the existing 5 flags, editable from the same User Management "Can Approve..." UI.
- `GET /manager/pending-requests` — add a `shiftApprovals` array (§4.3), scoped by the same dept/direct-employee filter already used for the other 4 categories.
- `PATCH /manager/shift-assignments/<pk>/status` — new endpoint in `manager_views.py`, following `manager_update_casual_leave_status`'s exact shape: verify `can_approve_shifts`, verify the assignment's employee is in the manager's scope, verify `approval_status == "pending"`, then set `approval_status`, `approved_by`, `approved_at`, `approval_comment`, and fire a `Notification` to the employee (same pattern as the other 4 — don't forget this one, given how many of the others were initially missed).

### 4.3 Approval Page (consolidated)

**Good news — the merge work is already done server-side.** `GET /manager/pending-requests` (`@require_auth`, requires an active `DepartmentManager` row for the caller) already returns leave + permission + attendance-override + casual-leave + resignation requests in **one call**:
```jsonc
{
  "leaveRequests": [ /* + nested employee{} */ ],
  "permissions": [ /* + nested employee{} */ ],
  "resignations": [...],
  "attendanceRequests": [...],
  "casualLeaves": [...],
  "totalPending": 7
}
```
Add `shiftApprovals: []` to this same response once §4.2 is built (small addition to the same view function). Each category is independently gated by the manager's `can_approve_*` flags — a Department Head who's disabled for, say, permissions will simply get an empty `permissions` array (⚠️ except leave/permission arrays currently aren't gated by their flags in this endpoint the way the other three are — worth tightening for consistency, though the individual approve/reject PATCH calls do correctly enforce the flag either way, so this is a display-only inconsistency, not a security gap).

**Acting on each item** still requires 5 separate PATCH calls (each has different business logic, e.g. CL/attendance write through to `AttendanceDayRecord` while leave/permission don't) — see §4.1 and the URL list in Appendix A.

**"Both HR and Department Heads should be able to interact"** — HR already has full approval capability via the existing HR Portal web pages (Leave Requests, Permissions, Resignations, CL, and the Attendance override queue) — no mobile work needed for HR's side of this; HR does not need to log into the mobile app. The mobile Approval tab is specifically the **Department Head's** interface, using their own employee login + the `manager/*` endpoints above.

---

## 5. Chat Module — ✅ BUILT

Backend is live: models in `models.py` (`ChatChannel`, `ChatMessage`, `ChatReaction`), endpoints in the new `chat_views.py`, migration `0028_chatchannel_chatmessage_chatreaction_and_more` applied. No WebSockets were needed — polling only, per the design below.

Verified end-to-end via a Django-shell smoke test: channel listing, posting to the company channel, replying, reacting/un-reacting, and — most importantly — a **cross-department post attempt correctly returned 403**, and each employee's `GET /chat/channels` only ever lists their own department's channel, never another one's. The access-control rule is doing its job.

**One field-name note for mobile integration:** the actual shipped endpoint accepts `reply_to_id` (snake_case) in the POST body, not `replyToId` as originally sketched below — the view accepts either key (`data.get("reply_to_id") or data.get("replyToId")`), so either casing works, but prefer `reply_to_id` to match what was actually tested.

### New models
```python
class ChatChannel(models.Model):
    CHANNEL_TYPES = [("company", "Company"), ("department", "Department")]
    channel_type = models.TextField(choices=CHANNEL_TYPES)
    department = models.ForeignKey(Department, null=True, blank=True, on_delete=models.CASCADE)
    # one row for "company" (department=None), one row per Department for "department" channels — created lazily on first message or seeded for every existing department

class ChatMessage(models.Model):
    channel = models.ForeignKey(ChatChannel, on_delete=models.CASCADE, related_name="messages")
    sender = models.ForeignKey(Employee, on_delete=models.CASCADE)
    text = models.TextField()
    reply_to = models.ForeignKey("self", null=True, blank=True, on_delete=models.SET_NULL, related_name="replies")
    created_at = models.DateTimeField(auto_now_add=True)

class ChatReaction(models.Model):
    message = models.ForeignKey(ChatMessage, on_delete=models.CASCADE, related_name="reactions")
    employee = models.ForeignKey(Employee, on_delete=models.CASCADE)
    emoji = models.TextField()   # store the emoji character itself, e.g. "👍"
    class Meta:
        unique_together = [("message", "employee", "emoji")]   # one of each emoji per person per message
```

### New endpoints
```
GET  /chat/channels                          → [{ id, type: "company"|"department", departmentId, departmentName }]
                                                 (department channel list is scoped to the caller's own department only —
                                                  an employee should not even see other departments' channel exists)
GET  /chat/channels/<id>/messages?before=<id>&limit=50
                                              → [{ id, senderId, senderName, text, replyTo: {id, senderName, text}|null,
                                                    reactions: [{emoji, count, reactedByMe}], createdAt }]
POST /chat/channels/<id>/messages            body: { text, replyToId? }
POST /chat/messages/<id>/reactions           body: { emoji }
DELETE /chat/messages/<id>/reactions         body: { emoji }   (toggle off)
```
**Access control (important, since this is company-wide messaging):** `company` channel → any active employee may post/read. `department` channel → server verifies `employee.department_id == channel.department_id` on every read and write; rejects with 403 otherwise. ✅ Confirmed working via direct test — see the note above.

### Mobile UI notes
- Two top tabs: Company / Department (hide the Department tab entirely if the employee has no `department_id` set).
- Message bubble: sender name above the bubble (group chat, not 1:1 — always show it, don't collapse consecutive messages from the same sender if that adds complexity you don't need).
- Swipe-to-reply: standard `react-native-gesture-handler` swipeable row revealing a reply icon; on release, populate a "replying to: ..." preview above the input, send `replyToId` with the next message.
- Emoji reactions: long-press a bubble → small emoji picker (5-6 common emoji is plenty per your "simple UI" instruction) → `POST .../reactions`; render reaction pill counts under the bubble, tap to toggle your own.
- "Instant updates": poll `GET /chat/channels/<id>/messages?after=<lastSeenId>` every 3-5s while the screen is focused; stop polling on blur. This satisfies "real-time" without needing Channels/WebSockets for a v1.

---

## 6. Consolidated backend work list

Everything 🔧-tagged above, in one place, roughly in priority order (fixes/small additions first, new feature builds last):

1. ✅ **DONE — Fix `GET /notifications` to self-scope by employee** (§3.3).
2. ✅ **DONE — Added missing `Notification.objects.create(...)` calls** for permission/CL/attendance-override approvals and both manager-path approvals (§3.3). All 7 workflows notify now.
3. ✅ **DONE — Added `uanNumber` to `employee_json()`** (§3.4).
4. ✅ **DONE — Self-service auth relaxation** on `idcard_data`, `idcard_settings_view` (GET only), `employee_monthly_attendance`, `employee_shift_monthly_stats` (§3.6, §3.7, §3.8).
5. **`GET /dashboard/mobile-home-summary`** — new endpoint (§3.1). **Not started.**
6. **`GET /attendance/live-feed`** — new endpoint (§3.1). **Not started.**
7. **`GET /salary-slips/<pk>/pdf`** — new endpoint, reuse existing HTML renderer + reportlab pattern already used for resignations (§3.5). **Not started.**
8. **`GET /my-shift-summary`** — new consolidated endpoint (§3.7), or skip this and do 3 client-side calls using the fixes from #4 (viable today). **Not started.**
9. **Shift Approval workflow** — new model fields + 2 endpoints (§4.2). **Decision confirmed: Department Head countersigns**, following the exact `can_approve_*` flag pattern already used for leave/permission/resignation/CL — add `DepartmentManager.can_approve_shifts` and route through `manager_views.py` the same way `manager_update_casual_leave_status` does. **Not started.**
10. ✅ **DONE — Chat module** — models + 3 endpoints built in `chat_views.py`, migration applied, access control verified end-to-end (§5).

Items 1-4 and 10 are done. None of items 5-8 require a new Django app or architectural change — they're additive fields/endpoints/auth-decorator tweaks on existing views, following the same patterns items 1-4 just used. Item 9 is unblocked (decision made) but not yet built.

---

## Appendix A — Full endpoint reference for this spec

| Page | Method | Endpoint | Notes |
|---|---|---|---|
| Auth | POST | `/auth/employee-login` | body `{identifier, password}` |
| Auth | POST | `/auth/set-password` | body `{identifier, password}` |
| Auth | GET | `/auth/me` | |
| Home | GET | `/dashboard/mobile-home-summary` 🔧 | new, not started |
| Home | GET | `/attendance/live-feed` 🔧 | new, not started |
| Home/ID Card | GET | `/idcard?employeeId=` ✅ | self-service auth fixed |
| Leave | GET/POST | `/leave-requests` | |
| Leave | GET | `/leave-types` | |
| Alerts | GET | `/notifications` ✅ | self-scoping fixed |
| Alerts | PATCH | `/notifications/<pk>/read` | |
| Profile | GET | `/employees/<id>` ✅ | `uanNumber` added |
| Profile | POST | `/auth/set-password` | reuse |
| Profile | GET/POST | `/my/resignation` | |
| Salary Slip | GET | `/my/salary-slips` | |
| Salary Slip | GET | `/salary-slips/<pk>` | |
| Salary Slip | GET | `/salary-slips/<pk>/pdf` 🔧 | new, not started |
| Permission | GET/POST | `/permissions` | monthly cap already enforced |
| Permission | GET | `/attendance/employee-shift-stats` ✅ | self-service auth fixed |
| My Shift | GET | `/my-shift-summary` 🔧 | new, not started (3-call client-side merge is viable now) |
| My Shift | GET | `/casual-leaves?status=approved` | already self-scoped |
| ID Card | GET | `/idcard?employeeId=` ✅ | self-service auth fixed |
| ID Card | GET | `/idcard-settings` ✅ | GET open to all authenticated users |
| ID Card | GET | `/verify-employee/<code>` | public, unchanged |
| Holidays | GET | `/holidays?year=` | filter month/upcoming client-side |
| CL Approval | GET/POST | `/casual-leaves` | already self-scoped |
| CL Approval | GET | `/casual-leaves/eligibility` | |
| Approval (mgr) | GET | `/manager/me` | use to decide whether to show Approval tab |
| Approval (mgr) | GET | `/manager/pending-requests` | combined list |
| Approval (mgr) | PATCH | `/manager/leave-requests/<pk>/status` | |
| Approval (mgr) | PATCH | `/manager/permissions/<pk>/status` | |
| Approval (mgr) | PATCH | `/manager/attendance-requests/<pk>/status` | |
| Approval (mgr) | PATCH | `/manager/casual-leaves/<pk>/status` | |
| Approval (mgr) | PATCH | `/manager/resignations/<pk>/action` | |
| Shift Approval | — | `/shift-assignments/pending-approval`, `/shift-assignments/<pk>/approve` 🔧 | new, not started |
| Chat | GET | `/chat/channels` ✅ | built |
| Chat | GET/POST | `/chat/channels/<id>/messages` ✅ | built, use `reply_to_id` |
| Chat | POST/DELETE | `/chat/messages/<id>/reactions` ✅ | built |

---

*This spec reflects the backend as it exists on 2026-07-08 (revised same day after punch-list items 1-4 landed), verified by direct source reading (not inference) across `models.py`, `views.py`, `leave_views.py`, `manager_views.py`, `casual_leave_views.py`, `recruitment_views.py`, `growth_views.py`, `attendance_views.py`, `salary_slip_views.py`, `shift_engine.py`, `night_shift_views.py`, `system_settings_views.py`, `serializers.py`, and the matching frontend ID-card component. `manage.py check` and a Django-shell import/serialization smoke test both pass clean as of this revision. Re-verify anything marked 🔧 against current source before implementation if significant time has passed since this snapshot.*
