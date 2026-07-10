# UKTextiles Employee Web App — Implementation Blueprint

_Target: extend the existing `frontend/src/pages/employee/*` module in this repo (React 19 + Vite + wouter + TanStack Query + orval-generated client, Tailwind + shadcn/ui) so the web app reaches feature parity with the Expo mobile app described in `uktextiles-employee-app/README.md` and `docs/MOBILE_APP_V2_SPEC.md`. This is additive to the existing HR Portal codebase — same repo, same auth, same API client, same design tokens. No new project, no new backend._

_Backend reference: `docs/MOBILE_APP_V2_SPEC.md` (2026-07-08 snapshot). Anything marked 🔧 there is still unbuilt on the backend as of this writing — the corresponding web page is designed below but gated behind that backend work landing first._

---

## 0. What already exists vs. what this spec adds

| Existing today (`frontend/src/pages/employee/`) | Status | This spec's treatment |
|---|---|---|
| `Dashboard.tsx` | Built — stats, attendance heatmap, recent salary | Extend: add ID card widget, quick actions, live feed (once 🔧 backend lands) |
| `Leave.tsx` | Built — basic leave list/apply | Extend: two-tab Live/Confirmed split, filters, summary cards |
| `Notifications.tsx` | Built | Extend: today filter, mark-as-read, category icons |
| `Profile.tsx` | Built — 360 lines, likely already covers most sections | Audit against §3.4 field mapping, add Change Password + Resignation entry points |
| `Salary.tsx` | Built — list only (79 lines) | Extend: detail view, PDF download/share (once 🔧 `/salary-slips/<pk>/pdf` lands) |
| Attendance calendar | **Missing** | New page, §3.2 below |
| Approvals (Department Head) | **Missing** | New page, §3.3 |
| Permission requests | **Missing** | New page, §3.5 |
| My Shift | **Missing** | New page, §3.6 |
| Digital ID Card (full page) | **Missing** (component exists at `components/idcard/IdCardViews.tsx`, used by HR only) | New page reusing that component, §3.7 |
| Holidays | **Missing** | New page, §3.8 |
| Settlement (employee view) | **Missing** (HR-only `pages/hr/Settlement.tsx` exists) | New page, §3.9 |
| Casual Leave (employee view) | **Missing** (HR-only `pages/hr/CasualLeave.tsx` exists) | New page, §3.10 |
| Chat | **Missing** | New page, §3.11 |
| Resignation | **Missing** | New page, §3.12 |

Reuse without change: `EmployeeLayout.tsx` (shell/nav), `AuthContext.tsx` (`useAuth`), `lib/api-client` (orval hooks — extend the OpenAPI spec and regenerate rather than hand-writing fetch calls), the shadcn/ui primitives already in `components/ui/`.

---

## 1. Full page list

| # | Route | Component (new unless noted) | Mobile equivalent |
|---|---|---|---|
| 1 | `/employee/dashboard` | `Dashboard.tsx` (extend) | Home |
| 2 | `/employee/attendance` | `Attendance.tsx` | Attendance tab |
| 3 | `/employee/leave` | `Leave.tsx` (extend) | Leave tab |
| 4 | `/employee/permissions` | `Permissions.tsx` | Permission (drawer) |
| 5 | `/employee/casual-leave` | `CasualLeave.tsx` | CL Approval (employee side) |
| 6 | `/employee/approvals` | `Approvals.tsx` (Department Heads only) | Approval tab |
| 7 | `/employee/notifications` | `Notifications.tsx` (extend) | Alerts tab |
| 8 | `/employee/profile` | `Profile.tsx` (extend) | Profile / My Profile |
| 9 | `/employee/salary` | `Salary.tsx` (extend, list) | Salary Slip list |
| 10 | `/employee/salary/:id` | `SalaryDetail.tsx` | Salary Slip detail |
| 11 | `/employee/shift` | `MyShift.tsx` | My Shift |
| 12 | `/employee/id-card` | `IdCard.tsx` | ID Card |
| 13 | `/employee/holidays` | `Holidays.tsx` | Holidays |
| 14 | `/employee/settlement` | `Settlement.tsx` | Settlement |
| 15 | `/employee/chat` | `Chat.tsx` | Chat |
| 16 | `/employee/resignation` | `Resignation.tsx` | Resignation (via Profile) |

