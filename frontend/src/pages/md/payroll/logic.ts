// Pure logic of the Payroll Analysis page: how figures become chips, chart rows, labels and questions. No React here,
// so it is unit-tested on its own (logic.test.ts).

import { changeTone, clockText, dayLong, inr, inrCompact, monthText, signed, type Tone } from "@/lib/md/format";
import type {
  BridgeStep,
  BridgeStepId,
  Change,
  GroupLine,
  MonthStatus,
  NetBand,
  PayrollDepartments,
  PayrollState,
  PayrollStatus,
  TrendRow,
} from "./types";

const dash = "—";

/** "+₹15,000.00" / "-₹40,000.00" / "₹0.00": an exact rupee change with its sign. */
export function signedInr(value: number | null | undefined, places = 2): string {
  if (value == null || Number.isNaN(value)) return dash;
  const rounded = Number(value.toFixed(places));
  if (rounded === 0) return inr(0, places);
  return `${rounded > 0 ? "+" : "-"}${inr(Math.abs(rounded), places)}`;
}

/** "+₹1.2 L" / "-₹45,000": the same with the portal's compact rupees. */
export function signedInrCompact(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return dash;
  return `${value > 0 ? "+" : ""}${inrCompact(value)}`;
}

export type DeltaView = { text: string; tone: Tone; direction: "up" | "down" | "flat" };

/**
 * The change chip next to a figure. `kind`: "money" shows the percent change (rupees when there is nothing to divide by),
 * "count" a plain number, "points" a percentage-point move. `goodWhen` is the direction that is good news ("neutral" for a
 * figure such as headcount, which is neither).
 */
export function deltaView(
  change: Change | null | undefined,
  kind: "money" | "count" | "points",
  goodWhen: "down" | "up" | "neutral" = "down",
): DeltaView | null {
  if (!change) return null;
  const direction = change.abs > 0 ? "up" : change.abs < 0 ? "down" : "flat";
  let text: string;
  if (kind === "points") text = `${signed(change.abs, 1)} pts`;
  else if (change.pct != null) text = `${signed(change.pct, 1)}%`;
  else text = kind === "count" ? signed(change.abs, 0) : signedInrCompact(change.abs);
  const tone: Tone = goodWhen === "neutral" ? "neutral" : changeTone(change.abs, goodWhen === "up");
  return { text, tone, direction };
}

/** "2026-01" -> "2025-12". */
export function previousMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

// ─── month state ────────────────────────────────────────────────────────────────────────────────────────────

export const STATE_STYLE: Record<PayrollState, { label: string; chip: string; dot: string }> = {
  paid: { label: "Paid", chip: "bg-green-100 text-green-800", dot: "bg-green-500" },
  part_paid: { label: "Part paid", chip: "bg-amber-100 text-amber-800", dot: "bg-amber-500" },
  generated: { label: "Generated", chip: "bg-blue-100 text-blue-800", dot: "bg-blue-500" },
  in_progress: { label: "In progress", chip: "bg-slate-100 text-slate-700", dot: "bg-slate-400" },
  not_generated: { label: "Not generated", chip: "bg-red-100 text-red-800", dot: "bg-red-500" },
  not_started: { label: "Not started", chip: "bg-slate-50 text-slate-500", dot: "bg-slate-300" },
  no_data: { label: "No payroll", chip: "bg-slate-50 text-slate-400", dot: "bg-slate-200" },
};

/** The server's wall-clock timestamp as "01 Oct 2026, 9:00 am". */
export function whenText(iso: string | null | undefined): string {
  if (!iso) return dash;
  return `${dayLong(iso)}, ${clockText(iso)}`;
}

export type StatusSummary = { headline: string; detail: string; tone: "good" | "warn" | "bad" | "info" };

