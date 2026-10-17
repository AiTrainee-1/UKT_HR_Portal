// The addresses of Outpass / Visitors: three pages under /hr/outpass-visitors (the three entries of the sidebar), and, on two of
// them, tabs in the PATH: /hr/outpass-visitors/outpass/overview/passes. Pure, so the page, the redirects and the tests read
// from one place. The page is the first segment, the subtab the second, the nested subtab the third; whatever is missing or
// unknown is replaced by the first one (see `resolveGatePath`).

export const GATE_BASE = "/hr/outpass-visitors";

export type GatePageKey = "outpass" | "visitors" | "tea-break";

/** The three pages, in the order of the sidebar. The first one is where the bare `/hr/outpass-visitors` lands. */
export const GATE_PAGES: readonly GatePageKey[] = ["outpass", "visitors", "tea-break"];

/** `/hr/outpass-visitors/tea-break`. */
export const gatePagePath = (key: GatePageKey): string => `${GATE_BASE}/${key}`;

export type GateTab = { value: string; label: string };

/** The subtabs of each page, in order. Visitors has none: it is one list, so it has no strip. */
export const GATE_SUBS: Record<GatePageKey, readonly GateTab[]> = {
  outpass: [
    { value: "overview", label: "Overview" },
    { value: "requests", label: "Requests" },
    { value: "in-out", label: "In/Out" },
  ],
  visitors: [],
  "tea-break": [
    { value: "records", label: "Records" },
    { value: "rule", label: "Rule" },
  ],
};

/** The nested subtabs of a subtab (`outpass/overview`): only a subtab with two or more sections has any. */
export const GATE_NESTED: Record<GatePageKey, Readonly<Record<string, readonly GateTab[]>>> = {
  outpass: {
    overview: [
      { value: "passes", label: "Passes" },
      { value: "qr-submissions", label: "Gate QR submissions" },
    ],
  },
  visitors: {},
  "tea-break": {},
};

export const subsOf = (page: GatePageKey): readonly GateTab[] => GATE_SUBS[page];
export const nestedOf = (page: GatePageKey, sub: string): readonly GateTab[] => GATE_NESTED[page][sub] ?? [];

/** `/hr/outpass-visitors/outpass/overview/passes`: the page, the subtab and the nested subtab it names (each optional). */
export function gateTabPath(page: GatePageKey, sub?: string, nested?: string): string {
  return [gatePagePath(page), sub, sub ? nested : undefined].filter(Boolean).join("/");
}

/** Where a page opens: its first subtab, and that subtab's first nested subtab (`/outpass/overview/passes`). */
export function gateLanding(page: GatePageKey): string {
  const sub = subsOf(page)[0]?.value;
  return gateTabPath(page, sub, sub ? nestedOf(page, sub)[0]?.value : undefined);
}

/** The page an address belongs to (`outpass` for the bare `/hr/outpass-visitors`, and for anything that is no page). */
export function gatePageOf(pathname: string): GatePageKey {
  const first = segmentsOf(pathname)[0];
  return GATE_PAGES.find((p) => p === first) ?? "outpass";
}

const segmentsOf = (pathname: string): string[] => {
  const path = pathname.split(/[?#]/)[0].toLowerCase();
  const rest = path.startsWith(`${GATE_BASE}/`) ? path.slice(GATE_BASE.length + 1) : "";
  return rest.split("/").filter(Boolean);
};

/** What an address names, read down the path: the page, then each subtab as far as it is a real one. */
export function readGatePath(pathname: string): { page: GatePageKey; sub: string | null; nested: string | null } {
  const [, subSeg, nestedSeg] = segmentsOf(pathname);
  const page = gatePageOf(pathname);
  const sub = subsOf(page).find((s) => s.value === subSeg)?.value ?? null;
  const nested = sub ? (nestedOf(page, sub).find((n) => n.value === nestedSeg)?.value ?? null) : null;
  return { page, sub, nested };
}

/**
 * The address an address really is: a path that stops early gets the first subtab (and the first nested subtab), an unknown
 * subtab or nested subtab is replaced by the first one, anything after the last level is dropped, and the bare
 * `/hr/outpass-visitors` is Outpass. The page itself decides to redirect when this is not the address it was opened at.
 */
export function resolveGatePath(pathname: string): string {
  const { page, sub, nested } = readGatePath(pathname);
  const subs = subsOf(page);
  if (subs.length === 0) return gatePagePath(page);
  const chosen = sub ?? subs[0].value;
  const levels = nestedOf(page, chosen);
  if (levels.length === 0) return gateTabPath(page, chosen);
  return gateTabPath(page, chosen, nested ?? levels[0].value);
}

/** The address with the trailing slash dropped, so `/hr/outpass-visitors/visitors/` is the page itself. */
export const cleanGatePath = (pathname: string): string => pathname.replace(/\/+$/, "") || "/";
