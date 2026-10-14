import type { SalaryStatement, StatementColumn, StatementGroup, StatementRow } from "@/lib/api-client/custom-hooks";
import { buildTotalRow, countStatement, type CellValue } from "./statement-model";

// Test data for the Salary Statement (and a way to look at it): the first fifteen rows of the printed September 2026
// statement (ACCOUNTS and ADMIN), a small production statement, and generators for statements of any size. The figures are
// read off the photographed page, so they are real-looking and add up row by row (E salary - Total Deduction = NET).

type ColumnSpec = Pick<StatementColumn, "key" | "label"> & Partial<StatementColumn>;

const column = (spec: ColumnSpec): StatementColumn => ({
  sub: null,
  align: "right",
  format: "money",
  weight: 1,
  total: true,
  group: "earnings",
  ...spec,
});

const identity: Partial<StatementColumn> = { group: "identity", total: false, align: "left" };

/**
 * The printed statement's columns as the server defines them (api/payroll_statement_views.py): SNO | ID NO | Name |
 * Designation | Basic salary | Total | Present | CL | LOP | HD | Total Days | PTRL | Others Allow | E salary | T.Advance |
 * Advance | ESI | PF | TDS | Others | Lop& PSAmt | Total Deduction | NET | Remarks. A label is never pre-split into two
 * lines; `sub` is a qualifier shown under it ("not tracked", "information").
 */
export const STAFF_COLUMNS: StatementColumn[] = [
  column({ key: "sno", label: "SNO", ...identity, align: "center", format: "int", weight: 0.6 }),
  column({ key: "code", label: "ID NO", ...identity, format: "text", weight: 1.1 }),
  column({ key: "name", label: "Name", ...identity, format: "text", weight: 3 }),
  column({ key: "designation", label: "Designation", ...identity, format: "text", weight: 2.2 }),
  column({ key: "basic", label: "Basic salary", weight: 1.3 }),
  column({ key: "total", label: "Total", weight: 1.3 }),
  column({ key: "present", label: "Present", format: "days", group: "attendance" }),
  column({ key: "cl", label: "CL", format: "days", group: "attendance" }),
  column({ key: "lop", label: "LOP", format: "days", group: "attendance" }),
  column({ key: "hd", label: "HD", format: "days", group: "attendance" }),
  column({ key: "totalDays", label: "Total Days", format: "days", group: "attendance" }),
  column({ key: "petrol", label: "PTRL", weight: 1.1 }),
  column({ key: "othersAllow", label: "Others Allow", weight: 1.2 }),
  column({ key: "eSalary", label: "E salary", weight: 1.3 }),
  column({ key: "tAdvance", label: "T.Advance", weight: 1.2, group: "deductions" }),
  column({ key: "advance", label: "Advance", weight: 1.1, group: "deductions" }),
  column({ key: "esi", label: "ESI", group: "deductions" }),
  column({ key: "pf", label: "PF", group: "deductions" }),
  column({ key: "tds", label: "TDS", sub: "not tracked", group: "deductions" }),
  column({ key: "others", label: "Others", weight: 1.1, group: "deductions" }),
  column({ key: "lopAmount", label: "Lop& PSAmt", sub: "information", weight: 1.2, group: "deductions" }),
  column({ key: "totalDeduction", label: "Total Deduction", weight: 1.3, group: "deductions" }),
  column({ key: "net", label: "NET", weight: 1.3, group: "result" }),
  column({ key: "remarks", label: "Remarks", align: "left", format: "text", weight: 2, total: false, group: "result" }),
];

/** The production statement: a rate per shift, shifts instead of days, no salary split. */
export const PRODUCTION_COLUMNS: StatementColumn[] = [
  column({ key: "sno", label: "SNO", ...identity, align: "center", format: "int", weight: 0.6 }),
  column({ key: "code", label: "ID NO", ...identity, format: "text", weight: 1.1 }),
  column({ key: "name", label: "Name", ...identity, format: "text", weight: 3 }),
  column({ key: "designation", label: "Designation", ...identity, format: "text", weight: 2.2 }),
  column({ key: "rate", label: "Rate / shift", weight: 1.1, total: false }),
  column({ key: "worked", label: "Days worked", format: "days", group: "attendance" }),
  column({ key: "absent", label: "Absent", format: "days", group: "attendance" }),
  column({ key: "late", label: "Late", format: "int", weight: 0.8, group: "attendance" }),
  column({ key: "shifts", label: "Shifts", format: "days", group: "attendance" }),
  column({ key: "eSalary", label: "E salary", weight: 1.3 }),
  column({ key: "tAdvance", label: "T.Advance", weight: 1.2, group: "deductions" }),
  column({ key: "advance", label: "Advance", weight: 1.1, group: "deductions" }),
  column({ key: "esi", label: "ESI / EF", group: "deductions" }),
  column({ key: "pf", label: "PF", group: "deductions" }),
  column({ key: "others", label: "Others", weight: 1.1, group: "deductions" }),
  column({ key: "totalDeduction", label: "Total Deduction", weight: 1.3, group: "deductions" }),
  column({ key: "net", label: "NET", weight: 1.3, group: "result" }),
  column({ key: "remarks", label: "Remarks", align: "left", format: "text", weight: 2, total: false, group: "result" }),
];

