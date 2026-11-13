import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canView, canViewRoute, isRouteViewOnly } from "@/contexts/AuthContext";
import type { PermissionLevel } from "@/lib/api-client/custom-hooks";
import {
  MODULE_TREE,
  PERMISSION_GROUPS,
  ROUTE_MODULE_MAP,
  ROUTE_PATTERNS,
  allModuleKeys,
  displayNodes,
  moduleForPath,
} from "./permission-modules";

// The portal side of "nothing missed, nothing changed" (the API side is backend/api/tests_permission_tree.py):
// every /hr address in App.tsx maps to a key or is allowlisted below, and every role keeps exactly the pages it had.

type Perms = Record<string, PermissionLevel>;
type User = Parameters<typeof canViewRoute>[0];
const hr = (permissions: Perms): User => ({ role: "hr", employeeId: null, permissions });

// ─── the rules of 2026-11-10, frozen (lib/permission-modules.ts and contexts/AuthContext.tsx as they were) ─────────────

const OLD_ROUTE_MODULE_MAP: Record<string, string> = {
  "/hr/dashboard": "dashboard",
  "/hr/employees": "employees",
  "/hr/departments": "employees.departments",
  "/hr/designations": "employees.designations",
  "/hr/branches": "employees.branches",
  "/hr/attendance": "attendance",
  "/hr/Biometric-Connectors": "attendance",
  "/hr/shifts": "shifts",
  "/hr/leave": "leave",
  "/hr/casual-leave": "casual_leave",
  "/hr/missing-punch": "missing_punch",
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
  "/hr/production-payroll": "production_payroll",
  "/hr/compensation": "compensation",
  "/hr/salary": "salary",
  "/hr/salary-slip": "salary_slip",
  "/hr/settlement": "settlement",
  "/hr/reports": "reports",
  "/hr/user-management": "user_management",
  "/hr/activity-logs": "activity_logs",
  "/hr/login-devices": "login_devices",
  "/hr/mobile-app-login": "mobile_app_login",
  "/hr/whatsapp-control": "whatsapp_control",
  "/hr/gmail-control": "gmail_control",
  "/hr/sms-control": "sms_control",
  "/hr/chat": "chat",
  "/hr/notifications": "notifications",
  "/hr/geo-attendance": "geo_attendance",
  "/hr/outpass-visitors": "outpass_visitors",
  "/hr/settings": "settings",
};
const OLD_CHILDREN: Record<string, string[]> = {
  employees: ["employees.departments", "employees.designations", "employees.branches"],
  recruitment: [
    "recruitment.new_joinees",
    "recruitment.resignations",
    "recruitment.required_roles",
    "recruitment.interviews",
    "recruitment.resume_screening",
    "recruitment.documents",
  ],
  user_management: ["user_management.approval_workflow"],
  settings: [
    "settings.company",
    "settings.hr_contact",
    "settings.attendance",
    "settings.late_detection",
    "settings.devices",
    "settings.documents",
    "settings.payroll",
    "settings.production_payroll",
    "settings.salary_slip",
    "settings.smtp",
    "settings.whatsapp",
    "settings.backup",
    "settings.themes",
    "settings.compensation",
  ],
};
const OLD_TOP = [
  "dashboard",
  "employees",
  "attendance",
  "shifts",
  "leave",
  "casual_leave",
  "missing_punch",
  "requests",
  "promotion",
  "increment",
  "bonus",
  "id_cards",
  "recruitment",
  "payroll",
  "production_payroll",
  "compensation",
  "salary",
  "salary_slip",
  "settlement",
  "reports",
  "user_management",
  "login_devices",
  "mobile_app_login",
  "whatsapp_control",
  "sms_control",
  "gmail_control",
  "chat",
  "notifications",
  "geo_attendance",
  "outpass_visitors",
  "settings",
];
const OLD_KEYS = OLD_TOP.flatMap((k) => [k, ...(OLD_CHILDREN[k] ?? [])]);
const OLD_OR: Record<string, string[]> = {
  "/hr/payroll": ["payroll", "salary", "salary_slip"],
  "/hr/user-management": ["user_management", "user_management.approval_workflow"],
};

function oldResolve(p: Perms | undefined, key: string): PermissionLevel {
  if (!p) return "hidden";
  const parts = key.split(".");
  for (let i = parts.length; i > 0; i--) {
    const c = parts.slice(0, i).join(".");
    if (c in p) return p[c];
  }
  return "hidden";
}
const visible = (l: PermissionLevel) => l === "view" || l === "edit";
function oldOrChildren(p: Perms | undefined, key: string): PermissionLevel {
  const direct = oldResolve(p, key);
  if (direct !== "hidden") return direct;
  return (OLD_CHILDREN[key] ?? []).map((c) => oldResolve(p, c)).find(visible) ?? "hidden";
}
function oldModuleForPath(path: string): string | null {
  let best: string | null = null;
  let bestLen = -1;
  const where = path.toLowerCase();
  for (const [prefix, key] of Object.entries(OLD_ROUTE_MODULE_MAP)) {
    const at = prefix.toLowerCase();
    if ((where === at || where.startsWith(at + "/")) && prefix.length > bestLen) {
      best = key;
      bestLen = prefix.length;
    }
  }
  return best;
}
function oldCanViewRoute(p: Perms, path: string): boolean {
  const or = OLD_OR[path];
  if (or) return or.some((k) => visible(oldResolve(p, k)));
  const key = oldModuleForPath(path);
  return key ? visible(oldOrChildren(p, key)) : true;
}
function oldViewOnly(p: Perms, path: string): boolean {
  const or = OLD_OR[path];
  if (or) {
    const levels = or.map((k) => oldResolve(p, k));
    return !levels.includes("edit") && levels.includes("view");
  }
  const key = oldModuleForPath(path);
  return key ? oldResolve(p, key) === "view" : false;
}

