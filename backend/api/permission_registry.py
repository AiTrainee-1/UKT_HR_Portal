"""
The HR portal's permission rules: the tree of keys (from permission_tree.py), how a key's level is worked out, and which
API paths each key guards (URL_MODULE_MAP + URL_PATTERNS, enforced by permission_middleware.py).

Role.permissions stays a flat {key: "hidden" | "view" | "edit"} dict. resolve_permission() gives it its hierarchy: a key
with no entry follows its dotted parent ("payroll.issues" follows "payroll"), or the key named in its `inherits` (Settings
-> ID Card follows the ID Cards page, as it always did), and a chain with no entry at all is "hidden" (fail closed). Only
keys that need a different level are stored, so a role made before a part got its own key keeps exactly the access it had.

The tree, the API prefixes of each key and the portal addresses are written once, in permission_tree.py; the portal reads
the same tree from frontend/src/lib/permission-tree.json. tests_permission_tree.py proves (1) every API path an HR login
can call maps to a key or is on its commented allowlist, (2) every /hr address maps to a key or is allowlisted, and
(3) every role keeps exactly the level it had on every API path and every address (tests_permission_snapshot.py is the
frozen copy of the rules before the full tree).
"""

from __future__ import annotations

import re

from .permission_tree import build_key_tree, inherits_map, url_entries, url_patterns, view_checked_keys

# [{"key", "label", "children": [...]}]: every key a role can be given, by key (a dotted key under its dotted parent).
MODULE_TREE: list[dict] = build_key_tree()

# key -> the key it follows when unset (instead of its dotted parent): permission_tree.py `inherits`.
INHERITS: dict[str, str] = inherits_map()

# Keys the API view checks itself (a settings field group, a Requests kind, a report group): permission_tree.py `viewCheck`.
VIEW_CHECKED_KEYS: frozenset[str] = view_checked_keys()


def all_module_keys() -> list[str]:
    """Every key in the tree, parents before children."""
    keys: list[str] = []

    def walk(nodes):
        for node in nodes:
            keys.append(node["key"])
            walk(node.get("children", []))

    walk(MODULE_TREE)
    return keys


# ── the Managing Director's working access ──────────────────────────────────────────────────────────────────────────────
#
# The MD portal (/md/*) reproduces these HR pages in full (Dashboard, Employees, Branches, Staff/Production Attendance,
# Geo Attendance, Attendance Search, Report Log, Outpass / Visitors / Tea Break, Manage Shift, Leave & Holiday, Requests)
# with the AI and visual extras on top, and the MD works in them like a super administrator does (except for the requests
# the MD only views: MD_VIEW_ONLY). That needs the same API access, so the MD account is given this access on exactly these
# modules, whatever its role says (a role can add more; it can never take these away). It is not a super administrator:
# every module not listed keeps following the role.
#
# One place to change it: set a level to "view" to make the MD's copy of a module read-only, or remove a key to take the
# module away. See md-portal.md section 10.
MD_HR_GRANTS: dict[str, str] = {
    # the fourteen pages
    "dashboard": "edit",
    "employees": "edit",
    "employees.departments": "edit",
    "employees.designations": "edit",
    "employees.branches": "edit",
    "attendance": "edit",
    "geo_attendance": "edit",
    "outpass_visitors": "edit",
    "shifts": "edit",
    # The MD only LOOKS at leave, permission and outpass requests, holidays and leave types: see MD_VIEW_ONLY below.
    "leave": "view",
    "requests": "view",
    # what the pages above read or approve through other modules (the Requests page decides leave, permission, casual-leave,
    # missing-punch, outpass and advance requests; the Dashboard counts them). See md-portal.md section 10 for the audit.
    "casual_leave": "edit",
    "missing_punch": "edit",
    "settlement": "edit",
    "notifications": "view",
    "recruitment": "view",
}

# Modules the Managing Director may only VIEW (2026-10-10, the product owner: "the MD only needs to view those requests"):
# the Leave & Holiday and Requests pages show leave, permission and outpass requests but the MD does not approve, reject,
# edit or delete them; HR and the department heads decide. Unlike a grant this is a CAP: a role on the MD account that says
# "edit" is lowered to "view" for these modules AND every part of them (a tab set to "edit" on its own is capped too), so
# nothing but this list decides it. To give the decisions back, remove a key here and set it to "edit" in MD_HR_GRANTS.
MD_VIEW_ONLY: frozenset[str] = frozenset({"leave", "requests"})

_LEVEL_RANK = {"hidden": 0, "view": 1, "edit": 2}


def _is_part_of(key: str, parent: str) -> bool:
    return key.startswith(parent + ".")


def apply_module_overrides(permissions: dict, overrides: dict) -> dict:
    """The role's {module: level} with an account's own changes on top. A change on a section is a change of the whole
    section: every part of it (its dotted keys) follows it, unless the account has a change of its own for that part
    too. (The Account Management screen also writes the parts that follow another key: Settings -> ID Card ...)"""
    out = dict(permissions)
    for key in sorted(overrides, key=lambda k: k.count(".")):  # sections before their parts
        out[key] = overrides[key]
        for part in [k for k in out if _is_part_of(k, key) and k not in overrides]:
            out.pop(part, None)
    return out


