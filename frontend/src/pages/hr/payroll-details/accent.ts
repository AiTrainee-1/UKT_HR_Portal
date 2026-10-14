import type { PayrollKind } from "@/lib/api-client/custom-hooks";

// Staff Payroll is indigo (the colour of its tabs), Production Payroll is amber. Tailwind only sees complete class
// names, so every class a kind needs is written out in full here and the components just read them.

export type Accent = {
  /** Text in the accent colour: links, small headings. */
  text: string;
  /** A pale surface in the accent colour. */
  soft: string;
  /** The same, as a KPI tile (background + text). */
  kpi: string;
  /** A strong fill with white text: the active section, the primary button. */
  solid: string;
  /** A hairline in the accent colour. */
  border: string;
  /** A ring for the one thing that is selected. */
  ring: string;
  /** A soft ring that sets the Net payable tile apart from the rest. */
  tileRing: string;
  /** The thin bar across the top of the header card. */
  bar: string;
  /** The title of the kind: "Payroll" / "Production Payroll". */
  name: string;
};

export const ACCENT: Record<PayrollKind, Accent> = {
  staff: {
    text: "text-indigo-700",
    soft: "bg-indigo-50",
    kpi: "bg-indigo-50 text-indigo-800",
    solid: "bg-indigo-600 text-white hover:bg-indigo-700",
    border: "border-indigo-200",
    ring: "ring-indigo-500",
    tileRing: "ring-2 ring-indigo-300",
    bar: "bg-indigo-500",
    name: "Payroll",
  },
  production: {
    text: "text-amber-700",
    soft: "bg-amber-50",
    kpi: "bg-amber-50 text-amber-800",
    solid: "bg-amber-600 text-white hover:bg-amber-700",
    border: "border-amber-200",
    ring: "ring-amber-500",
    tileRing: "ring-2 ring-amber-300",
    bar: "bg-amber-500",
    name: "Production Payroll",
  },
};
