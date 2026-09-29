"""Audit trail reports: activity log, employee change & deletion log and an audit summary.

Admin-only (``super_admin_only``): the audit trail is an oversight tool that only super admins can open
elsewhere in the app. Rows carry the branch of the acting user, so the Branch filter and branch isolation
(``ctx.emp_q()`` on AuditLog.branch) still apply for consistency.

Date filters use IST day bounds (not ``created_at__date``, which compares UTC dates). ``old_values`` /
``new_values`` are never exported, and no token, JWT id or password material is ever read."""

from __future__ import annotations

import re

from django.db.models import Count, F, Max, Min, Q
from django.db.models.functions import TruncDate

from api.clock import FACTORY_TZ
from api.models import AuditLog

from ..filters import branches, date_range, select, text
from ..formatting import fmt_dt
from ..registry import register
from ..types import BADGE, DATE, DATETIME, INTEGER, TEXT, ColumnSpec, ReportResult, ReportSpec
from .employees_admin_util import ist_range_q, label

# Modules / actions the application really writes (see audit_utils.log_action callers + AuditLog.ACTION_CHOICES).
AUDIT_MODULES = (
    ("auth", "Login / auth"),
    ("employees", "Employees"),
    ("user_management", "User management"),
    ("settings", "Settings"),
    ("attendance", "Attendance"),
    ("bonus", "Bonus"),
    ("compensation", "Compensation"),
    ("mobile_app_login", "Mobile app login"),
    ("mobile_app_version", "Mobile app version"),
    ("reports", "Reports"),
)
AUDIT_ACTIONS = (
    ("login", "Login"),
    ("logout", "Logout"),
    ("login_failed", "Login failed"),
    ("login_blocked", "Login blocked (locked out)"),
    ("create", "Create"),
    ("update", "Update"),
    ("delete", "Delete"),
    ("export", "Export"),
    ("approve", "Approve"),
    ("reject", "Reject"),
    ("upload", "Upload"),
    ("restore", "Restore"),
    ("backup", "Backup"),
    ("announce", "Announce"),
    ("redeem", "Redeem"),
    ("lock", "Lock"),
)
_FAILED = ("login_failed", "login_blocked")


def _audit_q(ctx) -> Q:
    """Branch isolation + Branch filter (AuditLog.branch) + the IST date range."""
    return ctx.emp_q() & ist_range_q("created_at", ctx.date_from, ctx.date_to)


# ── Audit / Activity Log ────────────────────────────────────────────────────

def _run_audit_log(ctx):
    q = _audit_q(ctx)
    modules = ctx.param("module", [])
    if modules:
        q &= Q(module__in=modules)
    actions = ctx.param("action", [])
    if actions:
        q &= Q(action__in=actions)
    user = ctx.param("userName")
    if user:
        q &= Q(user_name__icontains=user)
    search = ctx.param("search")
    if search:
        q &= (
            Q(user_name__icontains=search)
            | Q(module__icontains=search)
            | Q(action__icontains=search)
            | Q(record_description__icontains=search)
        )
    base = AuditLog.objects.filter(q)
    logs = (
        base.select_related("branch")
        .defer("old_values", "new_values")
        .order_by("-created_at", "-id")[: ctx.row_limit]
    )
    rows = [
        {
            "createdAt": fmt_dt(a.created_at),
            "userName": a.user_name,
            "userType": label(a.user_type),
            "action": label(a.action),
            "module": a.module,
            "recordId": a.record_id,
            "description": a.record_description or None,
            "ipAddress": a.ip_address or None,
            "branch": a.branch.name if a.branch_id else None,
        }
        for a in logs
    ]
    agg = base.order_by().aggregate(
        total=Count("id"),
        users=Count("user_name", distinct=True),
        failed=Count("id", filter=Q(action__in=_FAILED)),
        deletes=Count("id", filter=Q(action="delete")),
        exports=Count("id", filter=Q(action="export")),
    )
    return ReportResult(
        rows=rows,
        summary=[
            {"label": "Events", "value": agg["total"], "format": "integer"},
            {"label": "Distinct users", "value": agg["users"], "format": "integer"},
            {"label": "Failed / blocked logins", "value": agg["failed"], "format": "integer"},
            {"label": "Deletes", "value": agg["deletes"], "format": "integer"},
            {"label": "Exports", "value": agg["exports"], "format": "integer"},
        ],
        notes=[
            "Only actions the application records are listed; employee status changes, resignation approvals, "
            "leave and missing-punch approvals and department/designation edits are not audited.",
            "Failed and blocked logins are logged under user 'system'; the attempted username is inside the description.",
            "Branch = the acting user's branch when the event happened; blank for company-wide admins and for "
            "events logged before branches were recorded. IP is the first address in X-Forwarded-For when present.",
            "Times are shown in IST.",
        ],
    )


