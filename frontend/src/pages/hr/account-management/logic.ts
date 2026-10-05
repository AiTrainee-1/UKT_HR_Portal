// Account Management: the rules behind the page, kept apart from the screens so they can be tested on their own.

import { MODULE_TREE, allModuleKeys, resolvePermission, type ModuleNode } from "@/lib/permission-modules";
import type { HrUserItem, PermissionLevel } from "@/lib/api-client/custom-hooks";

export type Permissions = Record<string, PermissionLevel>;

export const LEVELS: { value: PermissionLevel; label: string }[] = [
  { value: "hidden", label: "Hidden" },
  { value: "view", label: "View" },
  { value: "edit", label: "Edit" },
];

// ─── Accounts: summary, filters, sorting ────────────────────────────────────────

export type AccountSummary = {
  total: number;
  active: number;
  disabled: number;
  /** Tied to one branch (sees only that branch's data). */
  branchScoped: number;
  /** Company-wide logins. */
  companyWide: number;
  /** Accounts that have no role and are not administrators: they can't open any module. */
  noRole: number;
};

export function summarizeAccounts(users: HrUserItem[]): AccountSummary {
  const active = users.filter((u) => u.isActive).length;
  const branchScoped = users.filter((u) => u.branchId != null).length;
  return {
    total: users.length,
    active,
    disabled: users.length - active,
    branchScoped,
    companyWide: users.length - branchScoped,
    // An administrator has full access without a role, so is never "missing" one.
    noRole: users.filter((u) => u.roleId == null && !u.isSuperAdmin).length,
  };
}

/** "none" in the role / branch filters: accounts with no role, or with no branch (company-wide). */
export const NONE = "none";

export type StatusFilter = "all" | "active" | "disabled";

export type AccountFilters = {
  query: string;
  status: StatusFilter;
  /** "all", NONE, or a role id. */
  role: string;
  /** "all", NONE (company-wide), or a branch id. */
  branch: string;
};

export const NO_FILTERS: AccountFilters = { query: "", status: "all", role: "all", branch: "all" };

export const filtersActive = (f: AccountFilters) =>
  f.query.trim() !== "" || f.status !== "all" || f.role !== "all" || f.branch !== "all";

