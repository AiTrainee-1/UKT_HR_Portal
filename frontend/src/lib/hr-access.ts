// HR account categories (Admin / HR Manager / HR Assistant) and approval rights, mirrored from backend/api/hr_access.py.
// The server decides; this file only lets the screens say the same thing before they ask (what a role or an account's own
// changes would give, which approvals are locked for HR Assistants). Keep APPROVAL_KINDS and ASSISTANT_LOCKED in step with
// the backend: tests_hr_categories.py pins the backend list, hr-access.test.ts pins this one.

import type { PermissionLevel } from "@/lib/api-client/custom-hooks";
import { MODULE_TREE, resolvePermission } from "@/lib/permission-modules";

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

export type ApprovalKind = { key: string; label: string; module: string; description: string };

/** Every kind of request HR decides (Holiday / Sunday work is decided by the Department Head only). */
export const APPROVAL_KINDS: ApprovalKind[] = [
  { key: "leave", label: "Leave", module: "leave", description: "Approve or reject employees' leave requests." },
  {
    key: "permission",
    label: "Permission",
    module: "requests",
    description: "Approve or reject Late-In / Early-Out / One-Hour permissions.",
  },
  {
    key: "casual_leave",
    label: "Casual Leave",
    module: "casual_leave",
    description: "Approve or reject Casual Leave requests.",
  },
  {
    key: "missing_punch",
    label: "Missing Punch",
    module: "missing_punch",
    description: "Approve or reject missed-punch requests.",
  },
  {
    key: "attendance_correction",
    label: "Attendance edits",
    module: "attendance",
    description: "Give HR's approval to an attendance change (after the Department Head's).",
  },
  {
    key: "on_duty",
    label: "On-Duty requests",
    module: "geo_attendance",
    description: "Approve or reject On-Duty (Geo Attendance) requests.",
  },
  {
    key: "on_duty_punch",
    label: "On-Duty punches",
    module: "geo_attendance",
    description: "Accept or reject the punches made On-Duty.",
  },
  { key: "outpass", label: "Gate Outpass", module: "requests", description: "Approve or reject outpass requests." },
  {
    key: "request",
    label: "Other requests",
    module: "requests",
    description: "Approve or reject employees' general requests.",
  },
  {
    key: "resignation",
    label: "Resignation",
    module: "recruitment.resignations",
    description: "Approve or reject resignations.",
  },
  { key: "advance", label: "Advance", module: "settlement", description: "Approve or reject salary advances." },
];

export const APPROVAL_LABEL: Record<string, string> = Object.fromEntries(APPROVAL_KINDS.map((k) => [k.key, k.label]));

/** What an HR Assistant may never approve, and why (the server refuses it whatever a role or an override says). */
export const ASSISTANT_LOCKED: Record<string, string> = {
  missing_punch: "HR Assistants can't approve missing-punch requests. An HR Manager or the Super Admin decides them.",
  attendance_correction:
    "HR Assistants can't approve attendance edits. An HR Manager or the Super Admin gives HR's approval.",
};

export const isLocked = (category: string | null | undefined, kind: string): boolean =>
  category === "hr_assistant" && kind in ASSISTANT_LOCKED;

export type Approvals = Record<string, boolean>;
export type Permissions = Record<string, PermissionLevel>;
export type Overrides = { modules?: Permissions; approvals?: Approvals };

const CHILDREN: Record<string, string[]> = Object.fromEntries(
  MODULE_TREE.map((n) => [n.key, (n.children ?? []).map((c) => c.key)]),
);

/** The role's levels with an account's own changes on top. A change on a section takes its sub-modules with it, unless
 *  the account has a change of its own for that sub-module (backend permission_registry.apply_module_overrides). */
export function applyModuleOverrides(role: Permissions | undefined, modules: Permissions | undefined): Permissions {
  const out: Permissions = { ...(role ?? {}) };
  const changes = modules ?? {};
  const keys = Object.keys(changes).sort((a, b) => a.split(".").length - b.split(".").length);
  for (const key of keys) {
    out[key] = changes[key];
    for (const child of CHILDREN[key] ?? []) if (!(child in changes)) delete out[child];
  }
  return out;
}

/** {kind: may approve} for an account: the role's approvals (or, with none, approve = edit on the module), the account's
 *  own changes, nobody approves what they cannot open, and the HR Assistant locks (backend effective_approvals). */
export function effectiveApprovals(opts: {
  rolePermissions?: Permissions;
  roleApprovals?: Approvals | null;
  overrides?: Overrides;
  category: string;
}): Approvals {
  const permissions = applyModuleOverrides(opts.rolePermissions, opts.overrides?.modules);
  const own = opts.overrides?.approvals ?? {};
  const out: Approvals = {};
  for (const kind of APPROVAL_KINDS) {
    const level = resolvePermission(permissions, kind.module);
    let allowed = opts.roleApprovals ? !!opts.roleApprovals[kind.key] : level === "edit";
    if (kind.key in own) allowed = !!own[kind.key];
    if (level === "hidden") allowed = false;
    if (isLocked(opts.category, kind.key)) allowed = false;
    out[kind.key] = allowed;
  }
  return out;
}

/** A role with no approvals of its own keeps the old rule; this is what it gives, so "Set approvals separately" starts
 *  from exactly what the role allows today. */
export function legacyApprovals(permissions: Permissions | undefined, category: string = ""): Approvals {
  const out: Approvals = {};
  for (const kind of APPROVAL_KINDS) {
    out[kind.key] = resolvePermission(permissions, kind.module) === "edit" && !isLocked(category, kind.key);
  }
  return out;
}

/** Every approval on or off at once; locked ones stay off. */
export function setAllApprovals(value: boolean, category: string = ""): Approvals {
  return Object.fromEntries(APPROVAL_KINDS.map((k) => [k.key, value && !isLocked(category, k.key)]));
}

/** How many approvals are switched on. */
export const approvalCount = (approvals: Approvals | null | undefined): number =>
  APPROVAL_KINDS.filter((k) => !!approvals?.[k.key]).length;

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
 *  (and an older backend) as before, which the module's view-only lock already governs; else its approvals. */
export function canApprove(user: AccessInfo | null | undefined, kind: string): boolean {
  if (!user || user.role !== "hr") return true;
  if (user.isSuperAdmin) return true;
  if (user.approvalMode !== "explicit") return true;
  return !!user.approvals?.[kind];
}
