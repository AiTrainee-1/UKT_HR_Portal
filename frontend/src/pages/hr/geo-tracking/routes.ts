// Geo Attendance is a module of its own with one address per section:
//
//   /hr/geo-attendance/approvals              On-Duty Approvals (where the bare /hr/geo-attendance lands)
//   /hr/geo-attendance/verifications          Punch Verifications
//   /hr/geo-attendance/live-map               Live Map
//   /hr/geo-attendance/journeys               Journey History (the list, and the Journey Simulation picker)
//   /hr/geo-attendance/journeys/12            one journey
//   /hr/geo-attendance/journeys/12/simulate   that journey replayed on the map
//   /hr/geo-attendance/on-duty-map            On-Duty Map
//   /hr/geo-attendance/settings               Tracking Settings
//
// The addresses of the old single page (/hr/geo-attendance?tab=map, ?tab=journeys&journey=12 ...) are still understood: they
// are sent on to the new ones, so a bookmark, a notification or a link written before the move keeps working.
// Pure functions (no React): tested in routes.test.ts.

export const GEO_BASE = "/hr/geo-attendance";

export type GeoSection = "approvals" | "verifications" | "live-map" | "journeys" | "on-duty-map" | "settings";

export const GEO_SECTIONS: readonly GeoSection[] = [
  "approvals",
  "verifications",
  "live-map",
  "journeys",
  "on-duty-map",
  "settings",
];

export const DEFAULT_GEO_SECTION: GeoSection = "approvals";

/** What each section is called: the tab strip, the sidebar and the page search use the same words. */
export const GEO_SECTION_LABEL: Record<GeoSection, string> = {
  approvals: "On-Duty Approvals",
  verifications: "Punch Verifications",
  "live-map": "Live Map",
  journeys: "Journey History",
  "on-duty-map": "On-Duty Map",
  settings: "Tracking Settings",
};

/** The tab names of the old single page. */
const OLD_TABS: Record<string, GeoSection> = {
  approvals: "approvals",
  verifications: "verifications",
  map: "live-map",
  journeys: "journeys",
  onduty: "on-duty-map",
  tracking: "settings",
};

export type GeoView = "list" | "journey" | "simulate";

export type GeoRoute = {
  section: GeoSection;
  /** Journey History: the journey that is open (null on the list). */
  journey: number | null;
  view: GeoView;
};

/** The address of a section (and of a journey, or of its replay). */
export function geoPath(section: GeoSection, journey: number | null = null, view: GeoView = "journey"): string {
  if (section === "journeys" && journey !== null) {
    return `${GEO_BASE}/journeys/${journey}${view === "simulate" ? "/simulate" : ""}`;
  }
  return `${GEO_BASE}/${section}`;
}

export const journeyPath = (id: number) => geoPath("journeys", id, "journey");
export const simulatePath = (id: number) => geoPath("journeys", id, "simulate");

const positiveInt = (text: string | null | undefined): number | null => {
  if (!text || !/^\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/** The search part of an address without the old page's own parameters (tab, journey); "" when nothing else is left. */
function otherParams(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("tab");
  params.delete("journey");
  const text = params.toString();
  return text ? `?${text}` : "";
}

/**
 * What an address under /hr/geo-attendance shows, or where it must be sent instead (`redirect`, always a full address under
 * GEO_BASE with the other query parameters kept). The router matches without regard to case, so this does too.
 */
export function readGeoRoute(
  pathname: string,
  search = "",
): { route: GeoRoute; redirect: null } | { route: null; redirect: string } {
  const clean = pathname.replace(/\/+$/, "");
  const lower = clean.toLowerCase();
  const base = GEO_BASE.toLowerCase();
  const rest = lower === base ? "" : lower.startsWith(`${base}/`) ? clean.slice(GEO_BASE.length + 1) : null;
  const keep = otherParams(search);

  if (rest === null || rest === "") {
    // the old single page: its tab (and journey) say where to go
    const params = new URLSearchParams(search);
    const tab = OLD_TABS[(params.get("tab") ?? "").toLowerCase()] ?? DEFAULT_GEO_SECTION;
    const journey = tab === "journeys" ? positiveInt(params.get("journey")) : null;
    return { route: null, redirect: `${geoPath(tab, journey)}${keep}` };
  }

  const parts = rest.split("/");
  const head = parts[0].toLowerCase();
  const section = (GEO_SECTIONS as readonly string[]).includes(head) ? (head as GeoSection) : OLD_TABS[head];
  if (!section) return { route: null, redirect: `${geoPath(DEFAULT_GEO_SECTION)}${keep}` };

  if (section === "journeys") {
    if (parts.length === 1) {
      // /journeys?journey=12 (an old link written by hand): the journey's own address
      const old = positiveInt(new URLSearchParams(search).get("journey"));
      if (old !== null) return { route: null, redirect: `${journeyPath(old)}${keep}` };
      return { route: { section, journey: null, view: "list" }, redirect: null };
    }
    const id = positiveInt(parts[1]);
    if (id === null) return { route: null, redirect: `${geoPath("journeys")}${keep}` };
    if (parts.length === 2) return { route: { section, journey: id, view: "journey" }, redirect: null };
    if (parts.length === 3 && parts[2].toLowerCase() === "simulate") {
      return { route: { section, journey: id, view: "simulate" }, redirect: null };
    }
    return { route: null, redirect: `${journeyPath(id)}${keep}` };
  }

  if (parts.length > 1 || head !== section) {
    // a section under an old name (/hr/geo-attendance/map) or with a tail it does not have
    return { route: null, redirect: `${geoPath(section)}${keep}` };
  }
  return { route: { section, journey: null, view: "list" }, redirect: null };
}
