# Report Center — how to add or change a report

Every report is one `ReportSpec` (metadata + a `run(ctx)` function) registered in a module under
`definitions/`. The catalog, the filter form, the on-screen table, the Excel file and the PDF are all
generated from that spec — **adding a report needs no frontend change**.

```
reporting/
  types.py        ReportSpec / ColumnSpec / FilterSpec / ReportResult, column types, categories
  filters.py      filter factories (period, date_range, scope, select…), parse_params, ReportContext
  formatting.py   r2, parse_date, fmt_dt (IST), full_name, minutes_text, indian_number …
  common.py       EMP_COLS, emp_cells(emp), with_subtotals(rows, …)
  registry.py     register(spec); definitions/ modules are auto-imported
  access.py       who may run a report (owning modules, super-admin-only)
  runner.py       run_report(): parse filters -> run -> normalise rows/totals; row limits
  export_xlsx.py  Excel writer (streamed, styled, formula-injection safe)
  export_pdf.py   PDF writer (letterhead, KPI strip, repeated header, Page X of Y)
  views.py        /api/reports/catalog | run/<id> | export/<id>?fmt=xlsx|pdf | options/employees
  layout.py       LAYOUT: the ONLY listed reports, per category, in display order (everything else is retired)
  derive.py       derive(): a new catalog entry that runs an existing report with some filters pinned
  custom/         Customise: the report builder's data sources, saved reports and /api/reports/custom/ endpoints
  definitions/    the reports, one module per domain (rc_*.py = the 2026-11-19 Attendance / Shift / Salary /
                  Employee Details reports)
```

## What the catalog lists: `layout.py` (the owner's 2026-11-19 cleanup)

The catalog shows **only** the reports `layout.LAYOUT` names, in that order, under these categories:

| Category id | Label | Reports |
|---|---|---|
| `hr` | HR Reports | 10, the owner's quality reference, kept exactly as they were (`hr_reports*.py`) |
| `attendance` | Attendance | 16: staff / production attendance grids, time cards, punches, leave, late, misspunch, geo, on-duty, logs |
| `shift` | Shift | 5: assigned, gained, shift change history, shift-wise attendance, shift assignment gaps |
| `payroll` | Salary | 8: salary statement, production / staff salary, gained / expected salary, department-wise figures |
| `employees` | Employee Details | 5: overall details, fixed salary, monthly shift, time card, punch details |
| `customise` | Customise | the saved custom reports (`custom/`), shown to whoever has `reports.customise` even with none saved |
| `md` | Executive (MD) | the Managing Director's own `md_only` reports, listed for the MD only |