register(ReportSpec(
    id="audit-log",
    title="Audit / Activity Log",
    description="Who did what and when in the HR portal, with module, action, user and text filters.",
    category="admin",
    icon="History",
    tags=("audit", "activity log", "security", "who changed"),
    family="audit",
    variant="Activity log",
    super_admin_only=True,
    filters=(
        date_range("last7", label="Date range", max_days=92),
        select("module", "Module", AUDIT_MODULES, multi=True, placeholder="All modules"),
        select("action", "Action", AUDIT_ACTIONS, multi=True, placeholder="All actions"),
        text("userName", "User", "Name contains"),
        text("search", "Search", "Text in user, module, action or description"),
        branches(),
    ),
    columns=(
        ColumnSpec("createdAt", "When (IST)", DATETIME, 1.4),
        ColumnSpec("userName", "User", TEXT, 1.6),
        ColumnSpec("userType", "Type", BADGE, 0.8),
        ColumnSpec("action", "Action", BADGE, 1.0),
        ColumnSpec("module", "Module", TEXT, 1.2),
        ColumnSpec("recordId", "Record ID", INTEGER, 0.8),
        ColumnSpec("description", "Description", TEXT, 3.2),
        ColumnSpec("ipAddress", "IP Address", TEXT, 1.2),
        ColumnSpec("branch", "Branch", TEXT, 1.1),
    ),
    run=_run_audit_log,
))


# ── Employee Change & Deletion Log ──────────────────────────────────────────

# Descriptions written by employee_views / employee_bulk_views: "<Verb> employee CODE -First Last" and, for a
# bulk update, "Bulk-updated employee CODE -changed <field list>". The separator is an ASCII hyphen.
_DESC = re.compile(r"^(Created|Updated|Deleted|Bulk-imported|Bulk-updated) employee (\S+) -(.*)$", re.S)
_KIND_LABEL = {
    "Created": "Created",
    "Updated": "Updated",
    "Deleted": "Deleted",
    "Bulk-imported": "Bulk import",
    "Bulk-updated": "Bulk update",
}
_CHANGE_ACTIONS = (("create", "Create"), ("update", "Update"), ("delete", "Delete"))


