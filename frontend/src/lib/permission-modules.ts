import type { PermissionLevel } from "@/lib/api-client/custom-hooks";
import treeJson from "./permission-tree.json";

/**
 * The HR portal's permission tree: every page, tab, sub-tab and feature a role can be given Hidden / View / Edit on.
 * The tree is written once, in backend/api/permission_tree.py, and read here from permission-tree.json (the backend test
 * tests_permission_tree.py fails when the two differ). A key with no setting of its own follows its dotted parent
 * ("payroll.issues" follows "payroll"), or the key named in its `inherits` (Settings -> ID Card follows the ID Cards page,
 * as it always did); nothing set at all is Hidden. Mirrors backend/api/permission_registry.py::resolve_permission.
 */

export type PermissionNodeType = "section" | "page" | "tab" | "subtab" | "view" | "feature";

/** One node as Account Management shows it. */
export type DisplayNode = {
  key: string;
  label: string;
  type: PermissionNodeType;
  help: string;
  /** Portal addresses this key guards (prefixes) and address patterns (with an id in them). */
  routes?: string[];
  routePatterns?: string[];
  /** When unset, follow this key instead of the dotted parent. */
  inherits?: string;
  /** Shown under a page although its key is not a dotted child of it: a setting of its own. */
  own?: boolean;
  /** Cannot be given to a role: who may use it (shown, never stored). */
  locked?: string;
  /** "server": it guards API calls itself; "parts": only its parts do; "screen": Hidden only hides it on screen. */
  enforce?: "server" | "parts" | "screen";
  children?: DisplayNode[];
};

/** A sidebar heading (Main, HR Operations, Payroll ...): no key of its own. */
export type DisplayGroup = { id: string; label: string; children: DisplayNode[] };

export const PERMISSION_GROUPS: DisplayGroup[] = (treeJson as unknown as { groups: DisplayGroup[] }).groups;

/** The tree by KEY (a dotted key under its dotted parent), as it has always been shaped. Only keys a role can be given. */
export type ModuleNode = { key: string; label: string; children?: ModuleNode[] };

/** Every node in the editor's order, with its depth and the node shown above it (groups not included). */
export function displayNodes(): { node: DisplayNode; depth: number; parent: DisplayNode | null; locked: boolean }[] {
  const out: { node: DisplayNode; depth: number; parent: DisplayNode | null; locked: boolean }[] = [];
  const walk = (nodes: DisplayNode[], depth: number, parent: DisplayNode | null, lockedAbove: boolean) => {
    for (const node of nodes) {
      const locked = lockedAbove || !!node.locked;
      out.push({ node, depth, parent, locked });
      walk(node.children ?? [], depth + 1, node, locked);
    }
  };
  for (const group of PERMISSION_GROUPS) walk(group.children, 0, null, false);
  return out;
}

const DISPLAY = displayNodes();
const GRANTABLE = DISPLAY.filter((d) => !d.locked).map((d) => d.node);

function buildKeyTree(): ModuleNode[] {
  const byKey = new Map<string, ModuleNode>();
  for (const n of GRANTABLE) byKey.set(n.key, { key: n.key, label: n.label });
  const roots: ModuleNode[] = [];
  for (const n of GRANTABLE) {
    const item = byKey.get(n.key)!;
    const parentKey = n.key.includes(".") ? n.key.slice(0, n.key.lastIndexOf(".")) : "";
    const parent = parentKey ? byKey.get(parentKey) : undefined;
    if (parent) (parent.children ??= []).push(item);
    else roots.push(item);
  }
  return roots;
}

export const MODULE_TREE: ModuleNode[] = buildKeyTree();

/** key -> the key it follows when unset, instead of its dotted parent. */
export const INHERITS: Record<string, string> = Object.fromEntries(
  GRANTABLE.filter((n) => n.inherits).map((n) => [n.key, n.inherits as string]),
);

