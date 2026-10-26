import type { PayrollBreakdown, PayrollStatutory, StatutoryRuleMatch } from "@/lib/api-client/custom-hooks";
import type { TableColumn } from "./export-table";
import { inr, inr2 } from "./format";

// PF, ESI and TDS on the payroll screens, as plain functions. PF and ESI only ever apply to Co Emp employees (rules from
// Settings -> PF & ESI); TDS only to employees on the TDS list. So the screens show a TDS column / line ONLY where a row
// has TDS, and never an empty one: everything that decides "is there TDS here?" lives in this file, so the register, the
// cards, the payslip list, the Breakdown drawer and the exports all agree.

/** Where the PF & ESI rules are edited (Settings -> PF & ESI). One place, so a change of address is one edit. */
export const PF_ESI_SETTINGS_PATH = "/hr/settings?tab=pf_esi";

/** Where an employee is made Co Emp (the PF / ESI switch) or added to TDS: the Employees page, Co Emp tab. */
export const CO_EMP_EMPLOYEES_PATH = "/hr/employees";

/** The two TDS fields any payroll row, slip or adjust target may carry. Both are absent on rows without TDS. */
export type TdsFields = {
  tdsDeduction?: number | string | null;
  tdsPercent?: number | string | null;
};

const toNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};

const money = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

/** The TDS a row carries, in rupees (0 when it has none). */
export const tdsAmount = (row: TdsFields | null | undefined): number => toNumber(row?.tdsDeduction) ?? 0;

/** The TDS percentage a row was worked out with, or null. */
export const tdsRate = (row: TdsFields | null | undefined): number | null => toNumber(row?.tdsPercent);

/** A row is a TDS row when it has a TDS amount, or a TDS percentage (an employee on the TDS list whose TDS came to 0). */
export const hasTds = (row: TdsFields | null | undefined): boolean => tdsAmount(row) > 0 || tdsRate(row) !== null;

/** Whether any row of a view has TDS: the TDS column is drawn only then. */
export const anyTds = (rows: readonly (TdsFields | null | undefined)[] | null | undefined): boolean =>
  (rows ?? []).some(hasTds);

/** The TDS of a set of rows, added up. */
export const sumTds = (rows: readonly (TdsFields | null | undefined)[] | null | undefined): number =>
  money((rows ?? []).reduce((total, row) => total + tdsAmount(row), 0));

/** "10%", "7.5%": a percentage without trailing zeros. */
export function percentText(value: number | string | null | undefined): string {
  const n = toNumber(value);
  if (n === null) return "";
  return `${Number.isInteger(n) ? n : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}%`;
}

/** "TDS (10%)" for a TDS row; "TDS" when the percentage is not known. */
export const tdsLabel = (row: TdsFields | null | undefined): string => {
  const rate = percentText(tdsRate(row));
  return rate ? `TDS (${rate})` : "TDS";
};

/**
 * The two export columns of TDS ("TDS %" and "TDS", rupees), put just before the `deductions` total (the total includes
 * the TDS, as in the printed statement) when any of `rows` has TDS. Without TDS the columns come back as they were, the very
 * same array, so an export with no TDS employee is exactly what it always was.
 */
export function withTdsColumns<Row extends TdsFields>(
  columns: TableColumn<Row>[],
  rows: readonly Row[],
  beforeKey = "deductions",
): TableColumn<Row>[] {
  if (!anyTds(rows)) return columns;
  const extra: TableColumn<Row>[] = [
    { key: "tdsPercent", label: "TDS %", width: 9, type: "money", value: (r) => tdsRate(r) },
    { key: "tdsDeduction", label: "TDS", width: 12, type: "money", value: (r) => (hasTds(r) ? tdsAmount(r) : null) },
  ];
  const at = columns.findIndex((c) => c.key === beforeKey);
  return at < 0 ? [...columns, ...extra] : [...columns.slice(0, at), ...extra, ...columns.slice(at)];
}

// ── What the Breakdown drawer and the details page say about PF, ESI and TDS ───────────────────────────────────────

export const BASIS_LABEL: Record<string, string> = {
  basic: "Basic salary",
  first_portion: "Basic + DA + Retaining Allowance",
  total: "Full monthly salary",
};

/** A Production worker has no monthly salary: the rules are tested on the monthly equivalent of the period's pay. */
export const PRODUCTION_BASIS_LABEL: Record<string, string> = {
  basic: "Basic part of the monthly equivalent pay",
  first_portion: "First 50% of the monthly equivalent pay",
  total: "Monthly equivalent pay",
};

export const basisLabel = (basis: string | null | undefined, production = false): string =>
  (production ? PRODUCTION_BASIS_LABEL : BASIS_LABEL)[basis ?? ""] ?? "Salary";

const rupees = (value: number | null | undefined): string =>
  value === null || value === undefined ? "—" : inr(value, Number.isInteger(value) ? 0 : 2);

/** "₹0 to ₹25,000", "₹25,000 and above" (a maximum of 0 means no upper limit). */
export function rangeText(rule: Pick<StatutoryRuleMatch, "minAmount" | "maxAmount">): string {
  const min = Number(rule.minAmount) || 0;
  const max = Number(rule.maxAmount) || 0;
  return max > 0 ? `${rupees(min)} to ${rupees(max)}` : `${rupees(min)} and above`;
}

/** Which rules this payroll was priced with: "the global rules" or "this unit's own rules". */
export function rulesScopeText(statutory: Pick<PayrollStatutory, "rulesScope">): string {
  return statutory.rulesScope === "branch" ? "this unit's own rules" : "the rules for all units";
}

