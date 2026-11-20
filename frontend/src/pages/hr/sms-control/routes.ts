// The addresses of SMS Control: one page, /hr/sms-control, with its tabs in the PATH and one level of nested tabs under
// Settings (/hr/sms-control/settings/limits). Pure, so the page, the sidebar link, the redirects and the tests read from one
// place. Whatever is missing or unknown is replaced by the first one (see `resolveSmsPath`); the filters of a tab stay in the
// query string (the Messages filters: ?status=failed&purpose=login; the Usage month: ?month=2026-10).

export const SMS_BASE = "/hr/sms-control";

/** The permission module of the page (lib/permission-tree.json, and permission_tree.py on the server). */
export const SMS_CONTROL_MODULE = "sms_control";

export type SmsTabKey = "overview" | "usage" | "settings" | "messages" | "test" | "setup";

export type SmsTab = { value: SmsTabKey; label: string };

/** The tabs, in order (the permission tree's order). The first one is where the bare `/hr/sms-control` lands. */
export const SMS_TABS: readonly SmsTab[] = [
  { value: "overview", label: "Overview" },
  { value: "usage", label: "Usage & Cost" },
  { value: "settings", label: "Settings" },
  { value: "messages", label: "Messages" },
  { value: "test", label: "Test" },
  { value: "setup", label: "Setup" },
];

export type SettingsSectionKey = "switches" | "limits" | "cost";

export type SmsNested = { value: SettingsSectionKey; label: string };

/** The sections of Settings, one at a time. Only Settings has a nested level. */
export const SETTINGS_SECTIONS: readonly SmsNested[] = [
  { value: "switches", label: "OTP Switches" },
  { value: "limits", label: "Limits" },
  { value: "cost", label: "Cost" },
];

/**
 * Sections that were renamed or folded into another, by their old address segment. `channel` (until 2026-11-20 SMS and
 * WhatsApp shared one "channel for codes") is gone: each has its own switch now, so a bookmark of it opens the switches.
 */
export const RETIRED_SECTIONS: Readonly<Record<string, SettingsSectionKey>> = { channel: "switches" };

export const nestedOf = (tab: SmsTabKey): readonly SmsNested[] => (tab === "settings" ? SETTINGS_SECTIONS : []);

/**
 * `/hr/sms-control/settings/limits`: the tab and the nested tab it names (each optional; a nested tab needs its tab, and is
 * left out for a tab that has no nested level).
 */
export function smsTabPath(tab?: SmsTabKey, nested?: string): string {
  return [SMS_BASE, tab, tab && nestedOf(tab).length > 0 ? nested : undefined].filter(Boolean).join("/");
}

/** Where a tab opens: itself, or its first nested tab (`/hr/sms-control/settings/switches`). */
export function smsLanding(tab: SmsTabKey): string {
  return smsTabPath(tab, nestedOf(tab)[0]?.value);
}

/** A tab's address with a query string (`messages`, `status=failed`). The query may start with `?` or not. */
export function smsPath(tab: SmsTabKey, nested?: string, query = ""): string {
  const q = query.replace(/^\?/, "");
  return `${smsTabPath(tab, nested ?? nestedOf(tab)[0]?.value)}${q ? `?${q}` : ""}`;
}

const segmentsOf = (pathname: string): string[] => {
  const path = pathname.split(/[?#]/)[0].toLowerCase();
  const rest = path.startsWith(`${SMS_BASE}/`) ? path.slice(SMS_BASE.length + 1) : "";
  return rest.split("/").filter(Boolean);
};

/** What an address names, read down the path: the tab and the nested tab, each as far as it is a real one. A retired
 *  section's old segment reads as the section that took its place. */
export function readSmsPath(pathname: string): { tab: SmsTabKey | null; nested: SettingsSectionKey | null } {
  const [tabSeg, nestedSeg] = segmentsOf(pathname);
  const tab = SMS_TABS.find((t) => t.value === tabSeg)?.value ?? null;
  const known = tab ? (nestedOf(tab).find((n) => n.value === nestedSeg)?.value ?? null) : null;
  const retired = tab === "settings" && nestedSeg ? (RETIRED_SECTIONS[nestedSeg] ?? null) : null;
  return { tab, nested: known ?? retired };
}

/** The permission key of a tab (`sms_control.test`) or of a Settings section (`sms_control.settings.limits`). Each follows
 *  the one above it while it has no setting of its own, so a role that never set one keeps what it had. */
export const smsTabModule = (tab: SmsTabKey): string => `${SMS_CONTROL_MODULE}.${tab}`;
export const smsSectionModule = (section: SettingsSectionKey): string => `${SMS_CONTROL_MODULE}.settings.${section}`;

/** The tabs and Settings sections the signed-in role may open (every one of them when left out). */
export type SmsVisible = { tabs: readonly SmsTabKey[]; sections: readonly SettingsSectionKey[] };

/**
 * The address an address really is: the bare page (or an unknown tab) is the first tab, Settings without a (known) section is
 * its first section, a retired section is the one that replaced it, and anything after the last level is dropped. With
 * `visible`, "first" is the first one the role may open, and a tab or section it may not open counts as unknown (the route
 * guard already turns such an address away). The page redirects when this is not the address it was opened at.
 */
export function resolveSmsPath(pathname: string, visible?: SmsVisible): string {
  const { tab, nested } = readSmsPath(pathname);
  const tabs = visible?.tabs ?? SMS_TABS.map((t) => t.value);
  const chosen = (tab && tabs.includes(tab) ? tab : tabs[0]) ?? SMS_TABS[0].value;
  const levels = nestedOf(chosen)
    .map((n) => n.value)
    .filter((n) => !visible || visible.sections.includes(n));
  if (nestedOf(chosen).length === 0) return smsTabPath(chosen);
  return smsTabPath(chosen, (nested && levels.includes(nested) ? nested : levels[0]) ?? undefined);
}

/** The address with the trailing slash dropped, so `/hr/sms-control/messages/` is the page itself. */
export const cleanSmsPath = (pathname: string): string => pathname.replace(/\/+$/, "") || "/";

/**
 * The query keys each tab's own view owns: they stay with their tab when another is opened from the tab row, and come back
 * when it is opened again (so the Messages filters do not follow HR to Usage, nor the Usage month to Messages).
 */
export const SMS_OWN_KEYS: Readonly<Record<string, readonly string[]>> = {
  messages: ["status", "purpose", "q", "from", "to", "page", "size"],
  usage: ["month"],
};
