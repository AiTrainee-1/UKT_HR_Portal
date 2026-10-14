import type { TableColumn } from "@/components/payroll/kit/export-table";
import { inr2, fileStem } from "@/components/payroll/kit/format";
import type {
  CompensationReport,
  ReportRow,
  ReportSection,
  ReportSummary,
  ReportType,
} from "@/lib/api-client/custom-hooks";
import type { Tone } from "@/lib/statusTones";
import { clock12, dateShort, fmtShifts, minutesText, rangeLabel } from "../logic";

// What History & Reports shows for each of the seven kinds of compensation: who benefits, the tiles of its summary, the
// columns of its table (the very columns of its Excel sheet), and the flat CSV of everything on screen.

export const REPORT_TYPES: ReportType[] = [
  "ot_allowance",
  "ot_shift_relaxation",
  "ot_shift_pay",
  "window_late_in",
  "window_early_out",
  "holiday_work",
  "birthday",
];

export const isReportType = (value: string): value is ReportType => (REPORT_TYPES as string[]).includes(value);

export type TypeMeta = {
  label: string;
  /** The name of its Excel sheet (at most 31 characters, no slashes). */
  sheet: string;
  /** Who benefits, in one sentence: the heading of the section. */
  who: string;
  /** Which setting switches it, so the section can link to it. */
  setting: string;
};

export const TYPE_META: Record<ReportType, TypeMeta> = {
  ot_allowance: {
    label: "OT: next-day late-in allowance",
    sheet: "OT allowance",
    who: "Staff who worked past their shift end and earned a late-in allowance for the next working morning. Automatic and unpaid; each row says whether the employee used it.",
    setting: "allowance-enabled",
  },
  ot_shift_relaxation: {
    label: "OT: shift compensation as relaxation",
    sheet: "OT relaxation",
    who: "Staff whose overtime HR gave as an alternative day off: the day granted is topped up by the shifts.",
    setting: "shift-relaxation",
  },
  ot_shift_pay: {
    label: "OT: shift compensation as pay",
    sheet: "OT payment",
    who: "Staff whose overtime HR gave as payment: shifts × the daily rate, paid in that month's payroll.",
    setting: "shift-pay",
  },
  window_late_in: {
    label: "Company late-in window",
    sheet: "Late-in window",
    who: "Staff who used a company-announced late-in window: they arrived within the announced time, so the day is marked Compensation instead of Late.",
    setting: "windows-enabled",
  },
  window_early_out: {
    label: "Company early-out window",
    sheet: "Early-out window",
    who: "Staff who used a company-announced early-out window: they left from the announced time, so the day is marked Compensation instead of Early Out.",
    setting: "windows-enabled",
  },
  holiday_work: {
    label: "Holiday / Sunday work",
    sheet: "Holiday work",
    who: "Staff HR claimed compensation for because they worked on a Sunday or company holiday. Once the Department Head approves, the shifts go to the employee's balance.",
    setting: "holiday-work-enabled",
  },
  birthday: {
    label: "Birthday leave",
    sheet: "Birthday",
    who: "Staff whose birthday falls in the period and who get the automatic paid leave for that day.",
    setting: "birthday-enabled",
  },
};

// ── Status tones ──────────────────────────────────────────────────────────────

const STATUS_TONE: Record<string, Tone> = {
  used: "success",
  applied: "success",
  approved: "success",
  in_payroll: "success",
  redeemed: "info",
  scheduled: "info",
  pending: "warning",
  pending_payroll: "warning",
  not_used: "neutral",
  not_applied: "caution",
  rejected: "danger",
};

export const statusTone = (status: string | null | undefined): Tone => (status && STATUS_TONE[status]) || "neutral";

// ── Tiles ─────────────────────────────────────────────────────────────────────

export type Tile = { key: string; label: string; value: string; sub?: string };

const n = (summary: ReportSummary, key: string): number => summary[key] ?? 0;
const count = (value: number): string => String(value);

