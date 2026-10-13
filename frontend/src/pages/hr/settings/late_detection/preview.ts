// The Late Detection tab's examples and checks. The pricing functions are twins of the engine (named in each comment)
// and are tested against its worked numbers (preview.test.ts): what the tab shows is what payroll would deduct.

export type Slab = { fromLates: number; deductionShifts: number };

const isSlab = (s: Slab) =>
  Number.isFinite(s.fromLates) && Number.isFinite(s.deductionShifts) && s.fromLates >= 0 && s.deductionShifts >= 0;

/**
 * payroll_views.late_shift_deduction: the rows in ascending order of their "from" count; the highest row the billable
 * count reaches wins and the last row holds beyond the table. No rows = no deduction. Rows that are not numbers are
 * skipped, as the engine skips malformed rows.
 */
export function slabDeduction(billable: number, slabs: Slab[]): number {
  const rows = slabs.filter(isSlab).sort((a, b) => a.fromLates - b.fromLates);
  let deduction = 0;
  for (const row of rows) {
    if (billable >= Math.trunc(row.fromLates)) deduction = row.deductionShifts;
    else break;
  }
  return deduction;
}

export type Pool = {
  lateIn: number;
  earlyOut: number;
  /** Approved permissions beyond the monthly cap: each one is a mark. */
  excess: number;
  total: number;
  free: number;
  billable: number;
};

/**
 * attendance_final.late_pool_summary: Late days + Early Out days + every approved permission beyond the monthly cap
 * (whatever its type) make one pool; the first `allowance` marks are free and the rest are billable.
 */
export function latePool(input: {
  lateIn: number;
  earlyOut: number;
  approvedPermissions: number;
  cap: number;
  allowance: number;
}): Pool {
  const whole = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0);
  const excess = Math.max(0, whole(input.approvedPermissions) - whole(input.cap));
  const total = whole(input.lateIn) + whole(input.earlyOut) + excess;
  const allowance = whole(input.allowance);
  return {
    lateIn: whole(input.lateIn),
    earlyOut: whole(input.earlyOut),
    excess,
    total,
    free: Math.min(total, allowance),
    billable: Math.max(0, total - allowance),
  };
}

/**
 * attendance_final.permission_cap_status: approved permissions are ranked earliest first (by date, then by id) within
 * their calendar month; the first `cap` are within the cap. True for each position (1st, 2nd ...) that is within it.
 */
export const withinCap = (count: number, cap: number): boolean[] =>
  Array.from({ length: Math.max(0, Math.trunc(count)) }, (_, i) => i < Math.max(0, Math.trunc(cap)));

// ── checks ──

export const MAX_ALLOWANCE = 999;
export const MAX_CAP = 31;
export const MAX_SLAB_SHIFTS = 31;

const n = (text: string): number => (text.trim() === "" ? NaN : Number(text));
const twoDecimals = (v: number) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9;

export function allowanceProblem(text: string): string | null {
  const v = n(text);
  return Number.isInteger(v) && v >= 0 && v <= MAX_ALLOWANCE
    ? null
    : `The free allowance must be a whole number of marks from 0 to ${MAX_ALLOWANCE}.`;
}

export type SlabText = { fromLates: string; deductionShifts: string };

/** Each row a whole number of billable marks (0 or more) and a deduction of 0-31 shifts; no threshold twice. */
export function slabsProblem(rows: SlabText[]): string | null {
  const seen = new Set<number>();
  for (const row of rows) {
    const from = n(row.fromLates);
    const shifts = n(row.deductionShifts);
    if (!Number.isInteger(from) || from < 0) {
      return "Every slab needs a whole number of billable marks (0 or more) in its first box.";
    }
    if (!Number.isFinite(shifts) || shifts < 0 || shifts > MAX_SLAB_SHIFTS || !twoDecimals(shifts)) {
      return `Every slab needs a deduction from 0 to ${MAX_SLAB_SHIFTS} shifts, with at most 2 decimals.`;
    }
    if (seen.has(from)) return `Duplicate threshold: ${from} billable marks appears more than once.`;
    seen.add(from);
  }
  return null;
}

export function capProblem(text: string): string | null {
  const v = n(text);
  return Number.isInteger(v) && v >= 0 && v <= MAX_CAP
    ? null
    : `Permission monthly cap must be a whole number from 0 to ${MAX_CAP}.`;
}

/** Things that are allowed but are almost certainly not meant: said beside the table, never blocking the save. */
export function slabWarnings(slabs: Slab[]): string[] {
  const rows = slabs.filter(isSlab).sort((a, b) => a.fromLates - b.fromLates);
  const warnings: string[] = [];
  const zero = rows.find((r) => r.fromLates === 0 && r.deductionShifts > 0);
  if (zero) {
    warnings.push(
      `The row "from 0" takes ${zero.deductionShifts} shift from every staff member every month, even someone with no marks at all.`,
    );
  }
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].deductionShifts < rows[i - 1].deductionShifts) {
      warnings.push(
        `From ${rows[i].fromLates} billable marks the deduction falls to ${rows[i].deductionShifts} (it was ${rows[i - 1].deductionShifts} from ${rows[i - 1].fromLates}): more marks would cost less.`,
      );
      break;
    }
  }
  return warnings;
}
