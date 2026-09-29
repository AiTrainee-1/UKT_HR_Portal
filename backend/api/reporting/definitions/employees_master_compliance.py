"""Compliance and data-quality reports on the employee master: statutory / KYC gaps, data-quality audit,
age verification and family dependents.

Owner: group ``employees_master``. The statutory report is the ONLY place PF / ESI / UAN numbers and bank
details are printed; bank account and ID-proof values are always masked to their last four characters.
"""

from __future__ import annotations

import re
from collections import Counter, defaultdict

from django.db.models import Count, Sum

from api.branch_scope import scope_to_branch

from .. import filters as F
from ..registry import register
from ..types import (
    BADGE,
    DATE,
    INTEGER,
    TEXT,
    ColumnSpec,
    ReportResult,
    ReportSpec,
)
from .employees_master_base import (
    age_on,
    blank,
    blood_group_of,
    clean,
    code_key,
    department_name,
    document_map,
    employees_qs,
    gender_bucket,
    gender_label,
    is_active,
    join_date_of,
    mask_tail,
    status_label,
    type_label,
)

CATEGORY = "employees"


def _person_name(emp) -> str:
    return f"{emp.first_name or ''} {emp.last_name or ''}".strip()


def _norm_id(value) -> str:
    """Identifier for equality / format checks: no spaces or hyphens, upper case."""
    return re.sub(r"[\s\-]+", "", str(value)).upper() if value is not None else ""


def _phone_digits(value) -> str:
    """Ten-digit Indian mobile from '+91 98765-43210', '098765 43210' etc. (other lengths are returned as-is)."""
    digits = re.sub(r"\D", "", str(value or ""))
    if len(digits) == 12 and digits.startswith("91"):
        return digits[2:]
    if len(digits) == 11 and digits.startswith("0"):
        return digits[1:]
    return digits


def _shared_with(mapping: dict, key, own_id) -> str | None:
    """Codes of the OTHER employees holding ``key`` (up to two), or None."""
    others = [code for emp_id, code in mapping.get(key, ()) if emp_id != own_id]
    return ", ".join(others[:2]) + (f" +{len(others) - 2} more" if len(others) > 2 else "") if others else None


def _index(rows, value_of) -> dict:
    """{value: [(employee_id, employee_code), ...]} over rows, ignoring blanks; only repeated values matter."""
    out: dict = defaultdict(list)
    for row in rows:
        v = value_of(row)
        if v:
            out[v].append((row[0], row[1]))
    return {k: v for k, v in out.items() if len(v) > 1}


# ═════════════════════════════════════════════════════════════════════════════
# statutory-compliance
# ═════════════════════════════════════════════════════════════════════════════

_IFSC = re.compile(r"^[A-Z]{4}0[A-Z0-9]{6}$")
_ACCOUNT = re.compile(r"^\d{9,18}$")
_UAN = re.compile(r"^\d{12}$")
_ESI = re.compile(r"^(\d{10}|\d{17})$")

STAT_ISSUE_OPTIONS = (
    ("missing_pf", "PF number missing"),
    ("missing_esi", "ESI number missing"),
    ("missing_uan", "UAN missing"),
    ("missing_bank", "Bank account / IFSC missing"),
    ("invalid_format", "Number in wrong format (IFSC, account, UAN, ESI)"),
    ("no_aadhaar_doc", "Aadhaar document not uploaded"),
    ("no_pan_doc", "PAN document not uploaded"),
    ("no_passbook_doc", "Bank passbook not uploaded"),
    ("duplicate_id", "Number used by another active employee"),
    ("deducted_no_number", "PF / ESI deducted but number missing"),
)
STAT_COLUMNS = (
    ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
    ColumnSpec("employeeName", "Employee", TEXT, 2.0),
    ColumnSpec("department", "Department", TEXT, 1.3),
    ColumnSpec("employmentType", "Type", BADGE, 0.9),
    ColumnSpec("pfNumber", "PF Number", TEXT, 1.6),
    ColumnSpec("esiNumber", "ESI Number", TEXT, 1.3),
    ColumnSpec("uanNumber", "UAN", TEXT, 1.3),
    ColumnSpec("bankName", "Bank", TEXT, 1.3),
    ColumnSpec("bankAccount", "Bank A/c (last 4)", TEXT, 1.4),
    ColumnSpec("bankIfsc", "IFSC", TEXT, 1.2),
    ColumnSpec("idProof", "ID Proof (last 4)", TEXT, 1.3),
    ColumnSpec("aadhaarDoc", "Aadhaar Doc", BADGE, 0.8),
    ColumnSpec("panDoc", "PAN Doc", BADGE, 0.8),
    ColumnSpec("passbookDoc", "Passbook Doc", BADGE, 0.8),
    ColumnSpec("pfDeducted", "PF Deducted", BADGE, 0.8),
    ColumnSpec("esiDeducted", "ESI Deducted", BADGE, 0.8),
    ColumnSpec("issueCount", "Issues", INTEGER, 0.6),
    ColumnSpec("issues", "What Needs Fixing", TEXT, 3.0),
)
_DOC_AADHAAR, _DOC_PAN, _DOC_PASSBOOK = "aadhaar_card", "pan_card", "bank_passbook"


