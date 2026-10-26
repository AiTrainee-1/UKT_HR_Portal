// The Daily Late Report: the late staff of one date, how late each was, the sorting, the severity steps and the summary. One
// model feeds the table on the page, the Excel file (late-excel.ts) and the PDF (late-pdf.ts), so their columns and figures
// can never differ. Pure: no React and no network, every rule has a test (late.test.ts).
//
// "Late by (after grace)" is the punch-in minus the late deadline: shift start + the employee's grace, as the attendance
// engine judged that day (a company-announced late-in moves it). The backend works the minutes out (`minutesLate`, at least 1
// on a day the engine flagged late), so the report agrees with why Staff Attendance shows the day as Late. "After shift start"
// is the plain minutes from the shift start to the punch.

import type { ReportLogDailyRow } from "@/lib/api-client/custom-hooks";
import { formatClock12, lateRows, minutesOf } from "./logic";

export const LATE_REPORT_TITLE = "Daily Late Report";

/** One late employee, ready to show or export. */
export type LateEntry = {
  employeeId: number;
  name: string;
  code: string;
  department: string | null;
  /** The unit label (HO, U-1 ...), null with no branch. */
  unit: string | null;
  /** "HH:MM" (24 hour) or null. */
  shiftStart: string | null;
  grace: number | null;
  lateDeadline: string | null;
  /** The first punch of the day, "HH:MM". */
  punchIn: string | null;
  /** Minutes after the late deadline (after grace), null when the backend gave none. */
  minutesLate: number | null;
  /** Minutes after the shift start. */
  minutesAfterStart: number | null;
};

export function toEntry(row: ReportLogDailyRow): LateEntry {
  return {
    employeeId: row.employeeId,
    name: row.employeeName,
    code: row.employeeCode,
    department: row.department ?? null,
    unit: row.unitLabel ?? null,
    shiftStart: row.shiftStart ?? null,
    grace: row.graceMinutes ?? null,
    lateDeadline: row.lateDeadline ?? null,
    punchIn: row.firstPunch ?? null,
    minutesLate: row.minutesLate ?? null,
    minutesAfterStart: row.minutesAfterStart ?? null,
  };
}

/** The late staff of a day's rows (the engine's own flag), as entries. */
export const lateEntries = (rows: ReportLogDailyRow[]): LateEntry[] => lateRows(rows).map(toEntry);

// ─── Columns (the page and both downloads) ───

export type LateColumnKey = "name" | "code" | "department" | "shiftStart" | "grace" | "punchIn" | "minutesLate";

export type LateColumn = {
  key: LateColumnKey;
  /** The header on the page and in the downloads. */
  header: string;
  align: "left" | "center";
  /** Excel column width (characters) and PDF column width (millimetres, summing to the A4 landscape text width). */
  chars: number;
  mm: number;
};

export const LATE_COLUMNS: LateColumn[] = [
  { key: "name", header: "Employee Name", align: "left", chars: 30, mm: 62 },
  { key: "code", header: "Employee Code", align: "left", chars: 15, mm: 28 },
  { key: "department", header: "Department", align: "left", chars: 24, mm: 48 },
  { key: "shiftStart", header: "Shift Start Time", align: "center", chars: 17, mm: 30 },
  { key: "grace", header: "Grace Period (minutes)", align: "center", chars: 22, mm: 32 },
  { key: "punchIn", header: "Actual Punch-In Time", align: "center", chars: 21, mm: 34 },
  { key: "minutesLate", header: "Total Minutes Late", align: "center", chars: 20, mm: 39 },
];

// ─── Severity ───

export type Severity = "low" | "mid" | "high";

/** The steps of the colour scale: 1-10 minutes, 11-30 and 31 or more. */
export const SEVERITY_BANDS: { key: Severity; label: string; min: number }[] = [
  { key: "low", label: "1-10 min", min: 1 },
  { key: "mid", label: "11-30 min", min: 11 },
  { key: "high", label: "31+ min", min: 31 },
];

export function severityOf(minutes: number | null | undefined): Severity | null {
  if (minutes == null || !Number.isFinite(minutes) || minutes < 1) return null;
  return minutes >= 31 ? "high" : minutes >= 11 ? "mid" : "low";
}

/** The same three colours on the page, in Excel and in the PDF: a soft background and its text. */
export const SEVERITY_COLORS: Record<Severity, { bg: string; text: string }> = {
  low: { bg: "#fef3c7", text: "#92400e" },
  mid: { bg: "#fed7aa", text: "#9a3412" },
  high: { bg: "#fecaca", text: "#991b1b" },
};

// ─── Text ───

/** 14 -> "14 min"; an average keeps its one decimal: 23.3 -> "23.3 min". */
export const formatMinutes = (minutes: number | null | undefined): string =>
  minutes == null || !Number.isFinite(minutes)
    ? "—"
    : `${Number.isInteger(minutes) ? minutes : Math.round(minutes * 10) / 10} min`;

/** "09:40" -> "09:40 AM"; no time -> a dash. */
export const clock = (time: string | null | undefined): string => formatClock12(time) || "—";