Public/shared (already exist, no change): `/verify/:code` (`VerifyEmployee.tsx`), `/employee-login`, `/set-password`.

---

## 2. Navigation & information architecture

The mobile app splits nav into bottom tabs (5 items) + a side drawer (13 items) because phone screens are small. On desktop that constraint doesn't exist — collapse everything into one persistent left sidebar (matches `EmployeeLayout.tsx`'s existing pattern, which already renders a sidebar shell for HR; mirror that same shell for employee, don't invent a tab bar).

**Sidebar groups** (top to bottom):

```
UKTextiles                              ← logo, matches EmployeeLayout header
─────────────────────────────
  Home              /employee/dashboard
  Attendance        /employee/attendance
  Leave             /employee/leave
  Permission        /employee/permissions
  Casual Leave      /employee/casual-leave
  Approvals*        /employee/approvals      (* only rendered if GET /manager/me succeeds)
─────────────────────────────
  Salary Slip       /employee/salary
  My Shift          /employee/shift
  ID Card           /employee/id-card
  Holidays          /employee/holidays
  Settlement        /employee/settlement
─────────────────────────────
  Chat              /employee/chat
  Alerts            /employee/notifications   (badge = unread count)
  Profile           /employee/profile
─────────────────────────────
  Logout
```

On mobile/tablet viewport widths, collapse the sidebar into a hamburger-triggered drawer (`components/ui/sheet.tsx` already available) rather than building a separate bottom-tab component — one nav data structure drives both the desktop sidebar and the mobile drawer, avoiding duplicated route lists.

**Top bar** (persistent across all employee pages): employee name + avatar (opens Profile), unread notification bell (opens a dropdown preview of last 5, "View all" → `/employee/notifications`), and on tablet/mobile the hamburger toggle.

**Cross-page navigation flow:**

```
Dashboard
 ├─ Quick Action: Permission  → /employee/permissions
 ├─ Quick Action: Leave       → /employee/leave
 ├─ Quick Action: Salary      → /employee/salary
 ├─ Quick Action: Shift       → /employee/shift
 └─ ID Card widget            → /employee/id-card

Salary (list) → click row → SalaryDetail (/employee/salary/:id) → Download/Share PDF

Profile
 ├─ Change Password  → inline dialog (no navigation)
 └─ Submit Resignation → /employee/resignation

Approvals (Dept Head only)
 └─ tap request card → inline expand/side panel, not a route change (keeps list scroll position)
```

---

## 3. Page-by-page spec

Each page below: purpose, layout, data/API, states, validation.

### 3.1 Dashboard (extend existing)

**Purpose:** at-a-glance status + shortcuts.

