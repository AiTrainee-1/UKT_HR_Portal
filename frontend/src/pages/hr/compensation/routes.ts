import type { ReportType } from "@/lib/api-client/custom-hooks";
import { leavePartOf, type LeavePart } from "./logic";

// The addresses of Compensation: five pages under /hr/compensation, and subtabs under three of them
// (/hr/compensation/ot-detection/type-1). The page and the subtab are the PATH; the filters of a page stay in the query
// string (see COMPENSATION_URL_DEFAULTS). Pure, so the sidebar, the in-app links and the redirects of the old
// `/hr/compensation?tab=ot&sub=...` addresses all read from one place.

export const COMPENSATION_BASE = "/hr/compensation";

export type CompensationPageKey = "ctc" | "ot" | "leave" | "history" | "reports";

export type CompensationPageInfo = {
  key: CompensationPageKey;
  /** The last segment of the address. */
  slug: string;
  /** The sidebar entry and the page heading. */
  label: string;
};

/** The five pages, in the order of the sidebar. The first one is where the bare `/hr/compensation` lands. */
export const COMPENSATION_PAGES: readonly CompensationPageInfo[] = [
  { key: "ctc", slug: "ctc-breakdown", label: "CTC Breakdown" },
  { key: "ot", slug: "ot-detection", label: "OT Detection" },
  { key: "leave", slug: "compensation-leave", label: "Compensation Leave" },
  { key: "history", slug: "history", label: "History" },
  { key: "reports", slug: "reports", label: "Reports" },
];

const PAGE = Object.fromEntries(COMPENSATION_PAGES.map((p) => [p.key, p])) as Record<
  CompensationPageKey,
  CompensationPageInfo
>;

/** `/hr/compensation/ot-detection`. */
export const pagePath = (key: CompensationPageKey): string => `${COMPENSATION_BASE}/${PAGE[key].slug}`;

export const FIRST_PAGE_PATH = pagePath("ctc");

export type Subtab = { value: string; label: string };

// ── OT Detection ──────────────────────────────────────────────────────────────

export const OT_SUBS = ["type-1", "type-2", "earlier"] as const;
export type OtSub = (typeof OT_SUBS)[number];
export const OT_SUB_LABEL: Record<OtSub, string> = {
  "type-1": "Type 1 · Late-in allowance",
  "type-2": "Type 2 · Shift compensation",
  earlier: "Earlier records",
};

// ── Compensation Leave ────────────────────────────────────────────────────────

export const LEAVE_SUBS = ["announcements", "holiday-work", "birthdays"] as const;
export type LeaveSub = (typeof LEAVE_SUBS)[number];
export const LEAVE_SUB_LABEL: Record<LeaveSub, string> = {
  announcements: "A. Announce late-in / early-out",
  "holiday-work": "B. Sunday & holiday work",
  birthdays: "C. Birthdays",
};

/** The subtab of an old `sub=windows|holiday-work|birthdays` value (and its other spellings). */
export const leaveSubOfPart = (part: LeavePart): LeaveSub => (part === "windows" ? "announcements" : part);

// ── History ───────────────────────────────────────────────────────────────────

export type HistorySubInfo = {
  value: string;
  label: string;
  /** The kinds of record the subtab lists (the two company windows share one). */
  types: readonly ReportType[];
};

export const HISTORY_SUBS: readonly HistorySubInfo[] = [
  { value: "ot-allowance", label: "OT allowance", types: ["ot_allowance"] },
  { value: "ot-relaxation", label: "OT relaxation", types: ["ot_shift_relaxation"] },
  { value: "ot-pay", label: "OT pay", types: ["ot_shift_pay"] },
  { value: "company-windows", label: "Company windows", types: ["window_late_in", "window_early_out"] },
  { value: "holiday-work", label: "Holiday / Sunday work", types: ["holiday_work"] },
  { value: "birthday-leave", label: "Birthday leave", types: ["birthday"] },
];

export const HISTORY_SUB_VALUES = HISTORY_SUBS.map((s) => s.value);

/** The History subtab a kind of record is listed under. */
export const historySubOfType = (type: string): string | undefined =>
  HISTORY_SUBS.find((s) => (s.types as readonly string[]).includes(type))?.value;

// ── Nested subtabs ────────────────────────────────────────────────────────────
// A subtab with several sections shows ONE section per nested subtab (a second level of tabs under the first), so nothing is
// stacked on a long page. The nested subtab is the third path segment (/hr/compensation/ot-detection/type-2/waiting). A
// subtab that is missing from these maps has a single section and no nested level.

/** The nested subtabs of each subtab of a page: `{ "type-2": [{ value: "waiting", label: "Waiting for HR" }, ...] }`. */
export type NestedMap = Readonly<Record<string, readonly Subtab[]>>;

export const OT_NESTED: NestedMap = {
  "type-1": [
    { value: "allowance", label: "Late-in allowance" },
    { value: "how", label: "How it is worked out" },
  ],
  "type-2": [
    { value: "waiting", label: "Waiting for HR" },
    { value: "assigned", label: "Assigned and rejected" },
    { value: "how", label: "How the suggested shifts are worked out" },
  ],
};

