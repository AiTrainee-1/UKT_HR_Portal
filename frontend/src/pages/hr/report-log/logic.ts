// Pure rules behind the Report Log page: the sub-tab an address names, the dates, the unit blocks of the paper STAFF LEAVE
// LIST (HO, U-1, U-2 ...), the late and leave row picks and the leave list's title. (The Daily Late Report's own rules, its
// minutes, sorting and summary, are in late.ts.)
// No React and no network here, so every rule has a test (logic.test.ts).

import type { ReportLogDailyRow } from "@/lib/api-client/custom-hooks";

// ─── Sub-tabs ───

export const TABS = ["monthly", "leave", "late"] as const;
export type TabKey = (typeof TABS)[number];

export const TAB_LABELS: Record<TabKey, string> = {
  monthly: "Monthly Report",
  leave: "Daily Leave Report",
  late: "Daily Late Report",
};

/** The sub-tab a `?tab=` value names. The old "daily" is the Daily Leave Report (it was renamed); anything else opens the
 *  Monthly Report. */
export function parseTab(value: string | null | undefined): TabKey {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "daily") return "leave";
  return (TABS as readonly string[]).includes(v) ? (v as TabKey) : "monthly";
}

/** The address with `tab` set (every other query key stays); search is "?a=b" or "". */
export function searchWithTab(search: string, tab: TabKey): string {
  const params = new URLSearchParams(search);
  params.set("tab", tab);
  return `?${params.toString()}`;
}