// ── The printed page ─────────────────────────────────────────────────────────

type StaffTuple = [
  department: string,
  sno: number,
  code: string,
  name: string,
  designation: string,
  basic: number,
  total: number,
  present: number,
  cl: number,
  lop: number,
  hd: number,
  totalDays: number,
  eSalary: number,
  esi: number,
  tds: number,
  others: number,
  lopAmount: number,
  totalDeduction: number,
  net: number,
  remarks: string,
  status: "paid" | "pending",
];

// prettier-ignore
const REFERENCE_ROWS: StaffTuple[] = [
  ["ACCOUNTS", 1, "2316", "MEENATCHI.T", "ACCOUNTS EXECUTIVE", 14750, 29500, 22, 2, 2, 0, 24, 27230, 125, 0, 1000, 2270, 1000, 26230, "", "paid"],
  ["ACCOUNTS", 2, "2896", "LOKESH KANNAN", "ACCOUNTS ASST", 8750, 17500, 21, 1, 4, 0, 22, 14809, 0, 0, 804, 2691, 804, 14005, "", "paid"],
  ["ACCOUNTS", 3, "30071", "SRIRAM DORAISWAMY", "ACCOUNTS MANAGER", 24000, 50000, 3, 0, 23, 0, 3, 5769, 0, 0, 0, 44231, 0, 5769, "LEFT", "pending"],
  ["ADMIN", 4, "189", "MURUGAN.K", "ADMINISTRATIVE OFFICER", 25000, 50000, 26, 0, 0, 0, 26, 50000, 0, 0, 2000, 0, 2000, 48000, "", "paid"],
  ["ADMIN", 5, "226", "KRISHNAN NAIR", "OFFICE ASST", 7000, 14000, 26, 0, 0, 0, 26, 14000, 0, 0, 0, 0, 0, 14000, "", "paid"],
  ["ADMIN", 6, "2234", "MURUGESAN.K", "AGM", 59000, 118000, 26, 0, 0, 0, 26, 118000, 0, 11800, 7000, 0, 18800, 99200, "", "pending"],
  ["ADMIN", 7, "2318", "KUNHIK KANNAN PV", "CHIEF EXECUTIVE", 61500, 123000, 26, 0, 0, 0, 26, 123000, 0, 0, 5000, 0, 5000, 118000, "", "paid"],
  ["ADMIN", 8, "2503", "NARAYANAN KUPPAYI", "PRINTING FOLLOW UP", 12250, 22500, 24.5, 1, 0.5, 0, 25.5, 22069, 0, 0, 1000, 431, 1000, 21069, "", "pending"],
  ["ADMIN", 9, "2552", "PRABAKARAN . S", "MIS", 13000, 26000, 24, 1, 1, 0, 25, 25000, 0, 0, 1400, 1000, 1400, 23600, "", "paid"],
  ["ADMIN", 10, "2671", "SANDHYA KRISHNAN AGARWAL", "JUNIOR MD", 54500, 109000, 26, 0, 0, 0, 26, 109000, 0, 10900, 0, 0, 10900, 98100, "", "paid"],
  ["ADMIN", 11, "2857", "MOHANA LAKSHMI P", "EXECUTIVE ASST", 10000, 20000, 23, 1, 2, 0, 24, 18461, 0, 0, 800, 1539, 800, 17661, "", "pending"],
  ["ADMIN", 12, "2904", "SUBBURAJ. M", "INTERNAL AUDITOR", 25000, 50000, 25, 1, 0, 0, 26, 50000, 0, 0, 1000, 0, 1000, 49000, "", "paid"],
  ["ADMIN", 13, "2961", "SUVITHA K", "MIS", 6720, 14000, 24, 1, 1, 0, 25, 13461, 0, 0, 134, 539, 134, 13327, "", "paid"],
  ["ADMIN", 14, "2981", "PANDIYAMMAL", "RECEPTIONIST", 7680, 16000, 24.5, 0, 1.5, 0, 24.5, 15076, 0, 0, 1000, 924, 1000, 14076, "", "paid"],
  ["ADMIN", 15, "2997", "THIRUNAVUKARASU", "GENARAL MANAGER", 96000, 200000, 26, 0, 0, 0, 26, 200000, 0, 20000, 12538, 0, 32538, 167462, "", "paid"],
];