export type StatutoryLine = {
  key: "pf" | "esi" | "tds";
  /** "PF", "ESI", "TDS". */
  title: string;
  /** Whether anything was deducted. */
  applied: boolean;
  /** The sum in words: "12% of ₹12,500", or "No rule matched". */
  summary: string;
  /** The rupees deducted (0 when nothing was). */
  amount: number;
  /** The lines under it: the rule, the amount it was tested on, why nothing was deducted. */
  notes: string[];
};

export type StatutoryView = {
  category: PayrollStatutory["category"];
  /** One sentence on what kind of employee this is and what that means for PF / ESI / TDS. */
  headline: string;
  lines: StatutoryLine[];
  /** The amounts every rule's range could have been tested on, when payroll recorded them. */
  eligibility: { label: string; amount: number }[];
};

/** The words for one matched PF / ESI rule: its name, the range and the figure that fell in it. */
function ruleNotes(rule: StatutoryRuleMatch, what: string, production: boolean): string[] {
  return [
    `Rule "${rule.label}": ${basisLabel(rule.basis, production)} of ${inr2(rule.amountTested)} is in its range (${rangeText(rule)}).`,
    `${what} is deducted at ${percentText(rule.ratePercent)}.`,
  ];
}

/** Why no PF / ESI rule matched: the amounts that were looked at. */
function noRuleNotes(what: string, statutory: PayrollStatutory, production: boolean): string[] {
  const e = statutory.eligibility;
  if (!e) return [`No ${what} rule in Settings covers this employee's salary, so none is deducted.`];
  const seen = production
    ? `${PRODUCTION_BASIS_LABEL.basic.toLowerCase()} ${inr2(e.basic)}, ${PRODUCTION_BASIS_LABEL.first_portion.toLowerCase()} ${inr2(e.firstPortion)} or ${PRODUCTION_BASIS_LABEL.total.toLowerCase()} ${inr2(e.total)}`
    : `Basic salary ${inr2(e.basic)}, Basic + DA + Retaining Allowance ${inr2(e.firstPortion)} or full salary ${inr2(e.total)}`;
  return [`No ${what} rule covers this employee's ${seen}.`];
}

/**
 * What payroll recorded about PF, ESI and TDS as sentences and figures, ready to draw. `deductions` supplies the rupees
 * (the statutory block holds the rules and the bases, the breakdown holds the amounts). Returns null when payroll recorded
 * nothing (a payroll generated before the redesign has no `statutory` block).
 */
export function explainStatutory(
  statutory: PayrollStatutory | null | undefined,
  deductions: Pick<PayrollBreakdown["deductions"], "pf" | "esi" | "tds"> | null | undefined,
  /** A Production payroll: the rules were tested on the monthly equivalent of the period's pay, and the labels say so. */
  production = false,
): StatutoryView | null {
  if (!statutory || typeof statutory !== "object") return null;
  const pf = toNumber(deductions?.pf) ?? 0;
  const esi = toNumber(deductions?.esi) ?? 0;
  const tds = toNumber(deductions?.tds) ?? statutory.tds?.amount ?? 0;
  const wages = toNumber(statutory.pfWages);
  const e = statutory.eligibility;
  const eligibility = e
    ? [
        { label: basisLabel("basic", production), amount: e.basic },
        { label: basisLabel("first_portion", production), amount: e.firstPortion },
        { label: basisLabel("total", production), amount: e.total },
      ]
    : [];

  if (statutory.category === "co_emp") {
    const lines: StatutoryLine[] = [];
    for (const [key, title, rule, amount] of [
      ["pf", "PF", statutory.pfRule, pf],
      ["esi", "ESI", statutory.esiRule, esi],
    ] as const) {
      if (rule) {
        lines.push({
          key,
          title,
          applied: amount > 0,
          summary: `${percentText(rule.ratePercent)} of ${wages === null ? "Basic + DA + Retaining Allowance" : inr2(wages)}`,
          amount,
          notes: ruleNotes(rule, title, production),
        });
      } else {
        lines.push({
          key,
          title,
          applied: false,
          summary: "No rule matched",
          amount: 0,
          notes: noRuleNotes(title, statutory, production),
        });
      }
    }
    return {
      category: "co_emp",
      headline: `Co Emp employee: PF and ESI are worked out from ${rulesScopeText(statutory)} in Settings, on Basic + DA + Retaining Allowance${
        wages === null ? "" : ` (${inr2(wages)} for the days paid)`
      }.`,
      lines,
      eligibility,
    };
  }

  if (statutory.category === "tds") {
    const t = statutory.tds;
    const rate = percentText(t?.percent);
    return {
      category: "tds",
      headline: "TDS employee: TDS is deducted instead of PF and ESI, which never apply to this employee.",
      lines: [
        {
          key: "tds",
          title: rate ? `TDS (${rate})` : "TDS",
          applied: tds > 0,
          summary: t ? `${rate} of the earned gross ${inr2(t.base)}` : "Percentage not recorded",
          amount: tds,
          notes: [],
        },
      ],
      eligibility: [],
    };
  }

  return {
    category: "none",
    headline: statutory.reason?.trim() || "Not a Co Emp employee: no PF or ESI is deducted.",
    lines: [],
    eligibility: [],
  };
}

/** The label of a PF or ESI line in the Breakdown drawer, from what payroll stored. */
export function statutoryRateLabel(
  kind: "pf" | "esi",
  deductions: Pick<PayrollBreakdown["deductions"], "pfRate" | "esiRate" | "statutory">,
): string {
  const rate = kind === "pf" ? deductions.pfRate : deductions.esiRate;
  const name = kind === "pf" ? "PF" : "ESI";
  const text = percentText(rate);
  const wages = toNumber(deductions.statutory?.pfWages);
  if (text && wages !== null) return `${name} (${text} of ${inr2(wages)})`;
  return text ? `${name} (${text})` : name;
}
