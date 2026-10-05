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
│   │   ├── ManageShift.tsx + shifts/   # Shifts / Assignments / Unassigned tabs; ShiftCard, ShiftFormDialog (live validation),
│   │   │                               #   AssignDialog (SelectionBuilder include/exclude chips + PlanPreview), AssignmentsTab,
│   │   │                               #   UnassignedTab, ManageAssignmentDialogs, shift-logic.ts (pure, tested)
│   │   ├── MissingPunch.tsx / ManualPunchImport.tsx / AttendancePunchSearch.tsx
│   │   ├── LeaveHoliday.tsx / CasualLeave.tsx / Requests.tsx
│   │   ├── StaffPayroll.tsx / ProductionPayroll.tsx / Settlement.tsx
│   │   ├── IdCards.tsx / Promotion.tsx / Increment.tsx / Bonus.tsx
│   │   ├── Reports.tsx + report-center/   # Report Center: catalog, workspace, schema-driven filters, result table
│   │   ├── recruitment/          # NewJoinees, Resignations, Interviews, ResumeScreening, Documents, ...
│   │   ├── AccountManagement.tsx / ActivityLogs.tsx / LoginDevices.tsx
│   │   │   (AccountManagement.tsx is the page; account-management/ holds its tabs, the role editor and logic.ts)
│   │   ├── BulkUploadEmployees.tsx + bulk-upload/   # Staff ⇄ Production workspace: templates, check-first upload flow,
│   │   │                                            #   per-row ResultsPanel, RemovalPanel (leave / make Inactive / delete)
│   │   ├── UserManagement.tsx + user-management/   # Two tabs: HodAssignmentTab (who the HODs are: HodCard list,
│   │   │                                            #   CreateUserDialog) and ApprovalWorkflowControl (every approval's
│   │   │                                            #   pipeline, ON/OFF, editor). Shared ApprovalPermissionPicker +
│   │   │                                            #   approval-permissions.ts (the 7 HOD switches, pipeline hints);
│   │   │                                            #   roster.ts (filter/summarise a department's people)
│   │   ├── ManagerDetail.tsx + user-management/manager-detail/   # One HOD: ManagerHero, permission cards (save on press),
│   │   │                                            #   DepartmentsCard -> DepartmentSection (employees listed automatically,
│   │   │                                            #   Remove / Restore / bulk / Undo), IndividualCard, ConflictDialogs
│   │   └── Settings.tsx          # Every tab: Company/Attendance/Late Detection/Devices/Documents/
│   │                             #   Payroll/Production Payroll/Salary Slip/WhatsApp/SMTP/Backup
│   ├── md/                       # The MD portal (/md/*): Md<Page>.tsx + a folder of pieces per page (dashboard, attendance,
│   │                             #   employees, visitors, tea-break, payroll, reports, recruitment, activity); see md-portal.md
│   └── employee/                 # Small in-portal employee self-service section, see Section 4
│       ├── Dashboard.tsx / Leave.tsx / Notifications.tsx / Profile.tsx / Salary.tsx
├── components/
│   ├── EmployeeSearchSelect.tsx  # Dynamic employee search by code
│   ├── HrLayout.tsx              # View-only fieldset lock per permission level
│   ├── status/                   # "Aurora Midnight" status screens (StatusScreen kit + ErrorBoundary): connection lost / database
│   │                             #   offline (ConnectivityOverlay), 404 (pages/not-found), server error (pages/ServerError, /server-error)
│   ├── ApprovalTrail.tsx         # How an HR screen shows a request's place in ITS approval pipeline:
│   │                             #   WaitingChip, ApprovalTrail stepper, ApprovalTrailLine, PipelineNote/Summary
│   ├── ui/dashboard-sidebar.tsx  # Sidebar, pending badges, permission-filtered nav
│   ├── md/                       # MD portal shell and kit: MdLayout/MdSidebar/md-nav.ts, kit/ (StatCard, SectionCard, TrendChart,
│   │                             #   BarList, DonutChart, Heatmap, DataTable, InsightList, FilterBar...), assistant/ (the AI side panel:
│   │                             #   Composer, MessageBubble, Explainer, voice/ input + speech output)
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
    ├── md/                       # format.ts (₹ lakh/crore, %), period.ts, types.ts, assistant-store.ts (module-level store so the
    │                             #   conversation survives page changes), markdown.ts, voice.ts, access.ts
    ├── permission-modules.ts     # Frontend mirror of backend/api/permission_registry.py -keep
    │                             #   these two in lockstep whenever a module/permission changes
    ├── approval-workflow.ts      # Twin of backend/api/approval_workflow.py for the UI: pipeline editing rules,
    │                             #   the per-request `approval` block helpers (hrCanAct, waitingText, wouldFinish, ...)
    └── api-client/
        ├── custom-hooks.ts       # Hand-written hooks for endpoints off the OpenAPI spec
        └── index.ts              # Orval-generated hooks
