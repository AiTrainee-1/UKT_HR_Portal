# UKTextiles HRMS -Frontend (HR Portal)

React + Vite SPA for the UKTextiles HR Portal -the admin/HR-facing app in this repo. Talks to the Django backend (`backend.md`) at `/api` (proxied in dev). The Employee Web App and Employee Mobile App are **separate repositories**, not part of this one, though this repo's `frontend/src/pages/employee/` also hosts a smaller, in-portal self-service section (Section 4).

---

## 1. Quick Start

```bash
cd frontend
npm install
copy .env.example .env
```

Start the backend on port **8080** first (`backend.md`), then:

```bash
npm run dev
```

Open **http://localhost:5173**. Vite proxies `http://localhost:5173/api/*` → `http://localhost:8080/api/*`.

**Production build:**
```bash
npm run build
npm run preview
```
Set `VITE_API_URL` if the API isn't served on the same host under `/api` (e.g. a separate deployed origin).

---

## 2. Tech Stack

| Package | Purpose |
|---|---|
| React 19 + Vite 7 + TypeScript | UI framework + dev server |
| Wouter | Client-side routing |
| TanStack Query | Server state, caching, polling (near-live notification/badge counts, bulk-operation progress bars) |
| Tailwind CSS v4 + shadcn/ui | Styling and component library ("clay" glassmorphism visual language) |
| Recharts | Charts and graphs |
| Orval (generated, `src/lib/api-client/`) | Type-safe API hooks from the OpenAPI spec, supplemented by hand-written hooks in `custom-hooks.ts` for endpoints not on the generated spec |
| Lucide React | Icons |
| html2canvas-pro | Client-side rasterization for ID Card Download/Print (the `-pro` fork specifically -see Section 5, it fixes a real Tailwind v4 `oklch()` color incompatibility the original `html2canvas` has) |

---

## 3. Project Structure

```
frontend/src/
├── pages/
│   ├── hr/                       # ~40+ page components -one per HR Portal sidebar item
│   │   ├── Dashboard.tsx / Employees.tsx / Attendance.tsx / GeoAttendance.tsx
│   │   ├── ManageShift.tsx / MissingPunch.tsx / ManualPunchImport.tsx / AttendancePunchSearch.tsx
│   │   ├── LeaveHoliday.tsx / CasualLeave.tsx / Requests.tsx
│   │   ├── StaffPayroll.tsx / ProductionPayroll.tsx / Settlement.tsx
│   │   ├── IdCards.tsx / Promotion.tsx / Increment.tsx / Bonus.tsx / Reports.tsx
│   │   ├── recruitment/          # NewJoinees, Resignations, Interviews, ResumeScreening, Documents, ...
│   │   ├── AccountManagement.tsx / ActivityLogs.tsx / LoginDevices.tsx
│   │   └── Settings.tsx          # Every tab: Company/Attendance/Late Detection/Devices/Documents/
│   │                             #   Payroll/Production Payroll/Salary Slip/WhatsApp/SMTP/Backup
│   └── employee/                 # Small in-portal employee self-service section, see Section 4
│       ├── Dashboard.tsx / Leave.tsx / Notifications.tsx / Profile.tsx / Salary.tsx
├── components/
│   ├── EmployeeSearchSelect.tsx  # Dynamic employee search by code
│   ├── HrLayout.tsx              # View-only fieldset lock per permission level
│   ├── ui/dashboard-sidebar.tsx  # Sidebar, pending badges, permission-filtered nav
│   ├── payroll/BreakdownDrawer.tsx  # Shared day-by-day payroll breakdown, staff + production
│   ├── SalarySlipBulkPipeline.tsx / WhatsAppBulkPipeline.tsx / PayrollGenerationPipeline.tsx
│   │                             # Inline progress bars for long-running bulk operations
│   └── Global*Banner.tsx         # Floating equivalents of the pipelines above, visible while
│                                 #   navigating away from the page that started the operation
├── contexts/
│   ├── AuthContext.tsx           # Session, permission level helpers
│   ├── SalarySlipBulkContext.tsx / WhatsAppBulkContext.tsx / PayrollGenerationContext.tsx
│   │                             # Own the actual trigger + polling for each bulk operation,
│   │                             #   mounted once at the app root so progress survives navigation
│   └── BiometricSyncContext.tsx
└── lib/
    ├── permission-modules.ts     # Frontend mirror of backend/api/permission_registry.py -keep
    │                             #   these two in lockstep whenever a module/permission changes
    └── api-client/
        ├── custom-hooks.ts       # Hand-written hooks for endpoints off the OpenAPI spec
        └── index.ts              # Orval-generated hooks
```

---

## 4. Employee Self-Service Pages (in this repo)

`frontend/src/pages/employee/` is a lightweight, in-portal self-service section -distinct from the separate standalone Employee Web App repo. Currently built: **Dashboard, Leave, Notifications, Profile, Salary**.

A implementation blueprint exists for extending this section toward parity with the mobile app's self-service surface (Attendance view, Approvals for department heads, Permission Requests, My Shift, Digital ID Card, Holidays, Settlement, Casual Leave, Chat, Resignation) -all currently **unbuilt** in this section. If picked up, each new page should follow the same reusable layout/component patterns, role/permission handling, and validation conventions as the five pages already shipped, and call the same backend endpoints documented in `backend.md`.

---

## 5. Notable Frontend-Specific Fixes & Patterns

**ID Card Download used to fail silently.** Root cause: `html2canvas` 1.4.1 can't parse the `oklch()` color functions Tailwind v4 emits by default (used throughout the card's own styling), and the failure was being swallowed by an empty `catch {}` -so Print (native browser rendering) worked while Download silently failed with a generic toast and no console error. Fixed by switching to `html2canvas-pro` (a maintained, API-compatible fork with `oklch`/`lab` support) and logging/surfacing the real error. If any other component ever adds its own html2canvas-based capture, use `html2canvas-pro`, not the original package.

**Bulk-operation progress bars all follow one pattern.** Payroll generation, biometric sync, salary-slip bulk email/download, and WhatsApp bulk send are all: a context mounted at the app root owning the trigger + a 600ms-interval poll of a backend in-memory progress endpoint, an inline pipeline component on the page that started it, and a floating "Global*Banner" equivalent shown elsewhere while it's still running. Copy this shape rather than inventing a new one for the next long-running bulk action.

**KPI-card counts must count distinct employees, not raw rows.** Two real bugs shipped and fixed the same day illustrate this: a `SalarySlip` list query was splitting Staff/Production by a stale `week_number IS NULL` check that no longer distinguished them correctly once Production moved to period-based payroll, and a Production Payroll KPI card was counting pending `Payroll` rows (multiple periods per employee) instead of distinct employees. Any new aggregate count on a per-employee-period table should default to counting distinct `employeeId`s.