def effective_permissions(hr_user) -> dict:
    """What an HR account may do in each module: its role's permissions, the account's own changes (HR Manager / HR
    Assistant accounts, hr_access.py) and, for the Managing Director, MD_HR_GRANTS.

    A grant only ever raises a level, except that MD_VIEW_ONLY modules are held at "view". The result is a flat
    {module key: level} dict like Role.permissions, so every consumer (the permission middleware, /auth/me, the per-view
    checks) reads it the same way."""
    permissions = dict((hr_user.role.permissions if hr_user is not None and hr_user.role else {}) or {})
    if hr_user is not None and getattr(hr_user, "permission_overrides", None):
        from .hr_access import overrides_of  # (imports this module)

        changes = overrides_of(hr_user)["modules"]
        if changes:
            permissions = apply_module_overrides(permissions, changes)
    if hr_user is None or not getattr(hr_user, "is_md", False) or not getattr(hr_user, "is_active", True):
        return permissions
    for key, level in MD_HR_GRANTS.items():
        if _LEVEL_RANK[level] > _LEVEL_RANK.get(resolve_permission(permissions, key), 0):
            permissions[key] = level
    for key in MD_VIEW_ONLY:
        if _LEVEL_RANK.get(resolve_permission(permissions, key), 0) > _LEVEL_RANK["view"]:
            permissions[key] = "view"
        for part in [k for k in permissions if _is_part_of(k, key)]:
            if _LEVEL_RANK.get(permissions[part], 0) > _LEVEL_RANK["view"]:
                permissions[part] = "view"
    return permissions


def resolve_permission(permissions: dict, key: str) -> str:
    """
    The level of `key`: its own entry, else the entry of the key it follows -its `inherits` key when it has one
    (permission_tree.py), else its dotted parent ("employees.departments" -> "employees")- and so on up. "hidden" when
    nothing on the way is set (fail closed).
    """
    seen: set[str] = set()
    current = key
    while current and current not in seen:
        seen.add(current)
        if current in permissions:
            return permissions[current]
        current = INHERITS.get(current) or current.rpartition(".")[0]
    return "hidden"


def legacy_module(key: str) -> str:
    """The key that governed `key`'s part of the portal before it had a setting of its own (it follows that key while
    unset): Biometric Connectors -> attendance, Settings -> ID Card -> id_cards. Activity Logs files changes under it."""
    current = key
    while current:
        if current in INHERITS:
            return legacy_module(INHERITS[current])
        current = current.rpartition(".")[0]
    return key