/** Every key a role can be given a level on, parents before their parts. */
export function allModuleKeys(): string[] {
  const keys: string[] = [];
  const walk = (nodes: ModuleNode[]) => {
    for (const n of nodes) {
      keys.push(n.key);
      walk(n.children ?? []);
    }
  };
  walk(MODULE_TREE);
  return keys;
}

const parentOf = (key: string): string => (key.includes(".") ? key.slice(0, key.lastIndexOf(".")) : "");

/**
 * The key whose entry decides `key`'s level: its own, else the key it follows (its `inherits`, else its dotted parent),
 * and so on up. Null when nothing on the way is set (then it is Hidden).
 */
export function resolveSource(permissions: Record<string, PermissionLevel> | undefined, key: string): string | null {
  if (!permissions) return null;
  const seen = new Set<string>();
  let current = key;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current in permissions) return current;
    current = INHERITS[current] ?? parentOf(current);
  }
  return null;
}

/**
 * The level of a key: its own entry, else the entry of the key it follows (its `inherits`, else its dotted parent), and so
 * on up. Hidden when nothing on the way is set (fail closed). Mirrors backend permission_registry.resolve_permission.
 */
export function resolvePermission(
  permissions: Record<string, PermissionLevel> | undefined,
  key: string,
): PermissionLevel {
  const source = resolveSource(permissions, key);
  return source && permissions ? permissions[source] : "hidden";
}

/**
 * Like resolvePermission, but for a page whose parts can be given on their own: a page whose own key is Hidden (or unset)
 * is still reachable when one of its parts (a key under it) is SET to View or Edit, so granting only "settings.payroll"
 * opens /hr/settings with just that tab. A part that only follows its page does not count. For a key with no parts, it is
 * resolvePermission.
 */
export function resolvePermissionOrChildren(
  permissions: Record<string, PermissionLevel> | undefined,
  key: string,
): PermissionLevel {
  const direct = resolvePermission(permissions, key);
  if (direct !== "hidden" || !permissions) return direct;
  const part = Object.keys(permissions)
    .filter((k) => k.startsWith(key + "."))
    .map((k) => permissions[k])
    .find((lvl) => lvl === "view" || lvl === "edit");
  return part ?? "hidden";
}

// ─── portal addresses ────────────────────────────────────────────────────────────