def _run_employee_changes(ctx):
    q = _audit_q(ctx) & Q(module="employees")
    actions = ctx.param("action", [])
    q &= Q(action__in=actions) if actions else Q(action__in=[a for a, _ in _CHANGE_ACTIONS])
    user = ctx.param("userName")
    if user:
        q &= Q(user_name__icontains=user)
    code = ctx.param("employeeCode")
    if code:
        q &= Q(record_description__icontains=f"employee {code} -")
    base = AuditLog.objects.filter(q)
    logs = (
        base.select_related("branch")
        .defer("old_values", "new_values")
        .order_by("-created_at", "-id")[: ctx.row_limit]
    )
    rows = []
    for a in logs:
        desc = a.record_description or ""
        m = _DESC.match(desc)
        if m:
            verb, emp_code, rest = m.groups()
            kind = _KIND_LABEL[verb]
            if verb == "Bulk-updated":
                name, fields = None, rest.removeprefix("changed ").strip() or None
            else:
                name, fields = rest.strip() or None, None
        else:  # e.g. "Bulk enabled live location tracking for 12 employee(s)"
            kind = "Bulk change" if desc.startswith("Bulk") else label(a.action)
            emp_code = name = fields = None
        rows.append({
            "createdAt": fmt_dt(a.created_at),
            "userName": a.user_name,
            "action": kind,
            "employeeCode": emp_code,
            "employeeName": name,
            "fieldsChanged": fields,
            "description": desc or None,
            "ipAddress": a.ip_address or None,
            "branch": a.branch.name if a.branch_id else None,
        })

    def desc_is(prefix: str) -> Q:
        return Q(record_description__startswith=prefix)

    agg = base.order_by().aggregate(
        created=Count("id", filter=Q(action="create") & desc_is("Created employee")),
        updated=Count("id", filter=Q(action="update") & desc_is("Updated employee")),
        deleted=Count("id", filter=Q(action="delete") & desc_is("Deleted employee")),
        imported=Count("id", filter=desc_is("Bulk-imported employee")),
        bulk_updated=Count("id", filter=desc_is("Bulk-updated employee")),
    )
    return ReportResult(
        rows=rows,
        summary=[
            {"label": "Created", "value": agg["created"], "format": "integer"},
            {"label": "Updated", "value": agg["updated"], "format": "integer"},
            {"label": "Deleted", "value": agg["deleted"], "format": "integer"},
            {"label": "Bulk imported", "value": agg["imported"], "format": "integer"},
            {"label": "Bulk updated", "value": agg["bulk_updated"], "format": "integer"},
        ],
        notes=[
            "Deleted employees no longer exist anywhere else in the system: this log is the only trace of them "
            "(code and name as they were when deleted).",
            "A single-employee edit does not record which fields changed; only bulk updates list the changed fields.",
            "Employee status changes (activate / deactivate) and resignation approvals are not audited, so exits "
            "do not appear here - use the exits register for them.",
        ],
    )


register(ReportSpec(
    id="employee-change-log",
    title="Employee Change & Deletion Log",
    description="Employee create, update, delete and bulk-import events, including employees who no longer exist.",
    category="admin",
    icon="UserRound",
    tags=("audit", "deleted employees", "employee changes", "bulk import"),
    family="audit",
    variant="Employee changes",
    super_admin_only=True,
    filters=(
        date_range("thisMonth", label="Date range"),
        select("action", "Action", _CHANGE_ACTIONS, multi=True, placeholder="All actions"),
        text("userName", "Changed by", "Name contains"),
        text("employeeCode", "Employee code", "Exact code"),
        branches(),
    ),
    columns=(
        ColumnSpec("createdAt", "When (IST)", DATETIME, 1.4),
        ColumnSpec("userName", "Changed By", TEXT, 1.5),
        ColumnSpec("action", "Action", BADGE, 1.0),
        ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
        ColumnSpec("employeeName", "Employee", TEXT, 1.8),
        ColumnSpec("fieldsChanged", "Fields Changed (bulk update)", TEXT, 2.0),
        ColumnSpec("description", "Description", TEXT, 3.0),
        ColumnSpec("ipAddress", "IP Address", TEXT, 1.2),
        ColumnSpec("branch", "Branch", TEXT, 1.1),
    ),
    run=_run_employee_changes,
))


# ── Audit Summary ───────────────────────────────────────────────────────────

_GROUPS = (("user", "By user"), ("module", "By module"), ("day", "By day"))