/** The tiles of a section's summary, in words an HR manager reads ("Used it", "Waiting for payroll"). */
export function summaryTiles(type: ReportType, s: ReportSummary): Tile[] {
  switch (type) {
    case "ot_allowance":
      return [
        {
          key: "earned",
          label: "Earned",
          value: count(n(s, "earned")),
          sub: `${minutesText(n(s, "earnedMinutes"))} allowed`,
        },
        { key: "used", label: "Used it", value: count(n(s, "used")), sub: `${minutesText(n(s, "usedMinutes"))} used` },
        { key: "notUsed", label: "Did not need it", value: count(n(s, "notUsed")) },
        { key: "pending", label: "Not yet worked", value: count(n(s, "pending")) },
        { key: "employees", label: "Employees", value: count(n(s, "employees")) },
      ];
    case "ot_shift_relaxation":
      return [
        { key: "records", label: "Records", value: count(n(s, "records")) },
        { key: "shifts", label: "Shifts given", value: fmtShifts(n(s, "shifts")) },
        { key: "applied", label: "Day off applied", value: count(n(s, "applied")) },
        { key: "scheduled", label: "Coming up", value: count(n(s, "scheduled")) },
        { key: "notApplied", label: "Not applied", value: count(n(s, "notApplied")) },
        { key: "employees", label: "Employees", value: count(n(s, "employees")) },
      ];
    case "ot_shift_pay":
      return [
        { key: "records", label: "Records", value: count(n(s, "records")) },
        { key: "shifts", label: "Shifts paid", value: fmtShifts(n(s, "shifts")) },
        {
          key: "amount",
          label: "Amount",
          value: inr2(n(s, "amount")),
          sub: n(s, "estimatedAmount") > 0 ? `+ ${inr2(n(s, "estimatedAmount"))} estimated` : undefined,
        },
        { key: "inPayroll", label: "In payroll", value: count(n(s, "inPayroll")) },
        { key: "pendingPayroll", label: "Waiting for payroll", value: count(n(s, "pendingPayroll")) },
        { key: "employees", label: "Employees", value: count(n(s, "employees")) },
      ];
    case "window_late_in":
    case "window_early_out":
      return [
        { key: "announcements", label: "Announcements", value: count(n(s, "announcements")) },
        { key: "staffCovered", label: "Staff covered", value: count(n(s, "staffCovered")) },
        { key: "used", label: "Used it", value: count(n(s, "used")) },
        { key: "employees", label: "Employees", value: count(n(s, "employees")) },
      ];
    case "holiday_work":
      return [
        { key: "claims", label: "Claims", value: count(n(s, "claims")) },
        {
          key: "pending",
          label: "Waiting for HOD",
          value: count(n(s, "pending")),
          sub: `${fmtShifts(n(s, "pendingShifts"))} shifts`,
        },
        {
          key: "approved",
          label: "Approved",
          value: count(n(s, "approved")),
          sub: `${fmtShifts(n(s, "approvedShifts"))} shifts`,
        },
        { key: "rejected", label: "Rejected", value: count(n(s, "rejected")) },
        {
          key: "redeemedShifts",
          label: "Redeemed",
          value: fmtShifts(n(s, "redeemedShifts")),
          sub: "shifts taken as days off",
        },
        { key: "employees", label: "Employees", value: count(n(s, "employees")) },
      ];
    case "birthday":
      return [
        { key: "birthdays", label: "Birthdays", value: count(n(s, "birthdays")) },
        { key: "applied", label: "Marked", value: count(n(s, "applied")) },
        { key: "pending", label: "Still to come", value: count(n(s, "pending")) },
        { key: "notApplied", label: "Not marked", value: count(n(s, "notApplied")) },
        { key: "shifts", label: "Shifts", value: fmtShifts(n(s, "shifts")) },
        { key: "employees", label: "Employees", value: count(n(s, "employees")) },
      ];
  }
}

/** The tiles of a section as one line of text (the Summary sheet of the workbook). */
export const tilesText = (tiles: Tile[]): string =>
  tiles.map((t) => `${t.label}: ${t.value}${t.sub ? ` (${t.sub})` : ""}`).join("; ");

// ── Columns ───────────────────────────────────────────────────────────────────

/**
 * A column of a section's table. The same list gives the cells on screen (`display`, words) and the sheet of the Excel
 * file (`value`, the real number or ISO date), so what HR sees is what HR exports.
 */
export type ReportColumn = TableColumn<ReportRow> & {
  display: (row: ReportRow) => string;
  align?: "right";
};

