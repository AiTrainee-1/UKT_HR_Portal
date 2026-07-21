import type { PermissionLevel } from "@/lib/api-client/custom-hooks";

/**
 * Canonical module/submodule tree — must mirror backend/api/permission_registry.py
 * MODULE_TREE key-for-key. Submodules only exist where the backend can
 * actually enforce them separately (distinct REST endpoints) — see the note
 * in permission_registry.py for why e.g. Attendance's tabs aren't split.
 */
export type ModuleNode = { key: string; label: string; children?: ModuleNode[] };

export const MODULE_TREE: ModuleNode[] = [
  { key: "dashboard", label: "Dashboard" },
  {
    key: "employees", label: "Employees", children: [
      { key: "employees.departments", label: "Departments" },
      { key: "employees.designations", label: "Designations" },
      { key: "employees.branches", label: "Manage Branch" },
    ],
  },
  { key: "attendance", label: "Attendance" },
  { key: "shifts", label: "Manage Shift" },
  { key: "leave", label: "Leave & Holiday" },
  { key: "casual_leave", label: "Casual Leave" },
  { key: "requests", label: "Requests" },
  { key: "promotion", label: "Promotion" },
  { key: "increment", label: "Increment" },
  { key: "bonus", label: "Bonus" },
  { key: "id_cards", label: "ID Cards" },
  {
    key: "recruitment", label: "Recruitment", children: [
      { key: "recruitment.resignations", label: "Resignations" },
      { key: "recruitment.required_roles", label: "Required Roles" },
      { key: "recruitment.interviews", label: "Interviews" },
      { key: "recruitment.resume_screening", label: "Resume Screening" },
    ],
  },
  { key: "payroll", label: "Payroll" },
  { key: "salary", label: "Salary" },
  { key: "salary_slip", label: "Salary Slip" },
  { key: "settlement", label: "Settlement" },
  { key: "reports", label: "Reports" },
  { key: "user_management", label: "User Management" },
  { key: "activity_logs", label: "Activity Logs" },
  { key: "chat", label: "Chat" },
  { key: "notifications", label: "Notifications" },
  { key: "night_shift", label: "Night Shift" },
  { key: "settings", label: "Settings" },
];

export function allModuleKeys(): string[] {
  const keys: string[] = [];
  for (const node of MODULE_TREE) {
    keys.push(node.key);
    for (const child of node.children ?? []) keys.push(child.key);
  }
  return keys;
}

/**
 * Walks a dotted key ("employees.departments") from most specific to least
 * specific, returning the first explicit entry found — a child with no
 * override inherits its parent's level. Defaults to "hidden" (fail closed).
 * Mirrors backend/api/permission_registry.py::resolve_permission exactly.
 */
export function resolvePermission(
  permissions: Record<string, PermissionLevel> | undefined,
  key: string,
): PermissionLevel {
  if (!permissions) return "hidden";
  const parts = key.split(".");
  for (let i = parts.length; i > 0; i--) {
    const candidate = parts.slice(0, i).join(".");
    if (candidate in permissions) return permissions[candidate];
  }
  return "hidden";
}

/** Frontend HR route -> module_key mapping (dotted for real submodules). */
export const ROUTE_MODULE_MAP: Record<string, string> = {
  "/hr/dashboard": "dashboard",
  "/hr/employees": "employees",
  "/hr/departments": "employees.departments",
  "/hr/designations": "employees.designations",
  "/hr/branches": "employees.branches",
  "/hr/attendance": "attendance",
  "/hr/shifts": "shifts",
  "/hr/leave": "leave",
  "/hr/casual-leave": "casual_leave",
  "/hr/requests": "requests",
  "/hr/promotion": "promotion",
  "/hr/increment": "increment",
  "/hr/bonus": "bonus",
  "/hr/id-cards": "id_cards",
  "/hr/recruitment/resignations": "recruitment.resignations",
  "/hr/recruitment/required-roles": "recruitment.required_roles",
  "/hr/recruitment/resume-screening": "recruitment.resume_screening",
  "/hr/interviews": "recruitment.interviews",
  "/hr/recruitment": "recruitment",
  "/hr/payroll": "payroll",
  "/hr/salary": "salary",
  "/hr/salary-slip": "salary_slip",
  "/hr/settlement": "settlement",
  "/hr/reports": "reports",
  "/hr/user-management": "user_management",
  "/hr/activity-logs": "activity_logs",
  "/hr/chat": "chat",
  "/hr/notifications": "notifications",
  "/hr/night-shift": "night_shift",
  "/hr/settings": "settings",
};

export function moduleForPath(path: string): string | null {
  let best: string | null = null;
  let bestLen = -1;
  for (const [prefix, moduleKey] of Object.entries(ROUTE_MODULE_MAP)) {
    if ((path === prefix || path.startsWith(prefix + "/")) && prefix.length > bestLen) {
      best = moduleKey;
      bestLen = prefix.length;
    }
  }
  return best;
}

// Flat label lookup, used where a plain module_key -> display name is needed.
export const MODULE_LABELS: Array<{ key: string; label: string }> = MODULE_TREE.flatMap((node) => [
  { key: node.key, label: node.label },
  ...(node.children ?? []).map((c) => ({ key: c.key, label: c.label })),
]);
