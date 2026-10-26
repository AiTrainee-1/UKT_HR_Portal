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
  /**
   * "Price permissions separately" is ON: the permissions beyond the cap LEAVE this pool (the pool is the Late and Early
   * Out days only) and are priced on their own (permissionPricing). `excess` still reports how many there are.
   */
  permissionsPriced?: boolean;
}): Pool {
  const whole = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0);
  const excess = Math.max(0, whole(input.approvedPermissions) - whole(input.cap));
  const total = whole(input.lateIn) + whole(input.earlyOut) + (input.permissionsPriced ? 0 : excess);
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

// ── permission pricing (staff, behind a switch) ──
//
// attendance_final.permission_pricing_summary / payroll_views: with "Price permissions separately" ON, the approved
// permissions beyond the monthly cap leave the late pool and are priced on their own: free ones first, then the slab table
// ("from this many billable permissions, this many shifts"), with the same lookup as the late slabs. OFF changes nothing.

export type PermissionSlab = { fromPermissions: number; deductionShifts: number };
export type PermissionSlabText = { fromPermissions: string; deductionShifts: string };

export const MAX_PERMISSION_ALLOWANCE = 999;
export const MAX_PERMISSION_FROM = 999;
export const MAX_PERMISSION_SLABS = 50;

/**
 * The rows in ascending order of their "from" count; the highest row the billable count reaches wins and the last row
 * holds beyond the table. No rows (or a count below the first row) = no deduction. Rows that are not numbers are skipped.
 * Returns the row that applied as well, for the worked example.
 */
export function permissionSlabHit(
  billable: number,
  slabs: PermissionSlab[],
): { shifts: number; row: PermissionSlab | null } {
  const rows = slabs
    .filter(
      (s) =>
        Number.isFinite(s.fromPermissions) &&
        Number.isFinite(s.deductionShifts) &&
        s.fromPermissions >= 0 &&
        s.deductionShifts >= 0,
    )
    .sort((a, b) => a.fromPermissions - b.fromPermissions);
  let hit: PermissionSlab | null = null;
  for (const row of rows) {
    if (billable >= Math.trunc(row.fromPermissions)) hit = row;
    else break;
  }
  return { shifts: hit ? hit.deductionShifts : 0, row: hit };
}

export type PermissionPricing = {
  enabled: boolean;
  approved: number;
  cap: number;
  /** max(0, approved - cap): the permissions that are beyond the cap, exactly as the late pool counts them today. */
  excess: number;
  freeAllowance: number;
  /** Excess permissions the free allowance covers (only while ON). */
  free: number;
  /** max(0, excess - freeAllowance) (only while ON; 0 while OFF: nothing is priced separately). */
  billable: number;
  row: PermissionSlab | null;
  shifts: number;
  /** shifts x the daily rate, to the paisa. 0 while OFF. */
  penalty: number;
};

const whole = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0);

/**
 * What the permissions of one month cost when they are priced separately (the slip's permissionSummary). While the switch
 * is OFF nothing is priced here: `shifts` and `penalty` are 0 and the excess permissions are marks of the late pool instead.
 */
export function permissionPricing(input: {
  enabled: boolean;
  approved: number;
  cap: number;
  freeAllowance: number;
  slabs: PermissionSlab[];
  /** The employee's daily rate: staff pricing, the month's salary over its working days. */
  dayRate: number;
}): PermissionPricing {
  const approved = whole(input.approved);
  const cap = whole(input.cap);
  const excess = Math.max(0, approved - cap);
  const freeAllowance = whole(input.freeAllowance);
  const base = { enabled: input.enabled, approved, cap, excess, freeAllowance };
  if (!input.enabled) return { ...base, free: 0, billable: 0, row: null, shifts: 0, penalty: 0 };
  const billable = Math.max(0, excess - freeAllowance);
  const { shifts, row } = permissionSlabHit(billable, input.slabs);
  return {
    ...base,
    free: Math.min(excess, freeAllowance),
    billable,
    row,
    shifts,
    penalty: Math.round(shifts * input.dayRate * 100) / 100,
  };
}

export type MonthOutcome = {
  /** The late pool: with pricing ON it holds the Late and Early Out days only. */
  pool: Pool;
  poolShifts: number;
  poolPenalty: number;
  permissions: PermissionPricing;
  totalShifts: number;
  totalPenalty: number;
};