const text = (key: keyof ReportRow, label: string, width = 16): ReportColumn => ({
  key,
  label,
  width,
  value: (r) => (r[key] as string | null) ?? null,
  display: (r) => (r[key] as string | null) || "—",
});
const day = (key: keyof ReportRow, label: string, width = 14): ReportColumn => ({
  key,
  label,
  width,
  type: "date",
  value: (r) => (r[key] as string | null) ?? null,
  display: (r) => (r[key] ? dateShort(r[key] as string) : "—"),
});
const whole = (key: keyof ReportRow, label: string, width = 12): ReportColumn => ({
  key,
  label,
  width,
  type: "int",
  align: "right",
  value: (r) => (r[key] as number | null) ?? null,
  display: (r) => (r[key] === null || r[key] === undefined ? "—" : String(r[key])),
});
/** Minutes worked past the shift end. Type 2 rows of an older backend carry it as `minutes`; Type 1 rows never do. */
const extraTime = (fallbackToMinutes: boolean): ReportColumn => ({
  key: "extraMinutes",
  label: "Extra time (min)",
  width: 14,
  type: "int",
  align: "right",
  value: (r) => r.extraMinutes ?? (fallbackToMinutes ? r.minutes : null) ?? null,
  display: (r) => {
    const v = r.extraMinutes ?? (fallbackToMinutes ? r.minutes : null);
    return v === null || v === undefined ? "—" : String(v);
  },
});
/** The next-day allowance of a Type 1 row (`allowanceMinutes`; an older backend sent it as `minutes`). */
const allowanceTime = (): ReportColumn => ({
  key: "allowanceMinutes",
  label: "Allowance (min)",
  width: 14,
  type: "int",
  align: "right",
  value: (r) => r.allowanceMinutes ?? r.minutes ?? null,
  display: (r) => {
    const v = r.allowanceMinutes ?? r.minutes;
    return v === null || v === undefined ? "—" : String(v);
  },
});
const shifts = (label = "Shifts"): ReportColumn => ({
  key: "shifts",
  label,
  width: 10,
  align: "right",
  value: (r) => r.shifts,
  display: (r) => (r.shifts === null ? "—" : fmtShifts(r.shifts)),
});
const status = (): ReportColumn => ({
  key: "statusLabel",
  label: "Status",
  width: 18,
  value: (r) => r.statusLabel,
  display: (r) => r.statusLabel || "—",
});
const details = (): ReportColumn => ({
  key: "detail",
  label: "Details",
  width: 56,
  value: (r) => r.detail || null,
  display: (r) => r.detail || "—",
});
const clock = (key: "time" | "firstPunch" | "lastPunch", label: string): ReportColumn => ({
  key,
  label,
  width: 12,
  value: (r) => r[key],
  display: (r) => (r[key] ? clock12(r[key]) : "—"),
});
const amount = (): ReportColumn => ({
  key: "amount",
  label: "Amount (₹)",
  width: 14,
  type: "money",
  align: "right",
  value: (r) => r.amount,
  display: (r) => (r.amount === null ? "—" : `${inr2(r.amount)}${r.amountEstimated ? " (estimate)" : ""}`),
});
const estimateFlag = (): ReportColumn => ({
  key: "amountEstimated",
  label: "Amount is an estimate",
  width: 14,
  value: (r) => (r.amount !== null && r.amountEstimated ? "Estimate" : r.amount !== null ? "From the payslip" : null),
  display: (r) => (r.amount !== null && r.amountEstimated ? "Estimate" : "—"),
});

const WINDOW_COLUMNS = (): ReportColumn[] => [
  day("date", "Date"),
  clock("time", "Window time"),
  clock("firstPunch", "First punch"),
  clock("lastPunch", "Last punch"),
  text("assignedBy", "Announced by"),
  day("grantedOn", "Announced on"),
  text("reason", "Reason", 34),
  status(),
  details(),
];

