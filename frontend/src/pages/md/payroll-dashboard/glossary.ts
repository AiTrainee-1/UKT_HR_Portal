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
    "What the employees cost the company: the salary their paid days earned, overtime, bonus and the employer's share of PF and ESI.",
    "Earned salary + overtime + bonus + employer PF / ESI",
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
    "What the days paid earned. Staff: paid days x the daily rate. Production: shifts x the rate per shift. Overtime and bonus are not in it.",
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
    "PF, ESI, TDS, salary-advance recovery and any other line taken off the slip. The late penalty is not here: it is an attendance deduction.",
    "Total deductions - late penalty",
  ),
  entry(
    "deductions",
    "Deductions",
    "Everything taken off the slips: PF, ESI, TDS, advance recovery, the late / early-out / permission penalty and other lines.",
    "PF + ESI + TDS + advance + late + other",
  ),
  entry(
    "net-paid",
    "Net paid",
    "What the employees received: earned salary plus overtime and bonus, less the deductions, rounded up to the rupee (the payroll rule).",
    "Earned salary + overtime + bonus - deductions",
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
    "A staff slip belongs to its month; a production slip to the month its pay period ends in. Weekly slips from the old production payroll and new joiners HR has not added yet are left out.",
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
    "An amount HR changed by hand after the slip was computed: + added, - removed. Blank when there was none.",
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
