"""
HR Analytics API (the /hr/analytics page). All GET, HR only, the caller's branch only.

    GET /api/hr-analytics/summary          the tab's checks, employees with hits (levels, scores), weekly counts,
                                           departments, the Department Head view (staff), totals, filter options
    GET /api/hr-analytics/category/<key>   one check: every employee in it with their records and pattern
    GET /api/hr-analytics/employee/<id>    one employee: every check's records and pattern, and a timeline

Common query: type=staff|production, from, to (default this month to today), departmentId, employeeId, q, t_<key>.
"""

from __future__ import annotations

from collections import defaultdict

from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from ..auth import require_hr
from ..employee_photo import employee_photo_link, photo_links
from . import categories as C
from .collect import collect, count, data_gaps, hod_view, pattern, record_json, weekly
from .period import FilterError, employee_scope, parse


def _employee_json(emp, photos) -> dict:
    return {
        "id": emp.id,
        "code": emp.employee_code,
        "name": f"{emp.first_name} {emp.last_name}".strip(),
        "department": emp.department.name if emp.department_id and emp.department else None,
        "departmentId": emp.department_id,
        "designation": emp.designation.title if emp.designation_id and emp.designation else None,
        "branch": emp.branch.name if emp.branch_id and emp.branch else None,
        "photoUrl": employee_photo_link(emp, photos),
        "type": emp.employment_type,
    }


def _period(f) -> dict:
    """The period, with the days left out because no punches arrived for this type that day (collect.data_gaps)."""
    return {**f.period_json(), "dataGaps": sorted(d.isoformat() for d in data_gaps(f, f.type))}


def _last_date(records: list[dict]) -> str | None:
    days = [d for r in records for d, _w in r["_spread"]]
    return max(days).isoformat() if days else None


def _options(request, kind: str) -> dict:
    from ..branch_scope import scope_to_branch
    from ..models import Department

    departments = scope_to_branch(Department.objects.all(), request, field="branch_id").order_by("name")
    return {
        "departments": [
            {"id": d.id, "name": d.name, "category": getattr(d, "category", None) or "staff"} for d in departments
        ]
    }


def _bad(exc: FilterError) -> Response:
    return Response({"error": str(exc)}, status=400)


@api_view(["GET"])
@require_hr
def summary(request: Request) -> Response:
    try:
        f = parse(request.query_params)
    except FilterError as exc:
        return _bad(exc)
    emps = list(employee_scope(f, request))
    ids = [e.id for e in emps]
    by_cat = collect(f.type, f, ids)
    cats = C.categories(f.type)

    per_emp: dict[int, dict[str, float]] = defaultdict(dict)
    last: dict[int, str] = {}
    for key, rows in by_cat.items():
        for emp_id, records in rows.items():
            n = count(records)
            if n:
                per_emp[emp_id][key] = n
                ld = _last_date(records)
                if ld and ld > last.get(emp_id, ""):
                    last[emp_id] = ld

    photos = photo_links(per_emp.keys())
    employees = []
    levels: dict[int, tuple[str, list[str]]] = {}
    for emp in emps:
        counts = per_emp.get(emp.id)
        if not counts:
            continue
        lvl, flags, score = C.level(counts, f.type, f)
        levels[emp.id] = (lvl, flags)
        employees.append(
            {
                **_employee_json(emp, photos),
                "counts": counts,
                "flags": flags,
                "level": lvl,
                "score": score,
                "lastDate": last.get(emp.id),
            }
        )
    rank = {"high": 0, "attention": 1, "watch": 2, "ok": 3}
    employees.sort(key=lambda e: (rank[e["level"]], -e["score"], e["name"]))

    categories_json = []
    for cat in cats:
        t = C.threshold(cat, f)
        values = [per_emp[i].get(cat.key, 0) for i in per_emp]
        hits = [v for v in values if v]
        categories_json.append(
            {
                **C.category_json(cat, f),
                "flagged": 0 if cat.informational else sum(1 for v in hits if v >= t),
                "high": 0 if cat.informational else sum(1 for v in hits if v >= 2 * t),
                "affected": len(hits),
                "total": round(sum(hits), 1) if sum(hits) % 1 else int(sum(hits)),
            }
        )

    by_dept: dict[int | None, dict] = {}
    for e in employees:
        d = by_dept.setdefault(
            e["departmentId"],
            {
                "id": e["departmentId"],
                "name": e["department"] or "No department",
                "employees": 0,
                "flagged": 0,
                "counts": defaultdict(float),
            },
        )
        d["employees"] += 1
        d["flagged"] += 1 if e["level"] in ("attention", "high") else 0
        for k, v in e["counts"].items():
            d["counts"][k] += v
    departments = sorted(
        ({**d, "counts": dict(d["counts"])} for d in by_dept.values()),
        key=lambda d: (-d["flagged"], -d["employees"], d["name"]),
    )

    return Response(
        {
            "type": f.type,
            "period": _period(f),
            "categories": categories_json,
            "employees": employees,
            "weekly": weekly(f, by_cat),
            "departments": departments,
            "hods": hod_view(f, ids) if f.type == "staff" else [],
            "totals": {
                "employeesInScope": len(emps),
                "employeesWithIssues": len(employees),
                "needingAttention": sum(1 for e in employees if e["level"] in ("attention", "high")),
                "high": sum(1 for e in employees if e["level"] == "high"),
            },
            "options": _options(request, f.type),
        }
    )


