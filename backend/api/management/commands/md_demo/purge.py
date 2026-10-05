"""``--purge``: remove everything the seeder created, and nothing else.

Two independent ways to find the demo rows, used together:

* TAGS. Everything that belongs to an employee carries the employee's code (``DM-0001`` ...), HR accounts end in ``_demo``,
  demo visitors carry ``DEMO-`` in the Aadhaar field, pay runs ``DM-PR-``, and demo network addresses come from reserved
  ranges. Deleting the demo employees takes their attendance, punches, slips, leave, tea breaks ... with them (cascade).
* THE MANIFEST. The primary keys of every created row, saved next to the command after the run. It finds the rows no tag
  can (units, departments, designations, shifts, holidays, roles, gates ...). It is trusted only when it matches the database
  (the Managing Director account it was written for must still exist with the same creation time), so a manifest left over from
  an earlier database can never delete rows that merely have the same numbers.

Rows that existed before the run (the migrations' head office and leave types, anything a developer added) are never listed
in the manifest and never touched.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Callable

from django.db.models import Q

from api.models import (
    Branch,
    Department,
    Designation,
    Employee,
    GateDevice,
    GateQRCode,
    HiringRuleSet,
    Holiday,
    HRUser,
    HrLoginAttempt,
    Job,
    LeaveType,
    OutpassGateScan,
    OutpassRecord,
    AuditLog,
    PayrollRun,
    PayrollSettings,
    ReceptionDevice,
    Role,
    ScreeningCandidate,
    ShiftTemplate,
    TeaBreakRule,
    Visitor,
)

from .common import (
    CODE_PREFIX,
    DEMO_IP_PREFIXES,
    DEMO_TAG,
    QR_TOKEN_PREFIX,
    MD_USERNAME,
    RUN_CODE_PREFIX,
    USERNAME_SUFFIX,
    VISITOR_TAG,
    expand,
    manifest_path,
    read_manifest,
)

ID_CHUNK = 5000


def _ids_q(manifest: dict | None, label: str) -> Q:
    """A Q matching the primary keys the manifest recorded for ``label`` (matches nothing when there are none)."""
    runs = (manifest or {}).get("rows", {}).get(label)
    if not runs:
        return Q(pk__in=[])
    q = Q()
    ids = list(expand(runs))
    for i in range(0, len(ids), ID_CHUNK):
        q |= Q(pk__in=ids[i : i + ID_CHUNK])
    return q


def _ip_q(field: str = "ip_address") -> Q:
    q = Q()
    for prefix in DEMO_IP_PREFIXES:
        q |= Q(**{f"{field}__startswith": prefix})
    return q


#: (model, tag query) in the order rows must go: rows an employee's deletion would orphan first, parents last.
def _plan(manifest: dict | None) -> list[tuple[type, Q]]:
    def m(model: type) -> Q:
        return _ids_q(manifest, model._meta.label)

    return [
        (
            OutpassGateScan,
            m(OutpassGateScan)
            | Q(employee__employee_code__startswith=CODE_PREFIX)
            | Q(gate__username__startswith="dm-gate-"),
        ),
        (OutpassRecord, m(OutpassRecord) | Q(employee_code__startswith=CODE_PREFIX)),
        (Visitor, m(Visitor) | Q(aadhaar_number__startswith=VISITOR_TAG)),
        (Employee, m(Employee) | Q(employee_code__startswith=CODE_PREFIX)),
        (AuditLog, m(AuditLog) | _ip_q()),
        (HrLoginAttempt, m(HrLoginAttempt) | _ip_q()),
        (HRUser, m(HRUser) | Q(username__endswith=USERNAME_SUFFIX)),
        (Role, m(Role) | Q(description__endswith=DEMO_TAG)),
        (PayrollRun, m(PayrollRun) | Q(run_code__startswith=RUN_CODE_PREFIX)),
        (Job, m(Job) | Q(description__endswith=DEMO_TAG)),
        (ScreeningCandidate, m(ScreeningCandidate) | Q(original_filename__startswith="DM-RES-")),
        (HiringRuleSet, m(HiringRuleSet) | Q(other_requirements="Demo data")),
        (GateQRCode, m(GateQRCode) | Q(token__startswith=QR_TOKEN_PREFIX)),
        (GateDevice, m(GateDevice) | Q(username__startswith="dm-gate-")),
        (ReceptionDevice, m(ReceptionDevice) | Q(username__startswith="dm-reception-")),
        (ShiftTemplate, m(ShiftTemplate) | Q(branch__address__endswith=DEMO_TAG)),
        (Designation, m(Designation) | Q(department__description__endswith=DEMO_TAG)),
        (Department, m(Department) | Q(description__endswith=DEMO_TAG)),
        (Holiday, m(Holiday) | Q(description__endswith=DEMO_TAG)),
        (LeaveType, m(LeaveType)),
        (Branch, m(Branch) | Q(address__endswith=DEMO_TAG)),
    ]


def manifest_matches_database(manifest: dict | None, database: str) -> bool:
    """Was this manifest written for THIS database's demo data (same Managing Director account, same creation time)?"""
    if not manifest or manifest.get("database") != database:
        return False
    stamp = manifest.get("fingerprint") or {}
    try:
        created = datetime.fromisoformat(stamp["mdCreatedAt"])
        md = HRUser.objects.filter(pk=stamp["mdUserId"], username=MD_USERNAME).first()
    except (KeyError, ValueError, TypeError):
        return False
    return md is not None and md.created_at == created