/** The cell text of a column, as the page and the PDF show it. */
export function cellText(entry: LateEntry, key: LateColumnKey): string {
  switch (key) {
    case "name":
      return entry.name;
    case "code":
      return entry.code;
    case "department":
      return entry.department?.trim() || "—";
    case "shiftStart":
      return clock(entry.shiftStart);
    case "grace":
      return entry.grace == null ? "—" : String(entry.grace);
    case "punchIn":
      return clock(entry.punchIn);
    case "minutesLate":
      return formatMinutes(entry.minutesLate);
  }
}

/** The sentence under a "Late by" figure: how it was worked out, for a hover and for a reader who asks why. */
export function explain(entry: LateEntry): string {
  if (entry.minutesLate == null) return "No shift is on file for this day, so the lateness cannot be measured.";
  const deadline = clock(entry.lateDeadline);
  const base = `Punch-in ${clock(entry.punchIn)} minus the late deadline ${deadline}`;
  const parts =
    entry.shiftStart && entry.grace != null
      ? ` (shift start ${clock(entry.shiftStart)} + ${entry.grace} min grace)`
      : "";
  return `${base}${parts} = ${formatMinutes(entry.minutesLate)}`;
}

// ─── Sorting ───

export type SortDir = "asc" | "desc";
export type LateSort = { key: LateColumnKey; dir: SortDir };

/** The report opens on the longest delays first. */
export const DEFAULT_SORT: LateSort = { key: "minutesLate", dir: "desc" };

/** The direction a column starts in when it is first clicked: minutes late and punch-in time show the worst first. */
export const firstDir = (key: LateColumnKey): SortDir => (key === "minutesLate" ? "desc" : "asc");

/** A click on a column header: the same column flips its direction, another column starts in its own. */
export function nextSort(current: LateSort, key: LateColumnKey): LateSort {
  if (current.key === key) return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  return { key, dir: firstDir(key) };
}

const sortValue = (entry: LateEntry, key: LateColumnKey): number | string | null => {
  switch (key) {
    case "name":
      return entry.name.toLowerCase();
    case "code":
      return entry.code;
    case "department":
      return entry.department?.toLowerCase() ?? null;
    case "shiftStart":
      return Number.isFinite(minutesOf(entry.shiftStart)) ? minutesOf(entry.shiftStart) : null;
    case "grace":
      return entry.grace;
    case "punchIn":
      return Number.isFinite(minutesOf(entry.punchIn)) ? minutesOf(entry.punchIn) : null;
    case "minutesLate":
      return entry.minutesLate;
  }
};

/** The entries in the order asked for (a new array). A missing value is always last, whichever way the column runs; ties are
 *  broken by name, so the order never jumps about. */
export function sortEntries(entries: LateEntry[], sort: LateSort = DEFAULT_SORT): LateEntry[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...entries].sort((a, b) => {
    const x = sortValue(a, sort.key);
    const y = sortValue(b, sort.key);
    if (x == null && y == null) return a.name.localeCompare(b.name);
    if (x == null) return 1;
    if (y == null) return -1;
    const diff =
      typeof x === "number" && typeof y === "number"
        ? x - y
        : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: "base" });
    return diff !== 0 ? sign * diff : a.name.localeCompare(b.name);
  });
}

// ─── Summary ───

export type LateSummary = {
  count: number;
  /** Average (one decimal) and longest of the minutes late over the staff whose lateness could be measured. */
  average: number | null;
  longest: number | null;
  longestName: string | null;
};

export function summarize(entries: LateEntry[]): LateSummary {
  const measured = entries.filter((e) => e.minutesLate != null);
  const totalMinutes = measured.reduce((sum, e) => sum + (e.minutesLate ?? 0), 0);
  let longest: LateEntry | null = null;
  for (const e of measured) if (!longest || (e.minutesLate ?? 0) > (longest.minutesLate ?? 0)) longest = e;
  return {
    count: entries.length,
    average: measured.length > 0 ? Math.round((totalMinutes / measured.length) * 10) / 10 : null,
    longest: longest?.minutesLate ?? null,
    longestName: longest?.name ?? null,
  };
}

// ─── Files ───

/** The file name (without the extension): Daily_Late_Report_2026-10-16. */
export const lateFileStem = (iso: string): string => `${LATE_REPORT_TITLE.replace(/\s+/g, "_")}_${iso}`;

/** "26 Oct 2026, 11:45 AM", the moment a file was made. */
export function generatedStamp(now: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const h = now.getHours();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(now.getDate())} ${months[now.getMonth()]} ${now.getFullYear()}, ${p(h % 12 === 0 ? 12 : h % 12)}:${p(now.getMinutes())} ${h < 12 ? "AM" : "PM"}`;
}

/** What narrows the list, in words, for the header of a download ("Department: Admin; search: kumar"), or "" for none. */
export function filterNote(department: string | null, search: string): string {
  const parts: string[] = [];
  if (department) parts.push(`Department: ${department}`);
  if (search.trim()) parts.push(`Search: ${search.trim()}`);
  return parts.join("; ");
}