function staffRow(t: StaffTuple, payrollId: number): StatementRow {
  // prettier-ignore
  const [, sno, code, name, designation, basic, total, present, cl, lop, hd, totalDays, eSalary, esi, tds, others, lopAmount, totalDeduction, net, remarks, status] = t;
  const values: Record<string, CellValue> = {
    sno,
    code,
    name,
    designation,
    basic,
    total,
    present,
    cl,
    lop,
    hd,
    totalDays,
    petrol: 0,
    othersAllow: 0,
    eSalary,
    tAdvance: 0,
    advance: 0,
    esi,
    pf: 0,
    tds,
    others,
    lopAmount,
    totalDeduction,
    net,
    remarks,
  };
  return { payrollId, employeeId: payrollId + 500, sno, status, values };
}

/** Departments in the order the rows come, each with its subtotal. */
function assemble(
  columns: StatementColumn[],
  rows: { department: string; row: StatementRow }[],
): { groups: StatementGroup[]; total: StatementRow } {
  const byDepartment = new Map<string, StatementRow[]>();
  for (const { department, row } of rows) byDepartment.set(department, [...(byDepartment.get(department) ?? []), row]);
  const groups: StatementGroup[] = [...byDepartment].map(([label, groupRows]) => ({
    key: label.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    label,
    rows: groupRows,
    subtotal: buildTotalRow(columns, groupRows),
  }));
  return {
    groups,
    total: buildTotalRow(
      columns,
      groups.flatMap((g) => g.rows),
    ),
  };
}

// The server's own notes (api/payroll_statement_views.py): long sentences, printed under the table.
const STAFF_NOTES = [
  "Basic is the first salary-split portion (Basic + DA + Retaining Allowance); with no split recorded it is 50% of the salary. PTRL is the Petrol allowance and Others Allow the rest of the second portion, so Basic + PTRL + Others Allow = Total.",
  "Total is the monthly salary. E salary is the salary earned for the days paid (Total x Total Days / working days) plus any overtime pay and HR bonus.",
  "Present is the days paid as worked (a half day counts 0.5; a working day HR marked as a paid holiday counts 1), without Casual Leave; CL is the approved Casual Leave days; Total Days = Present + CL; LOP = working days - Total Days; HD is the number of half-shift days.",
  "T.Advance is the advance balance before this month's recovery; Advance is what was recovered this month.",
  "Others is the late deduction plus any deduction HR added; Total Deduction = ESI + PF + TDS + Advance + Others; NET = E salary - Total Deduction.",
  "Lop& PSAmt = Total - E salary: the pay lost to LOP. It is shown for information and is not part of Total Deduction.",
  "TDS is not tracked by the HRMS and is always 0.",
];

const PRODUCTION_NOTES = [
  "Rate / shift is the worker's salary per shift; Shifts is the total shifts earned in the period (a day earns 0.25 to 1.5); Days worked and Absent count the days of the period; Late counts the days marked late.",
  "E salary is the pay for the shifts earned (Shifts x Rate / shift) plus any HR bonus.",
  "T.Advance is the advance balance before this period's recovery; Advance is what was recovered in this period.",
  "ESI / EF is the ESI deduction (EF, under a salary band). Others is the late deduction plus any deduction HR added; Total Deduction = ESI / EF + PF + Advance + Others; NET = E salary - Total Deduction.",
];

/** September 2026, the first fifteen rows of the printed statement: ACCOUNTS (3) and ADMIN (12). */
export function staffStatement(): SalaryStatement {
  const { groups, total } = assemble(
    STAFF_COLUMNS,
    REFERENCE_ROWS.map((t, i) => ({ department: t[0], row: staffRow(t, 1001 + i) })),
  );
  return {
    kind: "staff",
    company: { name: "U.K TEXTILES", branchLabel: "H.O" },
    title: "Salary Statement From 01-09-2026 To 30-09-2026",
    period: {
      label: "September 2026",
      start: "2026-09-01",
      end: "2026-09-30",
      month: 9,
      year: 2026,
      days: 30,
      cycle: null,
      cycleLabel: null,
      fromLabel: "01-09-2026",
      toLabel: "30-09-2026",
    },
    generatedAt: "2026-10-01T09:30:00+05:30",
    columns: STAFF_COLUMNS,
    groups,
    total,
    counts: countStatement(groups),
    notes: STAFF_NOTES,
  };
}

// ── Production ───────────────────────────────────────────────────────────────

type ProductionTuple = [
  department: string,
  code: string,
  name: string,
  designation: string,
  rate: number,
  worked: number,
  absent: number,
  late: number,
  eSalary: number,
  advance: number,
  esi: number,
  others: number,
  remarks: string,
  status: "paid" | "pending",
];

