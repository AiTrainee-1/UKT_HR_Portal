// What each figure on the Payroll page means, in plain words: the entries the "How is this calculated?" buttons open
// (kit ProvenanceButton). They describe the contract in types.ts; keep the two in step.

import type { Provenance } from "@/lib/md/types";

const DATASET = "Salary slips";

const entry = (id: string, title: string, definition: string, formula: string | null = null, caveats: string[] = []) =>
  ({ id, title, dataset: DATASET, definition, formula, rows: null, filters: [], caveats }) satisfies Provenance;

/** Every explanation the page uses; a card picks the ones it needs by id. */
export const GLOSSARY: Provenance[] = [
  entry(
    "company-cost",
    "Company cost",
    "What the employees cost the company: the salary their paid days earned, overtime, HR's excess less detection and the employer's share of PF and ESI.",
    "Earned salary + overtime + (excess - detection) + employer PF / ESI",
    ["Employer PF / ESI is an estimate from the PF and ESI rules, not a remittance."],
  ),
  entry(
    "actual-salary",
    "Actual salary",
    "The full monthly salary of the staff on the payroll: what they would get if every company day of the month were paid.",
    null,
    ["Production workers are paid per shift and have no fixed monthly salary, so they are not in this figure."],
  ),
  entry(
    "earned-salary",
    "Earned salary",
    "What the days paid earned. Staff: paid days x the daily rate. Production: shifts x the rate per shift. Overtime and HR's excess / detection are not in it.",
    "Actual salary - loss of pay (staff)",
  ),
  entry(
    "attendance-deductions",
    "Attendance deductions",
    "Salary lost to attendance: loss of pay for days not paid (absent, unpaid leave, before joining) plus the late, early-out and permission penalties.",
    "Loss of pay + late / early-out / permission penalties",
    ["Production has no loss of pay (it is paid only for shifts worked): only its penalties count."],
  ),
  entry(
    "loss-of-pay",
    "Loss of pay",
    "The salary not earned because days were not paid: absent, unpaid leave, days before joining. Staff only.",
    "Actual salary - earned salary",
  ),
  entry(
    "other-deductions",
    "Other deductions",
    "PF, ESI, TDS, salary-advance recovery and any other line taken off the pay (a change HR made to the deductions by hand counts here). The late penalty is not here: it is an attendance deduction.",
    "Total deductions - late penalty",
  ),
  entry(
    "deductions",
    "Deductions",
    "Everything taken off the pay, as HR's payroll pages and the Salary Statement show it: PF, ESI, TDS, advance recovery, the late / early-out / permission penalty and other lines.",
    "PF + ESI + TDS + advance + late + other",
  ),
  entry(
    "net-paid",
    "Net paid",
    "What the employees received: earned salary plus overtime and HR's excess less detection, less the deductions, rounded up to the rupee (the payroll rule). The payroll's own net, as the bank file pays it.",
    "Earned salary + overtime + (excess - detection) - deductions",
  ),
  entry(
    "cl",
    "Casual leave (CL)",
    "Approved casual-leave days that fell on paid days (a half day counts 0.5): the Salary Statement's CL column. The CL amount is the salary paid for those days.",
    "CL amount = CL days x the daily rate",
    ["Staff only: production is not paid for leave."],
  ),
  entry(
    "employees",
    "Employees",
    "People with a salary slip in the month. A production worker paid for several periods in the month counts once.",
  ),
  entry(
    "month-rule",
    "Which month a slip belongs to",
    "A staff slip belongs to its month; a production slip to the month its pay period ends in. Weekly slips from the old production payroll, new joiners HR has not added yet and production workers waiting in a pay period's New Joiners are left out. People who have left since stay in: what a month cost does not change when someone leaves later.",
  ),
  entry(
    "attendance-pct",
    "Attendance",
    "Paid days as a share of working days, staff and production together.",
    "Paid days / working days x 100",
  ),
  entry(
    "share",
    "Share",
    "This department's part of the company cost of everyone shown.",
    "Department company cost / total company cost x 100",
  ),
  entry(
    "adjustment",
    "Adjustment by HR",
    "What HR changed the deductions by, by hand, after the payroll was worked out: + = deductions taken off (more pay), - = deductions added. Blank when there was none. Excess and detection are their own line.",
  ),
  entry(
    "excess",
    "Excess and detection",
    "Amounts HR adds to (excess) or takes off (detection) an employee's earned salary for one month or one pay period, each with a written remark (the Excess tab of HR's payroll pages). They are paid with the salary.",
    "Excess - detection = the bonus line of the pay",
    ["An older HR bonus, from before the Excess tab, counts as excess."],
  ),
  entry(
    "workflow",
    "Where the month stands",
    "HR generates the month (still open: it can be worked out again), presses Payroll Done (locked, payment pending) and then Mark as Paid. Cleared only means HR checked a salary; it is not payment.",
    null,
    [
      "Held salaries are in the figures (they are on the Salary Statement) but not paid with the month.",
      "New joiners waiting to be added are not in the figures until HR adds them.",
    ],
  ),
  entry(
    "not-included",
    "Not included",
    "Active staff who joined by the end of the month but have no payroll for it at all: HR has not generated them, or they have no monthly salary on their profile.",
  ),
  entry(
    "left-since",
    "Left since",
    "People paid in the month who are no longer active. They stay in these figures (the month's cost does not change), while HR's payroll lists and Salary Statement show active employees only.",
  ),
  entry(
    "yearly",
    "The year so far",
    "January to the chosen month added up, beside the same months a year before (only months that have payroll). The whole year before is shown too.",
  ),
  entry(
    "prod-cycle",
    "Pay cycle and period",
    "Production is paid per pay period: Weekly (one week), BiWeekly (two weeks) or Monthly (four weeks). A payslip belongs to the cycle it was generated on (older ones: the worker's cycle now); a period's figures are its payroll, without the workers waiting in its New Joiners.",
  ),
  entry(
    "prod-gross",
    "Gross pay",
    "What the shifts earned: shifts x the worker's rate per shift. HR's excess / detection is not in it.",
    "Shifts x rate per shift",
  ),
  entry(
    "prod-net",
    "Net paid",
    "What the workers received: gross pay plus HR's excess less detection, less the deductions, rounded up to the rupee. The payroll's own net, as the bank file pays it.",
    "Gross pay + (excess - detection) - deductions",
  ),
  entry(
    "prod-cost",
    "Company cost",
    "What the period cost the company: gross pay, HR's excess less detection, and the employer's share of PF and ESI.",
    "Gross pay + (excess - detection) + employer PF / ESI",
    ["Employer PF / ESI is an estimate from the PF and ESI rules, not a remittance."],
  ),
  entry(
    "prod-shifts",
    "Shifts and days",
    "Shifts earned in the period (a half shift counts 0.5), the days worked and absent, and the days the payslip pays (the whole period; fewer or more after a change of pay cycle).",
    "Attendance = days worked / (days worked + days absent)",
  ),
  entry(
    "prod-state",
    "Where the period stands",
    "Generated (open: HR can work it out again), Payroll Done (locked, payment pending) and Paid (Mark as Paid, with the day it was paid). Cleared only means HR checked a payslip. Part paid: some payslips were marked paid one by one.",
  ),
  entry(
    "prod-month",
    "Production by month",
    "Every cycle together, each pay period in the month it ends in, so weekly, two-weekly and four-weekly pay can be compared month by month.",
  ),
  entry(
    "days",
    "Working, paid and LOP days",
    "Staff: the company days of the month, the days paid and the days not paid (LOP). Production: the days in the pay periods, the days worked and the days absent.",
    "LOP days = working days - paid days",
  ),
];

/** The entries for some ids, in the order asked. */
export const explain = (...ids: string[]): Provenance[] =>
  ids.map((id) => GLOSSARY.find((g) => g.id === id)).filter((g): g is Provenance => !!g);