/** One plain sentence for the status banner: which month this is and what is outstanding about it. */
export function describeStatus(status: MonthStatus): StatusSummary {
  const unpaid = `${status.unpaidSlips} of ${status.slips} slips are not marked paid (${inr(status.unpaidNet)} net pay)`;
  switch (status.state) {
    case "paid":
      return status.provisionalSlips > 0
        ? {
            headline: "Paid, but some figures are provisional",
            detail: `${status.provisionalSlips} staff slip(s) were generated before the month ended and understate pay: regenerate payroll.`,
            tone: "warn",
          }
        : { headline: "Paid", detail: `All ${status.slips} slips are marked paid.`, tone: "good" };
    case "part_paid":
      return { headline: "Part paid", detail: `${unpaid}.`, tone: "warn" };
    case "generated":
      return { headline: "Generated, not marked paid", detail: `${unpaid}.`, tone: "warn" };
    case "in_progress":
      return {
        headline: "Month in progress",
        detail:
          "The month has not ended: staff slips count the days still to come as absent, so these figures are provisional.",
        tone: "warn",
      };
    case "not_generated":
      return { headline: "Not generated", detail: "Payroll has not been generated for this month.", tone: "bad" };
    default:
      return { headline: STATE_STYLE[status.state].label, detail: "There is no payroll for this month.", tone: "info" };
  }
}

// ─── month picker ───────────────────────────────────────────────────────────────────────────────────────────

/** The picker's value for "the latest closed month" (Radix selects cannot hold an empty string). */
export const LATEST = "__latest__";

export type MonthOption = { value: string; label: string; state?: PayrollState };

/** The months the picker offers: those with payroll (newest first), plus the one currently chosen if it has none. */
export function monthOptions(status: PayrollStatus | undefined, chosen: string): MonthOption[] {
  const byMonth = new Map((status?.months ?? []).map((m) => [m.month, m]));
  const months = [...(status?.available ?? [])];
  if (chosen && !months.includes(chosen)) months.unshift(chosen);
  return months.map((m) => ({ value: m, label: monthText(m), state: byMonth.get(m)?.state }));
}

// ─── trend chart ────────────────────────────────────────────────────────────────────────────────────────────

/** "2026-09" -> "Sep 26": short enough for twelve ticks, with the year so a window across new year stays readable. */
export function tickMonth(month: string): string {
  return `${monthText(month, true)} ${month.slice(2, 4)}`;
}

export type TrendChartRow = {
  month: string;
  gross: number | null;
  grossProvisional: number | null;
  headcount: number | null;
};

/** Gross pay bars (months still running, or with provisional slips, drawn in a lighter series) and the headcount line. */
export function trendChartRows(rows: TrendRow[]): TrendChartRow[] {
  return rows.map((r) => {
    const provisional = r.hasData && (r.state === "in_progress" || r.provisionalSlips > 0);
    return {
      month: r.month,
      gross: provisional ? null : r.grossPay,
      grossProvisional: provisional ? r.grossPay : null,
      headcount: r.headcount,
    };
  });
}

// ─── the bridge as a waterfall ──────────────────────────────────────────────────────────────────────────────

export const STEP_SHORT: Record<BridgeStepId, string> = {
  joined: "Joined",
  left: "Left",
  rate: "Pay rate",
  overtime: "Overtime",
  attendance: "Attendance",
  oneoffs: "One-offs",
  other: "Other",
};

export type WaterfallBar = {
  key: string;
  label: string;
  shortLabel: string;
  kind: "total" | "up" | "down";
  /** The exact amount: a total, or the signed change of a step. */
  amount: number;
  /** The invisible part under a floating step (0 for a total). */
  base: number;
  /** The height that is drawn. */
  value: number;
  /** The running total before and after (a total's `to` is its own amount). */
  from: number;
  to: number;
  people?: number;
  detail?: string;
};

const r2 = (n: number) => Math.round(n * 100) / 100;

/** A step the chart draws: it moved money or it touched people (steps that did neither are listed, not drawn). */
export const stepIsDrawn = (s: BridgeStep) => s.amount !== 0 || s.people > 0;

/**
 * Start total, one floating bar per step, end total. Each step floats from the running total before it to the running
 * total after it, so the last step always lands on the end total when the steps add up (they do: the server makes
 * them add up to the paisa, and `reconciles` lets a test and the page prove it).
 */
