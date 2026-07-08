# UKTextiles HRMS — Workflow Review & Known Issues
_Last updated: 7 July 2026_

## 1. Core pipeline status

**Attendance Fetch → Shift Assignment → Shift Calculation → Payroll Generation**

| Stage | Status | Notes |
|---|---|---|
| Biometric fetch | ✅ Working | `.env` device (BIOMETRIC_DEVICE_IP/PORT/PASSWORD) + Settings devices, merged. "All Devices" pulls from every enabled source. One failing device no longer sinks the sync. |
| Shift assignment | ✅ Working | Staff: gendered templates (Male → 20:00, Female → 19:00). Production: single gender-neutral shift, auto-assigned on employee creation. Per-employee `custom_start_time`/`custom_end_time` overrides are now honored by both attendance engines (fixed 7 Jul). |
| Staff shift calculation | ✅ Working | Strict 4-punch engine. Late = `shift.start_time + grace_period_minutes`; lunch-return deadline = `punch2 + lunch_duration_minutes`; all from ShiftTemplate — no hardcoded times (the only fallbacks are for employees with **no shift assigned**). |
| Production shift calculation | ✅ Working | Segment-coverage engine: 4 punches → morning + afternoon spans, each `ProductionShiftSegment` credited when covered within `ProductionShiftConfig.grace_minutes`. Full 08:30–20:00 day = **1.50**, stop at 17:30 = **1.00**, morning only = **0.50**. Sunday is a normal working day (absent only with zero punches). |
| Staff payroll | ✅ Working | Monthly, pro-rated by real calendar working days (holidays + Saturday-off aware). PF/ESI/advances/late-penalty from settings. |
| Production payroll | ✅ Working | Bi-weekly (W1&2 = 1–15, W3&4 = 16–end). Pay = Total Shifts × `Employee.salary_per_shift`. PF/ESI per production settings. All figures persisted in `payrolls` + `salary_slips.breakdown_details` (full day-by-day traceability). |

Everything above is DB-driven: `ShiftTemplate`, `EmployeeShiftAssignment`, `ProductionShiftConfig`, `ProductionShiftSegment`, `PayrollSettings`, `AttendanceDayRecord` (payroll source of truth), `Payroll`, `SalarySlip`.

## 2. Fixed in this pass (7 July 2026)

1. **Production payroll counted 1 shift instead of 1.5** — root cause: all 5 `ProductionShiftSegment` rows had been toggled `is_active=False` (the old toggle button's label was ambiguous and made accidental disabling easy). Segments re-enabled, July W1 payroll regenerated (verified 7.5 shifts / 5 full days), toggle replaced with an explicit ON/OFF switch.
2. **Per-employee custom shift times ignored** — `_get_shift_for_date` now applies `custom_start_time`/`custom_end_time` from the assignment, so late/half/full detection respects individual schedules in both strict and simple modes.
3. **Scroll jumped to top after actions** — two causes fixed: (a) list pages replaced content with short skeletons on every refetch (now skeletons only show when there's no data yet); (b) navigating away/back remounted the layout at scrollTop 0 (per-path scroll restoration added to HrLayout, retries while async content loads).
4. **Payroll page showed nothing under Production** — frontend filtered on the legacy `salaryMode === "session"`; now recognizes the current `"shift"` mode too, with a proper shift-based breakdown view (legacy session records still render in the old format).
5. **Staff/Production separation** added to Employees and Salary pages (Payroll, SalarySlip, Attendance, ID Cards, Reports already had it).
6. **Glassmorphism** applied portal-wide via the shared Dialog/AlertDialog components (frosted blur, translucency, layered shadows, rounded corners) — every detail view/confirmation inherits it.
7. **New setting**: `Default Salary Per Shift` (Settings → Payroll) — pre-fills the rate for new production employees.

## 3. Known issues / decisions for next phase

| # | Item | Severity | Notes |
|---|---|---|---|
| 1 | **Strict staff mode doesn't penalize early departure.** With all 4 punches present, the day counts 1.00 even if punch4 is 15:00. Simple mode flags `early_leave` but doesn't reduce pay either. | Decision needed | Enforcing this changes salaries — needs HR sign-off on the rule (e.g. leave before `shift.end_time − X min` ⇒ half shift?). |
| 2 | **Weekly-off day is hardcoded to Sunday** for staff (`_sunday()` / `_build_working_days`). | Low | Make configurable in Settings if a unit ever runs a different off-day. |
| 3 | **Legacy leftovers**: `SessionConfig`/`WorkSession` models, the `prod_first_half_*` fields in PayrollSettings, and the "Legacy Session Config" panel on the Payroll page exist only for historical session-based records. | Low | Remove once old records no longer need viewing. |
| 4 | **`RecruitmentDashboard.tsx` has 2 pre-existing TypeScript errors** (icon prop typing). Doesn't affect runtime/build. | Low | Cosmetic type fix. |
| 5 | **Legacy `SalaryRecord` auto-calc** (`views.py`, ÷26 monthly / ÷6 weekly) is an old path superseded by the payroll engine. | Low | Candidate for removal. |
| 6 | **Production employees without `salary_per_shift` are skipped** at generation (reported in the skip list). | Info | Intentional guard; the new default-rate setting reduces how often this happens. |
| 7 | **Biometric device edit requires the device's numeric Comm Key** — text values are rejected per-device with a clear error instead of crashing the sync (fixed), but the field itself can't validate against the device. | Info | — |
| 8 | **EmployeeDetail full page** hasn't received the glass restyle (dialogs/panels have). | Cosmetic | Do in the next UI pass if wanted. |

## 4. Operational notes

- Changing punch times / segments / grace in Settings affects **new computations**; regenerating payroll recomputes attendance for the period automatically (manual overrides `source=manual` are never touched).
- Biometric sync requires no other software (vendor apps) holding the device connection, and the device IP must be current — both caused outages this week.
- Cron: `python manage.py sync_biometric` (all sources), `--device-id <n>` or `--device-id env` for one source.
