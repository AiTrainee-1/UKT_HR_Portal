// Account Management: the rules behind the page, kept apart from the screens so they can be tested on their own.

import {
  MODULE_LABELS,
  PERMISSION_GROUPS,
  allModuleKeys,
  resolvePermission,
  resolveSource,
  type DisplayGroup,
  type DisplayNode,
} from "@/lib/permission-modules";
import type { HrUserItem, PermissionLevel, Role } from "@/lib/api-client/custom-hooks";
import { CATEGORY_LABEL, type Category, type DisplayCategory } from "@/lib/hr-access";

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
  /** Accounts that have no role and are neither administrators nor the MD: they can't open any module. */
  noRole: number;
  /** The Managing Director's account, if one is assigned. */
  md: HrUserItem | null;
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
    // An administrator has full access without a role, so is never "missing" one. Neither is the MD: the executive
    // portal comes from the MD identity, not from a role.
    noRole: users.filter((u) => u.roleId == null && !u.isSuperAdmin && !u.isMd).length,
    md: users.find((u) => u.isMd) ?? null,
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
  /** "all" or a display category ("super_admin", "md", "admin", "hr_manager", "hr_assistant"). Optional: older callers. */
  category?: string;
};

export const NO_FILTERS: AccountFilters = { query: "", status: "all", role: "all", branch: "all", category: "all" };

export const filtersActive = (f: AccountFilters) =>
  f.query.trim() !== "" ||
  f.status !== "all" ||
  f.role !== "all" ||
  f.branch !== "all" ||
  (f.category ?? "all") !== "all";

/** What the screens call the account: the server's displayCategory, or worked out the same way (an older backend). */
export function displayCategoryOf(u: HrUserItem): DisplayCategory {
  if (u.displayCategory) return u.displayCategory;
  if (u.isSuperAdmin) return "super_admin";
  if (u.isMd) return "md";
  return u.category ?? "admin";
}