**Additions to the existing `Dashboard.tsx`:**
- ID Card widget: compact card rendering the same `components/idcard/IdCardViews.tsx` component at reduced scale (reuse, don't fork), linking to `/employee/id-card`.
- Quick Actions row: 4 icon buttons (Permission, Leave, Salary, Shift) — `<Link>` wrapped `Card`s, `lucide-react` icons, matches existing stat-card visual language.
- Upcoming holiday strip (from `GET /holidays?year=`, filtered client-side to next holiday) — zero new backend work, per spec §3.1.
- Present/Absent/Leave/Pending-requests company-wide widget and live attendance ticker: **defer** — both require the 🔧 unbuilt `GET /dashboard/mobile-home-summary` and `GET /attendance/live-feed`. Build the UI slot now with a feature flag/conditional render so it activates the moment those endpoints ship; don't block this page's release on backend work that isn't started.

**States:** loading → skeleton stat cards (already implemented pattern, reuse `Skeleton`). Error → toast + retry button, don't blank the page. Empty recent-salaries → hide the card section entirely (already implemented).

### 3.2 Attendance

**Purpose:** monthly attendance calendar with per-day punch detail.

**Layout:** month header with prev/next arrows (or a month `<Select>` for desktop — faster than paging), summary bar (Present / Absent / Late / On Leave counts as 4 small stat chips), then a full calendar grid (7-column CSS grid, not a carousel — desktop has room). Each day cell color-coded exactly per mobile: green=present, red=absent, yellow=late, blue=leave, grey=holiday/Sunday. Click a day → **side panel** (desktop) or bottom sheet-style `Dialog` (mobile width) showing First Punch In / Last Punch Out / Total Punches.

**API:** `GET /attendance/employee/{id}?month=&year=` (existing, self-scoped since the mobile fix). Cache per month with TanStack Query key `["attendance", employeeId, month, year]`.

**Empty/edge cases:** future months → disable next-arrow past current month; no data for a day → cell renders grey/empty, clicking shows "No attendance record" instead of an empty panel.

### 3.3 Approvals (Department Head only)

**Purpose:** single-screen consolidated approval queue for leave, permission, attendance-override, casual-leave, and resignation requests.

**Visibility gate:** call `GET /manager/me` once on layout mount (in `EmployeeLayout` or a dedicated `useManagerStatus()` hook); if it 403/404s, don't render the sidebar item or the route (redirect `/employee/approvals` → `/employee/dashboard` if hit directly).

**Layout:** tab strip — Leave / Permission / Attendance / Casual Leave / Resignation — each tab badge shows live pending count from the single `GET /manager/pending-requests` payload (already returns all 5 categories in one call — do not make 5 separate list calls). Each row: employee name + code avatar, request type chip, date range, reason (truncated, expand on click), Approve/Reject buttons inline (desktop has room — don't hide actions behind a second click like the mobile bottom-sheet does).

Clicking "Reject" opens a small `Dialog` for the optional comment field before confirming (matches mobile's bottom-sheet comment field); "Approve" fires immediately with an optimistic UI update, since approvals are rarely regretted and the write-through (e.g. CL → `AttendanceDayRecord`) is idempotent server-side.

**API:**
- `GET /manager/pending-requests` — poll every 30s while tab is focused (`refetchInterval: 30_000` in TanStack Query, paused via `refetchIntervalInBackground: false`).
- `PATCH /manager/leave-requests/{id}/status`
- `PATCH /manager/permissions/{id}/status`
- `PATCH /manager/attendance-requests/{id}/status`
- `PATCH /manager/casual-leaves/{id}/status`
- `PATCH /manager/resignations/{id}/action`

After any PATCH, invalidate the `pending-requests` query key so counts and the acted-on row disappear together — don't manually splice arrays client-side, the server response is the source of truth.

**Known backend gap (§4.3 of the mobile spec):** leave/permission arrays in `pending-requests` aren't currently gated by the manager's `can_approve_*` flags the way the other three are — this is a display-only inconsistency (the PATCH endpoints do enforce the flag), but it means a Department Head disabled for "leave approval" could still see leave rows in this list even though acting on them will 403. Render a disabled/greyed-out state on the Approve/Reject buttons for a category if `GET /manager/me` reports that flag as false, so the UI doesn't offer an action that will fail server-side.

### 3.4 Profile (extend existing)

Audit the existing 360-line `Profile.tsx` against this field mapping (all from `GET /employees/{id}`, single flat table, no need for new endpoints):

| Section | Fields |
|---|---|
| Header | `firstName`, `lastName`, `employeeCode`, `departmentName`, `designationTitle`, `phone`, `joinDate`, `photoUrl` |
| Personal | `firstName`, `lastName`, `gender`, `dateOfBirth`, `email`, `phone`, `bloodGroup`, `emergencyContact` |
| Family | `fatherName`, `motherName` |
| Employment | `employeeCode`, `employmentType`, `role`, `departmentName`, `designationTitle`, `joinDate`, `status` |
| Bank | `bankName`, `bankAccount`, `bankIfsc` |
| Compliance | `pfNumber`, `esiNumber`, `uanNumber` |
| Address | `address` (single free-text block, render as multi-line, don't try to split into structured fields — there are none server-side) |

Add if missing: **Change Password** (inline `Dialog` → `POST /auth/set-password`, prefill `identifier` from session, never make the user retype their own code) and a **Submit Resignation** button linking to `/employee/resignation`.

**Layout:** desktop gets a two-column grid of section cards instead of the mobile's single vertical scroll — more information visible without scrolling, same data.

### 3.5 Permission Requests

**Purpose:** request Early Out / Late In / Short Leave, track monthly cap usage.

**Layout:** top summary card — "Permissions used this month: 2/3" progress bar sourced directly from the list response's `monthlyUsed`/`monthlyLimit` fields (don't compute the cap client-side — the server is authoritative and enforces it). Below: Live Requests / Confirmed Requests tabs (same pattern as Leave), each a table (desktop) with columns Type, Date, Time, Reason, Status.

**Apply form** (`Dialog` or dedicated panel): Type — segmented control (Early Out / Late In / Short Leave), Date picker (`components/ui/calendar.tsx`), Time picker (native `<input type="time">` is fine for web — no need to port a mobile clock-wheel component), Reason — `Textarea`, min 5 chars.

**Validation:** all fields required; reason min length 5; date cannot be in the past (client-side check as a UX nicety — server is still authoritative). If `monthlyUsed >= monthlyLimit`, disable the submit button proactively and show "Monthly limit reached" rather than letting the user hit the 400 — but still handle the 400 gracefully (toast with the server's message) in case of a race (e.g. two tabs open).

**API:** `GET/POST /permissions?employeeId=&status=`. `GET /attendance/employee-shift-stats?employee_id=` for the Late Count / Shift Deductions / Salary Deduction Amount read-only panel described in mobile spec §3.6 — render these three numbers below the cap summary since they're the actual payroll-facing consequence of lateness, distinct from the permission-request cap.

### 3.6 My Shift

**Purpose:** assigned shift timing + monthly lateness/absence rollup.

**Layout:** header card — shift name, start/end time, grace period (large, glanceable). Below, a stat row: Late Count, Half-Shift Count, CL Approvals, Total Working Shifts, Absent Count. Below that, a daily log table (date, punch-in, punch-out, status) — this is the same `dailyLogs` shape `employee-shift-stats` already returns.

**API:** if `GET /my-shift-summary` (🔧, not yet built) has landed, use it — one call. Otherwise, merge client-side from the three calls the mobile spec confirms are already self-service-safe:
- `GET /attendance/employee-shift-stats?month=&year=` → lateCount, halfShiftCount, totalWorkingShifts, absentCount, dailyLogs
- `GET /attendance/employee-monthly-attendance?month=&year=` (or equivalent) → assignedShift resolution
- `GET /casual-leaves?status=approved&month=&year=` → count for casualLeaveApprovals

Wrap this merge in a single custom hook (`useMyShiftSummary(month, year)`) so the page component doesn't care which of the two data-sourcing strategies is active — swapping in the consolidated endpoint later is a one-file change.

### 3.7 Digital ID Card

**Purpose:** employee's own ID card, pixel-matching the HR Portal's canonical design.

**Do not rebuild the card visuals.** Reuse `components/idcard/IdCardViews.tsx` exactly as HR's `IdCards.tsx` does — pass the employee's own `employeeId` (never expose a picker for other employees on this page). Two-column layout on desktop: front face left, back face (with QR) right, both full-size — no flip animation needed since both sides fit on screen simultaneously (this is a web-only improvement over the mobile tap-to-flip interaction, worth calling out to the user as one of the "modern enhancement" opportunities).

**API:** `GET /idcard?employeeId=` (self-scoped), `GET /idcard-settings` (template/theme, GET open to all authenticated users).

**Do not attempt to make `template.textColor`, `template.backgroundStyle`, `template.logoPosition` do anything** — confirmed dead fields per the mobile spec; the live component hardcodes its visuals regardless.

**Add-on for web only:** a "Download as PNG" button (canvas-to-PNG via a library like `html-to-image`, already low-risk since the card is a fixed-size DOM node) — mobile can't easily do this but web can, and it's a genuinely useful addition (save to share via email/print) without needing any backend change.

### 3.8 Holidays

**Purpose:** company holiday calendar for the year.

**Layout:** year `<Select>` (defaults to current year) + a card-per-month or flat sortable table (Date, Holiday Name, Day of Week, Type badge). Fetch once per year (`GET /holidays?year=`), derive "this month" / "upcoming" sections client-side exactly as the mobile spec recommends (no month/upcoming param exists server-side — don't add one, the dataset is small enough to filter client-side).

**Empty state:** if a year has zero holidays yet configured by HR, show "No holidays published for {year} yet" rather than a blank table.

### 3.9 Settlement

**Purpose:** view Full & Final Settlement details, if applicable to this employee.

**Layout:** single detail card — settlement amount, itemized deductions table, status badge. If the employee has no settlement record (still active, no resignation processed), show an empty state: "No settlement on file" rather than a 404-styled error — this is the common case, not an error case.

**API:** `GET /settlement` (existing, per mobile spec Appendix A — confirm self-scoping the same way `/employees/{id}` and `/permissions` were fixed; if it isn't yet self-scoped for employee tokens, flag that as a backend gap before shipping this page, since it's the kind of endpoint that could leak another employee's settlement data if it isn't).

### 3.10 Casual Leave

**Purpose:** apply for and track Casual Leave (CL), a distinct workflow from regular Leave — staff-only, requires 6+ months service, one per calendar month.

**Layout:** eligibility banner at top (`GET /casual-leaves/eligibility?employeeId=`) — if ineligible, show why (e.g. "Available after 6 months of service") and disable the Apply button rather than letting them hit a submit error. Below: same Live/Confirmed tab pattern as Leave and Permission, list from `GET /casual-leaves?employeeId=&status=&month=&year=`.

**Important UX note carried over from the backend spec:** approving/rejecting a CL automatically writes the attendance record for that date (approved = paid present day, rejected = unpaid leave) — make this visible in the UI copy ("Approved CL days count as a paid present day") so employees understand why their attendance calendar changes after a CL decision, rather than it looking like an unexplained discrepancy.

### 3.11 Chat

**Purpose:** company-wide and department-scoped group messaging.

**Layout:** two-tab layout, Company / Department (hide the Department tab if the employee has no `departmentId` — per backend note). Standard chat UI: message list (sender name above each bubble, always shown — this is group chat, not 1:1), input box pinned to bottom, reply preview strip above input when replying, emoji reaction pills below bubbles.

**Interactions:**
- Reply: click a small reply icon on hover (web has no swipe gesture — use hover-reveal instead of the mobile swipe-to-reply), populates "replying to: ..." above input, sends `reply_to_id` with the next message (use the snake_case key — confirmed as the tested field name, not `replyToId`).
- Reactions: click a reaction-add icon on hover → small emoji picker popover (5-6 common emoji, matches mobile's "simple UI" instruction) → `POST /chat/messages/{id}/reactions`; click an existing pill to toggle your own reaction off (`DELETE .../reactions`).
- Live updates: poll `GET /chat/channels/{id}/messages?after={lastSeenId}` every 3-5s while the tab is focused (use the Page Visibility API to pause polling when the browser tab isn't active — a web-specific optimization mobile's focus/blur equivalent doesn't need to think about as carefully, since a stray desktop background tab is cheaper to avoid-poll than a backgrounded phone app).

**Access control note for the UI:** treat 403 on posting to a department channel as "you don't have a department channel" and hide the tab retroactively rather than showing a raw error — matches the backend's confirmed behavior of scoping department channel visibility per-employee.

### 3.12 Resignation

**Purpose:** submit and track a resignation request through its multi-stage approval (dept-head → HR).

**Layout:** if no resignation on file — a form (reason `Textarea`, requested last-working-day date picker, submit button). If one exists — a status timeline (Submitted → Dept Head Decision → HR Decision), each stage showing who acted and when, plus the final outcome.

**API:** `GET/POST /my/resignation`.

**Validation:** reason required (min length, match whatever the HR-side resignation form already enforces in `pages/hr/recruitment/Resignations.tsx` — check that file for the exact rule rather than inventing a new one, to keep the two sides consistent).

---

## 4. Reusable components & layout structure

Build these once, share across the new pages — don't duplicate per-page:

| Component | Used by | Notes |
|---|---|---|
| `StatusBadge` | Leave, Permission, CL, Approvals, Resignation | Pending/Approved/Rejected color mapping — one source of truth, currently likely duplicated ad hoc per page |
| `RequestTabs` | Leave, Permission, CL | Generic "Live / Confirmed" tab shell taking a list + status accessor, avoid rebuilding the tab logic 3 times |
| `MonthYearPicker` | Attendance, My Shift, Holidays | Shared month/year selector control |
| `AttendanceCalendarGrid` | Attendance, (Dashboard heatmap could migrate to reuse this later) | 7-col grid, color-coded cells, click handler prop |
| `DayDetailPanel` | Attendance | Side panel / dialog showing punch times for a selected day |
| `ApprovalCard` | Approvals | Generic card taking `{type, employee, dates, reason, onApprove, onReject}` — one component for all 5 request kinds, differing only in the fields shown |
| `EmptyState` | every list page | Already may exist in mobile form (`src/components/ui/EmptyState.tsx` in the RN app) — port the visual pattern using `components/ui/empty.tsx` which already exists in this repo |
| `useManagerStatus()` hook | Layout, Approvals | Wraps `GET /manager/me`, caches the boolean + flags for the session |
| `useMyShiftSummary(month, year)` hook | My Shift | Isolates the "1 call vs 3 calls" backend-readiness decision from the page |

**Folder structure addition** (files to add under the existing structure — nothing new at the top level):

```
frontend/src/
├── pages/employee/
│   ├── Dashboard.tsx        (extend)
│   ├── Attendance.tsx       (new)
│   ├── Leave.tsx            (extend)
│   ├── Permissions.tsx      (new)
│   ├── CasualLeave.tsx      (new)
│   ├── Approvals.tsx        (new)
│   ├── Notifications.tsx    (extend)
│   ├── Profile.tsx          (extend)
│   ├── Salary.tsx           (extend)
│   ├── SalaryDetail.tsx     (new)
│   ├── MyShift.tsx          (new)
│   ├── IdCard.tsx           (new)
│   ├── Holidays.tsx         (new)
│   ├── Settlement.tsx       (new)
│   ├── Chat.tsx             (new)
│   └── Resignation.tsx      (new)
├── components/
│   └── employee/            (new subfolder, mirrors components/idcard/ convention)
│       ├── StatusBadge.tsx
│       ├── RequestTabs.tsx
│       ├── MonthYearPicker.tsx
│       ├── AttendanceCalendarGrid.tsx
│       ├── DayDetailPanel.tsx
│       └── ApprovalCard.tsx
├── hooks/
│   ├── useManagerStatus.ts  (new)
│   └── useMyShiftSummary.ts (new)
└── lib/api-client/generated/  (regenerate via orval once backend OpenAPI schema adds the new endpoints — do not hand-write fetch wrappers for endpoints orval can generate)
```

---

## 5. Navigation flow diagram

```
                    ┌───────────┐
                    │  Login    │
                    └─────┬─────┘
                          │
                    ┌─────▼─────┐
                    │ Dashboard │◄──────────────────────┐
                    └─────┬─────┘                       │
        ┌───────┬─────────┼─────────┬───────┐          │
        ▼        ▼         ▼         ▼       ▼          │
   Attendance  Leave   Permission  Salary  Shift        │
                 │         │       (list)               │
                 ▼         │          │                  │
           My Requests     │          ▼                  │
                            │    SalaryDetail             │
              (Approvals — only if Dept Head) ────────────┤
                                                            │
   Profile ──► Change Password (dialog)                    │
      └──────► Resignation (route) ──────────────────────►┘
   ID Card / Holidays / Settlement / Chat / Casual Leave ─►┘
   (all reachable from sidebar directly, no deep nesting)
```

Keep navigation shallow — every page is one click from the sidebar, and the only two-level flow is Salary → SalaryDetail. This mirrors good web IA practice better than the mobile app's necessarily deeper drawer/tab nesting.

---

## 6. Responsive design

| Breakpoint | Layout behavior |
|---|---|
| Desktop (≥1280px) | Persistent left sidebar (240px), content max-width ~1100px centered or full-bleed for tables, two-column card grids where noted (Profile, stat rows) |
| Tablet (768–1279px) | Sidebar collapses to icon-only rail (tooltips on hover) or a toggleable drawer; stat/card grids drop to 2 columns |
| Mobile (<768px) | Sidebar becomes a `Sheet`-based drawer triggered by hamburger; all grids collapse to 1 column; tables convert to stacked card rows (reuse the pattern already likely present in `pages/hr/*` tables — check `Employees.tsx` for the existing responsive-table convention before inventing a new one) |

Use Tailwind's existing breakpoint tokens already configured in this project rather than introducing new custom breakpoints. Test each new page at 375px, 768px, and 1280px widths before considering it done (per this project's own verification workflow expectations).

---

## 7. Mobile-style UI patterns adapted for web

| Mobile pattern | Web adaptation |
|---|---|
| Bottom sheet (day detail, approval detail) | Side panel (desktop) or centered `Dialog` (narrow viewport) — `components/ui/sheet.tsx` and `dialog.tsx` already exist, pick per breakpoint |
| Swipe-to-reply (Chat) | Hover-reveal reply icon |
| Tap-to-flip ID card | Side-by-side front/back (desktop has room) |
| Pull-to-refresh | Explicit refresh button + TanStack Query `refetchInterval` for near-live data (Approvals, Chat) — pull-to-refresh has no clean web equivalent and shouldn't be faked |
| Native date/time picker | `components/ui/calendar.tsx` (already in repo) for dates; native `<input type="time">` for time — don't port a custom wheel picker, browsers already provide this well on web |
| Bottom tab bar | Persistent sidebar (see §2) |
| Marquee live ticker | CSS `animation: scroll` marquee, pausable on hover (a web-only nicety — the mobile version can't easily pause on touch) |

---

## 8. State management

- **Server state:** TanStack Query exclusively, exactly as the existing pages already do (`useGetEmployeeDashboardSummary`, `useListAttendance`, etc. via orval). Every new page gets its data through a generated or thin custom hook — no ad hoc `fetch`/`axios` calls inside components.
- **Query keys:** namespace by resource + params, e.g. `["attendance", employeeId, month, year]`, `["manager-pending-requests"]`, `["chat-messages", channelId]` — mirrors the existing `getGetEmployeeDashboardSummaryQueryKey()` convention from orval; for hand-rolled hooks (Chat polling, manager status) follow the same explicit-key discipline so invalidation from mutations (Approve/Reject, Send Message) is precise instead of blanket `invalidateQueries()`.
- **Auth/session:** `AuthContext` as-is — no changes needed, `user.employeeId` is already the scoping key every new hook needs.
- **Local/UI state:** plain `useState`/`useReducer` per component (active tab, selected month, dialog open/closed) — this app doesn't need a global client-state library (Redux/Zustand) for anything described here; resist adding one.
- **Polling:** Approvals (30s) and Chat (3-5s) are the only two pages needing `refetchInterval`; pair both with `refetchIntervalInBackground: false` and, for Chat, the Page Visibility API to fully stop polling on an inactive tab.

---

## 9. User roles & permission handling

Two effective states for an employee-role JWT (per mobile spec §1 — there is no separate "manager" role):

1. **Regular employee** — sees all sidebar items except Approvals.
2. **Employee + active `DepartmentManager` row** — additionally sees Approvals, and within it only the categories their `can_approve_*` flags permit (see §3.3's disabled-button handling for the leave/permission display-gap).

Determine which via `useManagerStatus()` (wraps `GET /manager/me`) once per session, cached, re-checked on login. Do **not** infer manager status from `user.role` — the JWT role is always `"employee"` even for Department Heads, exactly as the backend spec states; gate purely on the `/manager/me` response.

HR-role users never see any `/employee/*` route — `ProtectedRoute`'s existing `allowedRoles` mechanism in `App.tsx` already handles this; no change needed there beyond registering the new routes with `allowedRoles={["employee"]}`.

---

## 10. Validation rules (forms)

| Form | Field | Rule |
|---|---|---|
| Apply Leave | Leave Type | required, one of the values from `GET /leave-types` (or the 6 built-in fallbacks) |
| | Start/End Date | both required, end ≥ start |
| | Reason | required, min 5 chars |
| Apply Permission | Type | required (Early Out / Late In / Short Leave) |
| | Date | required, not in the past |
| | Time | required |
| | Reason | required, min 5 chars |
| | (implicit) monthly cap | disable submit client-side once `monthlyUsed >= monthlyLimit`; still handle server 400 gracefully |
| Apply Casual Leave | Date | required; disabled entirely if eligibility check fails |
| | Reason | required |
| Change Password | New Password | min 8 chars (matches backend's stated rule) |
| | Confirm Password | must match |
| Resignation | Reason | required, match HR-side form's existing min-length rule |
| | Last Working Day | required, ≥ today |

All forms: inline field-level error text on blur/submit (not just a top-of-form summary), submit button disabled while the mutation is in flight, and a success toast + navigation/reset on success.

---

## 11. Loading, empty, and error states

- **Loading:** skeleton components matching each page's actual layout shape (stat-card skeletons, table-row skeletons, calendar-grid skeletons) — never a single centered spinner for a whole page once any partial data is renderable, following the existing `Dashboard.tsx` pattern of skeleton-per-card.
- **Empty:** every list/table page needs a distinct empty-state illustration + message (`components/ui/empty.tsx`) — "No leave requests yet", "No holidays published for {year}", "No settlement on file", etc. Never render a bare empty table.
- **Error:** toast notification (`components/ui/toast.tsx` + `sonner.tsx`, already wired via `<Toaster />` in `App.tsx`) for mutation failures, surfacing the server's actual message where available (e.g. the permission monthly-cap 400). For query failures, an inline retry affordance on the affected card/section — don't crash the whole page for one failed widget (e.g. if the ID card widget on Dashboard fails to load, the rest of Dashboard should still render).

---

## 12. Notifications, alerts, toasts

- **In-app toast** (ephemeral, already available via `sonner`): mutation success/failure — "Leave request submitted", "Permission request rejected: monthly limit reached", etc.
- **Persistent Alerts page** (`/employee/notifications`, extending the existing page): full history from `GET /notifications`, filterable to today, mark-as-read via `PATCH /notifications/{id}/read`, category icon per `type` field (leave/permission/resignation/casual-leave/attendance/chat-mention if that's later added).
- **Notification bell dropdown** (top bar, new): last 5 unread, "Mark all read" action, "View all" link — a web-only convenience the mobile app's tab-based nav doesn't need but that meaningfully improves desktop UX (users check email-style notification bells reflexively on web).

---

## 13. Performance

- Route-level code splitting: wrap each new employee page in `React.lazy` + `Suspense` (or rely on Vite's automatic per-route chunking if the project already does this via dynamic `import()` in `App.tsx` — check first; if `App.tsx` currently imports every page eagerly, as shown above, that's worth revisiting for a project this size, but treat it as a separate perf pass rather than bundling it into this feature work).
- TanStack Query `staleTime` tuned per resource: attendance/holidays (rarely change intra-session) can have a longer `staleTime` than Approvals/Chat (need near-live data).
- Virtualize the Chat message list and any Attendance report table beyond ~200 rows if HR-side tables already use a virtualization pattern (check `pages/hr/AttendanceReportLog.tsx` for precedent before introducing a new library).
- Debounce any search/filter inputs added to list pages (Leave/Permission/CL filters).
- Reuse the ID card component's rendering as-is rather than re-rendering it twice (once on Dashboard widget, once on the full ID Card page) if it turns out to be render-expensive — memoize with `React.memo` if profiling shows it's worth it, not preemptively.

---

## 14. Accessibility

- All interactive elements (calendar day cells, approval action buttons, tab strips) must be keyboard-operable — shadcn/ui primitives already handle most of this; custom components (`AttendanceCalendarGrid`, `ApprovalCard`) need explicit `role`, `tabIndex`, and `aria-label`s (e.g. a day cell's `aria-label="July 9, Present, 2 punches"`).
- Color is never the only signal: attendance status cells and approval status badges need a text label or icon alongside color (colorblind users must be able to distinguish Present/Late/Absent/Leave without relying on green/yellow/red/blue alone).
- Forms: every input has an associated `<label>` (via `components/ui/form.tsx` + `field.tsx`, already in repo), error messages linked via `aria-describedby`.
- Focus management: opening a `Dialog`/`Sheet` traps focus and returns it to the triggering element on close (Radix-based shadcn components handle this by default — verify custom panels don't break it).
- Sufficient contrast on all new status-badge color combinations — check against the existing `StatusBadge` colors already used elsewhere in the HR portal rather than inventing a new palette.

---

## 15. Suggested build order

Group by dependency on unbuilt backend work, so the team isn't blocked:

**Phase 1 — no backend work needed, ship immediately:**
Attendance, extend Leave (tabs/filters), Permissions, Casual Leave, extend Profile (Change Password + Resignation link), Holidays, Settlement (pending self-scoping confirmation), Chat, Resignation, My Shift (via 3-call client merge), ID Card (full page).

**Phase 2 — needs Approvals-specific backend confirmation:**
Approvals page (backend already built per mobile spec §4.3 — just needs the leave/permission flag-gating display fix noted in §3.3 above, which can ship without it as a known limitation).

**Phase 3 — blocked on 🔧 unbuilt backend endpoints:**
Dashboard's company-wide today widget + live ticker (`/dashboard/mobile-home-summary`, `/attendance/live-feed`), Salary PDF download/share (`/salary-slips/<pk>/pdf`), Shift Approval workflow (entirely new feature, §4.2 of mobile spec — not designed above since it has no employee-facing UI requirement yet beyond "my shift assignment shows a pending-approval state," which can be added to My Shift once the backend fields exist).

This ordering lets most of the web app ship now, with Dashboard and Salary getting incremental upgrades as the corresponding backend items in `docs/MOBILE_APP_V2_SPEC.md` §6 land.
