// The addresses of SMS Control: one page, /hr/sms-control, with its tabs in the PATH and one level of nested tabs under
// Settings (/hr/sms-control/settings/limits). Pure, so the page, the sidebar link, the redirects and the tests read from one
// place. Whatever is missing or unknown is replaced by the first one (see `resolveSmsPath`); the filters of a page stay in
// the query string (the Messages filters: ?status=failed&purpose=login).

export const SMS_BASE = "/hr/sms-control";

/** The permission module of the page (lib/permission-modules.ts, and permission_registry.py on the server). */
export const SMS_CONTROL_MODULE = "sms_control";

export type SmsTabKey = "overview" | "settings" | "messages" | "test" | "setup";

export type SmsTab = { value: SmsTabKey; label: string };

/** The tabs, in order. The first one is where the bare `/hr/sms-control` lands. */
export const SMS_TABS: readonly SmsTab[] = [
  { value: "overview", label: "Overview" },
  { value: "settings", label: "Settings" },
  { value: "messages", label: "Messages" },
  { value: "test", label: "Test" },
  { value: "setup", label: "Setup" },
];

export type SettingsSectionKey = "channel" | "limits" | "switches";

export type SmsNested = { value: SettingsSectionKey; label: string };

/** The sections of Settings, one at a time. Only Settings has a nested level. */
export const SETTINGS_SECTIONS: readonly SmsNested[] = [
  { value: "channel", label: "Channel" },
  { value: "limits", label: "Limits" },
  { value: "switches", label: "Switches" },
];

export const nestedOf = (tab: SmsTabKey): readonly SmsNested[] => (tab === "settings" ? SETTINGS_SECTIONS : []);

/**
 * `/hr/sms-control/settings/limits`: the tab and the nested tab it names (each optional; a nested tab needs its tab, and is
 * left out for a tab that has no nested level).
 */
export function smsTabPath(tab?: SmsTabKey, nested?: string): string {
  return [SMS_BASE, tab, tab && nestedOf(tab).length > 0 ? nested : undefined].filter(Boolean).join("/");
}

/** Where a tab opens: itself, or its first nested tab (`/hr/sms-control/settings/channel`). */
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

/** What an address names, read down the path: the tab and the nested tab, each as far as it is a real one. */
export function readSmsPath(pathname: string): { tab: SmsTabKey | null; nested: SettingsSectionKey | null } {
  const [tabSeg, nestedSeg] = segmentsOf(pathname);
  const tab = SMS_TABS.find((t) => t.value === tabSeg)?.value ?? null;
  const nested = tab ? (nestedOf(tab).find((n) => n.value === nestedSeg)?.value ?? null) : null;
  return { tab, nested };
}

/**
 * The address an address really is: the bare page (or an unknown tab) is Overview, Settings without a (known) section is its
 * first one, and anything after the last level is dropped. The page redirects when this is not the address it was opened at.
 */
export function resolveSmsPath(pathname: string): string {
  const { tab, nested } = readSmsPath(pathname);
  const chosen = tab ?? SMS_TABS[0].value;
  const levels = nestedOf(chosen);
  if (levels.length === 0) return smsTabPath(chosen);
  return smsTabPath(chosen, nested ?? levels[0].value);
}

/** The address with the trailing slash dropped, so `/hr/sms-control/messages/` is the page itself. */
export const cleanSmsPath = (pathname: string): string => pathname.replace(/\/+$/, "") || "/";