/** Address prefixes of the pages whose key has always been here; the parts' own addresses come from the tree. */
const BASE_ROUTE_MODULE_MAP: Record<string, string> = {
  "/hr/dashboard": "dashboard",
  "/hr/employees": "employees",
  "/hr/departments": "employees.departments",
  "/hr/designations": "employees.designations",
  "/hr/branches": "employees.branches",
  "/hr/attendance": "attendance",
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

function buildRouteMap(): Record<string, string> {
  const out: Record<string, string> = { ...BASE_ROUTE_MODULE_MAP };
  for (const { node } of DISPLAY) {
    for (const route of node.routes ?? []) {
      if (route in BASE_ROUTE_MODULE_MAP || (route in out && out[route] !== node.key)) {
        throw new Error(`permission-modules: the address ${route} is claimed twice`);
      }
      out[route] = node.key;
    }
  }
  return out;
}

/** Frontend HR address prefix -> key (longest prefix wins, compared without regard to case). */
export const ROUTE_MODULE_MAP: Record<string, string> = buildRouteMap();

/** Addresses with an id in them (/hr/employees/12/edit): a full match wins over every prefix. */
export const ROUTE_PATTERNS: { pattern: RegExp; key: string }[] = DISPLAY.flatMap(({ node }) =>
  (node.routePatterns ?? []).map((p) => ({ pattern: new RegExp(`^(?:${p})$`, "i"), key: node.key })),
);

// Routes where several independently-permissioned keys share one page (Staff Payroll's Payroll/Salary/Payslip tabs are
// the unrelated "payroll"/"salary"/"salary_slip" keys; User Management's two tabs). Page-level reachability and the
// view-only banner should be the most permissive level across all of them, not just moduleForPath's single match.
export const ROUTE_OR_MODULES: Record<string, string[]> = {
  "/hr/payroll": ["payroll", "salary", "salary_slip"],
  // User Management's two tabs (HOD Assignment, Approval Workflow Control) carry their own levels, so a role can be
  // given one tab as View and the other as Edit: the page-wide lock must only fire when neither tab is editable.
  "/hr/user-management": ["user_management", "user_management.hod", "user_management.approval_workflow"],
};

export function moduleForPath(path: string): string | null {
  // Compared without regard to case: the router matches routes that way, so a page opened as /hr/biometric-connectors
  // must be gated like /hr/Biometric-Connectors, not slip through as "no module".
  const where = path.toLowerCase().replace(/\/+$/, "") || "/";
  for (const { pattern, key } of ROUTE_PATTERNS) if (pattern.test(where)) return key;
  let best: string | null = null;
  let bestLen = -1;
  for (const [prefix, moduleKey] of Object.entries(ROUTE_MODULE_MAP)) {
    const at = prefix.toLowerCase();
    if ((where === at || where.startsWith(at + "/")) && prefix.length > bestLen) {
      best = moduleKey;
      bestLen = prefix.length;
    }
  }
  return best;
}

// ─── the address rules of 2026-11-10 (kept so no existing role loses or gains a page) ──────────────────────────────

/**
 * Before 2026-11-11 a page was reachable when its module, OR one of that module's sub-modules, was visible: a role with
 * only "Departments" could open /hr/employees/new (whose data it could not load). The new addresses (/hr/employees/new is
 * now "employees.add") must keep that for a role that never set the new keys, so the old answer stands while nothing
 * between the new key and the old one is set. These are the old address prefixes whose key changed, and the old
 * sub-modules.
 */
const LEGACY_ROUTE_KEYS: Record<string, string> = {
  "/hr/employees": "employees",
  "/hr/recruitment": "recruitment",
  "/hr/user-management": "user_management",
};
const LEGACY_CHILDREN: Record<string, string[]> = {
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
};

/** The old module of an address whose key changed, when the old rule could still open it; else null. */
export function legacyRouteKey(path: string, moduleKey: string | null): string | null {
  if (!moduleKey) return null;
  const where = path.toLowerCase();
  for (const [prefix, key] of Object.entries(LEGACY_ROUTE_KEYS)) {
    if ((where === prefix || where.startsWith(prefix + "/")) && moduleKey.startsWith(key + ".")) {
      // a key of its own that is not one of the old sub-modules' own pages
      if (LEGACY_CHILDREN[key].some((c) => moduleKey === c || moduleKey.startsWith(c + "."))) return null;
      return key;
    }
  }
  return null;
}

/** The old answer for a legacy address: its module, or one of the module's old sub-modules, visible. */
export function legacyCanView(permissions: Record<string, PermissionLevel> | undefined, key: string): boolean {
  if (!permissions) return false;
  const visible = (lvl: PermissionLevel) => lvl === "view" || lvl === "edit";
  if (visible(resolvePermission(permissions, key))) return true;
  return (LEGACY_CHILDREN[key] ?? []).some((c) => c in permissions && visible(permissions[c]));
}

/** Is anything set on the new key's own chain below `legacy` (then the new rules decide)? */
export function hasOwnSetting(
  permissions: Record<string, PermissionLevel> | undefined,
  key: string,
  legacy: string,
): boolean {
  if (!permissions) return false;
  for (let k = key; k && k !== legacy; k = parentOf(k)) if (k in permissions) return true;
  return false;
}

// Flat label lookup, used where a plain key -> display name is needed (locked rows included).
export const MODULE_LABELS: Array<{ key: string; label: string }> = DISPLAY.map(({ node }) => ({
  key: node.key,
  label: node.label,
}));
