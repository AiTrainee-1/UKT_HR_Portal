"""
Attendance Notify's report (owner 2026-11-17): who is Absent, on CL, On Leave, on Permission or under Compensation on a
day (or each day of a range), and the same report as WhatsApp text, an email (HTML or text), a PDF and a chat card.

No attendance is calculated here. Every day comes from the Report Log's own engine (attendance_views.
report_log_day_records -> compute_day_record, the AttendanceDayRecord payroll reads), with the approved Casual Leave,
leave and permission requests of that day for the details:

    CL            an approved Casual Leave request for the day (full day or a half)
    On Leave      an approved leave request covering the day, or a day the engine counts as leave without one
    Absent        the engine says absent and there is no CL / leave / On-Duty for the day (for "today": no punch
                  yet)
    On Duty       an On-Duty request HR finally approved covers the day (payroll_calendar's rule, the same the
                  Staff / Production Attendance roll call and the payroll calendar show)
    Permission    an approved permission request for the day
    Compensation  the day used compensation (a birthday leave, a relaxation, an OT allowance or a window)

Each employee's day is judged with the settings of their own branch (user_settings.settings_for_employee's rule).
"""

from __future__ import annotations

import base64
import html as html_lib
import io
import logging
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

logger = logging.getLogger(__name__)

CATEGORIES = ("absent", "cl", "on_leave", "on_duty", "permission", "compensation")
LABELS = {
    "absent": "Absent",
    "cl": "CL",
    "on_leave": "On Leave",
    "on_duty": "On Duty",
    "permission": "Permission",
    "compensation": "Compensation",
}
LONG_LABELS = {**LABELS, "cl": "CL (Casual Leave)"}
TYPE_LABELS = {"all": "All employees", "staff": "Staff", "production": "Production"}
EMPLOYEE_TYPES = tuple(TYPE_LABELS)
# colours of each category in the email and the PDF
COLOURS = {
    "absent": "#B42318",
    "cl": "#6941C6",
    "on_leave": "#175CD3",
    "on_duty": "#0E7090",
    "permission": "#B54708",
    "compensation": "#067647",
}
COMPENSATION_LABELS = {
    "birthday": "Birthday leave",
    "relaxation": "Relaxation",
    "ot_allowance": "OT allowance used",
    "window_late_in": "Late-in covered by the compensation window",
    "window_early_out": "Early-out covered by the compensation window",
}
CL_PORTIONS = {"full": "Full day", "first_half": "First half", "second_half": "Second half"}
HALF_SLOTS = {"morning": "Morning half", "afternoon": "Afternoon half"}
MAX_RANGE_DAYS = 31
# WhatsApp: one text message holds at most about this many characters (it is split at category boundaries beyond)
TEXT_PART_LIMIT = 3500
# the employee lines written into WhatsApp / chat text (the PDF and the email always have everyone)
MAX_TEXT_ROWS = 120
PHOTO_PX = 96


@dataclass
class Person:
    id: int
    code: str
    name: str
    department: str
    designation: str
    employment_type: str
    branch: str


@dataclass
class Row:
    day: date
    category: str
    person: Person
    detail: str


@dataclass
class Report:
    name: str
    days: list
    employee_type: str
    categories: list
    rows: list = field(default_factory=list)
    counts: dict = field(default_factory=dict)
    total_employees: int = 0
    as_of: str = ""  # "09:30" when the report is about today (absences are "no punch yet")
    branch: str = ""

    @property
    def employees(self) -> int:
        return len({r.person.id for r in self.rows})

    @property
    def is_empty(self) -> bool:
        return not self.rows


def day_text(d: date) -> str:
    return d.strftime("%d %b %Y")


def days_text(days: list) -> str:
    if not days:
        return ""
    if len(days) == 1:
        return day_text(days[0])
    return f"{day_text(days[0])} – {day_text(days[-1])}"


def _person(emp) -> Person:
    return Person(
        id=emp.id,
        code=str(emp.employee_code or ""),
        name=f"{emp.first_name or ''} {emp.last_name or ''}".strip() or str(emp.employee_code or ""),
        department=emp.department.name if emp.department_id and emp.department else "",
        designation=emp.designation.title if emp.designation_id and emp.designation else "",
        employment_type=emp.employment_type or "",
        branch=emp.branch.name if emp.branch_id and emp.branch else "",
    )