```

### The MD portal front end
`/md/*` is a second shell (`MdLayout`) for the one Managing Director account (`AuthContext.isMd`, from `/auth/me`; the route guard in `App.tsx` sends everyone else away). Pages are built from the kit in `components/md/kit/` and read `/api/md/*` through `useMdQuery`. Two rules worth knowing before touching a page: **layout answers to the page's width, not the screen's** (`MdLayout`'s `<main>` is a Tailwind v4 `@container`; use `@3xl:`/`@5xl:` variants, because the assistant panel can take 444 px of the page), and **every figure carries its provenance** ("How is this calculated?") and an Ask-AI question. The assistant panel (`AssistantHost`, mounted once in `App.tsx`) is text + voice (Web Speech API with a server-transcription fallback) and renders the server-built explanation. Full recipe and rules: `md-portal.md` sections 4 and 6.

---

## 4. Employee Self-Service Pages (in this repo)

`frontend/src/pages/employee/` is a lightweight, in-portal self-service section -distinct from the separate standalone Employee Web App repo. Currently built: **Dashboard, Leave, Notifications, Profile, Salary**.

A implementation blueprint exists for extending this section toward parity with the mobile app's self-service surface (Attendance view, Approvals for department heads, Permission Requests, My Shift, Digital ID Card, Holidays, Settlement, Casual Leave, Chat, Resignation) -all currently **unbuilt** in this section. If picked up, each new page should follow the same reusable layout/component patterns, role/permission handling, and validation conventions as the five pages already shipped, and call the same backend endpoints documented in `backend.md`.

---

### Approval pipelines in the HR portal
Who may approve a request, and in what order, is **not** hard-coded in any screen: it is configured in User Management → Approval Workflow Control and every HR screen reads it from the request's `approval` block (see `backend.md` Section 4.13 and `api-database-reference.md`). The rules for a screen that shows or decides a request:

- Gate **Approve** with `hrCanAct(item.approval, <older rule>)` and **Reject** with `hrCanReject(...)` (`lib/approval-workflow.ts`); the second argument is what an older backend without the block would have allowed, so a rolling deploy never strands a screen.
- Show a waiting request with `WaitingChip` when `explainsWaiting(approval)` (more than one step, or HR is not who decides it), a step trail (`ApprovalTrail` / `ApprovalTrailLine`) in details and rows, and `PipelineNote workflow="..."` (or `PipelineSummary`) under the page title so the current pipeline is on screen with a **Change** link (`/hr/user-management?tab=approvals`).
- Say whether an approval is final with `wouldFinish` / `remainingAfter` (a resignation approval by HR is not final when the Department Head still has to decide).
- Show the server's reason when a decision is refused (`err.message`), never a bare "Failed".
- Sidebar badges count only what HR can decide now.
- Interactive controls on the configuration page carry a mutating verb in their accessible name (`lib/view-only-lock.ts` only disables buttons it can classify by name), e.g. the ON/OFF switch is "Enable or disable Leave".

## 5. Notable Frontend-Specific Fixes & Patterns

**ID Card Download used to fail silently.** Root cause: `html2canvas` 1.4.1 can't parse the `oklch()` color functions Tailwind v4 emits by default (used throughout the card's own styling), and the failure was being swallowed by an empty `catch {}` -so Print (native browser rendering) worked while Download silently failed with a generic toast and no console error. Fixed by switching to `html2canvas-pro` (a maintained, API-compatible fork with `oklch`/`lab` support) and logging/surfacing the real error. If any other component ever adds its own html2canvas-based capture, use `html2canvas-pro`, not the original package.

**Bulk-operation progress bars all follow one pattern.** Payroll generation, biometric sync, salary-slip bulk email/download, and WhatsApp bulk send are all: a context mounted at the app root owning the trigger + a 600ms-interval poll of a backend in-memory progress endpoint, an inline pipeline component on the page that started it, and a floating "Global*Banner" equivalent shown elsewhere while it's still running. Copy this shape rather than inventing a new one for the next long-running bulk action.

**KPI-card counts must count distinct employees, not raw rows.** Two real bugs shipped and fixed the same day illustrate this: a `SalarySlip` list query was splitting Staff/Production by a stale `week_number IS NULL` check that no longer distinguished them correctly once Production moved to period-based payroll, and a Production Payroll KPI card was counting pending `Payroll` rows (multiple periods per employee) instead of distinct employees. Any new aggregate count on a per-employee-period table should default to counting distinct `employeeId`s.
