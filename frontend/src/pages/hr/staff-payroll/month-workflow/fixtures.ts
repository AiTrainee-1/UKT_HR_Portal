import type { PayrollMonthStatus, PayrollRunItem } from "@/lib/api-client/custom-hooks";

// Test data for the Staff Payroll month workflow (2026-11-10): a month's status and a payroll row.

export function monthStatus(over: Partial<PayrollMonthStatus> = {}): PayrollMonthStatus {
  return {
    month: 10,
    year: 2026,
    label: "October 2026",
    state: "open",
    locked: false,
    monthEnded: true,
    finalizedAt: null,
    finalizedBy: null,
    paidAt: null,
    paidBy: null,
    daysToPay: null,
    firstGeneratedAt: "2026-11-01T04:30:00Z",
    lastComputedAt: "2026-11-03T09:15:00Z",
    counts: { inPayroll: 120, notCleared: 0, onHold: 0, newJoiners: 0, paidSeparately: 0, paid: 0, notPaid: 120 },
    snapshot: null,
    wholeCompany: true,
    can: { finalize: true, markPaid: false, hold: true, addToPayroll: true, releaseAndPay: false },
    ...over,
  };
}

export function run(over: Partial<PayrollRunItem> = {}): PayrollRunItem {
  return {
    id: 7,
    employeeId: 70,
    employeeName: "Asha Kumar",
    employeeCode: "E001",
    departmentName: "Accounts",
    bankAccount: "123",
    salaryMode: "monthly",
    month: 10,
    year: 2026,
    totalWorkingDays: 27,
    presentDays: 27,
    absentDays: 0,
    otHours: 0,
    otAmount: 0,
    baseSalary: 24000,
    grossSalary: 24000,
    deductions: 1000,
    bonus: 0,
    finalSalary: 23000,
    status: "pending",
    ...over,
  };
}
