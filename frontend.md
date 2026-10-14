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
│   │   ├── DeviceControl.tsx + device-control/   # Biometric Connectors -> Device Control (/hr/Biometric-Connectors/DeviceControl, /fetch, /push, /connectors): shell with
│   │   │                               #   Overview / Data Fetch / Data Push / Site connectors tabs (ConnectorsTab: add, pairing code, settings, remove); OverviewTab, FetchTab + FetchResults, PushTab +
│   │   │                               #   PeopleFilters + PeopleTable, UserDialog (add/edit), DeleteDialog, AddToDevicesDialog,
│   │   │                               #   ResultDialog, CameraCapture, logic.ts (pure, tested); data via custom-hooks/device-control.ts
│   │   ├── BiometricDeviceStatus.tsx + device-status/   # Biometric Connectors -> Biometric Device Status (/hr/Biometric-Connectors/device-status):
│   │   │                               #   SummaryCards, ServerPanel, DeviceCard, DiagnosisPanel (nine layers), UnknownSenders,
│   │   │                               #   parts.tsx, logic.ts (pure, tested); data via custom-hooks/device-status.ts (polls 15 s)
│   │   ├── LeaveHoliday.tsx / CasualLeave.tsx / Requests.tsx
│   │   ├── StaffPayroll.tsx + staff-payroll/   # Payroll / Salary / Payslip tabs: thin shell (state in the address), PayrollTab, SalaryTab,
│   │   │                               #   GenerateDialog, PeriodControls, SessionConfigPanel (legacy), logic.ts (URL defaults, scope, register columns)
│   │   ├── production-payroll/         # One page per pay cycle (ProductionPayrollWeekly/Biweekly/Monthly -> ProductionCyclePage): same
│   │   │                               #   shell + PayrollTab / EmployeesTab (roster) / SalaryTab / PayslipTab, GenerateDialog, PeriodPicker
│   │   ├── payroll-details/            # One payroll on its own page (/hr/payroll/details/:id, /hr/production-payroll/details/:id): header with
│   │   │                               #   Previous/Next, KPIs, Overview / Rules / Issues / Attendance / Pay / Employee / History, exports, print
│   │   ├── Compensation.tsx + compensation/   # /hr/compensation: four tabs kept in the address (?tab=ctc|ot|leave|history): CtcBreakdownTab; ot/ (OtTab:
│   │   │                               #   Type1Section read-only, Type2Section + AssignDialog, LegacySection, RulesExplain); leave/ (LeaveTab: WindowsPart,
│   │   │                               #   HolidayWorkPart + BalancePart + RedeemDialog, BirthdaysPart); history/ (HistoryTab, ReportSectionCard, workbook.ts);
│   │   │                               #   shared logic.ts / period.tsx / ui.tsx; pure logic in ot-logic, leave-logic, history-logic; tests use harness.tsx + fixtures.ts;
│   │   │                               #   data via custom-hooks/compensation.ts (Settings tab: custom-hooks/compensation-settings.ts)
│   │   ├── Settlement.tsx
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
│   │   │                                            #   approval-permissions.ts (the 8 HOD switches, pipeline hints);
│   │   │                                            #   roster.ts (filter/summarise a department's people)
│   │   ├── ManagerDetail.tsx + user-management/manager-detail/   # One HOD: ManagerHero, permission cards (save on press),
│   │   │                                            #   DepartmentsCard -> DepartmentSection (employees listed automatically,
│   │   │                                            #   Remove / Restore / bulk / Undo), IndividualCard, ConflictDialogs
│   │   └── Settings.tsx          # Every tab: Company/Attendance/Late Detection/Compensation/Devices/Documents/
│   │                             #   Payroll/Production Payroll/Salary Slip/WhatsApp/SMTP/Backup (the tabs live in settings/;
│   │                             #   Compensation = settings/CompensationTab.tsx + settings/compensation/)
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
│   ├── attendance-compensation/  # The compensation marker of an attendance day (OT / LI / EO / BD / RX): kinds.ts (pure: compensationMark, KIND_META, countMarks,
│   │                             #   isPunchlessRelaxation) + CompensationChip / CompensationSymbol / CompensationLegend, drawn by every HR screen that shows a day
│   ├── ui/dashboard-sidebar.tsx  # Sidebar, pending badges, permission-filtered nav
│   ├── md/                       # MD portal shell and kit: MdLayout/MdSidebar/md-nav.ts, kit/ (StatCard, SectionCard, TrendChart,
│   │                             #   BarList, DonutChart, Heatmap, DataTable, InsightList, FilterBar...), assistant/ (the AI side panel:
│   │                             #   Composer, MessageBubble, Explainer, voice/ input + speech output)
│   ├── payroll/                  # The payroll UI, shared by Staff and Production Payroll and the details page:
│   │   ├── kit/                  #   format.ts (₹, dates), issue-meta.ts (severity/type names + icons), parts.tsx (KpiTile, Chip, EmptyNote, loaders),
│   │   │                         #   ExportMenu, export-table.ts (Excel/CSV), url-state.ts (useUrlParams, openPayrollDetails), statement-url.ts,
│   │   │                         #   use-payroll-actions.ts (useMarkPaid, useRefreshPayroll), issue-summary.ts, ViewSwitch
│   │   ├── panels/               #   dashboard, filters, records (cards + table), issues, skipped, rules, payslips: each takes a `scope`
│   │   │                         #   (staff month | production cycle + period) and an `accent` (indigo | amber) and loads its own data
│   │   ├── statement/            #   The Salary Statement (printed format): SalaryStatementPanel, scroll table + paper "Pages" view, Excel / PDF / Print
│   │   ├── AdjustPayrollDialog.tsx / adjust-target.ts   # bonus + deductions of one payslip
│   │   └── BreakdownDrawer.tsx   #   Old day-by-day breakdown drawer (no longer used by the payroll pages; kept for other callers)
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