def _run_audit_summary(ctx):
    group = ctx.param("groupBy", "user")
    base = AuditLog.objects.filter(_audit_q(ctx)).order_by()
    counts = dict(
        total=Count("id"),
        logins=Count("id", filter=Q(action="login")),
        failed=Count("id", filter=Q(action__in=_FAILED)),
        creates=Count("id", filter=Q(action="create")),
        updates=Count("id", filter=Q(action="update")),
        deletes=Count("id", filter=Q(action="delete")),
        exports=Count("id", filter=Q(action="export")),
        first=Min("created_at"),
        last=Max("created_at"),
    )
    if group == "day":
        grouped = base.annotate(bucket=TruncDate("created_at", tzinfo=FACTORY_TZ))
        order = ("bucket",)
    else:
        grouped = base.annotate(bucket=F("user_name" if group == "user" else "module"))
        order = ("-total", "bucket")
    result = grouped.values("bucket").annotate(**counts).order_by(*order)
    rows = []
    for r in result:
        known = r["logins"] + r["failed"] + r["creates"] + r["updates"] + r["deletes"] + r["exports"]
        rows.append({
            "group": r["bucket"].isoformat() if group == "day" else r["bucket"],
            "total": r["total"],
            "logins": r["logins"],
            "failedLogins": r["failed"],
            "creates": r["creates"],
            "updates": r["updates"],
            "deletes": r["deletes"],
            "exports": r["exports"],
            "other": r["total"] - known,
            "firstAt": fmt_dt(r["first"]),
            "lastAt": fmt_dt(r["last"]),
        })
    overall = base.aggregate(total=Count("id"))["total"]
    top_user = base.values("user_name").annotate(n=Count("id")).order_by("-n", "user_name").first()
    busiest = (
        base.annotate(day=TruncDate("created_at", tzinfo=FACTORY_TZ)).values("day").annotate(n=Count("id"))
        .order_by("-n", "day").first()
    )
    head = {"user": ("User", TEXT), "module": ("Module", TEXT), "day": ("Day (IST)", DATE)}[group]
    columns = [ColumnSpec("group", head[0], head[1], 1.8), *_SUMMARY_COLUMNS[1:]]
    return ReportResult(
        rows=rows,
        columns=columns,
        summary=[
            {"label": "Events", "value": overall, "format": "integer"},
            {
                "label": "Most active user",
                "value": f"{top_user['user_name']} ({top_user['n']})" if top_user else None,
                "format": "text",
            },
            {
                "label": "Busiest day",
                "value": f"{busiest['day'].isoformat()} ({busiest['n']})" if busiest else None,
                "format": "text",
            },
        ],
        notes=[
            "Days are IST calendar days. 'Failed / blocked logins' counts failed logins and lock-out blocks. "
            "'Other' = every action not listed in the other columns (rejects, uploads, backups, restores ...).",
        ],
    )


_SUMMARY_COLUMNS = (
    ColumnSpec("group", "Group", TEXT, 1.8),
    ColumnSpec("total", "Events", INTEGER, 0.9, total="sum"),
    ColumnSpec("logins", "Logins", INTEGER, 0.9, total="sum"),
    ColumnSpec("failedLogins", "Failed / Blocked Logins", INTEGER, 1.1, total="sum"),
    ColumnSpec("creates", "Creates", INTEGER, 0.9, total="sum"),
    ColumnSpec("updates", "Updates", INTEGER, 0.9, total="sum"),
    ColumnSpec("deletes", "Deletes", INTEGER, 0.9, total="sum"),
    ColumnSpec("exports", "Exports", INTEGER, 0.9, total="sum"),
    ColumnSpec("other", "Other", INTEGER, 0.8, total="sum"),
    ColumnSpec("firstAt", "First Event", DATETIME, 1.3),
    ColumnSpec("lastAt", "Last Event", DATETIME, 1.3),
)

register(ReportSpec(
    id="audit-summary",
    title="Audit Summary",
    description="Counts of audit events by user, module or day with the action split.",
    category="admin",
    icon="BarChart3",
    tags=("audit", "activity summary", "most active", "logins"),
    family="audit",
    variant="Summary",
    super_admin_only=True,
    filters=(
        date_range("thisMonth", label="Date range", max_days=92),
        select("groupBy", "Group by", _GROUPS, default="user"),
        branches(),
    ),
    columns=_SUMMARY_COLUMNS,
    run=_run_audit_summary,
))
