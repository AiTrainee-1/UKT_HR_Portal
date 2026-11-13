// HR account categories (Admin / HR Manager / HR Assistant) and approval rights, mirrored from backend/api/hr_access.py.
// The server decides; this file only lets the screens say the same thing before they ask (what a role or an account's own
// changes would give, which approvals are locked for HR Assistants). The approval kinds come from permission-tree.json,
// which backend tests_permission_tree.py keeps equal to hr_access.APPROVAL_KINDS.

import type { PermissionLevel } from "@/lib/api-client/custom-hooks";
import { resolvePermission } from "@/lib/permission-modules";
import treeJson from "./permission-tree.json";

export type Category = "admin" | "hr_manager" | "hr_assistant";
/** What the screens call an account: its category, or the Super Admin / the Managing Director. */
export type DisplayCategory = Category | "super_admin" | "md";
/** "" = a role for any account. */
export type RoleCategory = "" | "hr_manager" | "hr_assistant";

export const CATEGORY_LABEL: Record<DisplayCategory, string> = {
  admin: "Admin",
  hr_manager: "HR Manager",
  hr_assistant: "HR Assistant",
  super_admin: "Super Admin",
  md: "Managing Director",
};

export const STAFF_CATEGORIES: Category[] = ["hr_manager", "hr_assistant"];
export const isStaffCategory = (c: string | null | undefined): c is "hr_manager" | "hr_assistant" =>
  c === "hr_manager" || c === "hr_assistant";

export type ApprovalKind = {
  key: string;
  label: string;
  /** The module that owns the requests: approving needs at least View on it (and, on the original rule, Edit). */
  module: string;
  description: string;
  /** The heading it is listed under (APPROVAL_GROUPS). */
  group: string;
  /** An older, wider kind it was split out of: it follows that switch until it has its own. */
  replaces?: string;
  /** An extra right on top of Edit on the module (never instead of it); unset on a role with switches = follows Edit. */
  needsEdit?: boolean;
  /** An extra condition in plain words. */
  note?: string;
};

type TreeApprovals = {
  approvals: ApprovalKind[];
  approvalGroups: { id: string; label: string }[];
  approvalInfo: { key: string; label: string; group: string; text: string }[];
  assistantLocked: Record<string, string>;
};
const TREE = treeJson as unknown as TreeApprovals;

/** Every kind of decision HR makes, each with its own switch. */
export const APPROVAL_KINDS: ApprovalKind[] = TREE.approvals;
/** The headings of the Approvals list (the page each decision is made on), in order. */
export const APPROVAL_GROUPS: { id: string; label: string }[] = TREE.approvalGroups;
/** Decisions HR does not make, listed without a switch (Holiday / Sunday work: the Department Head only). */
export const APPROVAL_INFO: { key: string; label: string; group: string; text: string }[] = TREE.approvalInfo;

export const APPROVAL_LABEL: Record<string, string> = {
  ...Object.fromEntries(APPROVAL_KINDS.map((k) => [k.key, k.label])),
  request: "Other requests",
  advance: "Advance",
};

/** The older kinds that were split (2026-11-11): "request" -> one kind per request type, "advance" -> general / term. */
export const APPROVAL_ALIASES: Record<string, string[]> = {
  request: APPROVAL_KINDS.filter((k) => k.replaces === "request").map((k) => k.key),
  advance: APPROVAL_KINDS.filter((k) => k.replaces === "advance").map((k) => k.key),
};

/** What an HR Assistant may never approve, and why (the server refuses it whatever a role or an override says). */
export const ASSISTANT_LOCKED: Record<string, string> = TREE.assistantLocked;

export const isLocked = (category: string | null | undefined, kind: string): boolean =>
  category === "hr_assistant" && kind in ASSISTANT_LOCKED;

export type Approvals = Record<string, boolean>;
export type Permissions = Record<string, PermissionLevel>;
export type Overrides = { modules?: Permissions; approvals?: Approvals };

/** The approval kind of one request: an employee request by its type, an advance by general / term (hr_access.kind_for). */
export function kindFor(kind: string, row?: { requestType?: string | null; advanceType?: string | null }): string {
  if (kind === "request") {
    const k = `request_${row?.requestType ?? ""}`;
    return APPROVAL_ALIASES.request.includes(k) ? k : "request_general";
  }
  if (kind === "advance") return row?.advanceType === "term" ? "advance_term" : "advance_general";
  return kind;
}

/** The role's levels with an account's own changes on top. A change on a section takes every part of it (its dotted keys)
 *  with it, unless the account has a change of its own for that part (backend permission_registry.apply_module_overrides). */
export function applyModuleOverrides(role: Permissions | undefined, modules: Permissions | undefined): Permissions {
  const out: Permissions = { ...(role ?? {}) };
  const changes = modules ?? {};
  const keys = Object.keys(changes).sort((a, b) => a.split(".").length - b.split(".").length);
  for (const key of keys) {
    out[key] = changes[key];
    for (const part of Object.keys(out)) if (part.startsWith(key + ".") && !(part in changes)) delete out[part];
  }
  return out;
}

/** A switch set for this kind, or for the older kind it was split out of; undefined when neither is set. */
function ownSwitch(switches: Approvals | null | undefined, kind: ApprovalKind): boolean | undefined {
  if (!switches) return undefined;
  if (kind.key in switches) return !!switches[kind.key];
  if (kind.replaces && kind.replaces in switches) return !!switches[kind.replaces];
  return undefined;
}

