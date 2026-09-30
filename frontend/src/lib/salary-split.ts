// Salary split: the mandatory 50% + 50% breakdown of an employee's salary.
//
//   First portion  (50% of the salary)  Basic + DA + Retention Allowance
//   Second portion (50% of the salary)  Other Allowance + Petrol Allowance + RHA + Special Allowance + CA
//
// It applies to whatever the Salary Amount is, Monthly or Weekly alike. The eight amounts are filled in from the
// salary (`defaultSplit`), can be edited one by one, and must always obey the rule (`checkSplit`): each portion is
// exactly half of the salary and together they equal it. The server enforces the same rule
// (backend/api/salary_split.py) and both are tested against the same worked examples, so what the form accepts the
// server accepts. All arithmetic is in whole paise, so nothing ever drifts by a fraction of a paisa.
//
// The split is descriptive: payroll and attendance still run on the salary amount and never read it.

export type SplitKey =
  "basic" | "da" | "retentionAllowance" | "otherAllowance" | "petrolAllowance" | "rha" | "specialAllowance" | "ca";

export type SplitField = { key: SplitKey; label: string };

export const FIRST_PORTION: SplitField[] = [
  { key: "basic", label: "Basic" },
  { key: "da", label: "DA" },
  { key: "retentionAllowance", label: "Retention Allowance" },
];

export const SECOND_PORTION: SplitField[] = [
  { key: "otherAllowance", label: "Other Allowance" },
  { key: "petrolAllowance", label: "Petrol Allowance" },
  { key: "rha", label: "RHA" },
  { key: "specialAllowance", label: "Special Allowance" },
  { key: "ca", label: "CA" },
];

export const SPLIT_FIELDS: SplitField[] = [...FIRST_PORTION, ...SECOND_PORTION];
export const SPLIT_KEYS: SplitKey[] = SPLIT_FIELDS.map((f) => f.key);
export const SPLIT_LABEL: Record<SplitKey, string> = Object.fromEntries(
  SPLIT_FIELDS.map((f) => [f.key, f.label]),
) as Record<SplitKey, string>;

export const FIRST_LABEL = "First portion (Basic + DA + Retention Allowance)";
export const SECOND_LABEL = "Second portion (Other + Petrol + RHA + Special Allowance + CA)";

/** The split as the form holds it (text, so a half-typed amount is never rewritten under the user's cursor). */
export type SplitValues = Record<SplitKey, string>;
/** The split as the API carries it. */
export type SalaryBreakup = Record<SplitKey, number>;

export const EMPTY_SPLIT: SplitValues = Object.fromEntries(SPLIT_KEYS.map((k) => [k, ""])) as SplitValues;

const AMOUNT = /^(\d+)(?:\.(\d{0,2}))?$/;

/** Whole paise for a plain non-negative amount with at most two decimals, else null (blank, text, negative...).
 *  A trailing dot ("4300.") is accepted, so an amount can be typed. */
export function toPaise(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const match = AMOUNT.exec(String(value).trim());
  if (!match) return null;
  const rupees = Number(match[1]);
  const paise = Number((match[2] ?? "").padEnd(2, "0"));
  const total = rupees * 100 + paise;
  return Number.isSafeInteger(total) ? total : null;
}

/** 2150000 -> "21500.00" (how an amount goes back into an input). */
export function fromPaise(paise: number): string {
  const whole = Math.trunc(paise / 100);
  const frac = String(Math.abs(paise % 100)).padStart(2, "0");
  return `${whole}.${frac}`;
}

/** 2150000 -> "₹21,500.00" (for messages). */
export function rupees(paise: number): string {
  const [whole, frac] = fromPaise(paise).split(".");
  return `₹${Number(whole).toLocaleString("en-IN")}.${frac}`;
}

/** (first, second) in paise: 50% each, the odd paisa (if any) going to the first portion. */
export function halves(totalPaise: number): [number, number] {
  const first = Math.floor((totalPaise + 1) / 2);
  return [first, totalPaise - first];
}

function share(amount: number, parts: number): number[] {
  const base = Math.floor(amount / parts);
  const extra = amount % parts;
  return Array.from({ length: parts }, (_, i) => base + (i < extra ? 1 : 0));
}

/** The automatic split of a salary: each portion is half of it, shared equally by its components. Null when the
 *  amount is not a positive amount with at most two decimals. */
