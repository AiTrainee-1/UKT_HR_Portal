// The addresses of Phone Notify Control: one page, /hr/phone-notify-control, with its tabs in the PATH, like SMS Control
// (/hr/phone-notify-control/overview, /messages, /employees, /controls, /send, /configuration, /message-text, /settings).
// Each tab's address is its own permission key's route in the tree, so the route guard and HrLayout gate and lock it. Pure,
// so the page, the sidebar link, the redirects and the tests read from one place. The bare page, or an unknown tab, is
// replaced by the first tab the role may open (see `resolvePnPath`); the filters of a tab stay in the query string
// (?status=failed&kind=late_alert). A tab's key is its permission key's last part; its address is the same word, except
// where PN_TAB_SEGMENT says otherwise (Message Text: key `templates`, address `/message-text`).

export const PN_BASE = "/hr/phone-notify-control";

/** The permission key of the page (lib/permission-modules.ts reads it from the tree; permission_tree.py on the server). */
export const PHONE_NOTIFY_MODULE = "phone_notify_control";

export type PnTabKey =
  "overview" | "messages" | "employees" | "controls" | "send" | "configuration" | "templates" | "settings";

export type PnTab = { value: PnTabKey; label: string };

/** The tabs, in order (the tree's order). The first one is where the bare `/hr/phone-notify-control` lands. */
export const PN_TABS: readonly PnTab[] = [
  { value: "overview", label: "Overview" },
  { value: "messages", label: "Messages" },
  { value: "employees", label: "Employees" },
  { value: "controls", label: "Controls" },
  { value: "send", label: "Send a message" },
  { value: "configuration", label: "Configuration" },
  // the title and wording of each kind of notification (2026-11-17)
  { value: "templates", label: "Message Text" },
  // who receives phone notifications at all (2026-11-17)
  { value: "settings", label: "Settings" },
];

const TAB_VALUES: readonly PnTabKey[] = PN_TABS.map((t) => t.value);

/** The tabs whose address is not their key (the tree's route for that key). */
export const PN_TAB_SEGMENT: Partial<Record<PnTabKey, string>> = { templates: "message-text" };

/** The last part of a tab's address (`message-text` for `templates`). */
export const pnTabSegment = (tab: PnTabKey): string => PN_TAB_SEGMENT[tab] ?? tab;

/** The address of a tab (`/hr/phone-notify-control/messages`); the bare page without one. */
export function pnTabPath(tab?: PnTabKey): string {
  return tab ? `${PN_BASE}/${pnTabSegment(tab)}` : PN_BASE;
}

/** A tab's address with a query string (`messages`, `status=failed`). The query may start with `?` or not. */
export function pnPath(tab: PnTabKey, query = ""): string {
  const q = query.replace(/^\?/, "");
  return `${pnTabPath(tab)}${q ? `?${q}` : ""}`;
}

/** The address with the trailing slash dropped, so `/hr/phone-notify-control/messages/` is the page itself. */
export const cleanPnPath = (pathname: string): string => pathname.replace(/\/+$/, "") || "/";

/**
 * The tab an address names, when it is a real one (the bare page, an unknown tab or another page: null). Only a tab's own
 * address counts: `/templates` is not the Message Text tab (its address is `/message-text`).
 */
export function readPnPath(pathname: string): PnTabKey | null {
  const path = pathname.split(/[?#]/)[0].toLowerCase();
  if (!path.startsWith(`${PN_BASE}/`)) return null;
  const segment = path.slice(PN_BASE.length + 1).split("/")[0];
  return TAB_VALUES.find((t) => pnTabSegment(t) === segment) ?? null;
}

/** The permission key of a tab (`phone_notify_control.messages`). It follows the page while it has no setting of its own. */
export const pnTabModule = (tab: PnTabKey): string => `${PHONE_NOTIFY_MODULE}.${tab}`;

/**
 * The address an address really is: the bare page (or an unknown tab) is the first tab, and anything after the tab is dropped.
 * With `visible` (the tabs the role may open), "first" is the first of them, and a tab the role may not open counts as unknown
 * (the route guard already turns such an address away). The page redirects when this is not the address it was opened at.
 */
export function resolvePnPath(pathname: string, visible?: readonly PnTabKey[]): string {
  const tab = readPnPath(pathname);
  const tabs = visible ?? TAB_VALUES;
  const chosen = (tab && tabs.includes(tab) ? tab : tabs[0]) ?? TAB_VALUES[0];
  return pnTabPath(chosen);
}