export const LEAVE_NESTED: NestedMap = {
  announcements: [
    { value: "announce", label: "Announce" },
    { value: "list", label: "Announcements" },
  ],
  "holiday-work": [
    { value: "raise", label: "Raise a claim" },
    { value: "claims", label: "Claims" },
    { value: "balance", label: "Compensation balance" },
    { value: "credits", label: "Earlier Alternative-Day credits" },
  ],
  birthdays: [
    { value: "list", label: "Who has a birthday" },
    { value: "how", label: "How it works" },
  ],
};

export const HISTORY_NESTED: NestedMap = {
  "company-windows": [
    { value: "late-in", label: "Late-in window" },
    { value: "early-out", label: "Early-out window" },
  ],
  "holiday-work": [
    { value: "work", label: "Sunday / holiday work" },
    { value: "redeemed", label: "Balance redeemed" },
  ],
};

/** The History nested subtab that lists a kind of record, where its subtab has several (the old `type` filter's meaning). */
const HISTORY_TYPE_NESTED: Readonly<Record<string, string>> = {
  window_late_in: "late-in",
  window_early_out: "early-out",
  holiday_work: "work",
};

export const historyNestedOfType = (type: string): string | undefined => HISTORY_TYPE_NESTED[type];

const NESTED_OF: Partial<Record<CompensationPageKey, NestedMap>> = {
  ot: OT_NESTED,
  leave: LEAVE_NESTED,
  history: HISTORY_NESTED,
};

/** The nested subtabs of a subtab (none for a subtab with one section, or for a page without subtabs). */
export const nestedOf = (key: CompensationPageKey, sub: string): readonly Subtab[] => NESTED_OF[key]?.[sub] ?? [];

/**
 * The nested subtab a subtab address opens when it names none (or an unknown one): the first, except that a link carrying the
 * filter of one section opens that section (`hstatus` / `hmonth` / `hyear` are the Claims filters, `otstatus` is the
 * Assigned-and-rejected one). Undefined for a subtab with no nested level.
 */
export function defaultNested(key: CompensationPageKey, sub: string, search = ""): string | undefined {
  const nested = nestedOf(key, sub);
  if (nested.length === 0) return undefined;
  const params = new URLSearchParams(search);
  const set = (name: string) => {
    const v = params.get(name);
    return v !== null && v !== "" && v !== "all";
  };
  if (key === "leave" && sub === "holiday-work" && (set("hstatus") || set("hmonth") || set("hyear"))) return "claims";
  if (key === "ot" && sub === "type-2" && set("otstatus")) return "assigned";
  return nested[0].value;
}

// ── Building addresses ────────────────────────────────────────────────────────

/** `/hr/compensation/ot-detection/type-2/waiting`, with a query string when one is given (`?month=9`, or `month=9`). */
export function subPath(key: CompensationPageKey, sub: string, query = "", nested?: string): string {
  const q = query.replace(/^\?/, "");
  return `${pagePath(key)}/${sub}${nested ? `/${nested}` : ""}${q ? `?${q}` : ""}`;
}

/** A subtab's address with its nested subtab: the one asked for, else the default one (the first). No query string. */
const pathOf = (key: CompensationPageKey, sub: string, nested?: string, search = ""): string =>
  subPath(key, sub, "", nested ?? defaultNested(key, sub, search));

export const otPath = (sub: OtSub = "type-1", nested?: string, search = ""): string =>
  pathOf("ot", sub, nested, search);
export const leavePath = (sub: LeaveSub = "announcements", nested?: string, search = ""): string =>
  pathOf("leave", sub, nested, search);
export const historyPath = (sub: string = HISTORY_SUBS[0].value, nested?: string, search = ""): string =>
  pathOf("history", sub, nested, search);

// ── The old addresses ─────────────────────────────────────────────────────────

/**
 * Where an old `/hr/compensation?tab=ot|leave|history|ctc&sub=...` address now lives: the new path (down to the nested
 * subtab), with every other query parameter (hstatus, month, year, ...) carried over. `tab` and `sub` are spent on the path;
 * History's old `type` filter is spent on its subtab (when it names a kind of record). An unknown or missing tab is CTC
 * Breakdown, as it always was.
 */
export function legacyCompensationTarget(search: string): string {
  const params = new URLSearchParams(search);
  const tab = (params.get("tab") ?? "").trim().toLowerCase();
  const sub = (params.get("sub") ?? "").trim();
  params.delete("tab");
  params.delete("sub");
  const rest = params.toString();

  let path: string;
  if (tab === "ot") {
    const named = OT_SUBS.find((s) => s === sub.toLowerCase());
    // the status filter belongs to the Type 2 history list, so a link carrying it opens Type 2
    const status = params.get("otstatus");
    path = otPath(named ?? (status && status !== "all" ? "type-2" : "type-1"), undefined, rest);
  } else if (tab === "leave") {
    path = leavePath(leaveSubOfPart(leavePartOf(sub)), undefined, rest);
  } else if (tab === "history") {
    const type = params.get("type") ?? "";
    // History has a subtab per kind of record instead of the old type filter
    params.delete("type");
    path = historyPath(historySubOfType(type), historyNestedOfType(type));
  } else if (tab === "reports") {
    path = pagePath("reports");
  } else {
    path = FIRST_PAGE_PATH;
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}
