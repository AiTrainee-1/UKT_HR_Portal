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
  definitions/    the reports, one module per domain
```

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

## A new category (a new group in the catalog)

Add one tuple to `types.CATEGORIES` (`id, label, description, lucide icon name`; the order is the display order, the icon
must be one of those listed in the frontend's `report-center/report-icons.ts`) and give the reports `category="<id>"`.
The catalog, the category chips and the group heading appear on their own. A colour for the group is optional: add the
id to `CATEGORY_STYLE` in `report-icons.ts`, otherwise it uses the neutral admin colour. Example: `hr` (HR Reports,
`definitions/hr_reports.py`).

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

`tests_reporting_all.py` runs **every** registered report (screen, Excel, PDF) for an unscoped admin,
a branch-scoped user and a view-only role — a new report is covered by it automatically.
