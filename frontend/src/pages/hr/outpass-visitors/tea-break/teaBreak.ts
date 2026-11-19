// The Tea Break page's own words and small rules: the filters it keeps in the address, what each request is sent, the
// four statuses (and their tones), and the minutes of a break that is still going on. Pure, so the page and the tests
// read from one place. The server decides every status (tea_break_admin_views.py); the page only keeps an open break's
// minutes ticking between two refreshes, with the same rule (out for over 60 minutes = not returned).

import type { TeaBreakAdminRecord, TeaBreakRemark, TeaBreakStatus } from "@/lib/api-client/custom-hooks";
import type { FilterOption, KitTone } from "../kit";
import { toInstant } from "../kit";

/** The list's filters in the address (module level: useGateFilters needs a stable object). */
export const TEA_DEFAULTS = {
  range: "today",
  from: "",
  to: "",
  departmentId: "",
  employeeId: "",
  gateId: "",
  status: "",
  q: "",
  branchId: "",
  /** Breaks | By employee: not a filter (Clear keeps it). */
  view: "breaks",
  /** The By employee table's order: not a filter. */
  sort: "",
  pageSize: "20",
};

export type TeaFilterValues = typeof TEA_DEFAULTS;
export type TeaView = "breaks" | "employees";
/** The keys Clear filters leaves alone (they are not filters). */
export const TEA_KEEP = ["view", "sort"] as const;

export const TEA_PAGE_SIZES = [20, 50, 100];

export const teaView = (value: string | undefined): TeaView => (value === "employees" ? "employees" : "breaks");

/** An open break turns from "on break" into "not returned" after this many minutes (fixed on the server). */
export const NOT_RETURNED_MINUTES = 60;

export const STATUS_LABEL: Record<TeaBreakStatus, string> = {
  on_break: "On break",
  on_time: "On time",
  overtime: "Overtime",
  not_returned: "Not returned",
};

export const STATUS_TONE: Record<TeaBreakStatus, KitTone> = {
  on_break: "amber",
  on_time: "teal",
  overtime: "rose",
  not_returned: "rose",
};

export const STATUS_OPTIONS: readonly FilterOption[] = (Object.keys(STATUS_LABEL) as TeaBreakStatus[]).map((s) => ({
  value: s,
  label: STATUS_LABEL[s],
}));

const REMARK_STATUS: Record<TeaBreakRemark, TeaBreakStatus> = {
  in_progress: "on_break",
  on_time: "on_time",
  overtime: "overtime",
  not_returned: "not_returned",
};

/** The status of a row (the server's; an old row without one is read from its remark). */
export const statusOf = (row: Pick<TeaBreakAdminRecord, "remark"> & { status?: TeaBreakStatus | null }) =>
  row.status ?? REMARK_STATUS[row.remark];

export const isOpen = (row: Pick<TeaBreakAdminRecord, "inAt">) => !row.inAt;

/** The minutes of a break: a finished one as the server counted them, an open one up to `now` (whole minutes). */
export function liveMinutes(row: Pick<TeaBreakAdminRecord, "inAt" | "outAt" | "takenMinutes">, now: Date): number {
  if (row.inAt) return row.takenMinutes;
  const out = toInstant(row.outAt);
  if (!out) return row.takenMinutes;
  return Math.max(row.takenMinutes, Math.round((now.getTime() - out.getTime()) / 60_000));
}

/** The status right now: an open break that has passed the hour since the list was loaded is not returned. */
export function liveStatus(row: TeaBreakAdminRecord, now: Date): TeaBreakStatus {
  const status = statusOf(row);
  if (status === "on_break" && liveMinutes(row, now) > NOT_RETURNED_MINUTES) return "not_returned";
  return status;
}

/** The request of each part of the page, from the filters' `params` (useGateFilters). */
export function teaQuery(params: URLSearchParams, part: "breaks" | "employees" | "summary" | "export"): string {
  const out = new URLSearchParams(params);
  out.delete("view");
  if (part !== "employees" && part !== "export") out.delete("sort");
  if (part === "summary" || part === "export") {
    out.delete("page");
    out.delete("pageSize");
  }
  // the tiles are the period's overview: the status filter narrows the table, not them
  if (part === "summary") out.delete("status");
  return out.toString();
}

/** The export's query: the filters, the view, and the order for the employees file. */
export function teaExportQuery(params: URLSearchParams, view: TeaView): URLSearchParams {
  const out = new URLSearchParams(teaQuery(params, "export"));
  if (view !== "employees") out.delete("sort");
  out.set("view", view);
  return out;
}

/** "-breaks" -> {key: "breaks", desc: true}; "" -> the server's default (most breaks first). */
export function readSort(sort: string): { key: string; desc: boolean } {
  if (!sort) return { key: "breaks", desc: true };
  return sort.startsWith("-") ? { key: sort.slice(1), desc: true } : { key: sort, desc: false };
}

/** The next order after a click on a column: a new column starts high to low (A to Z for the name), the same one flips. */
export function nextSort(current: string, key: string): string {
  const { key: now, desc } = readSort(current);
  if (now === key) return desc ? key : `-${key}`;
  return key === "name" ? "name" : `-${key}`;
}

/** What a flag means, in plain words (the drawer and the status cell's tooltip). */
export const FLAG_NOTE: Record<"long" | "left_open", string> = {
  long: "Long break: over an hour between the two scans. This usually means a scan was missed.",
  left_open: "Left open: not scanned back in for over 12 hours. This usually means a scan was missed.",
};
