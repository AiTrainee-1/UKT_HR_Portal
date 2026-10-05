// Whether the signed-in account can use the HR portal too. The Managing Director's own portal needs no role, but an
// account that was an HR user before it became the MD keeps its HR access, and then a link between the two portals helps.

import type { PermissionLevel } from "@/lib/api-client/custom-hooks";

type AccessUser = { isSuperAdmin?: boolean; permissions?: Record<string, PermissionLevel> } | null | undefined;

export function hasHrAccess(user: AccessUser): boolean {
  if (!user) return false;
  if (user.isSuperAdmin) return true;
  return Object.values(user.permissions ?? {}).some((level) => level === "view" || level === "edit");
}