def employees_for(employee_type: str, branch_id: int | None) -> list:
    """The active employees a report is about (photos never read: they are fetched one by one when drawn)."""
    from django.db.models import F

    from .models import Employee

    qs = (
        Employee.objects.filter(status="active")
        .select_related("department", "designation", "branch")
        .defer("photo_url")
        .order_by(F("department__name").asc(nulls_last=True), "first_name", "id")
    )
    if branch_id:
        qs = qs.filter(branch_id=branch_id)
    if employee_type in ("staff", "production"):
        qs = qs.filter(employment_type=employee_type)
    else:
        qs = qs.filter(employment_type__in=("staff", "production"))
    return list(qs)


def _day_records(employees: list, d: date) -> dict:
    """{employee_id: AttendanceDayRecord} from the Report Log's engine, each branch with its own settings."""
    from .attendance_views import report_log_day_records
    from .user_settings import _overlay_for_branch

    groups: dict = defaultdict(list)
    for emp in employees:
        groups[(emp.branch_id, emp.employment_type)].append(emp)
    records: dict = {}
    for (branch_id, employment_type), emps in groups.items():
        recs, _ctx = report_log_day_records(emps, d, _overlay_for_branch(branch_id), employment_type)
        records.update(recs)
    return records


def _leave_label(lr) -> str:
    ref = getattr(lr, "leave_type_ref", None)
    name = ref.name if ref is not None else (lr.type or "Leave").replace("_", " ").title()
    parts = [name]
    if lr.is_half_day:
        parts.append(HALF_SLOTS.get(lr.half_day_slot or "", "Half day"))
    if lr.reason:
        parts.append(lr.reason.strip())
    return " · ".join(p for p in parts if p)


def day_rows(d: date, employees: list, categories, *, as_of: str = "") -> list:
    """The report lines of one day, in category order, then department and name."""
    from .models import CasualLeaveRequest, EmployeePermission, LeaveRequest
    from .payroll_calendar import ON_DUTY_APPROVED_STATES, on_duty_states_by_employee

    wanted = [c for c in CATEGORIES if c in set(categories)]
    if not employees or not wanted:
        return []
    ids = [e.id for e in employees]
    records = _day_records(employees, d)
    cl = {
        c.employee_id: c
        for c in CasualLeaveRequest.objects.filter(employee_id__in=ids, date=d, status="approved").order_by("id")
    }
    leaves: dict = {}
    for lr in (
        LeaveRequest.objects.filter(
            employee_id__in=ids, status="approved", start_date__lte=str(d), end_date__gte=str(d)
        )
        .select_related("leave_type_ref")
        .order_by("id")
    ):
        if str(lr.start_date)[:10] <= str(d) <= str(lr.end_date)[:10]:
            leaves[lr.employee_id] = lr
    # On-Duty HR approved for the day (whether its punches are verified yet or not): never Absent
    on_duty = {
        emp_id: days[d]
        for emp_id, days in on_duty_states_by_employee(ids, d, d).items()
        if d in days and days[d]["state"] in ON_DUTY_APPROVED_STATES
    }
    permissions: dict = defaultdict(list)
    if "permission" in wanted:
        for p in EmployeePermission.objects.filter(employee_id__in=ids, date=d, status="approved").order_by("id"):
            permissions[p.employee_id].append(p)

    by_cat: dict = {c: [] for c in wanted}
    for emp in employees:
        rec = records.get(emp.id)
        status = getattr(rec, "status", None)
        person = None

        def add(cat: str, detail: str) -> None:
            nonlocal person
            if cat in by_cat:
                person = person or _person(emp)
                by_cat[cat].append(Row(d, cat, person, detail))

        c = cl.get(emp.id)
        lr = leaves.get(emp.id)
        kind = getattr(rec, "compensation_kind", "") or ""
        if c is not None:
            add("cl", " · ".join(p for p in (CL_PORTIONS.get(c.portion, "Full day"), (c.reason or "").strip()) if p))
        if lr is not None:
            add("on_leave", _leave_label(lr))
        elif status == "on_leave" and c is None and kind not in ("birthday", "relaxation"):
            add("on_leave", "Leave")
        od = on_duty.get(emp.id)
        if od is not None:
            add("on_duty", " · ".join(x for x in ((od.get("destination") or "").strip(), od.get("label") or "") if x))
        full_day_off = (c is not None and c.portion == "full") or (lr is not None and not lr.is_half_day)
        if status == "absent" and not full_day_off and od is None:
            add("absent", f"No punch yet (as of {as_of})" if as_of else "No punch")
        for p in permissions.get(emp.id, ()):
            label = EmployeePermission.TYPE_LABELS.get(p.type or "", "Permission")
            when = p.permission_time.strftime("%H:%M") if p.permission_time else ""
            add("permission", " · ".join(x for x in (label, when, (p.reason or "").strip()) if x))
        if kind:
            note = (getattr(rec, "compensation_note", "") or "").strip()
            add(
                "compensation",
                " · ".join(x for x in (COMPENSATION_LABELS.get(kind, kind.replace("_", " ")), note) if x),
            )
    rows = []
    for c in wanted:
        rows.extend(by_cat[c])
    return rows