def _yes_no(flag: bool | None) -> str | None:
    return None if flag is None else ("Yes" if flag else "No")


def _statutory_run(ctx) -> ReportResult:
    from api.models import Employee, SalarySlip

    issue_filter = ctx.params.get("issue")
    include_ok = bool(ctx.params.get("includeCompliant"))
    period = ctx.period
    emps = list(employees_qs(ctx))
    emps.sort(key=lambda e: code_key(e.employee_code))
    ids = [e.id for e in emps]

    docs = document_map(ids, (_DOC_AADHAAR, _DOC_PAN, _DOC_PASSBOOK)) if ids else {}

    # Duplicates are looked for across ALL active employees the user may see (a department filter must not hide
    # a clash with someone in another department). An inactive employee is never flagged: a rejoiner legitimately
    # keeps the old PF / UAN / bank account.
    pool = list(
        scope_to_branch(Employee.objects.filter(status="active"), ctx.request).values_list(
            "id", "employee_code", "pf_number", "esi_number", "uan_number", "bank_account"
        )
    )
    dup = {
        "PF number": _index(pool, lambda r: _norm_id(r[2])),
        "ESI number": _index(pool, lambda r: _norm_id(r[3])),
        "UAN": _index(pool, lambda r: _norm_id(r[4])),
        "Bank account": _index(pool, lambda r: _norm_id(r[5])),
    }

    deducted: dict[int, dict] = {}
    if period and ids:
        year, month = period
        for row in (
            SalarySlip.objects.filter(year=year, month=month, employee_id__in=ids)
            .order_by()
            .values("employee_id")
            .annotate(pf=Sum("pf_deduction"), esi=Sum("esi_deduction"), n=Count("id"))
        ):
            deducted[row["employee_id"]] = row

    rows = []
    counter: Counter = Counter()
    for e in emps:
        pf, esi, uan = clean(e.pf_number), clean(e.esi_number), clean(e.uan_number)
        account, ifsc = clean(e.bank_account), clean(e.bank_ifsc)
        present = docs.get(e.id, set())
        slip = deducted.get(e.id)
        pf_ded = None if slip is None else (slip["pf"] or 0) > 0
        esi_ded = None if slip is None else (slip["esi"] or 0) > 0

        found: list[tuple[str, str]] = []  # (issue code, text)
        if pf is None:
            found.append(("missing_pf", "PF number missing"))
        if esi is None:
            found.append(("missing_esi", "ESI number missing"))
        if uan is None:
            found.append(("missing_uan", "UAN missing"))
        if account is None or ifsc is None:
            what = (
                "account number and IFSC"
                if account is None and ifsc is None
                else "account number"
                if account is None
                else "IFSC"
            )
            found.append(("missing_bank", f"Bank {what} missing"))
        if ifsc is not None and not _IFSC.match(_norm_id(ifsc)):
            found.append(("invalid_format", "IFSC format is invalid"))
        if account is not None and not _ACCOUNT.match(_norm_id(account)):
            found.append(("invalid_format", "Bank account should be 9-18 digits"))
        if uan is not None and not _UAN.match(_norm_id(uan)):
            found.append(("invalid_format", "UAN should be 12 digits"))
        if esi is not None and not _ESI.match(_norm_id(esi)):
            found.append(("invalid_format", "ESI number should be 10 (or 17) digits"))
        for code, label in ((_DOC_AADHAAR, "Aadhaar"), (_DOC_PAN, "PAN"), (_DOC_PASSBOOK, "Bank passbook")):
            if code not in present:
                key = {"aadhaar_card": "no_aadhaar_doc", "pan_card": "no_pan_doc", "bank_passbook": "no_passbook_doc"}[
                    code
                ]
                found.append((key, f"{label} document not uploaded"))
        if is_active(e):
            for label, value in (("PF number", pf), ("ESI number", esi), ("UAN", uan), ("Bank account", account)):
                other = _shared_with(dup[label], _norm_id(value), e.id) if value else None
                if other:
                    found.append(("duplicate_id", f"{label} also used by {other}"))
        if pf is None and pf_ded:
            found.append(("deducted_no_number", "PF deducted in payroll but no PF number"))
        if esi is None and esi_ded:
            found.append(("deducted_no_number", "ESI deducted in payroll but no ESI number"))

        codes = {c for c, _t in found}
        counter.update(codes)
        counter["checked"] += 1
        counter["clean"] += not found
        row = {
            "employeeCode": e.employee_code,
            "employeeName": _person_name(e),
            "department": department_name(e),
            "employmentType": type_label(e.employment_type),
            "pfNumber": pf,
            "esiNumber": esi,
            "uanNumber": uan,
            "bankName": clean(e.bank_name),
            "bankAccount": mask_tail(account),
            "bankIfsc": ifsc.upper() if ifsc else None,
            "idProof": mask_tail(e.id_proof),
            "aadhaarDoc": _yes_no(_DOC_AADHAAR in present),
            "panDoc": _yes_no(_DOC_PAN in present),
            "passbookDoc": _yes_no(_DOC_PASSBOOK in present),
            "pfDeducted": _yes_no(pf_ded),
            "esiDeducted": _yes_no(esi_ded),
            "issueCount": len(found),
            "issues": "; ".join(t for _c, t in found) or None,
        }
        if issue_filter:
            keep = issue_filter in codes
        else:
            keep = include_ok or bool(found)
        if keep:
            rows.append(row)

    checked = counter["checked"]
    summary = [
        {"label": "Employees checked", "value": checked, "format": "integer"},
        {"label": "Fully compliant", "value": counter["clean"], "format": "integer"},
        {"label": "PF number missing", "value": counter["missing_pf"], "format": "integer"},
        {"label": "ESI number missing", "value": counter["missing_esi"], "format": "integer"},
        {"label": "UAN missing", "value": counter["missing_uan"], "format": "integer"},
        {"label": "Bank details missing", "value": counter["missing_bank"], "format": "integer"},
        {"label": "Deducted, number missing", "value": counter["deducted_no_number"], "format": "integer"},
        {"label": "Completeness", "value": round(counter["clean"] * 100 / checked, 1) if checked else None, "format": "percent"},
    ]  # fmt: skip
    notes = [
        "Bank account and ID proof are masked to their last four characters. PF / ESI / UAN numbers are shown in full: "
        "this is the only report that prints them.",
        "PF and ESI numbers are only required for employees the scheme covers (it depends on payroll settings and wage "
        "ceilings), so a missing number is a gap to check, not always a breach. 'Deducted' comes from the generated "
        "salary slips"
        + (f" of {period[1]:02d}/{period[0]}" if period else "")
        + "; a blank means no slip exists for that month.",
        "The app stores no Aadhaar or PAN numbers: the Aadhaar / PAN / passbook columns show whether a document has "
        "been uploaded (its content is not verified).",
        "Duplicate numbers are looked for among active employees only.",
    ]
    if checked and counter["missing_uan"] * 10 > checked * 9:
        notes.append(
            "UAN cannot currently be entered in the app (there is no field for it in the employee form or bulk upload), "
            "so a missing UAN here is a data-capture gap, not an employee omission."
        )
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(ReportSpec(
    id="statutory-compliance",
    title="Statutory & KYC Compliance",
    description="PF, ESI, UAN, bank and KYC-document gaps, wrong-format numbers and duplicates - masked where sensitive.",
    category=CATEGORY,
    modules=("payroll", "salary", "employees"),
    icon="ShieldCheck",
    tags=("pf", "esi", "uan", "bank", "kyc", "aadhaar", "pan", "statutory", "compliance", "ifsc"),
    filters=(
        F.period(default="lastMonth", label="Payroll month (deduction check)", required=False),
        *F.scope(status="active"),
        F.select("issue", "Show employees with", STAT_ISSUE_OPTIONS, placeholder="Any issue"),
        F.boolean("includeCompliant", "Include fully compliant employees"),
    ),
    columns=STAT_COLUMNS,
    run=_statutory_run,
))  # fmt: skip