// ─── every address of the portal ───────────────────────────────────────────────────────────────────────────────────

const APP = readFileSync(resolve(__dirname, "../App.tsx"), "utf-8");
const ROUTE_PATHS = [...APP.matchAll(/path="(\/hr\/[^"]*)"/g)].map((m) => m[1]);

/** Addresses no role key controls, and why (permission-inventory.md lists the same). */
const ROUTE_ALLOWLIST: Record<string, string> = {
  "/hr/account-management": "the Super Admin only (a locked row in the tree)",
  "/hr/account-management/master": "the master administrator only",
  "/hr/assistant-activity": "the Super Admin and HR Managers, by account type",
};

const sample = (route: string) =>
  route
    .replace(/\/\*\?$/, "")
    .replace(/:tab\?/, "fetch")
    .replace(/:id/, "12")
    .replace(/:employeeId/, "12")
    .replace(/:date/, "2026-11-11")
    .replace(/:tab/, "payroll");

const TREE_ADDRESSES = displayNodes().flatMap(({ node }) => [
  ...(node.routes ?? []),
  ...(node.routePatterns ?? []).map((p) => p.replace(/\\d\+/g, "12")),
]);
const ADDRESSES = [
  ...new Set([...ROUTE_PATHS.map(sample), ...Object.keys(OLD_ROUTE_MODULE_MAP), ...TREE_ADDRESSES]),
].filter((p) => !(p in ROUTE_ALLOWLIST));

const SIDEBAR_CHILDREN = [
  "/hr/employees",
  "/hr/employees/productionEmployee",
  "/hr/attendance/staff",
  "/hr/attendance/production",
  "/hr/attendance/search",
  "/hr/attendance/report-log",
  "/hr/missing-punch",
  "/hr/geo-attendance/approvals",
  "/hr/geo-attendance/journeys",
  "/hr/outpass-visitors/outpass",
  "/hr/outpass-visitors/visitors",
  "/hr/outpass-visitors/tea-break",
  "/hr/production-payroll/weekly",
  "/hr/compensation/ctc-breakdown",
  "/hr/compensation/history",
  "/hr/recruitment/dashboard",
  "/hr/recruitment/new-joinees",
  "/hr/interviews",
  "/hr/Biometric-Connectors/device-status",
  "/hr/Biometric-Connectors/DeviceControl",
];

function roleShapes(): Perms[] {
  const levels: PermissionLevel[] = ["hidden", "view", "edit"];
  const shapes: Perms[] = [{}];
  for (const level of levels) shapes.push(Object.fromEntries(OLD_KEYS.map((k) => [k, level])));
  for (const k of OLD_KEYS) {
    for (const level of levels) {
      shapes.push({ [k]: level });
      const parent = k.includes(".") ? k.slice(0, k.lastIndexOf(".")) : "";
      if (parent) for (const other of levels) shapes.push({ [parent]: other, [k]: level });
    }
  }
  let seed = 20261111;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let i = 0; i < 300; i++) {
    const p: Perms = {};
    for (const k of OLD_KEYS) if (rand() < 0.4) p[k] = levels[Math.floor(rand() * 3)];
    shapes.push(p);
  }
  return shapes;
}

function assertSame(p: Perms, label: string) {
  const user = hr(p);
  for (const path of ADDRESSES) {
    const key = moduleForPath(path);
    expect(canViewRoute(user, path, key), `${label}: open ${path}`).toBe(oldCanViewRoute(p, path));
    // One deliberate change (2026-11-11): a page whose own key is View but with a part set to Edit on its own is no
    // longer locked as a whole (that locked the editable part too); the page locks its View parts itself.
    const editablePart = !!key && Object.entries(p).some(([k, v]) => k.startsWith(`${key}.`) && v === "edit");
    const before = oldViewOnly(p, path) && !editablePart;
    expect(isRouteViewOnly(user, path, key), `${label}: view-only ${path}`).toBe(before);
  }
  for (const path of SIDEBAR_CHILDREN) {
    const before = (() => {
      const k = oldModuleForPath(path);
      return k ? visible(oldResolve(p, k)) : true;
    })();
    const key = moduleForPath(path);
    expect(key ? canView(user, key) : true, `${label}: sidebar ${path}`).toBe(before);
  }
}

