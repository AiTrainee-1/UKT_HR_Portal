// Where the Endpoint Sharing tab is, in the page address: /hr/settings?tab=endpoint_sharing&sub=endpoints&endpoint=12&section=data
//   sub      the subtab: endpoints | guide | activity
//   endpoint the endpoint opened in the editor (a number, or "new"); under sub=activity, the endpoint whose log is shown
//   section  the nested subtab of the editor: basics | data | access | guide

export const SHARING_TAB = "endpoint_sharing";
export const SUBTABS = ["endpoints", "guide", "activity"] as const;
export const SECTIONS = ["basics", "data", "access", "guide"] as const;

export type Subtab = (typeof SUBTABS)[number];
export type Section = (typeof SECTIONS)[number];
export type SharingAddress = { sub: Subtab; endpoint: number | "new" | null; section: Section };

export function parseSharingAddress(search: string): SharingAddress {
  const params = new URLSearchParams(search);
  const sub = SUBTABS.find((s) => s === params.get("sub")) ?? "endpoints";
  const raw = params.get("endpoint");
  const endpoint = raw === "new" ? "new" : raw && /^\d+$/.test(raw) ? Number(raw) : null;
  const section = SECTIONS.find((s) => s === params.get("section")) ?? "basics";
  return { sub, endpoint, section };
}

export function sharingAddress(address: SharingAddress): string {
  const params = new URLSearchParams({ tab: SHARING_TAB, sub: address.sub });
  if (address.endpoint !== null) params.set("endpoint", String(address.endpoint));
  if (address.endpoint !== null && address.sub === "endpoints") params.set("section", address.section);
  return `/hr/settings?${params.toString()}`;
}