# ═════════════════════════════════════════════════════════════════════════════
# data-quality-audit
# ═════════════════════════════════════════════════════════════════════════════

DQ_CHECKS = (
    ("dob", "Date of birth"),
    ("gender", "Gender"),
    ("phone", "Phone"),
    ("address", "Address"),
    ("join_date", "Join date"),
    ("org_unit", "Department / designation / branch"),
    ("salary", "Salary set-up"),
    ("profile", "Father's name, blood group, emergency contact"),
    ("duplicates", "Duplicate people"),
    ("code", "Employee code format"),
)
DQ_COLUMNS = (
    ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
    ColumnSpec("employeeName", "Employee", TEXT, 2.0),
    ColumnSpec("department", "Department", TEXT, 1.4),
    ColumnSpec("employmentType", "Type", BADGE, 0.9),
    ColumnSpec("status", "Status", BADGE, 0.8),
    ColumnSpec("joinDate", "Join Date (as entered)", TEXT, 1.2),
    ColumnSpec("dateOfBirth", "Date of Birth", DATE, 1.1),
    ColumnSpec("phone", "Phone (as entered)", TEXT, 1.3),
    ColumnSpec("issueCount", "Issues", INTEGER, 0.6),
    ColumnSpec("issues", "What Needs Fixing", TEXT, 3.6),
)


