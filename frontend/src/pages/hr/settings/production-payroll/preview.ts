/**
 * Worked examples for the Production Payroll tab, with the engine's own rules:
 *   late deduction   backend/api/payroll_views.py      late_shift_deduction (the production slab pool, per cycle)
 *   a late day       backend/api/payroll_views.py      _production_late_days (Simple / Strict, seconds count)
 *   PF / ESI         backend/api/payroll_views.py      _generate_production_payroll, with the cycle's monthly factor
 * The pay period maths is in ./cycles.ts. Money is whole paise, rounded as the engine rounds.
 */

import {
  divRoundHalfUp,
  productionPay,
  toPaise,
  type ProductionPay,
  type ProductionPayInput,
} from "../payroll/preview";
import { CYCLE_INFO, type PayCycle } from "./cycles";

// ── late deductions ──

export type LateSlab = { fromLates?: unknown; deductionShifts?: unknown };

const wholeNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^\s*[+-]?\d+\s*$/.test(value)) return Number.parseInt(value, 10);
  return null;
};

const plainNumber = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^\s*[+-]?(\d+\.?\d*|\.\d+)\s*$/.test(value)) return Number(value);
  return null;
};

/**
 * Shifts deducted for `billable` lates under a slab table: rows sorted by their threshold, the highest row reached
 * wins and the last row holds beyond it; an empty table deducts nothing; unreadable rows are skipped.
 */
export function lateShiftDeduction(billable: number, slabs: LateSlab[]): number {
  const rows = slabs
    .map((s) =>
      s && typeof s === "object" ? { from: wholeNumber(s.fromLates), shifts: plainNumber(s.deductionShifts) } : null,
    )
    .filter((r): r is { from: number; shifts: number } => !!r && r.from !== null && r.shifts !== null)
    .sort((a, b) => a.from - b.from);
  let deduction = 0;
  for (const row of rows) {
    if (billable >= row.from) deduction = row.shifts;
    else break;
  }
  return deduction;
}

export type LatePenalty = { billable: number; shifts: number; penalty: number };

/** One pay period's late penalty: lates beyond the free allowance are billable; penalty = shifts x the worker's rate. */
export function productionLatePenalty(
  lates: number,
  allowance: number,
  slabs: LateSlab[],
  ratePerShift: number,
): LatePenalty {
  const billable = Math.max(0, lates - Math.max(0, allowance || 0));
  const shifts = lateShiftDeduction(billable, slabs);
  const penalty = shifts > 0 ? divRoundHalfUp(Math.round(shifts * 10_000) * toPaise(ratePerShift), 10_000) : 0;
  return { billable, shifts, penalty };
}

// ── a late day ──

const seconds = (clock: string): number => {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(clock.trim());
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0) : 0;
};

/**
 * Whether one day is late for production late deductions: the first punch after shift start + grace (to the second),
 * or, in Strict mode, the last punch before shift end - grace. Either or both make ONE late day.
 */
export function judgeProductionDay(input: {
  shiftStart: string;
  shiftEnd: string;
  graceMinutes: number;
  firstPunch: string;
  lastPunch?: string | null;
  mode: string;
}): { late: boolean; arrivedLate: boolean; leftEarly: boolean } {
  const grace = (input.graceMinutes || 0) * 60;
  const arrivedLate = seconds(input.firstPunch) > seconds(input.shiftStart) + grace;
  const leftEarly =
    input.mode === "strict" && !!input.lastPunch && seconds(input.lastPunch) < seconds(input.shiftEnd) - grace;
  return { late: arrivedLate || leftEarly, arrivedLate, leftEarly };
}

// ── PF and ESI on a cycle's payslip ──

/**
 * One production payslip on a pay cycle: gross = shifts x rate per shift, and the "estimated monthly pay" the PF / ESI
 * salary bands and the ESI ceiling are tested on is the period's gross x 4 (Weekly), x 2 (BiWeekly) or x 1 (Monthly: a
 * production month is four weeks). The rest is the Payroll tab's productionPay: a matching band wins (even while the
 * flat switch is off; its EF % has no ceiling test), otherwise the flat rates when their switch is on (ESI only while
 * the estimate is at or below the ceiling), otherwise none.
 */
export function cyclePay(input: ProductionPayInput, cycle: PayCycle): ProductionPay {
  return productionPay({ ...input, monthlyFactor: CYCLE_INFO[cycle].monthlyFactor });
}