/** Every word typed must appear somewhere in the account's username, name, email, role or branch. */
export function filterAccounts(users: HrUserItem[], f: AccountFilters): HrUserItem[] {
  const words = f.query.toLowerCase().split(/\s+/).filter(Boolean);
  return users.filter((u) => {
    if (f.status === "active" && !u.isActive) return false;
    if (f.status === "disabled" && u.isActive) return false;
    if (f.role === NONE ? u.roleId != null || u.isSuperAdmin : f.role !== "all" && String(u.roleId ?? "") !== f.role) {
      return false;
    }
    if (f.branch === NONE ? u.branchId != null : f.branch !== "all" && String(u.branchId ?? "") !== f.branch) {
      return false;
    }
    if (words.length === 0) return true;
    const haystack = [
      u.username,
      u.fullName,
      u.email,
      u.roleName,
      u.branchName,
      u.branchId == null ? "all branches" : "",
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
}

export type SortKey = "username" | "role" | "branch" | "status" | "lastLogin";
export type SortDir = "asc" | "desc";

const text = (v: string | null | undefined) => (v ?? "").toLowerCase();

/** A sorted copy. Ties fall back to the username so the order never jumps around. Never logged in counts as oldest. */
export function sortAccounts(users: HrUserItem[], key: SortKey, dir: SortDir): HrUserItem[] {
  const sign = dir === "asc" ? 1 : -1;
  const compare = (a: HrUserItem, b: HrUserItem): number => {
    switch (key) {
      case "role":
        return text(a.roleName).localeCompare(text(b.roleName));
      case "branch":
        return text(a.branchName).localeCompare(text(b.branchName));
      case "status":
        return Number(b.isActive) - Number(a.isActive); // ascending = active first
      case "lastLogin":
        return (
          (a.lastLogin ? Date.parse(a.lastLogin) : -Infinity) - (b.lastLogin ? Date.parse(b.lastLogin) : -Infinity)
        );
      default:
        return text(a.username).localeCompare(text(b.username));
    }
  };
  return [...users].sort((a, b) => {
    const c = compare(a, b);
    // -Infinity - -Infinity is NaN: two accounts that never signed in are equal
    return (Number.isNaN(c) || c === 0 ? text(a.username).localeCompare(text(b.username)) : sign * c) || 0;
  });
}

/** Two letters for an avatar: the first and last word of the name, else the start of the username. */
export function initials(u: Pick<HrUserItem, "username" | "fullName">): string {
  const words = (u.fullName ?? "").split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  const single = words[0] ?? u.username;
  return single.slice(0, 2).toUpperCase();
}

// Spelled out here rather than asked of Intl, whose short month names differ between browsers ("Sep" / "Sept").
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Just now", "5m ago", "3h ago", "4d ago", then the date; "Never" when there is none. */
export function relativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  const then = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(then)) return "Never";
  const mins = Math.floor((now.getTime() - then) / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const d = new Date(then);
  return `${String(d.getDate()).padStart(2, "0")} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** How many of the listed accounts use each role. */
export function roleUsage(users: HrUserItem[]): Record<number, number> {
  const usage: Record<number, number> = {};
  for (const u of users) if (u.roleId != null) usage[u.roleId] = (usage[u.roleId] ?? 0) + 1;
  return usage;
}

// ─── Roles: counting and editing permissions ────────────────────────────────────

export type LevelCounts = { edit: number; view: number; hidden: number; total: number };

function countKeys(permissions: Permissions | undefined, keys: string[]): LevelCounts {
  const counts: LevelCounts = { edit: 0, view: 0, hidden: 0, total: keys.length };
  for (const key of keys) counts[resolvePermission(permissions, key)] += 1;
  return counts;
}

const keysOf = (node: ModuleNode) => [node.key, ...(node.children ?? []).map((c) => c.key)];

/** What a role can actually do across every module and submodule (a submodule with no setting of its own counts as its parent's level). */
export const levelCounts = (permissions: Permissions | undefined): LevelCounts =>
  countKeys(permissions, allModuleKeys());

export const sectionCounts = (permissions: Permissions | undefined, node: ModuleNode): LevelCounts =>
  countKeys(permissions, keysOf(node));

/** Submodules with a setting of their own (as opposed to inheriting their parent's). */
export const overrideCount = (permissions: Permissions | undefined, node: ModuleNode): number =>
  (node.children ?? []).filter((c) => permissions != null && c.key in permissions).length;

export function setLevel(permissions: Permissions, key: string, level: PermissionLevel): Permissions {
  return { ...permissions, [key]: level };
}

/** A submodule goes back to following its parent. */
export function clearOverride(permissions: Permissions, key: string): Permissions {
  const next = { ...permissions };
  delete next[key];
  return next;
}

/** The module and every submodule of it get this level; the submodules stop having a setting of their own. */
export function setSection(permissions: Permissions, node: ModuleNode, level: PermissionLevel): Permissions {
  const next = { ...permissions, [node.key]: level };
  for (const child of node.children ?? []) delete next[child.key];
  return next;
}

/** Every module at one level. Keys the page does not know about are left alone. */
export function setAll(permissions: Permissions, level: PermissionLevel): Permissions {
  const known = new Set(allModuleKeys());
  const next: Permissions = Object.fromEntries(Object.entries(permissions).filter(([k]) => !known.has(k)));
  for (const node of MODULE_TREE) next[node.key] = level;
  return next;
}

/** A new role starts with nothing granted. */
export const emptyPermissions = (): Permissions => setAll({}, "hidden");

export function permissionsEqual(a: Permissions | undefined, b: Permissions | undefined): boolean {
  const x = a ?? {};
  const y = b ?? {};
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  for (const k of keys) if (x[k] !== y[k]) return false;
  return true;
}

export type VisibleSection = { node: ModuleNode; children: ModuleNode[]; matched: boolean };

/** The modules left after a search. A section whose own name matches keeps all its submodules; otherwise only the matching ones. */
export function filterModules(query: string): VisibleSection[] {
  const q = query.trim().toLowerCase();
  const hit = (n: ModuleNode) => n.label.toLowerCase().includes(q) || n.key.toLowerCase().includes(q);
  return MODULE_TREE.flatMap((node): VisibleSection[] => {
    const children = node.children ?? [];
    if (!q) return [{ node, children, matched: true }];
    if (hit(node)) return [{ node, children, matched: true }];
    const some = children.filter(hit);
    return some.length ? [{ node, children: some, matched: false }] : [];
  });
}

/** How many modules (sections and submodules) a search leaves. */
export const visibleModuleCount = (sections: VisibleSection[]): number =>
  sections.reduce((n, s) => n + 1 + s.children.length, 0);