// ─── Dates and times ───

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Today in the browser's own calendar as YYYY-MM-DD (not toISOString: that is the UTC date, a day behind before 05:30 IST). */
export function localToday(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

export const isIsoDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

/** 2026-10-16 -> 16.10.2026 */
export function formatDMY(iso: string): string {
  if (!isIsoDate(iso)) return iso;
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

/** "09:06" (24 hour, local time) -> "09:06 AM"; "13:05" -> "01:05 PM"; "00:10" -> "12:10 AM". "" for no punch or a bad value. */
export function formatClock12(time: string | null | undefined): string {
  const match = /^(\d{1,2}):(\d{2})/.exec((time ?? "").trim());
  if (!match) return "";
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return "";
  return `${pad2(h % 12 === 0 ? 12 : h % 12)}:${pad2(m)} ${h < 12 ? "AM" : "PM"}`;
}

/** Minutes after midnight of an "HH:MM" time, for ordering; rows with no punch sort last. */
export function minutesOf(time: string | null | undefined): number {
  const match = /^(\d{1,2}):(\d{2})/.exec((time ?? "").trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : Number.POSITIVE_INFINITY;
}

export const leaveTitle = (iso: string) => `${formatDMY(iso)} STAFF LEAVE LIST`;

// ─── Informed / Not informed (the Daily Leave Report's remark) ───

export type InformedFilter = "all" | "informed" | "not_informed" | "unset";

export const informedLabel = (row: Pick<ReportLogDailyRow, "isInformed">): string =>
  row.isInformed === true ? "Informed" : row.isInformed === false ? "Not informed" : "Unset";

/** The remark cell colours of the paper list: green Informed, orange Not informed (a grey Unset). */
export const INFORMED_COLORS = {
  informed: "#9bbb59",
  notInformed: "#f79646",
  unset: "#dddddd",
} as const;

export const informedColor = (row: Pick<ReportLogDailyRow, "isInformed">): string =>
  row.isInformed === true
    ? INFORMED_COLORS.informed
    : row.isInformed === false
      ? INFORMED_COLORS.notInformed
      : INFORMED_COLORS.unset;

export const informedValue = (row: Pick<ReportLogDailyRow, "isInformed">): "informed" | "not_informed" | "unset" =>
  row.isInformed === true ? "informed" : row.isInformed === false ? "not_informed" : "unset";

// ─── Row picks ───

/** The Daily Leave Report is Absent-only, deliberately: it is made around 10-11 AM, when anyone Late has already punched in
 *  (present) and anyone on approved leave is accounted for on file; who is left, and needs a call, never showed up. */
export const absentRows = (rows: ReportLogDailyRow[]): ReportLogDailyRow[] => rows.filter((r) => r.status === "absent");

export function filterByInformed(rows: ReportLogDailyRow[], filter: InformedFilter): ReportLogDailyRow[] {
  if (filter === "all") return rows;
  return rows.filter((r) =>
    filter === "informed"
      ? r.isInformed === true
      : filter === "not_informed"
        ? r.isInformed === false
        : r.isInformed == null,
  );
}

/** The Daily Late Report: the attendance engine's own late flag (isLate, a Late-zone arrival), so the list agrees with Staff
 *  Attendance. The backend only ever sends staff: production workers are not part of this report. */
export const lateRows = (rows: ReportLogDailyRow[]): ReportLogDailyRow[] => rows.filter((r) => r.isLate === true);

// ─── Unit blocks (HO / U-1 / U-2 / Other) ───

export const OTHER_UNIT = "Other";

export type UnitBlock = {
  /** The branch id as text, or "none" for employees with no branch. */
  key: string;
  /** The block label in the left gutter: HO, U-1, U-2 ..., or "Other". */
  label: string;
  /** The branch's full name for a tooltip (null for "Other"). */
  branchName: string | null;
  rows: ReportLogDailyRow[];
};

const unitKey = (row: ReportLogDailyRow) => (row.branchId == null ? "none" : String(row.branchId));
const unitLabelOf = (row: ReportLogDailyRow) =>
  row.branchId == null && !row.unitLabel ? OTHER_UNIT : (row.unitLabel ?? row.branchName ?? OTHER_UNIT);

/** The unit blocks of a list of rows: the head office (HO) first, then the other branches by name (U-1 before U-2, and U-2
 *  before U-10), and the employees with no branch last as "Other". A block's rows keep the order they come in. */
export function groupByUnit(rows: ReportLogDailyRow[]): UnitBlock[] {
  const blocks = new Map<string, UnitBlock>();
  for (const row of rows) {
    const key = unitKey(row);
    let block = blocks.get(key);
    if (!block) {
      block = { key, label: unitLabelOf(row), branchName: row.branchName ?? null, rows: [] };
      blocks.set(key, block);
    }
    block.rows.push(row);
  }
  const rank = (b: UnitBlock) => (b.key === "none" ? 2 : b.label === "HO" ? 0 : 1);
  return Array.from(blocks.values()).sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.branchName ?? a.label).localeCompare(b.branchName ?? b.label, undefined, {
        numeric: true,
        sensitivity: "base",
      }) ||
      a.label.localeCompare(b.label, undefined, { numeric: true }),
  );
}

/** "HO 12 · U-1 6 · U-2 1" */
export const unitCounts = (blocks: UnitBlock[]): string => blocks.map((b) => `${b.label} ${b.rows.length}`).join(" · ");

export const totalRows = (blocks: UnitBlock[]): number => blocks.reduce((sum, b) => sum + b.rows.length, 0);

/** The latest arrival of a late list (the one with the greatest first punch), or null. */
export function latestArrival(rows: ReportLogDailyRow[]): ReportLogDailyRow | null {
  let best: ReportLogDailyRow | null = null;
  for (const row of rows) {
    if (!Number.isFinite(minutesOf(row.firstPunch))) continue;
    if (!best || minutesOf(row.firstPunch) > minutesOf(best.firstPunch)) best = row;
  }
  return best;
}

// ─── Files ───

/** A cell with nothing to show reads as a dash. */
export const dash = (value: string | null | undefined) => (value && value.trim() ? value : "—");

/** The branch line under the company name on an export: the signed-in HR user's branch, or every branch. */
export const branchLine = (branchName: string | null | undefined) =>
  branchName ? `${branchName} Branch` : "All Branches";