def _quality_run(ctx) -> ReportResult:
    from api.models import Employee

    today = ctx.today
    wanted = set(ctx.params.get("check") or []) or {k for k, _l in DQ_CHECKS}
    include_clean = bool(ctx.params.get("includeClean"))
    emps = list(employees_qs(ctx))
    emps.sort(key=lambda e: code_key(e.employee_code))

    phone_dup: dict = {}
    person_dup: dict = {}
    if wanted & {"phone", "duplicates"}:
        pool = list(
            scope_to_branch(Employee.objects.filter(status="active"), ctx.request).values_list(
                "id", "employee_code", "phone", "first_name", "last_name", "date_of_birth"
            )
        )
        phone_dup = _index(pool, lambda r: _phone_digits(r[2]) if len(_phone_digits(r[2])) == 10 else "")
        person_dup = _index(
            pool,
            lambda r: f"{(r[3] or '').strip().lower()}|{(r[4] or '').strip().lower()}|{r[5]}" if r[5] else "",
        )

    rows = []
    per_check: Counter = Counter()
    clean_count = 0
    for e in emps:
        found: list[tuple[str, str]] = []
        joined, join_state = join_date_of(e)
        age = age_on(e.date_of_birth, today)

        if "dob" in wanted:
            if e.date_of_birth is None:
                found.append(("dob", "Date of birth missing"))
            elif e.date_of_birth > today:
                found.append(("dob", "Date of birth is in the future"))
            else:
                if age is not None and (age < 14 or age > 80):
                    found.append(("dob", f"Age {age} looks implausible"))
                if joined and e.date_of_birth >= joined:
                    found.append(("dob", "Date of birth is not before the join date"))
        if "gender" in wanted:
            if blank(e.gender):
                found.append(("gender", "Gender not set"))
            elif gender_bucket(e.gender) == "other" and (e.gender or "").strip().lower() != "other":
                found.append(("gender", f"Gender '{e.gender.strip()}' is not recognised (use male / female / other)"))
        if "phone" in wanted:
            if blank(e.phone):
                found.append(("phone", "Phone missing"))
            else:
                digits = _phone_digits(e.phone)
                if len(digits) != 10:
                    found.append(("phone", "Phone is not a 10-digit number"))
                elif is_active(e):
                    other = _shared_with(phone_dup, digits, e.id)
                    if other:
                        found.append(("phone", f"Phone also used by {other}"))
        if "address" in wanted and blank(e.address):
            found.append(("address", "Address missing"))
        if "join_date" in wanted:
            if join_state == "missing":
                found.append(("join_date", "Join date missing"))
            elif join_state == "unreadable":
                found.append(("join_date", f"Join date '{e.join_date.strip()}' cannot be read"))
            elif joined > today:
                found.append(("join_date", "Join date is in the future"))
        if "org_unit" in wanted:
            if not e.department_id:
                found.append(("org_unit", "No department"))
            if not e.designation_id:
                found.append(("org_unit", "No designation"))
            if not e.branch_id:
                found.append(("org_unit", "No branch"))
        if "salary" in wanted:
            et = (e.employment_type or "").strip()
            if et == "staff" and not e.salary_amount:
                found.append(("salary", "Monthly salary not set"))
            elif et == "production" and not e.salary_per_shift:
                found.append(("salary", "Per-shift rate not set"))
        if "profile" in wanted:
            if blank(e.father_name):
                found.append(("profile", "Father's name missing"))
            if blank(e.blood_group):
                found.append(("profile", "Blood group missing"))
            elif blood_group_of(e.blood_group) is None:
                found.append(("profile", f"Blood group '{e.blood_group.strip()}' is not recognised"))
            if blank(e.emergency_contact):
                found.append(("profile", "Emergency contact missing"))
        if "duplicates" in wanted and is_active(e) and e.date_of_birth:
            key = f"{(e.first_name or '').strip().lower()}|{(e.last_name or '').strip().lower()}|{e.date_of_birth}"
            other = _shared_with(person_dup, key, e.id)
            if other:
                found.append(("duplicates", f"Same name and date of birth as {other}"))
        if "code" in wanted and e.employee_code != (e.employee_code or "").strip():
            found.append(("code", "Employee code has stray spaces"))

        per_check.update({c for c, _t in found})
        clean_count += not found
        if found or include_clean:
            rows.append({
                "employeeCode": e.employee_code.strip() if e.employee_code else e.employee_code,
                "employeeName": _person_name(e),
                "department": department_name(e),
                "employmentType": type_label(e.employment_type),
                "status": status_label(e.status),
                "joinDate": clean(e.join_date),
                "dateOfBirth": e.date_of_birth,
                "phone": clean(e.phone),
                "issueCount": len(found),
                "issues": "; ".join(t for _c, t in found) or None,
            })  # fmt: skip

    checked = len(emps)
    summary = [
        {"label": "Employees checked", "value": checked, "format": "integer"},
        {"label": "Clean records", "value": clean_count, "format": "integer"},
        {"label": "Records with issues", "value": checked - clean_count, "format": "integer"},
        {
            "label": "Profile completeness",
            "value": round(clean_count * 100 / checked, 1) if checked else None,
            "format": "percent",
        },
    ]
    for key, label in DQ_CHECKS:
        if key in wanted and per_check[key]:
            summary.append({"label": f"{label}: issues", "value": per_check[key], "format": "integer"})
    notes = [
        "Join date and phone are shown exactly as entered so the fix is visible. Duplicate phone / name checks look "
        "at active employees only (family members can legitimately share a phone).",
        "Blank phone numbers are common for bulk-imported employees; reporting-manager, nationality, zone and "
        "workstation are not checked because nothing in the app records them.",
    ]
    if not include_clean:
        notes.append("Only records with at least one issue are listed; tick 'Include clean records' to list everyone.")
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(ReportSpec(
    id="data-quality-audit",
    title="Employee Data Quality Audit",
    description="Missing, implausible and duplicate details in the employee master, with what to fix for each person.",
    category=CATEGORY,
    modules=("employees",),
    icon="ClipboardCheck",
    tags=("data quality", "audit", "missing", "duplicates", "cleanup", "incomplete", "validation"),
    filters=(
        *F.scope(employee=False, status="active"),
        F.select("check", "Checks to run", DQ_CHECKS, multi=True, placeholder="All checks"),
        F.boolean("includeClean", "Include clean records"),
    ),
    columns=DQ_COLUMNS,
    run=_quality_run,
))  # fmt: skip