def resolve_days(config: dict, today: date) -> list:
    """The days a report covers: today / yesterday for a daily report, the fixed date or range of a custom one."""
    if config.get("reportType") == "custom":
        start = config.get("dateFrom")
        end = config.get("dateTo") or start
        if isinstance(start, str):
            start = date.fromisoformat(start)
        if isinstance(end, str):
            end = date.fromisoformat(end)
        if start is None:
            return [today]
        if end < start:
            start, end = end, start
        end = min(end, start + timedelta(days=MAX_RANGE_DAYS - 1))
        return [start + timedelta(days=i) for i in range((end - start).days + 1)]
    return [today - timedelta(days=1)] if config.get("reportDay") == "yesterday" else [today]


def build(config: dict, *, now: datetime, branch_id: int | None = None, branch_name: str = "", max_days=None) -> Report:
    """The report an automation's `config` (its camelCase form) describes, as of `now` (naive or aware IST)."""
    today = now.date()
    days = resolve_days(config, today)
    if max_days:
        days = days[:max_days]
    employee_type = config.get("employeeType") or "all"
    categories = [c for c in CATEGORIES if c in set(config.get("categories") or [])]
    employees = employees_for(employee_type, branch_id)
    report = Report(
        name=config.get("name") or "Attendance report",
        days=days,
        employee_type=employee_type,
        categories=categories,
        total_employees=len(employees),
        branch=branch_name,
    )
    for d in days:
        as_of = now.strftime("%H:%M") if d == today else ""
        if as_of:
            report.as_of = as_of
        report.rows.extend(day_rows(d, employees, categories, as_of=as_of))
    report.counts = {c: sum(1 for r in report.rows if r.category == c) for c in categories}
    return report


# ─────────────────────────── text (WhatsApp, chat, plain email) ───────────────────────────


def _bold(text: str, markdown: bool) -> str:
    return f"*{text}*" if markdown else text


def header_lines(report: Report, markdown: bool = True) -> list:
    meta = [days_text(report.days), TYPE_LABELS.get(report.employee_type, "All employees")]
    if report.branch:
        meta.append(report.branch)
    if report.as_of:
        meta.append(f"as of {report.as_of}")
    return [_bold(f"Attendance report – {report.name}", markdown), " · ".join(meta)]


def summary_text(report: Report, markdown: bool = True) -> str:
    lines = header_lines(report, markdown) + [""]
    for c in report.categories:
        lines.append(f"{LONG_LABELS[c]}: {_bold(str(report.counts.get(c, 0)), markdown)}")
    lines.append("")
    lines.append(f"Employees in the report: {report.employees} of {report.total_employees}")
    return "\n".join(lines).strip()


def _row_line(i: int, r: Row, multi_day: bool) -> str:
    who = f"{r.person.name} ({r.person.code})"
    where = ", ".join(x for x in (r.person.department, r.person.designation) if x)
    day = f"{r.day.strftime('%d %b')}: " if multi_day else ""
    return f"{i}. {day}{who}" + (f" – {where}" if where else "") + (f" · {r.detail}" if r.detail else "")


