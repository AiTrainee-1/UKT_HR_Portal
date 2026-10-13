// Worked examples for the Salary Slip tab, using the formulas of the code that reads the settings.

/** An amount as the PDFs print it: rupee sign, thousands commas, two decimals (document_pdf.rupee, Python "{:,.2f}"). */
export function pdfRupee(amount: number): string {
  const value = Number.isFinite(amount) ? amount : 0;
  return `₹${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export type MinWageCase = {
  /** The made-up slip. */
  label: string;
  /** How the report reads the figure for this case. */
  reading: string;
  /** The slip's wage per unit, as the report works it out. */
  wage: number;
  result: "OK" | "Below minimum";
  /** Money needed to bring the period's pay up to the minimum (0 when OK). */
  shortfall: number;
};

// The made-up slips of the examples (also the numbers in the inventory: 18,000 over 26 paid days = 692.31 a day).
const STAFF_GROSS = 18000;
const STAFF_PAID_DAYS = 26;
const STAFF_WORKING_DAYS = 26;
const PROD_GROSS = 9000;
const PROD_SHIFTS = 15;

/**
 * What the Report Center's "Minimum Wage Compliance" check says for a staff slip and a production slip, with the
 * figure typed in (reporting/definitions/payroll_statutory_controls.py _run_min_wage). The figure has no unit, so the
 * report lets the reader choose: per paid day / shift (its default) or per month (staff only). Nothing else reads
 * the figure: it never changes pay, PF or ESI.
 */
export function minWageCases(rate: number): MinWageCase[] {
  if (!(rate > 0)) return [];
  const staffDay = STAFF_GROSS / STAFF_PAID_DAYS;
  const prodShift = PROD_GROSS / PROD_SHIFTS;
  const below = (wage: number) => wage < rate;
  return [
    {
      label: `Staff slip: ${pdfRupee(STAFF_GROSS)} for ${STAFF_PAID_DAYS} paid days`,
      reading: "read per paid day (the report's default)",
      wage: round2(staffDay),
      result: below(staffDay) ? "Below minimum" : "OK",
      shortfall: below(staffDay) ? round2((rate - staffDay) * STAFF_PAID_DAYS) : 0,
    },
    {
      label: `Same staff slip: monthly salary ${pdfRupee(STAFF_GROSS)}`,
      reading: "read per month",
      wage: STAFF_GROSS,
      result: below(STAFF_GROSS) ? "Below minimum" : "OK",
      shortfall: below(STAFF_GROSS) ? round2(((rate - STAFF_GROSS) * STAFF_PAID_DAYS) / STAFF_WORKING_DAYS) : 0,
    },
    {
      label: `Production slip: ${pdfRupee(PROD_GROSS)} for ${PROD_SHIFTS} shifts`,
      reading: "read per shift",
      wage: round2(prodShift),
      result: below(prodShift) ? "Below minimum" : "OK",
      shortfall: below(prodShift) ? round2((rate - prodShift) * PROD_SHIFTS) : 0,
    },
  ];
}

/** The rate as typed, or why it cannot be saved (the column holds up to 99,999,999.99; the server does not check). */
export function parseMinWage(raw: string): { value: number; problem: string | null } {
  const text = raw.trim();
  if (text === "") return { value: 0, problem: null };
  const value = Number(text);
  if (!Number.isFinite(value)) return { value: 0, problem: "Type a number, such as 700 or 18000." };
  if (value < 0) return { value, problem: "The minimum wage cannot be negative." };
  if (value > 99_999_999.99) return { value, problem: "That is more than the setting can hold (99,999,999.99)." };
  if (/\.\d{3,}$/.test(text)) return { value, problem: "Use at most two decimals (it is stored to the paisa)." };
  return { value, problem: null };
}