# ═════════════════════════════════════════════════════════════════════════════
# age-compliance
# ═════════════════════════════════════════════════════════════════════════════

AGE_COLUMNS = (
    ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
    ColumnSpec("employeeName", "Employee", TEXT, 2.2),
    ColumnSpec("department", "Department", TEXT, 1.5),
    ColumnSpec("designation", "Designation", TEXT, 1.5),
    ColumnSpec("employmentType", "Type", BADGE, 0.9),
    ColumnSpec("gender", "Gender", TEXT, 0.8),
    ColumnSpec("dateOfBirth", "Date of Birth", DATE, 1.1),
    ColumnSpec("age", "Age", INTEGER, 0.5),
    ColumnSpec("joinDate", "Join Date", DATE, 1.1),
    ColumnSpec("ageAtJoining", "Age at Joining", INTEGER, 0.8),
    ColumnSpec("flag", "Flag", BADGE, 1.0),
    ColumnSpec("birthProof", "Age Proof on File", BADGE, 1.0),
)
AGE_SHOW_OPTIONS = (
    ("exceptions", "Exceptions only"),
    ("under_min", "Under minimum age"),
    ("over_max", "Over maximum age"),
    ("dob_missing", "Date of birth missing / invalid"),
    ("all", "Everyone"),
)