/** The type-specific columns after the employee's identity. */
export const TYPE_COLUMNS: Record<ReportType, () => ReportColumn[]> = {
  ot_allowance: () => [
    day("workDate", "OT date"),
    clock("lastPunch", "Last punch"),
    extraTime(false),
    allowanceTime(),
    day("usedOn", "Used on"),
    whole("minutesUsed", "Minutes used"),
    clock("firstPunch", "First punch"),
    status(),
    details(),
  ],
  ot_shift_relaxation: () => [
    day("date", "Day off granted"),
    day("workDate", "OT date"),
    extraTime(true),
    shifts(),
    text("assignedBy", "Assigned by"),
    day("grantedOn", "Assigned on"),
    status(),
    details(),
  ],
  ot_shift_pay: () => [
    day("date", "Granted date"),
    day("workDate", "OT date"),
    extraTime(true),
    shifts(),
    amount(),
    estimateFlag(),
    text("assignedBy", "Assigned by"),
    day("grantedOn", "Assigned on"),
    status(),
    details(),
  ],
  window_late_in: WINDOW_COLUMNS,
  window_early_out: WINDOW_COLUMNS,
  holiday_work: () => [
    day("date", "Work date"),
    shifts(),
    text("assignedBy", "Raised by"),
    text("approvedBy", "Approved by"),
    day("grantedOn", "Decided on"),
    text("reason", "Reason", 34),
    status(),
    details(),
  ],
  birthday: () => [
    day("date", "Birthday"),
    clock("firstPunch", "First punch"),
    clock("lastPunch", "Last punch"),
    shifts(),
    status(),
    details(),
  ],
};

/** The columns of the balance redeemed in a period (the extra table of the Holiday / Sunday work section). */
export const REDEMPTION_COLUMNS = (): ReportColumn[] => [
  day("usedOn", "Redeemed on"),
  shifts(),
  text("assignedBy", "Recorded by"),
  day("grantedOn", "Recorded on"),
  details(),
];

/** Who the row is about: the first columns of every sheet. */
export const IDENTITY_COLUMNS = (): TableColumn<ReportRow>[] => [
  { key: "employeeCode", label: "Code", width: 12 },
  { key: "employeeName", label: "Name", width: 24 },
  { key: "department", label: "Department", width: 18 },
  { key: "designation", label: "Designation", width: 18 },
  { key: "branch", label: "Branch", width: 16 },
];

// ── The flat CSV of what is on screen ─────────────────────────────────────────

const label = (type: string): string => (isReportType(type) ? TYPE_META[type].label : type);

/** One flat table for the CSV: every row of every section shown, with the type named in the first column. */
export const CSV_COLUMNS: TableColumn<ReportRow>[] = [
  { key: "type", label: "Type", value: (r) => label(r.type) },
  ...IDENTITY_COLUMNS(),
  { key: "date", label: "Date", type: "date" },
  { key: "workDate", label: "Work / OT date", type: "date" },
  { key: "usedOn", label: "Used on", type: "date" },
  { key: "time", label: "Window time" },
  { key: "firstPunch", label: "First punch" },
  { key: "lastPunch", label: "Last punch" },
  { key: "minutes", label: "Minutes", type: "int" },
  { key: "extraMinutes", label: "Extra time (min)", type: "int" },
  { key: "allowanceMinutes", label: "Allowance (min)", type: "int" },
  { key: "minutesUsed", label: "Minutes used", type: "int" },
  { key: "shifts", label: "Shifts" },
  { key: "statusLabel", label: "Status" },
  { key: "amount", label: "Amount (₹)", type: "money" },
  {
    key: "amountEstimated",
    label: "Amount is an estimate",
    value: (r) => (r.amount !== null && r.amountEstimated ? "Estimate" : null),
  },
  { key: "assignedBy", label: "Assigned / raised / announced by" },
  { key: "approvedBy", label: "Approved by" },
  { key: "grantedOn", label: "Decided / assigned on", type: "date" },
  { key: "reason", label: "Reason" },
  { key: "detail", label: "Details" },
];

/** Every row of the sections on screen, redeemed balance included (it is filed under Holiday / Sunday work). */
export function flatRows(report: CompensationReport): ReportRow[] {
  return report.sections.flatMap((s) => [...s.rows, ...(s.redemptions ?? [])]);
}

export const reportFileStem = (report: CompensationReport): string =>
  `${fileStem("Compensation", "Report")}_${report.from}${report.from === report.to ? "" : `_to_${report.to}`}`;

export const reportSubtitle = (report: CompensationReport, extra: (string | null)[] = []): string =>
  ["Compensation", rangeLabel(report.from, report.to), ...extra].filter(Boolean).join(" · ");

/** The number of beneficiaries of a section: distinct employees (the summary's own count). */
export const beneficiaries = (section: ReportSection): number => section.summary.employees ?? 0;

/** "3 employees · 5 records" for the overview of a section. */
export function overviewText(section: ReportSection): string {
  const people = beneficiaries(section);
  const rows = section.rows.length;
  return `${people} ${people === 1 ? "employee" : "employees"} · ${rows} ${rows === 1 ? "record" : "records"}`;
}