def detail_sections(report: Report, markdown: bool = True, limit: int = MAX_TEXT_ROWS) -> list:
    """One text block per category with its employees ("*Absent (4)*" then numbered lines)."""
    multi = len(report.days) > 1
    blocks = []
    written = 0
    for c in report.categories:
        rows = [r for r in report.rows if r.category == c]
        if not rows:
            continue
        lines = [_bold(f"{LONG_LABELS[c]} ({len(rows)})", markdown)]
        for i, r in enumerate(rows, start=1):
            if written >= limit:
                lines.append(f"…and {len(rows) - i + 1} more")
                break
            lines.append(_row_line(i, r, multi))
            written += 1
        blocks.append("\n".join(lines))
    if not blocks:
        blocks.append("Nobody is in the chosen categories.")
    return blocks


def message_parts(report: Report, content: str, *, markdown: bool = True, pdf_note: bool = False) -> list:
    """The text messages for WhatsApp / chat: the summary and / or the detailed list, split so no message is longer
    than TEXT_PART_LIMIT characters (at category boundaries; a very long category is cut into numbered pieces)."""
    parts: list = []
    if content in ("summary", "both"):
        parts.append(summary_text(report, markdown))
    if content in ("detailed", "both"):
        head = "\n".join(header_lines(report, markdown)) if content == "detailed" else ""
        current = head
        for block in detail_sections(report, markdown):
            pieces = [block]
            if len(block) > TEXT_PART_LIMIT:  # cut by lines
                pieces, buf = [], ""
                for line in block.split("\n"):
                    if buf and len(buf) + len(line) + 1 > TEXT_PART_LIMIT:
                        pieces.append(buf)
                        buf = ""
                    buf = f"{buf}\n{line}" if buf else line
                if buf:
                    pieces.append(buf)
            for piece in pieces:
                if current and len(current) + len(piece) + 2 > TEXT_PART_LIMIT:
                    parts.append(current)
                    current = piece
                else:
                    current = f"{current}\n\n{piece}" if current else piece
        if current:
            parts.append(current)
    if pdf_note and parts:
        parts[-1] = f"{parts[-1]}\n\nThe employee list with photos follows as a PDF."
    return [p.strip() for p in parts if p.strip()]


# ─────────────────────────── photos ───────────────────────────


