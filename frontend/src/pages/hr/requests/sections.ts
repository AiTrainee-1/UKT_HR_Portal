// Requests page: its three sections ("Requests", "HoD's", "Notify") and what the address says about them.
//
// The section is `?tab=` (none = Requests, so every old link still opens the list). The Requests section keeps its own
// `?kind=` (the sub-tab of a kind of request) and understands `?focus=<id>`: open that request's details once the list is in.
// HoD's links every pending request to `/hr/requests?kind=<category>&focus=<id>`; a category key that is not a hub kind
// (the head's "attendance" is the hub's "attendance_correction") is read through KIND_ALIASES.

export type PageSection = "requests" | "hods" | "notify";

export const PAGE_SECTIONS: { value: PageSection; label: string }[] = [
  { value: "requests", label: "Requests" },
  { value: "hods", label: "HoD's" },
  { value: "notify", label: "Notify" },
];

const params = (search: string) => new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);

/** The section an address names; anything else is the Requests list. */
export function sectionFromSearch(search: string): PageSection {
  const tab = (params(search).get("tab") ?? "").toLowerCase();
  return tab === "hods" || tab === "notify" ? tab : "requests";
}

/** The query string (without "?") for another section: the other keys stay, `focus` (a one-time instruction) goes. */
export function searchForSection(search: string, section: PageSection): string {
  const next = params(search);
  next.delete("focus");
  if (section === "requests") next.delete("tab");
  else next.set("tab", section);
  return next.toString();
}

/** The head's category keys that the Requests hub calls by another name. */
export const KIND_ALIASES: Readonly<Record<string, string>> = {
  attendance: "attendance_correction",
};

export const hubKind = (raw: string | null | undefined): string | null => {
  const k = (raw ?? "").trim();
  return k ? (KIND_ALIASES[k] ?? k) : null;
};

export type FocusTarget = { kind: string; id: number };

/** The request `?kind=&focus=` asks to open, or null. */
export function focusFromSearch(search: string): FocusTarget | null {
  const p = params(search);
  const kind = hubKind(p.get("kind"));
  const id = Number(p.get("focus"));
  return kind && Number.isInteger(id) && id > 0 ? { kind, id } : null;
}

/** The hub's key of a focus target ("leave-12"). */
export const focusKey = (t: FocusTarget) => `${t.kind}-${t.id}`;

/**
 * What a link from HoD's opens: when it is this page (`/hr/requests?...`), the request to open in the Requests section,
 * so the page switches in place instead of reloading; null for any other address (it is then simply followed).
 */
export function requestLinkTarget(openPath: string): FocusTarget | null {
  if (!openPath) return null;
  const [path, query = ""] = openPath.split("?");
  if (path.replace(/\/+$/, "") !== "/hr/requests") return null;
  return focusFromSearch(query);
}