def has_demo_data() -> bool:
    return (
        Employee.objects.filter(employee_code__startswith=CODE_PREFIX).exists()
        or HRUser.objects.filter(username=MD_USERNAME).exists()
    )


def purge(manifest_dir: Path, database: str, say: Callable[[str], None]) -> dict[str, int]:
    """Delete every demo row of ``database`` (the active one). Returns {model label: rows deleted}."""
    path = manifest_path(manifest_dir, database)
    manifest = read_manifest(path)
    if manifest is not None and not manifest_matches_database(manifest, database):
        say("  The saved manifest belongs to a different database state: ignored (tags only).")
        manifest = None
    elif manifest is None:
        say(
            "  No manifest found: removing by tags only (a shift of a pre-existing unit, and a leave type this run had to create, cannot be tagged)."
        )

    deleted: dict[str, int] = {}
    for model, query in _plan(manifest):
        qs = model.objects.filter(query)
        total, per_model = qs.delete()
        if total:
            deleted[model._meta.label] = per_model.get(model._meta.label, 0)
            for label, n in per_model.items():  # rows that went with it (cascade)
                if label != model._meta.label:
                    deleted[label] = deleted.get(label, 0) + n

    created: dict[str, bool] = (manifest or {}).get("singletons", {})
    if created.get("PayrollSettings"):
        deleted["api.PayrollSettings"] = PayrollSettings.objects.filter(pk=1).delete()[0]
    if created.get("TeaBreakRule"):
        deleted["api.TeaBreakRule"] = TeaBreakRule.objects.filter(pk=1).delete()[0]
    for branch_id, seq in ((manifest or {}).get("branchSeq") or {}).items():
        # give back the Unit Code numbers the run used, but only if nobody has used more since
        Branch.objects.filter(pk=int(branch_id), next_employee_seq=seq["after"]).update(next_employee_seq=seq["before"])
    if path.exists():
        path.unlink()
    return {k: v for k, v in sorted(deleted.items()) if v}


def leftover_counts() -> dict[str, int]:
    """Demo rows still present (a purge leaves none): used by the tests and the command's own check."""
    return {
        "employees": Employee.objects.filter(employee_code__startswith=CODE_PREFIX).count(),
        "accounts": HRUser.objects.filter(username__endswith=USERNAME_SUFFIX).count(),
        "visitors": Visitor.objects.filter(aadhaar_number__startswith=VISITOR_TAG).count(),
        "payrollRuns": PayrollRun.objects.filter(run_code__startswith=RUN_CODE_PREFIX).count(),
        "auditRows": AuditLog.objects.filter(_ip_q()).count(),
        "outpassRecords": OutpassRecord.objects.filter(employee_code__startswith=CODE_PREFIX).count(),
    }
