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
      { key: "recruitment.new_joinees", label: "New Joinees" },
      { key: "recruitment.resignations", label: "Resignations" },
      { key: "recruitment.required_roles", label: "Required Roles" },
      { key: "recruitment.interviews", label: "Interviews" },
      { key: "recruitment.resume_screening", label: "Resume Screening" },
      { key: "recruitment.documents", label: "Documents" },
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
  { key: "geo_attendance", label: "Geo Attendance" },
  {
    key: "settings", label: "Settings", children: [
      { key: "settings.company", label: "Company" },
      { key: "settings.attendance", label: "Attendance" },
      { key: "settings.devices", label: "Devices" },
      { key: "settings.documents", label: "Company Documents" },
      { key: "settings.payroll", label: "Payroll" },
      { key: "settings.salary_slip", label: "Salary Slip" },
      { key: "settings.smtp", label: "SMTP / Email" },
      { key: "settings.backup", label: "Backup" },
    ],
  },
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

/**
 * Like resolvePermission, but for a parent module with children that all
 * live on one shared route (e.g. "settings" — its tabs have no routes of
 * their own, unlike Employees/Recruitment's children which do). A parent
 * whose own bare key is unset ("hidden") but that has at least one visible
 * child should still be reachable, otherwise granting only e.g.
 * "settings.payroll" would leave the whole /hr/settings page unreachable —
 * defeating the point of the per-tab permission. Employees/Recruitment don't
 * need this: their sidebar entries branch on `item.children` before ever
 * checking the parent's own moduleKey (see dashboard-sidebar.tsx), and each
 * child has its own route. Safe to use in place of resolvePermission for any
 * single-route parent — for keys with no MODULE_TREE children, it's
 * identical to resolvePermission.
 */
export function resolvePermissionOrChildren(
  permissions: Record<string, PermissionLevel> | undefined,
  key: string,
): PermissionLevel {
  const direct = resolvePermission(permissions, key);
  if (direct !== "hidden") return direct;
  const node = MODULE_TREE.find((n) => n.key === key);
  const childLevel = (node?.children ?? [])
    .map((c) => resolvePermission(permissions, c.key))
    .find((lvl) => lvl !== "hidden");
  return childLevel ?? "hidden";
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
  "/hr/recruitment/new-joinees": "recruitment.new_joinees",
  "/hr/recruitment/resignations": "recruitment.resignations",
  "/hr/recruitment/required-roles": "recruitment.required_roles",
  "/hr/recruitment/resume-screening": "recruitment.resume_screening",
  "/hr/recruitment/documents": "recruitment.documents",
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
  "/hr/geo-attendance": "geo_attendance",
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
