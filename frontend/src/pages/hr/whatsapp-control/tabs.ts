// The tabs of WhatsApp Control (/hr/whatsapp-control) and the permission key of each (Account Management -> Roles &
// Permissions). All of them live at the page's one address; the open one is `?tab=` (none: the Overview). A tab with no
// setting of its own follows the page's key (whatsapp_control).

export const WA_PATH = "/hr/whatsapp-control";
export const WA_MODULE = "whatsapp_control";

export type WaTab = "overview" | "messages" | "employees" | "controls" | "templates" | "test" | "config";

/** In the order they are shown (the permission tree's order). */
export const WA_TABS: readonly { value: WaTab; label: string }[] = [
  { value: "overview", label: "Overview" },
  { value: "messages", label: "Messages" },
  { value: "employees", label: "Employees" },
  { value: "controls", label: "Feature Controls" },
  { value: "templates", label: "Message Text" },
  { value: "test", label: "Send a test" },
  { value: "config", label: "Configuration" },
];

/** The permission key of a tab: whatsapp_control.<tab>. */
export const waTabModule = (tab: string): string => `${WA_MODULE}.${tab}`;