### The payroll pages (Staff + Production)
Both payroll areas are built from the same kit and panels (`components/payroll/`), so a change to how an issue, a rule or the statement looks is made once. Rules worth knowing before touching them:

- **Everything on screen is read-only explanation of stored payroll.** The dashboard, Issues, Skipped, Rules, Salary Statement and the details page read `/api/payroll/.../details|issues|rules|salary-statement` (see `backend.md`), which never recompute or write. Only Generate, Mark Paid and Adjust change data, and those use the existing endpoints.
- **Page state lives in the address** (`?tab=&view=&month=&year=&period=&q=&dept=&status=&issue=&icode=...&sq=...`) through `useUrlParams`, written with `replace`, so a reload, a shared link and Back from a details page land on the same tab, period and filters. Open a details page with `openPayrollDetails(navigate, kind, id, section?)` (it sets the history state that makes Back return to the list); a pasted link falls back to `payrollListPath`.
- **Staff Payroll's three tabs are three permission modules** (`payroll`, `salary`, `salary_slip`); the Production pages are the single `production_payroll` module. The details page and the insight endpoints follow the URL's module (`payroll` / `production_payroll`).
- **View Only**: `lib/view-only-lock.ts` disables a `<button>` whose accessible name has a mutating verb. Give data-changing buttons such a name (e.g. `title="Update the status of ... to Paid"`) and wrap read-only exports in `data-view-safe` (`ExportMenu` already does).
- **Loaders**: whole panel loading -> `PayrollLoader` / a sheet-shaped skeleton; figures -> `SkeletonKpis`; lists -> `SkeletonRows`; errors say so and offer Retry. Never a blank area while data is on its way.
- Tests: logic in `*-logic.test.ts`, jsdom render tests next to each panel, and the Playwright specs `payroll.spec.ts`, `payroll-insights.spec.ts` and `production-cycles.spec.ts`.

### The Compensation page and its Settings tab
`/hr/compensation` (permission module `compensation`) has four tabs; **Settings → Compensation** (module `settings.compensation`) holds every rule and switch behind them. Staff only: nothing here lists, detects or changes a production employee (the CTC tab still lists everyone). The endpoints are in `backend.md` and `api-database-reference.md`. Rules worth knowing before touching the front end:

- **Page state lives in the address** through `useUrlParams(COMPENSATION_URL_DEFAULTS)` (`compensation/logic.ts`): `tab=ctc|ot|leave|history`; OT Detection `month, year, otq, otdept, otstatus`; Compensation Leave `sub=windows|holiday-work|birthdays`, plus `hmonth, hyear, hstatus, hdate` (claims) and `bperiod, bdate` (birthdays); History `period, date, type, dept, branch`. A value equal to its default is left out. **The deep link `/hr/compensation?tab=leave&sub=holiday-work`** is what the Requests hub's "Open in Compensation" uses: the server's `openPath` for the `holiday_work` kind is only `/hr/compensation`, and `OPEN_PATH_DEEP_LINKS` in `requests/logic.ts` narrows it. `leavePartOf()` also accepts `holiday`, `holiday_work`, `window`, `announce` and `birthday`.
- **Two layers of switches; everything stays readable.** `featuresOff` (the master switch, `usePayrollSettings().compensationFeatureEnabled === false`) pauses every change and shows the page-level notice. Each feature's own switch comes from the `config` / `enabled` block of the endpoint (`GET /api/compensation/config` is the read-only copy of the Settings body for a role without the Settings permission). A paused control stays in place, is disabled and says why in its `title`; `SwitchOffNotice` links to the very switch with `compensationSettingsHref("<setting id>")` (`/hr/settings?tab=compensation#shift-enabled`; the ids are the `data-setting-id` of each Settings block, listed in `settings/CompensationTab.meta.ts`). The master switch has one home, Settings → Payroll → OT / Compensation (`MASTER_SWITCH_HREF`): `settings/payroll/OtPanel.tsx` is only that switch plus a link to the tab.
- **Shifts and dates.** The only amounts are `SHIFT_CHOICES` (0.25 / 0.5 / 0.75 / 1, type `ShiftsValue`), picked with `ShiftsPicker` and written with `fmtShifts` / `shiftsText`. Dates are plain ISO strings split by hand, never `new Date("2026-10-13")` (UTC midnight, so the day before in some zones), and "today" is `todayIst()`. A refused change shows the server's own `{error}` sentence (`errorMessage()`; `problemsOf()` for the all-or-nothing claim request). `useSingleFlight()` absorbs a double click on the buttons that create records (Redeem, Assign, Add announcement, Submit claims).
- **One cache rule.** Every Compensation query key starts with `/api/compensation`; a successful change calls `invalidateCompensation(queryClient)` (a predicate, because TanStack matches keys element by element), so an assigned relaxation, an approved claim or a changed rule refreshes every list on screen. Saving the Settings tab refreshes everything except its own key.
- **View Only.** Controls that only read (filters, period bars, exports, "Details") carry `VIEW_SAFE_ATTR`; the buttons that change data have a mutating verb in their accessible name (Assign, Reject, Add announcement, Withdraw, Redeem, Delete the announcement ...), which `lib/view-only-lock.ts` disables.
- **The Settings tab is one form with one Save** (`settings/CompensationTab.tsx`). `settings/compensation/form.ts` is the draft: `draftFrom`, `sameDraft`, `validateDraft` (the server's own rules, in plain words) and `toInput`; the rule arrays REPLACE the tables server-side, so row order is table order and a row keeps its `id`. `time.ts` reads and writes "9:00 PM" / "2:00 AM next day"; `preview.ts` + `Examples.tsx` are the live Worked examples (pure arithmetic that follows `backend/api/compensation_rules.py`: keep the two in step); `dateAfterSwitch` shows at once the date the server will stamp (today) when Type 1 or Birthday is switched on. The tab is registered in `settings/tabs.ts`, `settings/metas.ts` (the page search reads `CompensationTab.meta.ts`), `settings/constants.ts` and, for the permission, `lib/permission-modules.ts` (mirror of `permission_registry.py`).
- **Attendance markers** are drawn by `components/attendance-compensation/` only. Every attendance JSON that shows a day carries `compensationKind` / `compensationMinutes` / `compensationNote` (typed in `custom-hooks/attendance.ts`; an older backend sends none); `kinds.ts` turns them into a mark (`compensationMark`, `KIND_META`: label, two-letter code OT / LI / EO / BD / RX, icon, meaning) and the chip, the symbol and the legend show it. Colour is never the only cue. Used by `Attendance.tsx`, `AttendanceSearch.tsx`, `AttendancePunchSearch.tsx`, `AttendanceSheet.tsx` (Report Log; its Excel export appends the code, `P·OT`), `shifts/EmployeeShiftStatsDialog.tsx` and `payroll-details/AttendanceCard.tsx`, and so by the MD's copies of them. A day topped up only by a relaxation has no punches: `isPunchlessRelaxation()` replaces the "Half day (afternoon)" label.
- **History & Reports** builds its Excel file in the browser (`history/workbook.ts`; `exceljs` is imported only when the export is chosen; a Summary sheet and one sheet per type) from the same column definitions that draw the tables (`TYPE_COLUMNS` in `history-logic.ts`), so the file is what is on screen. The CSV is `flatRows()` through `exportTableToCsv`.
- **The HOD side.** `user-management/approval-permissions.ts` has eight switches (`canApproveCompensation`: card title "Compensation", workflow `holiday_work`; an HR-raised pipeline reads "HR raises it, the Department Head approves"), and the Requests hub has the `holiday_work` kind (`requests/logic.ts`, icon in `requests/parts.tsx`). The MD's Overtime card (`pages/md/attendance/OvertimeCard.tsx`) has an `Allowance` chip for the automatic Type 1 records.
- **Tests.** Pure logic: `logic.test.ts`, `ot/ot-logic.test.ts`, `leave/leave-logic.test.ts`, `history/history-logic.test.ts`, `history/workbook.test.ts` (builds a real workbook in memory), `settings/compensation/{form,time,preview}.test.ts` and `components/attendance-compensation/*.test.ts(x)`. Render tests (jsdom), one per tab or part, all on **`compensation/harness.tsx`**: `installWorld(fetchMock)` puts a fake server behind `customFetch` (October 2026 data from `fixtures.ts`; every change is recorded in `world.writes`, a request nobody planned lands in `world.unexpected`, `world.failing` and `world.hold` simulate errors and slow answers), `mountPage(url)` renders the page at a real address and `freezeClock()` fixes the date at 14 Oct 2026. Each test file keeps its own `vi.mock` calls (vitest only hoists them there). The attendance screens have a `*.compensation.test.tsx` next to them. Playwright: `e2e/compensation.spec.ts` (the four tabs, the master-switch pause and its 403s, the deep link, each tab, an announce / delete round trip that puts back the setting it flipped), plus additions in `approval-workflow`, `hod-roster`, `requests-hub`, `settings` and `settings-explained`.
- `src/pages/hr/compensation`, `src/pages/hr/Compensation.tsx` and `src/components/attendance-compensation` are on both Prettier lists in `package.json` (`format` and `format:check`): keep new folders on both.

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
