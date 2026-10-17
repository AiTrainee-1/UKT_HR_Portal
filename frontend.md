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
│   │   ├── SmsControl.tsx + sms-control/   # /hr/sms-control (Administration -> SMS Control): tabs in the path (overview, settings/channel|limits|switches,
│   │   │                               #   messages, test, setup); routes.ts + logic.ts (pure, tested), ui.tsx kit, one file per tab / section;
│   │   │                               #   data via custom-hooks/sms-control.ts (backend.md Section 4.15, 2factor-sms-otp-integration.md)
│   │   └── Settings.tsx          # Every tab: Company/Attendance/Late Detection/Compensation/Devices/Documents/
│   │                             #   Payroll/Production Payroll/Salary Slip/WhatsApp/SMTP/Backup (the tabs live in settings/;
│   │                             #   Compensation = settings/CompensationTab.tsx + settings/compensation/)
│   │                             #   Production Shifts = settings/ProductionShiftsTab.tsx + settings/production-shifts/
│   │                             #   Endpoint Sharing (super admin only) = settings/EndpointSharingTab.tsx + settings/endpoint-sharing/
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

### The Production Shifts settings tab and the Manage Shifts summary
**Settings → Production Shifts** (`/hr/settings?tab=production_shifts`, permission module `settings.attendance`, group "time" in `settings/tabs.ts`) edits how a production worker's punches become shifts earned (production only; the engine and the API are in `backend.md` and `api-database-reference.md`, "Production shift rules"). The tab is lazy-loaded (`settings/ProductionShiftsTab.tsx`, which takes a `readOnly` prop for a view-only role); its search text and the explanation of every block live in `ProductionShiftsTab.meta.ts` (registered in `settings/metas.ts`), so the blocks and the search cannot drift apart.

