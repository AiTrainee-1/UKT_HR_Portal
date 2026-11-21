import type { PayrollKind } from "@/lib/api-client/custom-hooks";

// The accent of a payroll screen shared by Staff Payroll (indigo, like its tabs) and the Production Payroll cycle pages
// (amber): the Excess tab, the Payslip tab and the Not included view. Tailwind only sees complete class strings, so every
// class is written out in full.

export type PayAccent = "indigo" | "amber";

export type AccentUi = {
  /** A primary button: "Add excess or detection", "Download picked". */
  solid: string;
  /** A text link / small text button. */
  link: string;
  /** An icon that picks the accent up. */
  icon: string;
  /** A checkbox when ticked (and half-ticked). */
  check: string;
  /** A ticked row, and the same row under the mouse. */
  pickedRow: string;
  /** A pill of something picked (the employees in the Add dialog). */
  pill: string;
  pillHover: string;
  /** The floating bar of what is picked. */
  bar: string;
  barText: string;
  /** The keyboard focus ring of a custom control. */
  ring: string;
  /** The ticked box of a custom checkbox. */
  boxOn: string;
  /** A picked option in a list. */
  optionOn: string;
  /** A positive net figure. */
  netText: string;
  /** The tint of a KPI tile in the accent. */
  tile: string;
  /** The "All" chip of a chip filter when it is on, and the ring of a picked chip. */
  chipOn: string;
  chipRing: string;
};

export const ACCENT_UI: Record<PayAccent, AccentUi> = {
  indigo: {
    solid: "border-0 bg-none bg-indigo-600 text-white hover:bg-indigo-700",
    link: "text-indigo-700",
    icon: "text-indigo-600",
    check:
      "data-[state=checked]:border-indigo-600 data-[state=checked]:bg-indigo-600 data-[state=indeterminate]:border-indigo-600",
    pickedRow: "bg-indigo-50/50",
    pill: "border-indigo-200 bg-indigo-50 text-indigo-800",
    pillHover: "hover:bg-indigo-100",
    bar: "border-indigo-200 bg-indigo-50/95",
    barText: "text-indigo-900",
    ring: "focus-visible:ring-indigo-300",
    boxOn: "border-indigo-600 bg-indigo-600 text-white",
    optionOn: "bg-indigo-50/70",
    netText: "text-indigo-700",
    tile: "bg-indigo-50 text-indigo-800",
    chipOn: "border-indigo-300 bg-indigo-50 text-indigo-800 ring-2 ring-indigo-200",
    chipRing: "ring-indigo-400",
  },
  amber: {
    solid: "border-0 bg-none bg-amber-600 text-white hover:bg-amber-700",
    link: "text-amber-700",
    icon: "text-amber-600",
    check:
      "data-[state=checked]:border-amber-600 data-[state=checked]:bg-amber-600 data-[state=indeterminate]:border-amber-600",
    pickedRow: "bg-amber-50/50",
    pill: "border-amber-200 bg-amber-50 text-amber-800",
    pillHover: "hover:bg-amber-100",
    bar: "border-amber-200 bg-amber-50/95",
    barText: "text-amber-900",
    ring: "focus-visible:ring-amber-300",
    boxOn: "border-amber-600 bg-amber-600 text-white",
    optionOn: "bg-amber-50/70",
    netText: "text-amber-700",
    tile: "bg-amber-50 text-amber-800",
    chipOn: "border-amber-300 bg-amber-50 text-amber-800 ring-2 ring-amber-200",
    chipRing: "ring-amber-400",
  },
};

/** Staff Payroll is indigo, Production Payroll amber. */
export const accentOf = (kind: PayrollKind): PayAccent => (kind === "production" ? "amber" : "indigo");

export const accentUi = (kind: PayrollKind): AccentUi => ACCENT_UI[accentOf(kind)];
