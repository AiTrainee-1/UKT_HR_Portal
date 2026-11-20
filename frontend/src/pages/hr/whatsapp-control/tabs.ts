// The tabs of WhatsApp Control (/hr/whatsapp-control) and the permission key of each (Account Management -> Roles &
// Permissions). All of them live at the page's one address; the open one is `?tab=` (none: the Overview). A tab with no
// setting of its own follows the page's key (whatsapp_control). The order and labels are the permission tree's
// (backend/api/permission_tree.py, frontend/src/lib/permission-tree.json); access.test.ts fails when they drift apart.

export const WA_PATH = "/hr/whatsapp-control";
export const WA_MODULE = "whatsapp_control";

export type WaTab =
  "overview" | "usage" | "controls" | "templates" | "otp" | "messages" | "employees" | "test" | "config";

/** In the order they are shown (the permission tree's order). */
export const WA_TABS: readonly { value: WaTab; label: string }[] = [
  { value: "overview", label: "Overview" },
  { value: "usage", label: "Usage & Cost" },
  { value: "controls", label: "Message Controls" },
  { value: "templates", label: "Templates" },
  { value: "otp", label: "OTP" },
  { value: "messages", label: "Messages" },
  { value: "employees", label: "Employees" },
  { value: "test", label: "Send a test" },
  { value: "config", label: "Settings" },
];

/** The permission key of a tab: whatsapp_control.<tab>. */
export const waTabModule = (tab: string): string => `${WA_MODULE}.${tab}`;

/** The address of a tab (the Overview is the page's own address). */
export const waTabHref = (tab: WaTab): string => (tab === "overview" ? WA_PATH : `${WA_PATH}?tab=${tab}`);

/** Whether the signed-in role may open a tab, and change things on it: what each tab hands its children so a card never
 *  asks the server for something guarded by a tab the role cannot see (the server refuses it, see permission_tree.py). */
export type WaAccess = { canOpen: (tab: WaTab) => boolean; canEdit: (tab: WaTab) => boolean };