- **One form, one Save.** `useDraft(saved, sameDraft)` keeps the draft; `SaveBar` + `SaveDock` save it and `ConfirmSave` lists what changes and the consequences first (the start date in the past re-judges days, "nothing already paid changes" otherwise, staff never touched). All the form logic is pure in `production-shifts/form.ts` (`draftFrom`, `toInput(draft, expectedVersion)`, `validateDraft` = the server's own rules, `warningsFor` / `newAdvice` (local advice, minus what the server already says), `draftChanges`, `isUnverifiedRow` / `unverifiedRows`, `ladderCap`, the add/sort helpers) and `production-shifts/time.ts` (`clock12`, `pointText`, `parsePunches`, `weekdayOf`, `nextSunday`).
- **Sections** (one file each in `production-shifts/`): `WhenSection` (master switch "Use the production shift rules", "Production rules apply from" with a past-date note and a Use today button, "Grace (minutes)", and the read-only echo of the old calculation), `GroupsSection` + `LadderTable` (a card per group: In use switch, Used on, Start time, First punch from / to, Standard departure, and the ladder rows with In use, Name, Leaves at, Next morning, Shifts; Add a row / Add a group / remove; the cap note under a ladder, which for Sunday says nothing is given after the last row), `BreaksSection`, `AdvancedSection` (Minimum shifts, Rounding step and how, Full-day value, Night session length) and `TryItSection`; shared pieces in `ui.tsx`. Every number and time shows its problem inline; the server's `warnings` and the local advice show as amber boxes above the form.
- **Try a day.** Debounced by 300 ms it POSTs the typed punches and date to `/production-shift-rules/preview` (`useProductionShiftPreview(request | null)`) and shows group, shifts (with a made-up per-shift pay), status, late, early and the note; five one-click samples are the owner's examples. It reads the SAVED rules only, so unsaved edits show a "not saved" hint instead.
- **The two handwriting rows.** The Day row 00:30 next day = 2.50 and the Night row 00:00 next day = 0.50 follow the owner's handwriting as written but could be read two ways; `isUnverifiedRow` puts a "Check these 2 rows with HR" banner on top and a note on each row, which goes away once its time or value is changed.
- **Safety nets.** `version` from the GET is kept as `baseVersion` and sent back as `expectedVersion`; a 400 `stale_settings` (`isStaleSettingsError`) shows "Reload the saved rules" (with a confirm that drops the edits). A branch login (`usePayrollSettings().companyWideRulesEditable === false`, or a 403 `company_wide_settings` on save) makes the whole tab read-only with the company-wide notice, but the Try a day box still works (it is a view-safe POST, `data-view-safe`).
- **Hooks.** `lib/api-client/custom-hooks/production-shift-rules.ts` (`useProductionShiftRules`, `useUpdateProductionShiftRules` returning `{ rules, warnings }`, `useProductionShiftPreview`) are hand-written, not orval-generated; the legacy `useProductionShiftConfig` hooks stay for the old calculation.
- **Manage Shifts → Production** no longer edits punch times or segments: `pages/hr/shifts/ProductionRulesSummary.tsx` (rendered by `ShiftsTab.tsx` for the production type) shows a read-only summary (on from which date, each group's start / standard departure / top value, the unpaid breaks) and an **Edit in Settings** link to the tab. Settings → Attendance → `attendance/ProductionSection.tsx` now shows the old calculation read-only with a link to the same tab, so every setting has one home.
- **Tests.** `production-shifts/form.test.ts`, `time.test.ts`, `ProductionShiftsTab.render.test.tsx`, `shifts/ProductionRulesSummary.render.test.tsx`, and the Playwright spec `e2e/production-shift-rules.spec.ts`.

### The MD portal front end
`/md/*` is a second shell (`MdLayout`) for the one Managing Director account (`AuthContext.isMd`, from `/auth/me`; the route guard in `App.tsx` sends everyone else away). Pages are built from the kit in `components/md/kit/` and read `/api/md/*` through `useMdQuery`. Two rules worth knowing before touching a page: **layout answers to the page's width, not the screen's** (`MdLayout`'s `<main>` is a Tailwind v4 `@container`; use `@3xl:`/`@5xl:` variants, because the assistant panel can take 444 px of the page), and **every figure carries its provenance** ("How is this calculated?") and an Ask-AI question. The assistant panel (`AssistantHost`, mounted once in `App.tsx`) is text + voice (Web Speech API with a server-transcription fallback) and renders the server-built explanation. Full recipe and rules: `md-portal.md` sections 4 and 6.

### SMS Control (`/hr/sms-control`)
Sign-in, forgot-password and first-time-password codes can go by SMS (through 2Factor.in) or by WhatsApp; this page (sidebar → Administration → SMS Control, permission module `sms_control`, mirrored in `lib/permission-modules.ts`, route `/hr/sms-control/*?` in `App.tsx`) is where HR chooses, limits and watches that. The backend is in `backend.md` Section 4.15 and the account / DLT / server setup in `2factor-sms-otp-integration.md`. Rules worth knowing before touching it:

- **The tabs live in the path, not in state:** `/hr/sms-control/overview`, `/settings/channel|limits|switches`, `/messages`, `/test`, `/setup` (`routes.ts`: `readSmsPath`, `resolveSmsPath`, `smsPath`). An unknown or missing tab is replaced by Overview, and Settings without a section by Channel; only the open tab renders, so a closed tab asks the server for nothing. The Messages filters stay in the query string (`?status=failed&purpose=login&q=&from=&to=&page=&size=`), so a link such as Overview's "See the failures" opens the list already narrowed.
- **The tabs:** Overview (a "what to do next" checklist worked out from the server state, status cards, usage bars against the hourly and daily caps, a 7-day chart), Settings (Channel, Limits, Switches; each setting is a `SettingBlock` that says what it is, what it changes and gives an example), Messages (the log, never a code or a full number), Test (one real SMS to a number typed here), Setup (steps that tick themselves, with copy buttons for the 2Factor template text, its name `UKT_HRMS_OTP`, the sender ID `UKTHRM` and the environment variable names).
- **Safety.** A View Only role, or a branch login (settings and tests are company-wide), sees everything and changes nothing (`LockContext`, `permissionLevel(user, "sms_control")`). Every save sends the whole settings document plus the loaded `version` as `expectedVersion` (a 400 `stale_settings` shows Reload); choosing the channel asks for confirmation, and the server refuses to select SMS until 2Factor is configured, which the page shows in the server's own sentence. The 2Factor API key is never asked for, sent or shown: Setup lists the environment variable **names** only (`TWOFACTOR_API_KEY`, `TWOFACTOR_TEMPLATE_NAME`, `TWOFACTOR_SENDER_ID`, `TWOFACTOR_API_BASE`, and the `SMS_ALLOW_SENDING` development guard), with Set / Not set taken from the overview. 2Factor is the only SMS provider; there is no provider choice.
- **Hooks:** `lib/api-client/custom-hooks/sms-control.ts` (`useSmsOverview`, `useSmsSettings`, `useUpdateSmsSettings`, `useSmsMessages`, `useSendSmsTest`), hand-written.
- **The two employee apps** (separate repositories) read `otpChannel` from `GET /auth/login-options` and `channel` from the code request's answer, and word every login screen "by SMS", "on WhatsApp" or a neutral "a code" (Employee Web App `src/lib/otp-channel.ts`; mobile app `src/lib/otp.ts`; both tested with `npm test`). **The mobile app needs a new APK build and the Employee Web App a separate Vercel deploy** to show the SMS wording; older builds keep working and keep saying "WhatsApp".
- **Tests:** `sms-control/logic.test.ts`, `routes.test.ts`, `access.test.ts`, `SmsControl.render.test.tsx`, `custom-hooks/sms-control.test.ts`, and the Playwright spec `e2e/sms-control.spec.ts` (against the fake 2Factor in `e2e/fake-twofactor.mjs`, which serves 2Factor's `GET /API/V1/<key>/SMS/+<phone>/<code>/<template>` call and records every request). `src/pages/hr/sms-control` and `SmsControl.tsx` are on both Prettier lists in `package.json`.

### Settings → Endpoint Sharing (super admin only)
**Settings → Endpoint Sharing** (`/hr/settings?tab=endpoint_sharing`) lets the super administrator publish chosen HR data to other applications as read-only addresses (`GET /api/shared/<slug>`), pick the exact fields, list the websites allowed to call each one, make API keys and read the integration guide. The backend, the datasets and the security model are in `backend.md` Section 4.16 and `api-database-reference.md`. Rules worth knowing:

- **Visible only to the super admin.** The tab is registered in `settings/tabs.ts` (id `endpoint_sharing`, group "Messages & data", between WhatsApp and Backup) and in `SUPER_ADMIN_ONLY_TABS` (`settings/constants.ts`). `settings/access.ts` (`settingsTabLevel`) gives it "edit" only when `user.role === "hr" && user.isSuperAdmin === true` and "hidden" to everyone else, so it is out of the nav, the page search and the deep links (a direct `?tab=endpoint_sharing` falls back to the first tab), and the component checks again. It is **not** a role permission (`SETTINGS_TAB_MODULE` has no entry for it); the backend refuses every other login.
- **The address** is `?tab=endpoint_sharing&sub=endpoints|guide|activity&endpoint=<id|new>&section=basics|data|access|guide` (`endpoint-sharing/address.ts`). Subtabs: **Endpoints** (a card per endpoint: on or off, dataset, fields, keys, origins, calls in 24 hours; New endpoint), **Integration guide** (the general guide for developers: how it works, authentication, the request, pages, the response, errors, CORS and origins explained honestly, looking after keys, example code in six languages, a security checklist) and **Activity** (the access log with filters). Opening or creating an endpoint shows four nested sections, one at a time: **Basics** (name, the address `/api/shared/<slug>`, chosen once and then fixed, description, enabled), **Data** (dataset, field checklist grouped by sensitivity with the never-shared list, locked filters, live preview), **Access** (allowed origins, the server-to-server switch, calls a minute, page sizes, API keys) and **Guide** (that endpoint's generated documentation with copy buttons).
- **One Save per endpoint** (`endpoint-sharing/form.ts`: the draft, validation in the server's words, `toInput`), all-or-nothing, with an unsaved-changes guard and the `version` / `expectedVersion` stale guard. Newly ticking a personal or financial field opens "Share personal or financial data?" naming the fields (sent as `acknowledgeSensitive`). Keys act at once (they do not wait for Save): the whole key is shown **once**, in a copy box; revoking, deleting and switching an endpoint off ask first. Origins are normalised and checked in the browser too (`origin.ts`), with the server's rules as the real gate.
- **Hooks:** `lib/api-client/custom-hooks/shared-endpoints.ts` (`useSharedCatalog`, `useSharedEndpoints`, `useSharedEndpoint`, create / update / delete, keys, preview, guide, activity), hand-written.
- **Tests:** `endpoint-sharing/form.test.ts`, `origin.test.ts`, `EndpointSharingTab.render.test.tsx`, `SettingsVisibility.render.test.tsx`, `settings/access.test.ts`, `settings/registry.test.ts`, and the Playwright spec `e2e/endpoint-sharing.spec.ts`.

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