/**
 * One made-up month for one staff member: the late pool (priced by the late slabs) and, with the switch ON, the
 * permissions beyond the cap priced on their own. Never the same incident twice: each excess permission is in exactly one
 * of the two.
 */
export function monthOutcome(input: {
  lateIn: number;
  earlyOut: number;
  approvedPermissions: number;
  cap: number;
  allowance: number;
  slabs: Slab[];
  pricing: { enabled: boolean; freeAllowance: number; slabs: PermissionSlab[] };
  dayRate: number;
}): MonthOutcome {
  const pool = latePool({
    lateIn: input.lateIn,
    earlyOut: input.earlyOut,
    approvedPermissions: input.approvedPermissions,
    cap: input.cap,
    allowance: input.allowance,
    permissionsPriced: input.pricing.enabled,
  });
  const poolShifts = slabDeduction(pool.billable, input.slabs);
  const permissions = permissionPricing({
    enabled: input.pricing.enabled,
    approved: input.approvedPermissions,
    cap: input.cap,
    freeAllowance: input.pricing.freeAllowance,
    slabs: input.pricing.slabs,
    dayRate: input.dayRate,
  });
  const poolPenalty = Math.round(poolShifts * input.dayRate * 100) / 100;
  return {
    pool,
    poolShifts,
    poolPenalty,
    permissions,
    totalShifts: Math.round((poolShifts + permissions.shifts) * 100) / 100,
    totalPenalty: Math.round((poolPenalty + permissions.penalty) * 100) / 100,
  };
}

/** "Free permissions a month" must be a whole number from 0 to 999. */
export function permissionAllowanceProblem(text: string): string | null {
  const v = n(text);
  return Number.isInteger(v) && v >= 0 && v <= MAX_PERMISSION_ALLOWANCE
    ? null
    : `The free permissions must be a whole number from 0 to ${MAX_PERMISSION_ALLOWANCE}.`;
}

/**
 * Each row a whole number of billable permissions from 1 to 999 and a deduction of 0-31 shifts with at most 2 decimals; no
 * threshold twice; at most 50 rows (what the server accepts).
 */
export function permissionSlabsProblem(rows: PermissionSlabText[]): string | null {
  if (rows.length > MAX_PERMISSION_SLABS) return `At most ${MAX_PERMISSION_SLABS} slabs are allowed.`;
  const seen = new Set<number>();
  for (const row of rows) {
    const from = n(row.fromPermissions);
    const shifts = n(row.deductionShifts);
    if (!Number.isInteger(from) || from < 1 || from > MAX_PERMISSION_FROM) {
      return `Every slab needs a whole number of billable permissions from 1 to ${MAX_PERMISSION_FROM} in its first box.`;
    }
    if (!Number.isFinite(shifts) || shifts < 0 || shifts > MAX_SLAB_SHIFTS || !twoDecimals(shifts)) {
      return `Every slab needs a deduction from 0 to ${MAX_SLAB_SHIFTS} shifts, with at most 2 decimals.`;
    }
    if (seen.has(from)) return `Duplicate threshold: ${from} billable permissions appears more than once.`;
    seen.add(from);
  }
  return null;
}

export const PRICING_NEEDS_SLAB = "Add at least one slab before turning this on.";

/** What stops the permission pricing being saved: a bad allowance or row, or the switch ON with no row to price by. */
export function pricingProblem(draft: {
  enabled: boolean;
  allowance: string;
  slabs: PermissionSlabText[];
}): string | null {
  return (
    permissionAllowanceProblem(draft.allowance) ??
    permissionSlabsProblem(draft.slabs) ??
    (draft.enabled && draft.slabs.length === 0 ? PRICING_NEEDS_SLAB : null)
  );
}

/** Things that are allowed but are almost certainly not meant: said beside the table, never blocking the save. */
export function permissionSlabWarnings(slabs: PermissionSlab[]): string[] {
  const rows = slabs
    .filter((s) => Number.isFinite(s.fromPermissions) && Number.isFinite(s.deductionShifts))
    .sort((a, b) => a.fromPermissions - b.fromPermissions);
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].deductionShifts < rows[i - 1].deductionShifts) {
      return [
        `From ${rows[i].fromPermissions} billable permissions the deduction falls to ${rows[i].deductionShifts} (it was ${rows[i - 1].deductionShifts} from ${rows[i - 1].fromPermissions}): more permissions would cost less.`,
      ];
    }
  }
  return [];
}