export function buildWaterfall(
  start: { label: string; amount: number },
  steps: BridgeStep[],
  end: { label: string; amount: number },
): WaterfallBar[] {
  const bars: WaterfallBar[] = [
    {
      key: "start",
      label: start.label,
      shortLabel: start.label.replace(" gross pay", ""),
      kind: "total",
      amount: start.amount,
      base: 0,
      value: start.amount,
      from: 0,
      to: start.amount,
    },
  ];
  let running = start.amount;
  for (const step of steps.filter(stepIsDrawn)) {
    const next = r2(running + step.amount);
    bars.push({
      key: step.id,
      label: step.label,
      shortLabel: STEP_SHORT[step.id] ?? step.label,
      kind: step.amount >= 0 ? "up" : "down",
      amount: step.amount,
      base: Math.min(running, next),
      value: Math.abs(step.amount),
      from: running,
      to: next,
      people: step.people,
      detail: step.detail,
    });
    running = next;
  }
  bars.push({
    key: "end",
    label: end.label,
    shortLabel: end.label.replace(" gross pay", ""),
    kind: "total",
    amount: end.amount,
    base: 0,
    value: end.amount,
    from: 0,
    to: end.amount,
  });
  return bars;
}

/** True when the drawn steps land on the end total (to the paisa). */
export function reconciles(bars: WaterfallBar[]): boolean {
  const end = bars[bars.length - 1];
  const last = bars.length > 2 ? bars[bars.length - 2] : bars[0];
  return Math.abs(last.to - end.to) < 0.005;
}

/** The value axis of the waterfall: it does not start at zero (the steps would be invisible slivers next to the totals),
 *  so the page says so. */
export function waterfallDomain(bars: WaterfallBar[]): { min: number; max: number; truncated: boolean } {
  const levels = bars.flatMap((b) => (b.kind === "total" ? [b.to] : [b.from, b.to]));
  const lo = Math.min(...levels);
  const hi = Math.max(...levels);
  const span = hi - lo;
  if (span === 0) return { min: Math.max(0, lo * 0.9), max: hi * 1.1 || 1, truncated: lo * 0.9 > 0 };
  const min = Math.max(0, lo - span * 0.6);
  return { min, max: hi + span * 0.18, truncated: min > 0 };
}

// ─── departments, units, staff vs production ────────────────────────────────────────────────────────────────

export type GroupView = "department" | "unit" | "type";

export type GroupRow = GroupLine & { key: string; name: string; unit: string | null };

/** The rows of the chosen grouping, highest cost first (the server already ranks them; this keeps a stable key). */
export function groupRows(data: PayrollDepartments | undefined, view: GroupView): GroupRow[] {
  if (!data) return [];
  if (view === "unit") return data.units.map((u) => ({ ...u, key: `unit-${u.id ?? "none"}`, unit: null }));
  if (view === "type") return data.types.map((t) => ({ ...t, key: `type-${t.id}`, unit: null }));
  return data.departments.map((d) => ({ ...d, key: `dept-${d.id ?? "none"}` }));
}

// ─── distribution ───────────────────────────────────────────────────────────────────────────────────────────

export type BandKind = "all" | "staff" | "production";

/** "Under ₹10k" -> "<10k", "₹10k–15k" -> "10k–15k", "Nil or negative" -> "Nil": a label short enough for a column. */
export function bandTick(label: string): string {
  return label.replace("Under ₹", "<").replace("Nil or negative", "Nil").replace(/₹/g, "");
}

export function bandRows(bands: NetBand[], kind: BandKind): { label: string; tick: string; count: number }[] {
  return bands.map((b) => ({ label: b.label, tick: bandTick(b.label), count: kind === "all" ? b.count : b[kind] }));
}

// ─── exceptions list ────────────────────────────────────────────────────────────────────────────────────────

export const EXCEPTION_PAGE = 10;
export const EXCEPTION_CAP = 100;

/** How many rows to ask for after "Show more": ten more, never past what exists or the server's cap. */
export function nextLimit(current: number, matching: number): number {
  return Math.min(current + EXCEPTION_PAGE, Math.max(current, matching), EXCEPTION_CAP);
}

// ─── questions for the assistant ────────────────────────────────────────────────────────────────────────────

export function bridgeQuestion(label: string, previousLabel: string, change: Change | null | undefined): string {
  if (!change || change.abs === 0) return `What changed in payroll in ${label} compared with ${previousLabel}?`;
  return `Why did payroll ${change.abs > 0 ? "rise" : "fall"} in ${label} compared with ${previousLabel}?`;
}