/** Every word typed must appear somewhere in the account's username, name, email, role or branch. */
export function filterAccounts(users: HrUserItem[], f: AccountFilters): HrUserItem[] {
  const words = f.query.toLowerCase().split(/\s+/).filter(Boolean);
  return users.filter((u) => {
    if (f.status === "active" && !u.isActive) return false;
    if (f.status === "disabled" && u.isActive) return false;
    if (f.category && f.category !== "all" && displayCategoryOf(u) !== f.category) return false;
    if (
      f.role === NONE
        ? u.roleId != null || u.isSuperAdmin || u.isMd
        : f.role !== "all" && String(u.roleId ?? "") !== f.role
    ) {
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
      CATEGORY_LABEL[displayCategoryOf(u)],
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

// ─── HR Manager / HR Assistant tabs ─────────────────────────────────────────────────

export type StaffCategory = "hr_manager" | "hr_assistant";

/** What each category is for, in the owner's words (shown on its tab and in its dialog). */
export const CATEGORY_PURPOSE: Record<StaffCategory, string> = {
  hr_manager:
    "Works inside the pages and approvals its role gives it, approves what HR Assistants can't (missing punches, attendance edits) and reviews their activity. Can't create or change any account.",
  hr_assistant:
    "Restricted login for day-to-day work: permissions, leave, compensation, payroll and attendance editing, as its role allows. Never approves missing-punch requests or attendance edits.",
};

/** The accounts of one category (never the Super Admin or the MD, who stay Admin accounts). */
export const accountsOf = (users: HrUserItem[], category: Category): HrUserItem[] =>
  users.filter((u) => displayCategoryOf(u) === category);

/** The roles an account of this category may be given: made for it, or for any account. Its own ones first. */
export function rolesFor(roles: Role[], category: Category): Role[] {
  const own = (r: Role) => (r.category ?? "") === (category === "admin" ? "" : category);
  const fits = roles.filter((r) => !r.category || r.category === category);
  return [...fits.filter(own), ...fits.filter((r) => !own(r))];
}

/** The role a new account of this category starts with: the first role made for it (the starter role), if any. */
export const defaultRoleFor = (roles: Role[], category: Category): Role | undefined =>
  category === "admin" ? undefined : roles.find((r) => r.category === category);

/** How many of the listed accounts use each role. */
export function roleUsage(users: HrUserItem[]): Record<number, number> {
  const usage: Record<number, number> = {};
  for (const u of users) if (u.roleId != null) usage[u.roleId] = (usage[u.roleId] ?? 0) + 1;
  return usage;
}

// ─── Roles: counting and editing permissions ────────────────────────────────────
//
// The tree the owner sees (lib/permission-modules.ts PERMISSION_GROUPS): sidebar headings -> sections / pages -> tabs ->
// sub-tabs and features. A part with no setting of its own follows the node above it (its dotted parent, or the key it
// `inherits`); a few nodes are shown under a page but have a setting of their own (`own`: Staff Payroll -> Salary).

export type LevelCounts = { edit: number; view: number; hidden: number; total: number };

function countKeys(permissions: Permissions | undefined, keys: string[]): LevelCounts {
  const counts: LevelCounts = { edit: 0, view: 0, hidden: 0, total: keys.length };
  for (const key of keys) {
    const level = resolvePermission(permissions, key);
    if (level in counts) counts[level] += 1;
    else counts.hidden += 1; // a stored value that is not a level (a hand-edited row) grants nothing
  }
  return counts;
}

/** The parts shown under a node that a role can be given a level on (locked ones left out), in order. */
export function partsOf(node: DisplayNode): DisplayNode[] {
  const out: DisplayNode[] = [];
  const walk = (nodes: DisplayNode[]) => {
    for (const n of nodes) {
      if (n.locked) continue;
      out.push(n);
      walk(n.children ?? []);
    }
  };
  walk(node.children ?? []);
  return out;
}

const groupNodes = (group: DisplayGroup): DisplayNode[] =>
  group.children.filter((n) => !n.locked).flatMap((n) => [n, ...partsOf(n)]);

/** What a role can actually do across every key (a part with no setting of its own counts as the level it follows). */
export const levelCounts = (permissions: Permissions | undefined): LevelCounts =>
  countKeys(permissions, allModuleKeys());

/** A node and every part under it. */
export const sectionCounts = (permissions: Permissions | undefined, node: DisplayNode): LevelCounts =>
  countKeys(permissions, node.locked ? [] : [node.key, ...partsOf(node).map((n) => n.key)]);

/** Every key under a sidebar heading. */
export const groupCounts = (permissions: Permissions | undefined, group: DisplayGroup): LevelCounts =>
  countKeys(
    permissions,
    groupNodes(group).map((n) => n.key),
  );

/** "12 of 14 edit", or the mix when it is not one level. */
export function countsText(c: LevelCounts): string {
  if (c.total === 0) return "";
  if (c.edit === c.total) return `all ${c.total} edit`;
  if (c.view === c.total) return `all ${c.total} view`;
  if (c.hidden === c.total) return `all ${c.total} hidden`;
  return `${c.edit} of ${c.total} edit · ${c.view} view`;
}

/** The one level every key of a set has, or null when they differ. */
export const commonLevel = (c: LevelCounts): PermissionLevel | null =>
  c.total === 0
    ? null
    : c.edit === c.total
      ? "edit"
      : c.view === c.total
        ? "view"
        : c.hidden === c.total
          ? "hidden"
          : null;

/** Parts under a node that have a setting of their own. A part whose key never followed the page (an `own` part, or one
 *  that follows another key) needs a setting to match it, so it counts only when its level differs from the page's. */
export function overrideCount(permissions: Permissions | undefined, node: DisplayNode): number {
  if (!permissions) return 0;
  let n = 0;
  const walk = (nodes: DisplayNode[], parent: DisplayNode) => {
    for (const c of nodes) {
      if (c.locked) continue;
      if (c.key in permissions) {
        const differs = resolvePermission(permissions, c.key) !== resolvePermission(permissions, parent.key);
        if (!(c.own || c.inherits) || differs) n += 1;
      }
      walk(c.children ?? [], c);
    }
  };
  walk(node.children ?? [], node);
  return n;
}

export function setLevel(permissions: Permissions, key: string, level: PermissionLevel): Permissions {
  return { ...permissions, [key]: level };
}

/** A part goes back to following the node above it. */
export function clearOverride(permissions: Permissions, key: string): Permissions {
  const next = { ...permissions };
  delete next[key];
  return next;
}

/**
 * The Hidden / View / Edit control of one node: the node gets this level, and so does every part under it that follows
 * it. A part with a setting of its own keeps it (that is what "custom" means); a part that follows another key (an `own`
 * part, or one that `inherits`) is given the level too, so "Staff Payroll: Hidden" also hides its Salary and Payslip tabs.
 */
export function applyLevel(permissions: Permissions, node: DisplayNode, level: PermissionLevel): Permissions {
  const next: Permissions = { ...permissions, [node.key]: level };
  const before = permissions;
  for (const part of partsOf(node)) {
    if (part.key in before) continue; // custom: keeps its own setting
    if (resolvePermission(next, part.key) !== level) next[part.key] = level;
  }
  return next;
}

/** The node and EVERY part under it at one level, with as few settings as possible (the "custom · reset" chip). */
export function setSection(permissions: Permissions, node: DisplayNode, level: PermissionLevel): Permissions {
  const next: Permissions = { ...permissions, [node.key]: level };
  const parts = partsOf(node);
  for (const part of parts) delete next[part.key];
  for (const part of parts) if (resolvePermission(next, part.key) !== level) next[part.key] = level;
  return next;
}

/** Every key under one sidebar heading at one level. */
export function setGroup(permissions: Permissions, group: DisplayGroup, level: PermissionLevel): Permissions {
  return group.children.filter((n) => !n.locked).reduce((p, node) => setSection(p, node, level), permissions);
}

/** Every key at one level. Keys the page does not know about are left alone. */
export function setAll(permissions: Permissions, level: PermissionLevel): Permissions {
  const known = new Set(allModuleKeys());
  const kept: Permissions = Object.fromEntries(Object.entries(permissions).filter(([k]) => !known.has(k)));
  return PERMISSION_GROUPS.reduce((p, group) => setGroup(p, group, level), kept);
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

const LABEL_OF = new Map(MODULE_LABELS.map((m) => [m.key, m.label]));

/** Where an unset node takes its level from, in words: "follows Staff Payroll", or "nothing set" (= Hidden). */
export function followText(permissions: Permissions | undefined, node: DisplayNode): string {
  const source = resolveSource(permissions, node.key);
  if (!source) return "nothing set";
  return `follows ${LABEL_OF.get(source) ?? source}`;
}

// ─── searching the tree ─────────────────────────────────────────────────────────

export type TreeItem = { node: DisplayNode; children: TreeItem[]; matched: boolean };
export type TreeGroup = { group: DisplayGroup; items: TreeItem[] };

const TYPE_WORD: Record<string, string> = {
  section: "Section",
  page: "Page",
  tab: "Tab",
  subtab: "Sub-tab",
  view: "View",
  feature: "Feature",
};
export const typeWord = (type: string): string => TYPE_WORD[type] ?? type;

/**
 * The tree left after a search (blank = everything). A node stays when it matches (its name or its key) or when
 * one of its parts does; a node that matches keeps all its parts, so a page's tabs show under it.
 */
export function filterTree(query: string): TreeGroup[] {
  const q = query.trim().toLowerCase();
  const hit = (n: DisplayNode) => !q || n.label.toLowerCase().includes(q) || n.key.toLowerCase().includes(q);
  const all = (n: DisplayNode): TreeItem => ({ node: n, matched: true, children: (n.children ?? []).map(all) });
  const prune = (nodes: DisplayNode[]): TreeItem[] =>
    nodes.flatMap((n): TreeItem[] => {
      if (hit(n)) return [all(n)];
      const children = prune(n.children ?? []);
      return children.length ? [{ node: n, matched: false, children }] : [];
    });
  return PERMISSION_GROUPS.map((group) => ({ group, items: prune(group.children) })).filter((g) => g.items.length);
}

/** How many nodes a search shows. */
export function visibleModuleCount(groups: TreeGroup[]): number {
  const count = (items: TreeItem[]): number => items.reduce((n, i) => n + 1 + count(i.children), 0);
  return groups.reduce((n, g) => n + count(g.items), 0);
}

/** How many nodes the search itself matched (not counting the parts shown with them or the path to them). */
export function matchedCount(groups: TreeGroup[], query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const count = (items: TreeItem[]): number =>
    items.reduce((n, i) => {
      const self = i.node.label.toLowerCase().includes(q) || i.node.key.toLowerCase().includes(q);
      return n + (self ? 1 : 0) + count(i.children);
    }, 0);
  return groups.reduce((n, g) => n + count(g.items), 0);
}

/** Every node that has parts (the ones "Expand all" opens). */
export const foldableKeys = (): string[] =>
  PERMISSION_GROUPS.flatMap((g) => {
    const out: string[] = [];
    const walk = (nodes: DisplayNode[]) => {
      for (const n of nodes) {
        if ((n.children ?? []).length) out.push(n.key);
        walk(n.children ?? []);
      }
    };
    walk(g.children);
    return out;
  });