export function defaultSplit(total: string | number | null | undefined): SplitValues | null {
  const paise = toPaise(total);
  if (paise === null || paise <= 0) return null;
  const [first, second] = halves(paise);
  const values = [...share(first, FIRST_PORTION.length), ...share(second, SECOND_PORTION.length)];
  return Object.fromEntries(SPLIT_KEYS.map((k, i) => [k, fromPaise(values[i])])) as SplitValues;
}

/** The stored split as form text, or null when there is none. */
export function splitFromBreakup(breakup: Partial<SalaryBreakup> | null | undefined): SplitValues | null {
  if (!breakup) return null;
  const out = {} as SplitValues;
  for (const k of SPLIT_KEYS) {
    const v = breakup[k];
    if (v === null || v === undefined || Number.isNaN(Number(v))) return null;
    out[k] = fromPaise(Math.round(Number(v) * 100));
  }
  return out;
}

export type PortionStatus = {
  /** What the portion adds up to now, in paise. */
  sum: number;
  /** What it must be: exactly half the salary (either whole-paise neighbour of it, when the half is a fraction). */
  required: [number, number];
  ok: boolean;
  /** Paise still to place (positive) or over (negative), against the nearest allowed amount. */
  difference: number;
};

export type SplitCheck = {
  ok: boolean;
  /** The first problem in plain words (the same wording as the server), or null. */
  message: string | null;
  /** Problems with individual boxes (blank, not a number, negative, too many decimals). */
  fieldErrors: Partial<Record<SplitKey, string>>;
  totalPaise: number | null;
  first: PortionStatus | null;
  second: PortionStatus | null;
};

function portionStatus(sum: number, totalPaise: number): PortionStatus {
  const required: [number, number] = [Math.floor(totalPaise / 2), Math.floor((totalPaise + 1) / 2)];
  const ok = sum === required[0] || sum === required[1];
  const difference = ok ? 0 : sum < required[0] ? required[0] - sum : required[1] - sum;
  return { sum, required, ok, difference };
}

/** Is `values` a valid split of `total`? Live totals for the form, and the message that blocks Save. */
export function checkSplit(total: string | number | null | undefined, values: Partial<SplitValues>): SplitCheck {
  const totalPaise = toPaise(total);
  const fieldErrors: Partial<Record<SplitKey, string>> = {};
  const amounts: Partial<Record<SplitKey, number>> = {};
  for (const { key } of SPLIT_FIELDS) {
    const raw = (values[key] ?? "").trim();
    if (raw === "") {
      fieldErrors[key] = "Enter an amount (0 if none)";
      continue;
    }
    const paise = toPaise(raw);
    if (paise === null) {
      fieldErrors[key] = /^-/.test(raw) ? "Cannot be negative" : "Use a number with at most 2 decimals";
      continue;
    }
    amounts[key] = paise;
  }

  const sumOf = (fields: SplitField[]) => fields.reduce((n, f) => n + (amounts[f.key] ?? 0), 0);
  const first = totalPaise !== null && totalPaise > 0 ? portionStatus(sumOf(FIRST_PORTION), totalPaise) : null;
  const second = totalPaise !== null && totalPaise > 0 ? portionStatus(sumOf(SECOND_PORTION), totalPaise) : null;

  let message: string | null = null;
  if (totalPaise === null || totalPaise <= 0) {
    message = "Enter the salary amount (up to two decimal places) to work out the split.";
  } else if (Object.keys(fieldErrors).length > 0) {
    const key = SPLIT_KEYS.find((k) => fieldErrors[k]) as SplitKey;
    message = `${SPLIT_LABEL[key]}: ${fieldErrors[key]}.`;
  } else if (first && second) {
    const half = rupees(halves(totalPaise)[0]);
    if (!first.ok) {
      message = `${FIRST_LABEL} is ${rupees(first.sum)}; it must be 50% of the salary (${half}).`;
    } else if (!second.ok) {
      message = `${SECOND_LABEL} is ${rupees(second.sum)}; it must be 50% of the salary (${half}).`;
    } else if (first.sum + second.sum !== totalPaise) {
      message = `The two portions add up to ${rupees(first.sum + second.sum)} but the salary is ${rupees(totalPaise)}; together they must equal the salary exactly.`;
    }
  }
  return { ok: message === null, message, fieldErrors, totalPaise, first, second };
}

/** What goes into the API request: the eight amounts as exact decimal text. */
export function splitPayload(values: SplitValues): Record<SplitKey, string> {
  return Object.fromEntries(
    SPLIT_KEYS.map((k) => {
      const paise = toPaise(values[k]);
      return [k, paise === null ? values[k] : fromPaise(paise)];
    }),
  ) as Record<SplitKey, string>;
}
