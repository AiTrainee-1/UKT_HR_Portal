import { describe, expect, it } from "vitest";
import type { PayslipRow } from "@/lib/api-client/custom-hooks";
import {
  ALL,
  DEFAULT_PAYSLIP_FILTERS,
  NO_DEPARTMENT,
  countText,
  dayLines,
  dayValueText,
  filterPayslips,
  lineAmountText,
  paidDaysText,
  payslipDepartments,
  payslipFilterCount,
  payslipFiltersFromUrl,
  payslipFiltersToUrl,
  payslipTotals,
  payslipsFileName,
  pickedIds,
  selectionState,
  toggleAll,
  toggleOne,
} from "./logic";

// The pure part of the Payslip tab (Staff Payroll: one month; a Production Payroll cycle page: one pay period).

const row = (payrollId: number, over: Partial<PayslipRow> = {}): PayslipRow => ({
  payrollId,
  slipId: payrollId + 100,
  employeeId: payrollId,
  code: `C${payrollId}`,
  name: `Name ${payrollId}`,
  department: "ACCOUNTS",
  designation: "ACCOUNTANT",
  unit: "HO",
  joinDate: "2025-04-21",
  bankAccountMasked: "XXXX1234",
  pfNumber: null,
  esiNumber: null,
  status: "pending",
  paymentStatus: "unpaid",
  earned: 24555.56,
  ot: 0,
  excess: 2000,
  detection: 500,
  eSalary: 26055.56,
  pf: 0,
  esi: 0,
  tds: 0,
  advance: 0,
  others: 0,
  totalDeduction: 0,
  net: 26056,
  earnings: [],
  deductions: [],
  hasSlip: true,
  ...over,
});

const STAFF = { kind: "staff", month: 11, year: 2026 } as const;
const WEEKLY = { kind: "production", cycle: "weekly", periodStart: "2026-11-02", periodEnd: "2026-11-08" } as const;

describe("the filters in the address", () => {
  it("reads them, prefixed pl, and falls back to every payslip for anything unknown", () => {
    expect(payslipFiltersFromUrl({ plq: "surya", pldept: "ACCOUNTS", plstatus: "paid", plpay: "unpaid" })).toEqual({
      q: "surya",
      dept: "ACCOUNTS",
      status: "paid",
      payment: "unpaid",
    });
    expect(payslipFiltersFromUrl({ plstatus: "cleared", plpay: "x" })).toEqual(DEFAULT_PAYSLIP_FILTERS);
    expect(payslipFiltersToUrl({ q: "a", status: ALL })).toEqual({ plq: "a", plstatus: ALL });
    expect(payslipFilterCount(DEFAULT_PAYSLIP_FILTERS)).toBe(0);
    expect(payslipFilterCount({ q: " x ", dept: "A", status: "paid", payment: "paid" })).toBe(4);
  });
});

describe("which payslips are listed", () => {
  const rows = [
    row(1, { name: "Surya M", code: "30020" }),
    row(2, { department: null, status: "paid", paymentStatus: "paid" }),
    row(3, { department: "STORES" }),
  ];

  it("matches every word of the search in the name or the code", () => {
    expect(filterPayslips(rows, { ...DEFAULT_PAYSLIP_FILTERS, q: "surya 300" }).map((r) => r.payrollId)).toEqual([1]);
    expect(filterPayslips(rows, { ...DEFAULT_PAYSLIP_FILTERS, q: "nobody" })).toEqual([]);
  });

  it("filters by department (or none), status (Cleared) and payment", () => {
    const pick = (f: Partial<typeof DEFAULT_PAYSLIP_FILTERS>) =>
      filterPayslips(rows, { ...DEFAULT_PAYSLIP_FILTERS, ...f }).map((r) => r.payrollId);
    expect(pick({ dept: "STORES" })).toEqual([3]);
    expect(pick({ dept: NO_DEPARTMENT })).toEqual([2]);
    expect(pick({ status: "paid" })).toEqual([2]);
    expect(pick({ status: "pending" })).toEqual([1, 3]);
    expect(pick({ payment: "paid" })).toEqual([2]);
    expect(pick({ payment: "unpaid" })).toEqual([1, 3]);
  });

  it("offers the departments by name, No department last", () => {
    expect(payslipDepartments(rows)).toEqual([
      { value: "ACCOUNTS", label: "ACCOUNTS" },
      { value: "STORES", label: "STORES" },
      { value: NO_DEPARTMENT, label: "No department" },
    ]);
  });
});