# Longest-prefix match against the request path with the "/api/" prefix
# stripped (e.g. "employees/12/status" for GET /api/employees/12/status).
# Paths not covered here (auth, manager/mobile endpoints, roles/hr-users which
# are super-admin-only regardless of this table ...) are left ungated: the
# allowlist in tests_permission_tree.py names every one and why. The prefixes
# of the parts that have keys of their own (tabs, sub-tabs, features) are
# written beside their node in permission_tree.py and merged in below.
_BASE_URL_MODULE_MAP: dict[str, str] = {
    "dashboard/": "dashboard",

    "employees": "employees",

    "departments": "employees.departments",
    "designations": "employees.designations",
    "branches": "employees.branches",

    "shifts": "shifts",
    "shift-assignments": "shifts",

    "leave-requests": "leave",

    "casual-leaves": "casual_leave",

    "missing-punch-requests": "missing_punch",

    "employee-requests": "requests",
    "permissions": "requests",
    "outpass-requests": "requests",
    # The Requests page's unified list, its HoD's and its Notify tabs are requests.list / .hods / .notify
    # (permission_tree.py). Viewing needs the page; changing the (company-wide) schedule and sending need edit (the
    # preview only reads: READ_ONLY_POST_PATHS).

    "promotions": "promotion",

    "increments": "increment",

    "idcard": "id_cards",
    "verify-employee": "id_cards",

    "recruitment/new-joinees": "recruitment.new_joinees",
    "recruitment/resignations": "recruitment.resignations",
    "recruitment/department-headcount": "recruitment.required_roles",
    "recruitment/resume-screening": "recruitment.resume_screening",
    "recruitment/employee-documents": "recruitment.documents",
    "interviews": "recruitment.interviews",
    "recruitment": "recruitment",
    # The Interviews page's job postings and applicants: the Recruitment section's (a role could always be given the
    # Interviews page apart from them, so they cannot move under it without changing what such a role may call).
    "jobs": "recruitment",
    "applicants": "recruitment",

    "salary-records": "salary",

    "advances": "settlement",

    "salary-slips": "salary_slip",

    "reports/": "reports",

    "attendance": "attendance",
    "biometric/punch": "attendance",
    "attendance-logs": "attendance",
    "work-sessions": "attendance",
    "session-configs": "attendance",

    # Employee-facing geo-punch/live-location routes (attendance/geo-punch*,
    # live-location/ping) are called with employee tokens, not HR ones, so
    # HrPermissionMiddleware never gates them regardless of this table (it
    # only checks role=="hr"). The HR-dashboard-facing routes are the Geo
    # Attendance tabs' (permission_tree.py).

    # Geo-Tracking (api/geo_tracking/): the journey history and the live feed are Geo Attendance tabs (permission_tree.py);
    # the geo-tracking RULES (thresholds, retention, day-end time, photos per punch, the notice) are Settings -> Attendance:
    # longest prefix wins, so "tracking/settings" resolves to settings.attendance.
    # tracking/state, /consent, /batch and /my-journeys are called with EMPLOYEE tokens, which this middleware never gates
    # (and the views answer an HR token 403); tracking/journeys/<id> is shared: the view itself scopes an employee to their
    # own tracks.
    "tracking/settings": "settings.attendance",

    # Outpass / Visitors / Tea Break: the pages and tabs are in permission_tree.py. "outpass/gate/..." / "visitor/gate/..."
    # are deliberately absent so they stay reachable with no bearer token at all (see outpass_visitor_views.py's module
    # docstring); gate-devices/login-info, /login, /scan and reception-devices/login-info, /login, /summary, /visits are
    # never called with an HR token (public, or a device's own login), so the middleware never applies to them anyway.
    # Tea Break: qr-token/my-status are employee-token calls; the rest is the Tea Break page.
    "tea-break": "outpass_visitors.tea_break",

    "payroll/production": "production_payroll",
    "payroll": "payroll",
    "compensation": "compensation",
    # Settings -> Compensation tab: the rules and switches of the OT / Compensation features. Longest prefix wins, so this
    # beats "compensation" above; "compensation/config" (the read-only copy for the page) stays under "compensation".
    "compensation/settings": "settings.compensation",
    "bonus": "bonus",

    # User Management -> HOD Assignment is user_management.hod (permission_tree.py).
    # Approval Workflow Control (a User Management sub-tab): changes who approves every kind of request, so it has its own
    # permission. "approval-summary" (the pipelines, read-only, for the apps) is deliberately left ungated.
    "approval-workflows": "user_management.approval_workflow",

    "audit-logs": "activity_logs",

    "login-sessions": "login_devices",

    # Mobile App Login: its tabs are in permission_tree.py. "mobile-app/latest-version" is deliberately absent: the
    # employee app reads it with no login at all.

    "whatsapp-control": "whatsapp_control",

    # SMS Control (one-time codes by SMS through 2Factor): view for the GETs, edit for the PUT and the test POST.
    "sms-control": "sms_control",

    "gmail-control": "gmail_control",

    "chat": "chat",

    "notifications": "notifications",

    # "payroll-settings" (Settings → Company/Attendance/Payroll/Salary Slip/
    # SMTP tabs) is deliberately absent here -those tabs write to one
    # shared PayrollSettings record via one endpoint, so a single URL-level
    # module_key can't separate them. payroll_settings_view() does its own
    # per-field settings.* permission check instead (see FIELD_GROUPS in
    # payroll_views.py). GET stays in ALWAYS_READABLE_GET_PREFIXES below,
    # same as before.
    "biometric-devices": "settings.devices",
    "document-settings": "settings.documents",
    "backup": "settings.backup",
    "whatsapp": "settings.whatsapp",
}


def _merged_url_map() -> dict[str, str]:
    tree = url_entries()
    clash = {p: (_BASE_URL_MODULE_MAP[p], k) for p, k in tree.items() if p in _BASE_URL_MODULE_MAP}
    if clash:
        raise ValueError(f"API prefixes mapped twice (permission_tree.py and URL_MODULE_MAP): {clash}")
    return {**_BASE_URL_MODULE_MAP, **tree}


URL_MODULE_MAP: dict[str, str] = _merged_url_map()

# API paths with an id in the middle (employees/12/offer-letter/pdf): a full match wins over every prefix above.
URL_PATTERNS: list[tuple[re.Pattern, str]] = url_patterns()


# POST endpoints that only READ (their input is too structured for a query string) and write nothing: a role that may
# only VIEW the module can call them, like a GET. Paths relative to /api/, exact. Everything else a POST does is a change.
READ_ONLY_POST_PATHS: frozenset[str] = frozenset({"production-shift-rules/preview", "hr/hod-reminders/preview"})


def resolve_module(path: str) -> str | None:
    """
    path is the request path relative to /api/, e.g. 'employees/12/status'.
    A URL_PATTERNS full match wins; otherwise the longest URL_MODULE_MAP prefix, matched on path-segment boundaries
    (never a bare substring), so e.g. "recruitment/resignations" resolves to the submodule rather than the parent
    "recruitment".
    """
    clean = path.rstrip("/")
    for pattern, module_key in URL_PATTERNS:
        if pattern.fullmatch(clean):
            return module_key
    best_match = None
    best_len = -1
    for raw_prefix, module_key in URL_MODULE_MAP.items():
        prefix = raw_prefix.rstrip("/")
        if (path == prefix or path.startswith(prefix + "/")) and len(prefix) > best_len:
            best_match = module_key
            best_len = len(prefix)
    return best_match
