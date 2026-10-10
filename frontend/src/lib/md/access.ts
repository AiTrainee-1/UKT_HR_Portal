// Whether the signed-in account can use the HR portal too. The Managing Director's own portal needs no role, but an
// account that was an HR user before it became the MD keeps its HR access, and then a link between the two portals helps.

import type { PermissionLevel } from "@/lib/api-client/custom-hooks";

type AccessUser =
  | {
      isSuperAdmin?: boolean;
      permissions?: Record<string, PermissionLevel>;
      rolePermissions?: Record<string, PermissionLevel>;
    }
  | null
  | undefined;

/** Does the account have HR access of its own (a role, or super admin)? The MD's added access to the pages the MD portal
 *  reproduces is not that: `rolePermissions` is the role alone (an older server sends only `permissions`). */
export function hasHrAccess(user: AccessUser): boolean {
  if (!user) return false;
  if (user.isSuperAdmin) return true;
  return Object.values(user.rolePermissions ?? user.permissions ?? {}).some(
    (level) => level === "view" || level === "edit",
  );
}