def _age_run(ctx) -> ReportResult:
    today = ctx.today
    min_age = ctx.param("minAge", 18)
    max_age = ctx.param("maxAge", 60)
    show = ctx.param("show", "exceptions")
    emps = list(employees_qs(ctx))
    emps.sort(key=lambda e: code_key(e.employee_code))
    proof = document_map((e.id for e in emps), ("voter_id_or_birth_certificate", "aadhaar_card")) if emps else {}

    counts: Counter = Counter()
    rows = []
    for e in emps:
        dob = e.date_of_birth
        age = age_on(dob, today)
        if dob is None:
            flag = "DOB missing"
        elif age is None:
            flag = "DOB invalid"
        elif age < min_age:
            flag = "Under age"
        elif age > max_age:
            flag = "Over age"
        else:
            flag = "OK"
        counts[flag] += 1
        keep = {
            "exceptions": flag != "OK",
            "under_min": flag == "Under age",
            "over_max": flag == "Over age",
            "dob_missing": flag in ("DOB missing", "DOB invalid"),
            "all": True,
        }[show]
        if not keep:
            continue
        joined, _state = join_date_of(e)
        rows.append({
            "employeeCode": e.employee_code,
            "employeeName": _person_name(e),
            "department": department_name(e),
            "designation": e.designation.title if e.designation_id else None,
            "employmentType": type_label(e.employment_type),
            "gender": gender_label(e.gender),
            "dateOfBirth": dob,
            "age": age,
            "joinDate": joined,
            "ageAtJoining": age_on(dob, joined) if joined else None,
            "flag": flag,
            "birthProof": "Yes" if proof.get(e.id) else "No",
        })  # fmt: skip

    summary = [
        {"label": "Under minimum age", "value": counts["Under age"], "format": "integer"},
        {"label": "Over maximum age", "value": counts["Over age"], "format": "integer"},
        {"label": "DOB missing / invalid", "value": counts["DOB missing"] + counts["DOB invalid"], "format": "integer"},
        {"label": "Total checked", "value": len(emps), "format": "integer"},
    ]
    notes = [
        f"Age is as on {today.strftime('%d-%b-%Y')}. Under age = below {min_age}; over age = above {max_age} "
        "(the maximum is a screening threshold - no retirement age is stored in the system).",
        "Age proof on file means a voter ID / birth certificate or Aadhaar document has been uploaded; the document "
        "itself is not opened or verified.",
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(ReportSpec(
    id="age-compliance",
    title="Age Verification & Compliance",
    description="Under-age, over-age and date-of-birth-missing employees with age-proof status - for buyer and factory audits.",
    category=CATEGORY,
    modules=("employees",),
    icon="BadgeCheck",
    tags=("age", "under age", "child labour", "audit", "date of birth", "compliance", "retirement"),
    filters=(
        *F.scope(employee=False, status="active"),
        F.number("minAge", "Minimum age", default=18, min=10, max=100),
        F.number("maxAge", "Maximum age", default=60, min=18, max=100),
        F.select("show", "Show", AGE_SHOW_OPTIONS, default="exceptions"),
    ),
    columns=AGE_COLUMNS,
    run=_age_run,
))  # fmt: skip


# ═════════════════════════════════════════════════════════════════════════════
# family-dependents
# ═════════════════════════════════════════════════════════════════════════════

FAMILY_COLUMNS = (
    ColumnSpec("employeeCode", "Emp Code", TEXT, 1.0),
    ColumnSpec("employeeName", "Employee", TEXT, 2.2),
    ColumnSpec("department", "Department", TEXT, 1.5),
    ColumnSpec("dependentName", "Dependent", TEXT, 2.0),
    ColumnSpec("relation", "Relation", BADGE, 0.9),
    ColumnSpec("dateOfBirth", "Date of Birth", DATE, 1.1),
    ColumnSpec("age", "Age", INTEGER, 0.5),
    ColumnSpec("isInsuranceNominee", "Insurance Nominee", BADGE, 1.0),
    ColumnSpec("coveredUnderHealthScheme", "Health Scheme", BADGE, 1.0),
)
RELATION_OPTIONS = (
    ("spouse", "Spouse"), ("child", "Child"), ("father", "Father"), ("mother", "Mother"),
    ("sibling", "Sibling"), ("other", "Other"),
)  # fmt: skip


def _family_run(ctx) -> ReportResult:
    from api.models import FamilyDependent

    today = ctx.today
    p = ctx.params
    qs = (
        FamilyDependent.objects.select_related("employee__department")
        .defer("employee__photo_url", "employee__password_hash")
        .filter(ctx.emp_q("employee__"))
    )
    if p.get("relation"):
        qs = qs.filter(relation=p["relation"])
    if p.get("nominee"):
        qs = qs.filter(is_insurance_nominee=True)
    if p.get("healthScheme"):
        qs = qs.filter(covered_under_health_scheme=True)
    deps = list(qs)
    deps.sort(key=lambda d: (code_key(d.employee.employee_code), (d.name or "").lower(), d.id))

    rows = [{
        "employeeCode": d.employee.employee_code,
        "employeeName": _person_name(d.employee),
        "department": department_name(d.employee),
        "dependentName": d.name,
        "relation": (d.relation or "").strip().title() or None,
        "dateOfBirth": d.date_of_birth,
        "age": age_on(d.date_of_birth, today),
        "isInsuranceNominee": "Yes" if d.is_insurance_nominee else "No",
        "coveredUnderHealthScheme": "Yes" if d.covered_under_health_scheme else "No",
    } for d in deps]  # fmt: skip
    summary = [
        {"label": "Dependents", "value": len(deps), "format": "integer"},
        {"label": "Employees with dependents", "value": len({d.employee_id for d in deps}), "format": "integer"},
        {"label": "Insurance nominees", "value": sum(d.is_insurance_nominee for d in deps), "format": "integer"},
        {
            "label": "Covered under health scheme",
            "value": sum(d.covered_under_health_scheme for d in deps),
            "format": "integer",
        },
    ]
    notes = [
        "Dependents cannot be added or edited from the HR portal today (employees can only view theirs in the app), "
        "so this register is empty until the records are loaded into the database.",
        "Age is as on " + today.strftime("%d-%b-%Y") + "; blank when no date of birth is stored.",
    ]
    return ReportResult(rows=rows, summary=summary, notes=notes)


register(ReportSpec(
    id="family-dependents",
    title="Family & Dependents",
    description="Dependents of each employee with insurance-nominee and health-scheme coverage flags.",
    category=CATEGORY,
    modules=("employees",),
    icon="Heart",
    tags=("family", "dependents", "nominee", "insurance", "health scheme", "esi"),
    filters=(
        *F.scope(status="active"),
        F.select("relation", "Relation", RELATION_OPTIONS, placeholder="All relations"),
        F.boolean("nominee", "Insurance nominees only"),
        F.boolean("healthScheme", "Health-scheme covered only"),
    ),
    columns=FAMILY_COLUMNS,
    run=_family_run,
))  # fmt: skip
