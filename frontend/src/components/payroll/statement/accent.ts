import type { ColumnGroupKey, StatementAccent } from "./statement-model";

// The colours of the on-screen statement. Tailwind only sees complete class strings, so every class is written out in full.
// Staff Payroll is indigo (like its tabs), Production Payroll amber.

export type AccentStyle = {
  /** The strip across the top of the paper. */
  topBar: string;
  /** A department's band row and the little count in it. */
  band: string;
  bandCount: string;
  /** A department's subtotal row. */
  subtotal: string;
  /** The grand total row. */
  total: string;
  /** What a data row turns into under the mouse. */
  hover: string;
  /** The "Net pay" group in the header. */
  resultBand: string;
  resultHead: string;
  /** Text that picks the accent up (the name you can click). */
  link: string;
  ring: string;
  /** The colour of the segmented switch's active pill (PillTabs takes a colour value). */
  pill: string;
};

export const ACCENT: Record<StatementAccent, AccentStyle> = {
  indigo: {
    topBar: "from-indigo-500 via-indigo-400 to-sky-400",
    band: "bg-indigo-50 text-indigo-900",
    bandCount: "bg-indigo-100 text-indigo-700",
    subtotal: "bg-indigo-50 text-indigo-950",
    total: "bg-indigo-600 text-white",
    hover: "group-hover:bg-indigo-50",
    resultBand: "bg-indigo-100 text-indigo-800",
    resultHead: "bg-indigo-50 text-indigo-900",
    link: "hover:text-indigo-700",
    ring: "focus-visible:ring-indigo-400",
    pill: "#4f46e5",
  },
  amber: {
    topBar: "from-amber-500 via-amber-400 to-orange-400",
    band: "bg-amber-50 text-amber-900",
    bandCount: "bg-amber-100 text-amber-700",
    subtotal: "bg-amber-50 text-amber-950",
    total: "bg-amber-600 text-white",
    hover: "group-hover:bg-amber-50",
    resultBand: "bg-amber-100 text-amber-800",
    resultHead: "bg-amber-50 text-amber-900",
    link: "hover:text-amber-700",
    ring: "focus-visible:ring-amber-400",
    pill: "#d97706",
  },
};

/** The header band of each column group, and the lighter tint of the labels under it. */
export const GROUP_BAND: Record<Exclude<ColumnGroupKey, "result">, string> = {
  identity: "bg-slate-100 text-slate-600",
  attendance: "bg-sky-100 text-sky-800",
  earnings: "bg-emerald-100 text-emerald-800",
  deductions: "bg-rose-100 text-rose-800",
};

export const GROUP_HEAD: Record<Exclude<ColumnGroupKey, "result">, string> = {
  identity: "bg-slate-50 text-slate-700",
  attendance: "bg-sky-50 text-sky-900",
  earnings: "bg-emerald-50 text-emerald-900",
  deductions: "bg-rose-50 text-rose-900",
};

/** A row's payment status as the small accent on its left edge. */
export const STATUS_ACCENT: Record<string, string> = {
  paid: "border-l-emerald-500",
  pending: "border-l-amber-400",
};

export const STATUS_TEXT: Record<string, string> = {
  paid: "Cleared",
  pending: "Pending",
};