def photo_bytes(emp_ids, px: int = PHOTO_PX) -> dict:
    """{employee_id: small JPEG bytes} of the employees who have a photo (stored inline as a data: URL)."""
    from PIL import Image

    from .models import Employee

    out: dict = {}
    ids = list({i for i in emp_ids if i})
    for start in range(0, len(ids), 50):
        for pk, value in Employee.objects.filter(pk__in=ids[start : start + 50]).values_list("pk", "photo_url"):
            if not isinstance(value, str) or not value.startswith("data:") or "," not in value:
                continue
            try:
                raw = base64.b64decode(value.split(",", 1)[1])
                img = Image.open(io.BytesIO(raw))
                img = img.convert("RGB")
                img.thumbnail((px * 2, px * 2))
                w, h = img.size
                side = min(w, h)  # a square crop, centred
                img = img.crop(((w - side) // 2, (h - side) // 2, (w - side) // 2 + side, (h - side) // 2 + side))
                img = img.resize((px, px))
                buf = io.BytesIO()
                img.save(buf, format="JPEG", quality=80)
                out[pk] = buf.getvalue()
            except Exception:  # a broken photo never stops a report
                logger.warning("Employee %s photo could not be read for Attendance Notify", pk)
    return out


def _initials(name: str) -> str:
    parts = [p for p in name.split() if p]
    if not parts:
        return "?"
    return (parts[0][0] + (parts[-1][0] if len(parts) > 1 else "")).upper()


# ─────────────────────────── email ───────────────────────────


def email_html(report: Report, content: str, photo_cids: dict | None = None) -> str:
    """The report block of the email (placed in the shared email shell): count tiles and / or a table per category.
    `photo_cids` = {employee_id: cid} of inline photos (None = no photo column)."""
    esc = html_lib.escape
    out = []
    meta = " · ".join(x for x in header_lines(report, markdown=False)[1:2])
    out.append(f'<p style="margin:0 0 12px;color:#475467;font-size:13px">{esc(meta)}</p>')
    if content in ("summary", "both"):
        cells = "".join(
            f'<td style="padding:10px 12px;border:1px solid #eaecf0;border-radius:8px;text-align:center">'
            f'<div style="font-size:22px;font-weight:bold;color:{COLOURS[c]}">{report.counts.get(c, 0)}</div>'
            f'<div style="font-size:12px;color:#475467">{esc(LONG_LABELS[c])}</div></td>'
            for c in report.categories
        )
        out.append(
            '<table style="width:100%;border-collapse:separate;border-spacing:6px;margin:0 0 16px">'
            f"<tr>{cells}</tr></table>"
            f'<p style="margin:0 0 16px;font-size:12px;color:#667085">Employees in the report: {report.employees} of '
            f"{report.total_employees}</p>"
        )
    if content in ("detailed", "both"):
        multi = len(report.days) > 1
        for c in report.categories:
            rows = [r for r in report.rows if r.category == c]
            if not rows:
                continue
            body = []
            for r in rows:
                photo = ""
                if photo_cids is not None:
                    cid = photo_cids.get(r.person.id)
                    photo = (
                        f'<img src="cid:{cid}" width="40" height="40" alt="" '
                        'style="border-radius:20px;display:block;object-fit:cover">'
                        if cid
                        else '<div style="width:40px;height:40px;border-radius:20px;background:#f2f4f7;color:#475467;'
                        f'font-size:13px;font-weight:bold;line-height:40px;text-align:center">{esc(_initials(r.person.name))}</div>'
                    )
                    photo = f'<td style="padding:6px 8px;width:40px">{photo}</td>'
                day = (
                    f'<td style="padding:6px 8px;white-space:nowrap">{esc(r.day.strftime("%d %b"))}</td>'
                    if multi
                    else ""
                )
                body.append(
                    '<tr style="border-top:1px solid #eaecf0">'
                    f"{photo}{day}"
                    f'<td style="padding:6px 8px"><strong>{esc(r.person.name)}</strong><br>'
                    f'<span style="color:#667085;font-size:12px">{esc(r.person.code)}</span></td>'
                    f'<td style="padding:6px 8px;font-size:12px">{esc(r.person.department)}<br>'
                    f'<span style="color:#667085">{esc(r.person.designation)}</span></td>'
                    f'<td style="padding:6px 8px;font-size:12px">{esc(r.detail)}</td></tr>'
                )
            head_cells = ("<th></th>" if photo_cids is not None else "") + ("<th>Date</th>" if multi else "")
            out.append(
                f'<h3 style="margin:18px 0 6px;font-size:15px;color:{COLOURS[c]}">{esc(LONG_LABELS[c])} ({len(rows)})</h3>'
                '<table style="width:100%;border-collapse:collapse;font-size:13px">'
                f'<tr style="text-align:left;color:#667085;font-size:11px">{head_cells}<th style="padding:4px 8px">'
                'Employee</th><th style="padding:4px 8px">Department</th><th style="padding:4px 8px">Details</th></tr>'
                f"{''.join(body)}</table>"
            )
        if not report.rows:
            out.append('<p style="color:#667085">Nobody is in the chosen categories.</p>')
    return "".join(out)


def email_text(report: Report, content: str) -> str:
    return "\n\n".join(message_parts(report, content, markdown=False))


# ─────────────────────────── PDF ───────────────────────────


def pdf_bytes(report: Report, *, with_photos: bool = True, content: str = "both") -> bytes:
    """The report as an A4 PDF: the counts, then a table per category (with each employee's photo when asked)."""
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import Image, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    styles = getSampleStyleSheet()
    small = ParagraphStyle("small", parent=styles["Normal"], fontSize=8, leading=10)
    cell = ParagraphStyle("cell", parent=styles["Normal"], fontSize=9, leading=11)
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=14 * mm,
        rightMargin=14 * mm,
        topMargin=14 * mm,
        bottomMargin=14 * mm,
        title=f"Attendance report – {report.name}",
    )
    esc = html_lib.escape
    story = [
        Paragraph(esc(f"Attendance report – {report.name}"), styles["Title"]),
        Paragraph(esc(" · ".join(header_lines(report, markdown=False)[1:2])), styles["Normal"]),
        Spacer(1, 6 * mm),
    ]
    if content in ("summary", "both") or not report.rows:
        data = [[LONG_LABELS[c] for c in report.categories], [str(report.counts.get(c, 0)) for c in report.categories]]
        if report.categories:
            t = Table(data, hAlign="LEFT")
            t.setStyle(
                TableStyle(
                    [
                        ("FONTSIZE", (0, 0), (-1, 0), 8),
                        ("FONTSIZE", (0, 1), (-1, 1), 16),
                        ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#475467")),
                        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#eaecf0")),
                        ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#eaecf0")),
                        ("TOPPADDING", (0, 0), (-1, -1), 5),
                        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
                    ]
                )
            )
            story += [t, Spacer(1, 2 * mm)]
        story += [
            Paragraph(f"Employees in the report: {report.employees} of {report.total_employees}", small),
            Spacer(1, 4 * mm),
        ]
    photos = photo_bytes([r.person.id for r in report.rows]) if with_photos and report.rows else {}
    multi = len(report.days) > 1
    for c in report.categories:
        rows = [r for r in report.rows if r.category == c]
        if not rows:
            continue
        story.append(
            Paragraph(
                f'<font color="{COLOURS[c]}"><b>{esc(LONG_LABELS[c])} ({len(rows)})</b></font>', styles["Heading3"]
            )
        )
        header = (
            (["Photo"] if with_photos else []) + (["Date"] if multi else []) + ["Employee", "Department", "Details"]
        )
        data = [header]
        for r in rows:
            line = []
            if with_photos:
                raw = photos.get(r.person.id)
                line.append(Image(io.BytesIO(raw), width=12 * mm, height=12 * mm) if raw else _initials(r.person.name))
            if multi:
                line.append(r.day.strftime("%d %b"))
            line += [
                Paragraph(f"<b>{esc(r.person.name)}</b><br/>{esc(r.person.code)}", cell),
                Paragraph(f"{esc(r.person.department)}<br/>{esc(r.person.designation)}", cell),
                Paragraph(esc(r.detail), cell),
            ]
            data.append(line)
        widths = ([16 * mm] if with_photos else []) + ([16 * mm] if multi else [])
        rest = (A4[0] - 28 * mm - sum(widths)) / 3
        t = Table(data, colWidths=widths + [rest, rest, rest], repeatRows=1)
        t.setStyle(
            TableStyle(
                [
                    ("FONTSIZE", (0, 0), (-1, 0), 8),
                    ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#475467")),
                    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                    ("LINEBELOW", (0, 0), (-1, -1), 0.4, colors.HexColor("#eaecf0")),
                    ("ALIGN", (0, 1), (0, -1), "CENTER"),
                ]
            )
        )
        story += [t, Spacer(1, 4 * mm)]
    if not report.rows:
        story.append(Paragraph("Nobody is in the chosen categories.", styles["Normal"]))
    doc.build(story)
    return buf.getvalue()


def pdf_filename(report: Report) -> str:
    stamp = report.days[0].isoformat() if report.days else "report"
    if len(report.days) > 1:
        stamp = f"{report.days[0].isoformat()}_to_{report.days[-1].isoformat()}"
    return f"attendance-report-{stamp}.pdf"


# ─────────────────────────── preview / chat ───────────────────────────


def row_json(r: Row, photo_url=None) -> dict:
    return {
        "date": r.day.isoformat(),
        "category": r.category,
        "employeeId": r.person.id,
        "code": r.person.code,
        "name": r.person.name,
        "department": r.person.department,
        "designation": r.person.designation,
        "employmentType": r.person.employment_type,
        "detail": r.detail,
        "photoUrl": photo_url,
    }


def chat_payload(report: Report, limit: int = 300) -> dict:
    """What a chat message carries for the HR chat page's card (photo links are added when the message is read)."""
    return {
        "kind": "attendance_report",
        "title": f"Attendance report – {report.name}",
        "date": report.days[0].isoformat() if report.days else None,
        "dateLabel": days_text(report.days),
        "employeeType": report.employee_type,
        "asOf": report.as_of or None,
        "categories": list(report.categories),
        "counts": dict(report.counts),
        "employees": report.employees,
        "total": report.total_employees,
        "rows": [row_json(r) for r in report.rows[:limit]],
        "truncated": len(report.rows) > limit,
    }