/** What a role's switches say about one kind (unset: off, except a "needs Edit" kind: Edit decides, as before). */
export function roleSwitch(roleApprovals: Approvals, kind: ApprovalKind, level: PermissionLevel): boolean {
  const own = ownSwitch(roleApprovals, kind);
  if (own !== undefined) return own;
  return kind.needsEdit ? level === "edit" : false;
}

/** {kind: may approve} for an account: the role's approvals (or, with none, approve = edit on the module), the account's
 *  own changes, nobody approves what they cannot open, a "needs Edit" kind never without Edit, and the HR Assistant locks
 *  (backend effective_approvals). */
export function effectiveApprovals(opts: {
  rolePermissions?: Permissions;
  roleApprovals?: Approvals | null;
  overrides?: Overrides;
  category: string;
}): Approvals {
  const permissions = applyModuleOverrides(opts.rolePermissions, opts.overrides?.modules);
  const out: Approvals = {};
  for (const kind of APPROVAL_KINDS) {
    const level = resolvePermission(permissions, kind.module);
    let allowed = opts.roleApprovals ? roleSwitch(opts.roleApprovals, kind, level) : level === "edit";
    const own = ownSwitch(opts.overrides?.approvals, kind);
    if (own !== undefined) allowed = own;
    if (level === "hidden") allowed = false;
    if (kind.needsEdit && level !== "edit") allowed = false;
    if (isLocked(opts.category, kind.key)) allowed = false;
    out[kind.key] = allowed;
  }
  return out;
}

/** A role with no approvals of its own keeps the old rule; this is what it gives, so "Set approvals separately" starts
 *  from exactly what the role allows today. A "needs Edit" kind is left unset: it keeps following Edit until it is set. */
export function legacyApprovals(permissions: Permissions | undefined, category: string = ""): Approvals {
  const out: Approvals = {};
  for (const kind of APPROVAL_KINDS) {
    if (kind.needsEdit) continue;
    out[kind.key] = resolvePermission(permissions, kind.module) === "edit" && !isLocked(category, kind.key);
  }
  return out;
}

/**
 * A role's stored switches as the editor shows them: every kind set (a kind that was split out of an older one takes the
 * old switch, a "needs Edit" kind never set takes Edit, any other unset kind is off), and the older keys dropped. Saving
 * this gives exactly what the role allowed before.
 */
export function normalizeApprovals(approvals: Approvals, permissions: Permissions | undefined): Approvals {
  const out: Approvals = {};
  for (const kind of APPROVAL_KINDS) {
    out[kind.key] = roleSwitch(approvals, kind, resolvePermission(permissions, kind.module));
  }
  return out;
}

/** An account's own switches with the older keys spread over the kinds that replaced them (the account editor). */
export function normalizeOverrideApprovals(approvals: Approvals | undefined): Approvals {
  const out: Approvals = {};
  for (const [key, value] of Object.entries(approvals ?? {})) {
    if (key in APPROVAL_ALIASES) {
      for (const k of APPROVAL_ALIASES[key]) if (!(k in (approvals ?? {}))) out[k] = value;
    } else out[key] = value;
  }
  return out;
}

/** Every approval on or off at once; locked ones stay off. */
export function setAllApprovals(value: boolean, category: string = ""): Approvals {
  return Object.fromEntries(APPROVAL_KINDS.map((k) => [k.key, value && !isLocked(category, k.key)]));
}

/** How many approvals are switched on (a kind split out of an older one counts the old switch until it has its own). */
export const approvalCount = (approvals: Approvals | null | undefined): number =>
  APPROVAL_KINDS.filter((k) => !!ownSwitch(approvals, k)).length;

/** Remove an account's own change for one module or one approval ("follow the role again"). */
export function clearOverride(overrides: Overrides, part: "modules" | "approvals", key: string): Overrides {
  const next: Overrides = { modules: { ...(overrides.modules ?? {}) }, approvals: { ...(overrides.approvals ?? {}) } };
  delete (next[part] as Record<string, unknown>)[key];
  return next;
}

/** An account's own changes as the API wants them: empty parts left out, locked approvals never switched on. */
export function cleanOverrides(overrides: Overrides, category: string): Overrides {
  const out: Overrides = {};
  const modules = overrides.modules ?? {};
  const approvals = Object.fromEntries(
    Object.entries(overrides.approvals ?? {}).filter(([k, v]) => !(v && isLocked(category, k))),
  );
  if (Object.keys(modules).length) out.modules = { ...modules };
  if (Object.keys(approvals).length) out.approvals = approvals;
  return out;
}

export const overrideCount = (overrides: Overrides | null | undefined): number =>
  Object.keys(overrides?.modules ?? {}).length + Object.keys(overrides?.approvals ?? {}).length;

/** What /auth/me says about the signed-in account (all optional: an older backend sends none of it). */
export type AccessInfo = {
  role?: string;
  isSuperAdmin?: boolean;
  approvalMode?: "explicit" | "legacy";
  approvals?: Approvals;
};

/** May the signed-in account approve / reject this kind of request? The Super Admin always; an account on the old rule
 *  (and an older backend) as before, which the module's view-only lock already governs; else its approvals. "request" and
 *  "advance" mean "any of their types" (each row's own `approval` block, or kindFor, names the exact one). */
export function canApprove(user: AccessInfo | null | undefined, kind: string): boolean {
  if (!user || user.role !== "hr") return true;
  if (user.isSuperAdmin) return true;
  if (user.approvalMode !== "explicit") return true;
  const approvals = user.approvals ?? {};
  if (kind in APPROVAL_ALIASES) {
    // an older backend still sends the old key
    return kind in approvals ? !!approvals[kind] : APPROVAL_ALIASES[kind].some((k) => !!approvals[k]);
  }
  return !!approvals[kind];
}
