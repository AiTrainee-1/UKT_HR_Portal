"""
Canonical module/submodule tree for HR-portal permissions, and the
URL-prefix -> module_key mapping used by permission_middleware.py.

module_key values here are the single source of truth mirrored on the
frontend (frontend/src/lib/permission-modules.ts) and Account Management —
keep the two in sync when adding a new sidebar section.

Keys are dot-separated for submodules that have their own distinct API
endpoints (e.g. "employees.departments"). Role.permissions stays a flat
{key: "hidden"|"view"|"edit"} dict — resolve_permission() below is what gives
it hierarchy: setting "employees"="edit" cascades to every "employees.*"
child unless that child has its own explicit entry overriding it. This keeps
the stored JSON simple while still supporting per-submodule overrides.

Not every sidebar group has been split into submodules — only Employees and
Recruitment currently have children with genuinely separate REST endpoints
(see URL_MODULE_MAP). Others (e.g. Attendance's Staff/Production/Report Log
pages) share the same underlying endpoints distinguished by query params
rather than URL path, so the API can't enforce a per-tab split without a
view-level change; they stay single-level for now.
"""

MODULE_TREE: list[dict] = [
    {"key": "dashboard", "label": "Dashboard"},
    {"key": "employees", "label": "Employees", "children": [
        {"key": "employees.departments", "label": "Departments"},
        {"key": "employees.designations", "label": "Designations"},
        {"key": "employees.branches", "label": "Manage Branch"},
    ]},
    {"key": "attendance", "label": "Attendance"},
    {"key": "shifts", "label": "Manage Shift"},
    {"key": "leave", "label": "Leave & Holiday"},
    {"key": "casual_leave", "label": "Casual Leave"},
    {"key": "requests", "label": "Requests"},
    {"key": "promotion", "label": "Promotion"},
    {"key": "increment", "label": "Increment"},
    {"key": "bonus", "label": "Bonus"},
    {"key": "id_cards", "label": "ID Cards"},
    {"key": "recruitment", "label": "Recruitment", "children": [
        {"key": "recruitment.resignations", "label": "Resignations"},
        {"key": "recruitment.required_roles", "label": "Required Roles"},
        {"key": "recruitment.interviews", "label": "Interviews"},
        {"key": "recruitment.resume_screening", "label": "Resume Screening"},
    ]},
    {"key": "payroll", "label": "Payroll"},
    {"key": "salary", "label": "Salary"},
    {"key": "salary_slip", "label": "Salary Slip"},
    {"key": "settlement", "label": "Settlement"},
    {"key": "reports", "label": "Reports"},
    {"key": "user_management", "label": "User Management"},
    {"key": "activity_logs", "label": "Activity Logs"},
    {"key": "chat", "label": "Chat"},
    {"key": "notifications", "label": "Notifications"},
    {"key": "night_shift", "label": "Night Shift"},
    {"key": "settings", "label": "Settings"},
]


def all_module_keys() -> list[str]:
    keys = []
    for node in MODULE_TREE:
        keys.append(node["key"])
        for child in node.get("children", []):
            keys.append(child["key"])
    return keys


def resolve_permission(permissions: dict, key: str) -> str:
    """
    Walks a dotted key ("employees.departments") from most specific to least
    specific, returning the first explicit entry found — so a child with no
    override inherits its parent's level. Defaults to "hidden" if nothing in
    the chain is set (fail closed).
    """
    parts = key.split(".")
    for i in range(len(parts), 0, -1):
        candidate = ".".join(parts[:i])
        if candidate in permissions:
            return permissions[candidate]
    return "hidden"


# Longest-prefix match against the request path with the "/api/" prefix
# stripped (e.g. "employees/12/status" for GET /api/employees/12/status).
# Paths not covered here (auth, dashboard summaries, manager/mobile endpoints,
# roles/hr-users which are super-admin-only regardless of this table) are left
# ungated — only the modules above are subject to hidden/view/edit.
URL_MODULE_MAP: dict[str, str] = {
    "dashboard/": "dashboard",

    "employees": "employees",

    "departments": "employees.departments",
    "designations": "employees.designations",
    "branches": "employees.branches",

    "shifts": "shifts",
    "shift-assignments": "shifts",

    "leave-types": "leave",
    "leave-balances": "leave",
    "holidays": "leave",
    "leave-requests": "leave",

    "casual-leaves": "casual_leave",

    "employee-requests": "requests",
    "permissions": "requests",

    "promotions": "promotion",

    "increments": "increment",

    "idcard": "id_cards",
    "idcard-settings": "id_cards",
    "verify-employee": "id_cards",

    "recruitment/resignations": "recruitment.resignations",
    "recruitment/department-headcount": "recruitment.required_roles",
    "recruitment/resume-screening": "recruitment.resume_screening",
    "interviews": "recruitment.interviews",
    "recruitment": "recruitment",
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

    "night-shift": "night_shift",

    "payroll": "payroll",

    "department-managers": "user_management",

    "audit-logs": "activity_logs",

    "chat": "chat",

    "notifications": "notifications",

    "payroll-settings": "settings",
    "biometric-devices": "settings",
    "production-shift-config": "settings",
    "production-shift-segments": "settings",
    "backup": "settings",
}


def resolve_module(path: str) -> str | None:
    """
    path is the request path relative to /api/, e.g. 'employees/12/status'.
    Matches on path-segment boundaries (never a bare substring), and prefers
    the longest/most-specific match so e.g. "recruitment/resignations"
    resolves to the submodule rather than the parent "recruitment".
    """
    best_match = None
    best_len = -1
    for raw_prefix, module_key in URL_MODULE_MAP.items():
        prefix = raw_prefix.rstrip("/")
        if (path == prefix or path.startswith(prefix + "/")) and len(prefix) > best_len:
            best_match = module_key
            best_len = len(prefix)
    return best_match