describe("figures", () => {
  it("adds a set of payslips up, to the paise", () => {
    expect(payslipTotals([row(1), row(2, { earned: 0.1, net: 0.2, totalDeduction: 300 })])).toEqual({
      employees: 2,
      earned: 24555.66,
      excess: 4000,
      detection: 1000,
      deductions: 300,
      net: 26056.2,
    });
    expect(payslipTotals([])).toMatchObject({ employees: 0, net: 0 });
  });

  it("writes the paid days of a staff payslip against the company days", () => {
    expect(paidDaysText({ paidDays: 25.5, companyDays: 27 })).toBe("25.5 of 27");
    expect(paidDaysText({ paidDays: 25, companyDays: 0 })).toBe("25");
    expect(countText(6.75)).toBe("6.75");
    expect(countText(undefined)).toBe("0");
  });

  it("lists a staff payslip's days and a production payslip's shifts, as the PDF prints them", () => {
    const staff = row(1, { companyDays: 27, paidDays: 25.5, present: 23.5, cl: 0, hd: 2, lop: 1.5 });
    expect(dayLines(staff).map((d) => [d.label, d.value])).toEqual([
      ["Company days", 27],
      ["Paid days", 25.5],
      ["Present", 23.5],
      ["Casual leave", 0],
      ["Half days", 2],
      ["Loss of pay", 1.5],
    ]);
    const worker = row(2, { salaryPerShift: 500, shifts: 6.5, daysWorked: 6, absent: 1 });
    expect(dayLines(worker, "production").map((d) => [d.label, d.value])).toEqual([
      ["Shifts", 6.5],
      ["Days worked", 6],
      ["Absent", 1],
    ]);
    expect(dayValueText(23)).toBe("23");
    expect(dayValueText(23.5)).toBe("23.50");
  });

  it("writes a payslip line, a Detection with a minus", () => {
    expect(lineAmountText(13000)).toBe("₹13,000.00");
    expect(lineAmountText(-500)).toBe("−₹500.00");
  });
});

describe("the selection", () => {
  it("toggles one, and every listed one", () => {
    expect([...toggleOne(new Set([1]), 2)]).toEqual([1, 2]);
    expect([...toggleOne(new Set([1, 2]), 2)]).toEqual([1]);
    expect([...toggleAll(new Set([1]), [1, 2])]).toEqual([1, 2]);
    expect([...toggleAll(new Set([1, 2, 3]), [1, 2])]).toEqual([3]);
  });

  it("says whether the header box is ticked, half ticked or not", () => {
    expect(selectionState(new Set(), [1, 2])).toBe(false);
    expect(selectionState(new Set([1]), [1, 2])).toBe("indeterminate");
    expect(selectionState(new Set([1, 2]), [1, 2])).toBe(true);
    expect(selectionState(new Set([1]), [])).toBe(false);
  });

  it("keeps only the picks still listed, in the list's order", () => {
    expect(pickedIds(new Set([3, 1, 99]), [row(1), row(2), row(3)])).toEqual([1, 3]);
  });
});

describe("files", () => {
  it("names the PDF of a staff month, and of one employee", () => {
    expect(payslipsFileName(STAFF)).toBe("Payslips-November-2026.pdf");
    expect(payslipsFileName(STAFF, { code: "30/020" })).toBe("Payslip-30_020-November-2026.pdf");
  });

  it("names the PDF of a production period", () => {
    expect(payslipsFileName(WEEKLY)).toBe("Payslips-Weekly-2026-11-02-to-2026-11-08.pdf");
    expect(payslipsFileName(WEEKLY, { code: "PC-W1" })).toBe("Payslip-PC-W1-Weekly-2026-11-02-to-2026-11-08.pdf");
  });
});