describe("nothing missed", () => {
  it("maps every /hr address of App.tsx to a key, or names why not", () => {
    expect(ROUTE_PATHS.length).toBeGreaterThan(60);
    for (const route of ROUTE_PATHS) {
      const path = sample(route);
      if (path in ROUTE_ALLOWLIST) continue;
      expect(moduleForPath(path), `${route} has no key`).not.toBeNull();
    }
    for (const path of Object.keys(ROUTE_ALLOWLIST)) expect(ROUTE_PATHS.map(sample)).toContain(path);
  });

  it("maps every address of the tree to its own key", () => {
    for (const { node } of displayNodes()) {
      for (const route of node.routes ?? []) expect(moduleForPath(route), route).toBe(node.key);
    }
    expect(moduleForPath("/hr/employees/12/edit")).toBe("employees.edit");
    expect(moduleForPath("/hr/employees/12")).toBe("employees.profile");
    expect(moduleForPath("/hr/employees/new")).toBe("employees.add");
    expect(moduleForPath("/hr/geo-attendance/journeys/4/simulate")).toBe("geo_attendance.journeys.simulate");
    expect(moduleForPath("/hr/geo-attendance/journeys/4")).toBe("geo_attendance.journeys");
    expect(moduleForPath("/hr/compensation/ot-detection/type-2/waiting")).toBe("compensation.ot.type2.waiting");
    expect(moduleForPath("/hr/user-management/3")).toBe("user_management.hod.detail");
    expect(ROUTE_PATTERNS.length).toBeGreaterThan(3);
    expect(Object.keys(ROUTE_MODULE_MAP).length).toBeGreaterThan(100);
  });

  it("knows every key of the tree, and every old key is still there", () => {
    const keys = new Set(allModuleKeys());
    for (const k of OLD_KEYS) expect(keys.has(k), k).toBe(true);
    expect(MODULE_TREE.length).toBeGreaterThanOrEqual(OLD_TOP.length);
    expect(PERMISSION_GROUPS.map((g) => g.id)).toEqual([
      "main",
      "hr_operations",
      "payroll",
      "recruitment",
      "administration",
    ]);
  });
});

describe("nothing changed for existing roles", () => {
  it("opens, locks and lists exactly the pages it did before, for every role shape", () => {
    roleShapes().forEach((p, i) => assertSame(p, `role #${i} ${JSON.stringify(p)}`));
  }, 180_000); // ~1,100 role shapes x every address: slow on a busy machine

  // The real roles of a database, written by a read-only script (see the report of 2026-11-11): optional.
  const file = process.env.PERM_COMPAT_ROLES_FILE;
  it.runIf(!!file)("does the same for the roles in PERM_COMPAT_ROLES_FILE", () => {
    const roles = JSON.parse(readFileSync(file as string, "utf-8")) as { name: string; permissions: Perms }[];
    expect(roles.length).toBeGreaterThan(0);
    for (const r of roles) assertSame(r.permissions ?? {}, `real role ${r.name}`);
  });
});

describe("the new keys decide when a role sets them", () => {
  it("does not lock a whole page whose tab is set to Edit under a View page", () => {
    const user = hr({ mobile_app_login: "view", "mobile_app_login.logins": "edit" });
    expect(isRouteViewOnly(user, "/hr/mobile-app-login", "mobile_app_login")).toBe(false);
    expect(isRouteViewOnly(hr({ mobile_app_login: "view" }), "/hr/mobile-app-login", "mobile_app_login")).toBe(true);
  });

  it("hides one tab of a page and keeps the rest", () => {
    const user = hr({ attendance: "edit", "attendance.report_log": "hidden" });
    expect(canViewRoute(user, "/hr/attendance/report-log", moduleForPath("/hr/attendance/report-log"))).toBe(false);
    expect(canViewRoute(user, "/hr/attendance/search", moduleForPath("/hr/attendance/search"))).toBe(true);
  });

  it("opens a page for a role that was given only one of its tabs", () => {
    const user = hr({ "settings.idcard": "edit" });
    expect(canViewRoute(user, "/hr/settings", "settings")).toBe(true);
    // ...but a tab that only follows another key does not open its page (as before)
    expect(canViewRoute(hr({ id_cards: "edit" }), "/hr/settings", "settings")).toBe(false);
  });

  it("makes a tab view-only on its own", () => {
    const user = hr({ compensation: "edit", "compensation.history": "view" });
    expect(isRouteViewOnly(user, "/hr/compensation/history", moduleForPath("/hr/compensation/history"))).toBe(true);
    expect(isRouteViewOnly(user, "/hr/compensation/reports", moduleForPath("/hr/compensation/reports"))).toBe(false);
  });

  it("stops following the old section rule once the new key is set", () => {
    // before: a role with only Departments could open /hr/employees/new (the old rule); it still can...
    const old = hr({ "employees.departments": "view" });
    expect(canViewRoute(old, "/hr/employees/new", "employees.add")).toBe(true);
    // ...until Add employee is set on its own
    const set = hr({ "employees.departments": "view", "employees.add": "hidden" });
    expect(canViewRoute(set, "/hr/employees/new", "employees.add")).toBe(false);
  });
});