// prettier-ignore
const PRODUCTION_ROWS: ProductionTuple[] = [
  ["Weaving", "P101", "RAMESH K", "WEAVER", 650, 6, 1, 1, 3900, 200, 0, 0, "", "paid"],
  ["Weaving", "P102", "SELVI M", "WEAVER", 650, 5.5, 1.5, 2, 3575, 0, 0, 100, "", "pending"],
  ["Weaving", "P103", "KARTHIK R", "HELPER", 520, 7, 0, 0, 3640, 0, 0, 0, "", "paid"],
  ["Spinning", "P201", "MALAR V", "OPERATOR", 600, 6, 1, 0, 3600, 300, 0, 0, "", "paid"],
  ["Spinning", "P202", "DEVAN S", "OPERATOR", 600, 4.25, 2.75, 3, 2550, 0, 0, 0, "JOINED 03-02", "pending"],
  ["Packing", "P301", "ANITHA P", "PACKER", 480, 6.75, 0.25, 1, 3240, 0, 24, 0, "", "paid"],
];

function productionRow(t: ProductionTuple, sno: number, payrollId: number): StatementRow {
  const [, code, name, designation, rate, worked, absent, late, eSalary, advance, esi, others, remarks, status] = t;
  const totalDeduction = advance + esi + others;
  const values: Record<string, CellValue> = {
    sno,
    code,
    name,
    designation,
    rate,
    worked,
    absent,
    late,
    shifts: worked,
    eSalary,
    tAdvance: 0,
    advance,
    esi,
    pf: 0,
    others,
    totalDeduction,
    net: eSalary - totalDeduction,
    remarks,
  };
  return { payrollId, employeeId: payrollId + 700, sno, status, values };
}

/** One weekly period of the Weekly production cycle: Weaving (3), Spinning (2) and Packing (1). */
export function productionStatement(): SalaryStatement {
  const { groups, total } = assemble(
    PRODUCTION_COLUMNS,
    PRODUCTION_ROWS.map((t, i) => ({ department: t[0], row: productionRow(t, i + 1, 2001 + i) })),
  );
  return {
    kind: "production",
    company: { name: "UKTextiles", branchLabel: "Weaving unit" },
    title: "Production Salary Statement From 02-02-2026 To 08-02-2026",
    period: {
      label: "2 Feb - 8 Feb 2026",
      start: "2026-02-02",
      end: "2026-02-08",
      month: 2,
      year: 2026,
      days: 7,
      cycle: "weekly",
      cycleLabel: "Weekly",
      fromLabel: "02-02-2026",
      toLabel: "08-02-2026",
    },
    generatedAt: "2026-02-09T18:05:00+05:30",
    columns: PRODUCTION_COLUMNS,
    groups,
    total,
    counts: countStatement(groups),
    notes: PRODUCTION_NOTES,
  };
}

// ── Any size ─────────────────────────────────────────────────────────────────

const DEPARTMENTS = ["ACCOUNTS", "ADMIN", "CUTTING", "STITCHING", "FINISHING", "PACKING", "STORES", "DISPATCH"];
const DESIGNATIONS = ["EXECUTIVE", "OPERATOR", "SUPERVISOR", "OFFICE ASST", "HELPER", "CHECKER"];

/**
 * A staff statement of `employees` rows spread evenly over the first `departments` departments (each department's
 * rows together, serial numbers running on across them). Deterministic: the same call gives the same statement.
 */
export function generatedStaffStatement(employees: number, departments = 6): SalaryStatement {
  const used = Math.max(1, Math.min(departments, DEPARTMENTS.length, employees));
  const rows: { department: string; row: StatementRow }[] = [];
  let sno = 0;
  for (let d = 0; d < used; d += 1) {
    const count = Math.floor(employees / used) + (d < employees % used ? 1 : 0);
    for (let k = 0; k < count; k += 1) {
      sno += 1;
      const total = 14000 + (sno % 9) * 3500;
      const lop = sno % 5 === 0 ? 2 : 0;
      const totalDays = 26 - lop;
      const eSalary = Math.round((total * totalDays) / 26);
      const others = sno % 3 === 0 ? 500 : 0;
      const t: StaffTuple = [
        DEPARTMENTS[d],
        sno,
        String(1000 + sno),
        `EMPLOYEE ${String(sno).padStart(3, "0")}`,
        DESIGNATIONS[sno % DESIGNATIONS.length],
        total / 2,
        total,
        totalDays,
        0,
        lop,
        0,
        totalDays,
        eSalary,
        0,
        0,
        others,
        total - eSalary,
        others,
        eSalary - others,
        sno % 17 === 0 ? "JOINED" : "",
        sno % 4 === 0 ? "pending" : "paid",
      ];
      rows.push({ department: DEPARTMENTS[d], row: staffRow(t, 3000 + sno) });
    }
  }
  const { groups, total } = assemble(STAFF_COLUMNS, rows);
  return { ...staffStatement(), groups, total, counts: countStatement(groups) };
}
