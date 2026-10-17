import { permissionLevel, type PermissionLevel } from "@/contexts/AuthContext";
import { SETTINGS_TAB_MODULE, SUPER_ADMIN_ONLY_TABS } from "./constants";

type SettingsUser = Parameters<typeof permissionLevel>[0];

/**
 * What the signed-in login may do in one Settings tab. A tab that is a role permission follows the role; a super-admin-only
 * tab (SUPER_ADMIN_ONLY_TABS) is editable for the super admin and hidden for everybody else, whatever their role says. The
 * answer for "nobody signed in yet" is hidden, so a deep link never shows such a tab before the login is known.
 */
export function settingsTabLevel(user: SettingsUser, tab: string): PermissionLevel {
  if (SUPER_ADMIN_ONLY_TABS.has(tab)) {
    return user && user.role === "hr" && user.isSuperAdmin === true ? "edit" : "hidden";
  }
  return permissionLevel(user, SETTINGS_TAB_MODULE[tab] ?? "settings");
}
