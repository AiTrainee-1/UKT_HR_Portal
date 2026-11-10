/**
 * Payroll's rounding rule for the NET pay (and the employee's ESI): up to the next whole rupee. Owner 2026-11-05 for the
 * Salary Statement, 2026-11-10 for the payroll engine itself and the bank file, so the statement, the bank file and the
 * payroll page all show the same rupees. Mirrors backend/api/pf_esi.py round_up_rupee.
 *
 * The value is first rounded to the paisa, so float noise never adds a rupee: a stored 8000 that arrives as
 * 7999.9999999998 stays 8000, while 14,444.44 becomes 14,445.
 */
export function roundToPaise(value: number): number {
  return Math.round(value * 100) / 100;
}

export function roundUpRupee(value: number): number {
  return Math.ceil(roundToPaise(value));
}