@api_view(["GET"])
@require_hr
def category(request: Request, key: str) -> Response:
    try:
        f = parse(request.query_params)
    except FilterError as exc:
        return _bad(exc)
    cat = C.by_key(f.type, key)
    if cat is None:
        other = "production" if f.type == "staff" else "staff"
        if C.by_key(other, key):
            return Response({"error": f"{key} is a {other} check"}, status=400)
        return Response({"error": "Unknown check"}, status=404)
    emps = list(employee_scope(f, request))
    ids = [e.id for e in emps]
    all_rows = collect(f.type, f, ids)
    rows = all_rows.get(key, {})
    photos = photo_links(rows.keys())
    t = C.threshold(cat, f)
    out = []
    for emp in emps:
        records = rows.get(emp.id)
        if not records:
            continue
        n = count(records)
        counts = {k: count(r[emp.id]) for k, r in all_rows.items() if r.get(emp.id)}
        lvl, _flags, _score = C.level(counts, f.type, f)
        out.append(
            {
                **_employee_json(emp, photos),
                "count": n,
                "flagged": (not cat.informational) and n >= t,
                "level": lvl,
                "lastDate": _last_date(records),
                "pattern": pattern(key, records),
                "records": [record_json(r) for r in records],
            }
        )
    out.sort(key=lambda e: (-e["count"], e["name"]))
    total = sum(e["count"] for e in out)
    return Response(
        {
            "category": {
                **C.category_json(cat, f),
                "flagged": sum(1 for e in out if e["flagged"]),
                "high": 0 if cat.informational else sum(1 for e in out if e["count"] >= 2 * t),
                "affected": len(out),
                "total": round(total, 1) if total % 1 else int(total),
            },
            "period": _period(f),
            "employees": out,
        }
    )


@api_view(["GET"])
@require_hr
def employee(request: Request, pk: int) -> Response:
    try:
        f = parse(request.query_params)
    except FilterError as exc:
        return _bad(exc)
    f = f.__class__(type=f.type, start=f.start, end=f.end, employee_id=pk, overrides=f.overrides)
    emp = employee_scope(f, request, use_search=False).first()
    if emp is None:
        return Response({"error": "Employee not found"}, status=404)
    by_cat = collect(f.type, f, [emp.id])
    counts: dict[str, float] = {}
    cats_json: dict[str, dict] = {}
    timeline = []
    for cat in C.categories(f.type):
        records = by_cat.get(cat.key, {}).get(emp.id, [])
        n = count(records) if records else 0
        if n:
            counts[cat.key] = n
        t = C.threshold(cat, f)
        cats_json[cat.key] = {
            "category": C.category_json(cat, f),
            "count": n,
            "flagged": (not cat.informational) and n >= t,
            "records": [record_json(r) for r in records],
            "pattern": pattern(cat.key, records),
        }
        # the Late details check repeats Frequent late: the timeline lists each record once
        if not cat.informational:
            timeline.extend(record_json(r, cat.key) for r in records)
    lvl, flags, score = C.level(counts, f.type, f)
    timeline.sort(key=lambda r: (r["date"] or "", r["at"] or ""), reverse=True)
    return Response(
        {
            "employee": _employee_json(emp, photo_links([emp.id])),
            "period": _period(f),
            "level": lvl,
            "score": score,
            "counts": counts,
            "flags": flags,
            "categories": cats_json,
            "timeline": timeline,
        }
    )