`layout.is_listed(spec)` is true for a layout id, a `customise` spec or an `md_only` spec; `layout.sort_key` gives the
catalog order (the layout's, then the saved custom reports). **A new report is invisible until its id is added to
`LAYOUT`** under its category (and `api/tests_reporting_rc_layout.py`'s `EXPECTED_LAYOUT`, which pins ids, order,
categories and titles).

### Retired reports

Every other registered report is **retired**: it is not in the catalog, and `/api/reports/run/<id>` and
`/api/reports/export/<id>` answer **404 `not_found`** for it (`views._resolve`), for every account including the super
admin and the MD. Their definitions stay registered on purpose: the MD portal analytics, the gate exports and the new
`rc_*` reports reuse their helpers (`attendance_core_data`, `requests_*`, `payroll_core_*` ...), and their test modules
keep guarding that logic. Those modules call `list_retired_reports()` / `unlist_retired_reports()` (from
`tests_reporting_rc_layout`) in their `setUpModule` / `tearDownModule`, which lists every report again while the module
runs; `tests_reporting_rc_layout` itself checks that the retired ids answer 404. The old categories `leave`, `gate`,
`finance` and `admin` stay in `types.CATEGORIES` only so those definitions still load; nothing in them is listed and
their `reports.<group>` permission keys are gone. To bring a report back, add its id to `LAYOUT` (in a listed category).

### `derive()`: an existing report with filters pinned

When a layout report is an existing report run for one kind of employee (or with some select fixed), do not copy the
logic: register it with `derive.derive()` after importing the base report's module.

```python
from . import attendance_core_timecard  # noqa: F401  (registers "time-card", the base)
from ..derive import derive

derive(
    "time-card",                            # the base report id
    id="example-staff-time-card",
    title="Example Staff Time Card",
    description="...",
    category="attendance",
    pin={"employment_type": "staff"},       # PARSED params (filters.parse_params keys), forced before the base runs
    drop=("employmentType",),               # filter keys hidden from the new entry (normally the pinned ones)
    defaults={"employeeStatus": "active"},  # optional: other defaults for kept filters
)
```

A pinned value **cannot be overridden from the query string**: the pinned filter is not declared on the derived spec,
so `parse_params` ignores the query value, and the derived `run()` writes the pinned value last (a test in
`tests_reporting_rc_layout` holds this). Columns, notes, builders, limits and modules are inherited unless given as
keyword overrides (e.g. `run=` to post-process the base's result, as `assigned-shift-report` does over `shift-roster`).

### What the catalog tells the workspace

Each catalog entry also carries `exportLimits` (`{screen, xlsx, pdf}`, the ceilings `runner.limit_for` applies, so the
workspace can offer "Download Excel instead" before a PDF would be refused with 413) and `autoRun` (False = opening the
report waits for "Show report"; a spec opts out with an `auto_run = False` attribute). `columns` is still sent (the HR
reports' catalog tests read it); the workspace takes the columns of each run.

## A minimal report

```python
from ..common import EMP_COLS, emp_cells
from ..filters import period, scope
from ..registry import register
from ..types import INTEGER, ColumnSpec, ReportResult, ReportSpec


def _run(ctx):
    year, month = ctx.period  # typed by the filter kind
    rows = []
    for emp in ctx.employees():  # employee filters + branch isolation already applied
        rows.append({**emp_cells(emp), "days": 26})
    return ReportResult(rows=rows, notes=["Counts working days only."])


register(
    ReportSpec(
        id="example-days",  # kebab-case, unique across ALL definitions
        title="Example",
        description="One line shown on the catalog card.",
        category="attendance",  # see types.CATEGORIES
        modules=("attendance",),  # permission modules that own this data (any one of)
        filters=(period(), *scope(status="active")),
        columns=(*EMP_COLS, ColumnSpec("days", "Days", INTEGER, 0.8, total="sum")),
        run=_run,
    )
)
```

Then add `"example-days"` to `layout.LAYOUT["attendance"]` where it should appear: an id the layout does not name is
retired (not listed, 404).

## A new category (a new group in the catalog)

Add one tuple to `types.CATEGORIES` (`id, label, description, lucide icon name`; the order is the display order, the icon
must be one of those listed in the frontend's `report-center/report-icons.ts`) and give the reports `category="<id>"`.
The catalog, the category chips and the group heading appear on their own once the category has a `LAYOUT` entry
(`layout.py`) naming its reports. Give it a permission group too: a `(id, label, help)` line in
`permission_tree._REPORT_GROUPS` (`reports.<id>`), then re-export `frontend/src/lib/permission-tree.json` with
`write_json()` and prettier. A colour for the group is optional: add the id to `CATEGORY_STYLE` in `report-icons.ts`,
otherwise it uses the neutral admin colour. Examples: `hr` (HR Reports, `definitions/hr_reports.py`), `shift` (2026-11-19).

## Rules every report must follow

1. **Branch isolation is not optional.** Filter employee-linked rows with `ctx.emp_q("employee__")`
   (or `ctx.employees()` / `ctx.emp_q()` on Employee). Data with no employee link (visitors, devices)
   must be scoped through whatever branch link exists, and be super-admin/unscoped-only if none does.
2. **`modules=`** names the permission modules (`permission_registry.MODULE_TREE` keys) that own the data.
   A role needs "view" on at least one of them *and* the "reports" module. Admin-only data
   (audit trail, user accounts) uses `super_admin_only=True`. A test asserts every key is real.
3. **GET requests must not write.** Never call an engine function that persists (`compute_month_records`
   writes `AttendanceDayRecord`). Read persisted rows and say in `notes` when data may be incomplete.
4. **Never recompute what the payroll/attendance engine already decided.** Use the stored values
   (`SalarySlip`, `AttendanceDayRecord`, `OvertimeRecord`, …) so a report always agrees with payroll.
5. **Dates.** ISO `YYYY-MM-DD` strings in rows. Several schema columns are *text* dates
   (`Employee.join_date`, `LeaveRequest.start_date/end_date`): parse with `formatting.parse_date`, and
   compare as ISO strings / overlap logic — never `__startswith`. Aware datetimes -> `fmt_dt()` (IST).
   Never `timezone.localdate()`; use `ctx.today` / `api.clock`.
6. **Units.** Money = rupees rounded to 2 places (`r2`). Minutes are ints. `percent` is 0–100.
   `None` means "no value" (rendered as a dash) — never use 0 for unknown.
7. **No N+1.** `select_related`/`prefetch_related`/aggregate; load lookups (leave types, settings,
   holidays) once, outside loops. Tests assert the query count does not grow with the row count.
8. **Row limits.** Honour `ctx.row_limit` in the query for detail reports that can be huge (punch logs).
   Exports over the limit are refused with a "narrow the filters" message, never silently truncated.
   `ctx.row_limit` is the ceiling **plus one** (so the runner can tell "exactly at the limit" from "over"):
   build summary cards from the rows the runner will keep, not from `rows[:ctx.row_limit]`. Subtotal/total
   lines (`_kind`) do not count against the limit; only data rows do.
9. **Sensitive data.** Aadhaar numbers are masked to the last 4 digits; `password_hash`, `photo_url`,
   `id_proof` and addresses never appear. Bank/PF/ESI/UAN identifiers stay text (no float rounding).
10. **State assumptions in `notes`** (rates used, exclusions, feature switched off) — they print under
    the table and in both exports.

## Totals, subtotals, summary cards, dynamic columns

* `ColumnSpec(total="sum"|"avg"|"count")` adds a totals row (over data rows only).
* `common.with_subtotals(rows, group_by, sum_keys)` inserts `_kind: "subtotal"` rows; they are styled
  and excluded from totals.
* `ReportResult.summary=[{"label", "value", "format"}]` renders KPI cards above the table.
* Reports whose columns depend on data (one column per day, per salary component) pass
  `ReportResult(columns=[...])` and declare `columns=()` on the spec.
* Related views of one subject (Records | Counts) share `family=` and differ in `variant=`.
* A printable document (salary slips, time cards) sets `pdf_builder=` / `xlsx_builder=`
  `(ctx, out) -> bytes`; the generic table export is used for the other format.

## Testing

```
python manage.py test api.tests_reporting_framework      # framework
python manage.py test api.tests_reporting_<domain>       # a domain's reports
```

`tests_reporting_all.py` runs **every listed** report (screen, Excel, PDF) for an unscoped admin,
a branch-scoped user and a view-only role — a new report is covered by it automatically once it is in `LAYOUT`.
`tests_reporting_rc_layout.py` pins the layout (ids, order, categories, titles), the HR category exactly as git HEAD had
it (a readable copy plus a digest of every spec field), the 404 of every retired id, the categories each kind of account
sees, every listed report's default run and Excel / PDF on a seeded month with staff and production employees, and
`derive()`'s pins. The slices' own modules are `tests_reporting_rc_<slice>.py` (attendance_staff,
attendance_production, attendance_requests, shift_employee, salary, customise, workspace).

## Customise: the report builder (`custom/`)

HR builds a report from a data source, picks the fields, sets the filters and saves it; saved reports are a team library
under the Customise category and run / export through the ordinary endpoints as `custom-<id>`.

```
custom/
  fields.py      Field (key, label, column type, section, loader group, modules) and Dataset
  common.py      the employee fields, the scope filters, join dates (the spreadsheet serial decoded), ordering
  attendance.py  day helpers shared by "employees" and "attendance_days" (employment window, OT, quarters, zones)
  ds_*.py        the data sources: employees, attendance_days (days), punches, requests, payroll
  datasets.py    DATASETS, in the order the builder offers them
  build.py       field / sort / filter checks, build_spec() (a ReportSpec on the fly), the A3 PDF builder
  specs.py       a saved report as a ReportSpec (catalog + run + export), can_view / can_edit
  views.py       /api/reports/custom/datasets | preview | saved | saved/<id> | saved/<id>/duplicate
models/report_center.py   SavedCustomReport (migration 0168)
```

**Data sources** (every query branch-scoped through `ctx.emp_q`, no per-employee queries):

| id | one row per | filters | reads |
|---|---|---|---|
| `employees` | employee | Month, scope, status | Employee; stored `AttendanceDayRecord` via `AttendanceData` (calendar day / shift day); `cl_balance.parts`; Payroll via `statement_rows` |
| `attendance_days` | employee-day (max 62 days) | date range, scope, status, day status | `AttendanceData` + `build_day` (as the Daily Attendance Register) |
| `punches` | punch (max 31 days) | date range, scope, status, source | `AttendanceLog`; the day it counts for from `AttendanceData.punches` (staff re-attribution, production shift day); on-duty GPS |
| `requests` | request | date range, scope, status, request type, request status | Leave, Casual Leave (1 / 0.5 day), Permission, On-duty, Missing punch |
| `payroll` | payroll | Month, scope, status, payment status | Payroll rows (staff month, production periods ending in the month) through `statement_rows` + the HR statements' `report_values` |

**Fields.** Keys are stable (`emp.code`, `att.present_days`, `day.late_minutes`, `punch.counts_for`, `req.days`,
`pay.net`): saved reports store them, so never rename or reuse a key. A field's `needs` names its loader group, so only the
groups of the chosen fields are loaded. A field's `modules` (any one) are on top of the data source's `modules`; a field
the user cannot view is not offered, is refused in preview / save (`400 field_forbidden`), and is dropped with a note
when a saved report that has it is opened (a change by that user keeps it in place).

**Permission.** `reports.customise` (permission_tree.py maps `reports/custom` to it, so the middleware lets view-only
roles do GETs only): view = list, open, preview, run, export; edit = create, change, duplicate; delete = edit and (the
creator or a super admin). The Managing Director reads, never changes. A saved report also needs one of its data source's
modules (403 `report_forbidden` otherwise, like any report); `GET /saved` lists only the reports the role can open (the
catalog's), and duplicating one on a data source the role cannot use is refused (403 `dataset_forbidden`). Payroll money
follows the Salary category per row kind (`rc_salary_common`): staff payrolls need `payroll`, production payrolls
`production_payroll` (it does not come with Payroll); the salary structure fields need `salary` or that kind's payroll.

**Saved filters** are stored in the query-parameter format (`period`, `dateFrom` / `dateTo`, `departmentIds` "1,2",
`employmentType`, `employeeStatus`, data-source keys) and become the catalog defaults of `custom-<id>`. A run goes through
`build.SavedReportSpec.run_inputs` (called by `runner.run_report`): every filter parameter the request leaves OUT takes
its saved value (so an API call or a file export without filters keeps the saved department / employee / type / selects
/ dates), and an id filter, the employee type or an optional select sent EMPTY (`departmentIds=`) means "all" - the
catalog marks those filters `clearable`, and the workspace sends them empty when they are cleared. A relative choice
may be saved as a token: `period` "thisMonth" | "lastMonth", or `dateRange` "thisMonth" | "lastMonth" | "today" |
"yesterday" | "last7" | "thisWeek" instead of dates. `filters.resolve_default` keeps literal defaults (a month, a
{dateFrom, dateTo} range, an id list) for this.

**Runs.** Preview = `custom-preview`, 200 rows; a saved report = the normal ceilings. With a sort, the data source returns
up to the Excel ceiling (5,000 for the preview), the rows are sorted (blanks last), then cut. PDF: landscape, A3 from 13
columns. Exports are audited by `reports_export`; create / change / copy / delete are audited here (`log_action`, module
`reports`).

**Adding a field:** add a `Field` to the data source with a new key, fill it in its loader group (or a new group, loaded
in a fixed number of queries), and extend `tests_reporting_rc_customise.py`. Adding a data source: a `Dataset` in a new
`ds_*.py`, listed in `datasets.py`.
