import { describe, expect, it } from "vitest";
import type { AdvanceEligibility } from "@/lib/api-client";
import { ApiError } from "@/lib/api-client/custom-fetch";
import {
  STALE_ELIGIBILITY_CODES,
  aboveLimit,
  emptyRequestForm,
  limitText,
  requestPayload,
  requestRefusal,
  requestSchedule,
  termEmi,
  typeEligibility,
  validateRequest,
  type RequestForm,
} from "./new-request";

// HR's New request under the employee rules (owner 2026-11-27): what the dialog checks before sending (the employee app's
// eligibility, the 50 % limit, whole rupees, 1-12 months from Rs 1,000, a purpose), the body it sends, the deductions it
// previews (the server's whole-rupee EMI) and how it reads the server's refusals.

const eligibility = (over: Partial<AdvanceEligibility> = {}): AdvanceEligibility => ({
  today: "2026-11-21",
  window: {
    isOpen: true,
    opensOn: "2026-11-21",
    closesOn: "2026-11-22",
    nextOpensOn: "2026-12-21",
    daysUntilOpen: 0,
    daysLeft: 2,
    message: "Salary Advance applications are open until 22 Nov.",
  },
  workflowEnabled: true,
  workflowMessage: null,
  employeeActive: true,
  monthlySalary: 26000,
  salaryAdvance: {
    canApply: true,
    reason: null,
    percent: 50,
    limit: 8060,
    deductionMonth: 11,
    deductionYear: 2026,
    deductionLabel: "November 2026",
    existing: null,
    earned: {
      month: 11,
      year: 2026,
      throughDay: 20,
      fixedSalary: 26000,
      workingDays: 16.12,
      paidDays: 16.12,
      earnedAmount: 16120,
      percent: 50,
      limit: 8060,
      final: true,
    },
  },
  termLoan: {
    canApply: true,
    reason: null,
    minMonths: 1,
    maxMonths: 12,
    minAmount: 1000,
    maxAmount: 9999999,
    firstDeductionMonth: 12,
    firstDeductionYear: 2026,
    firstDeductionLabel: "December 2026",
    pending: null,
    activeCount: 0,
    service: {
      eligible: true,
      joinDate: "2025-01-10",
      serviceMonths: 22,
      requiredMonths: 6,
      eligibleFrom: "2025-07-10",
      reason: null,
    },
  },
  rules: [],
  employee: { id: 7, code: "S7", name: "Priya Nair", department: null, branch: null, type: "staff", joinDate: null },
  ...over,
});

const form = (over: Partial<RequestForm> = {}): RequestForm => ({
  ...emptyRequestForm("general"),
  employeeId: "7",
  amount: "5000",
  purpose: "Medical",
  ...over,
});

const refusal = (status: number, data: unknown) =>
  new ApiError(new Response(null, { status, statusText: "Refused" }), data, { method: "POST", url: "/api/advances" });

describe("what can be raised now", () => {
  it("follows the employee app's canApply and its reason, per type", () => {
    const e = eligibility({
      salaryAdvance: { ...eligibility().salaryAdvance, canApply: false, reason: "Outside the 21st-22nd window." },
    });
    expect(typeEligibility(e, "general")).toEqual({ canApply: false, reason: "Outside the 21st-22nd window." });
    expect(typeEligibility(e, "term")).toEqual({ canApply: true, reason: null });
    const silent = eligibility({ termLoan: { ...eligibility().termLoan, canApply: false, reason: null } });
    expect(typeEligibility(silent, "term").reason).toBe("This request cannot be raised now.");
  });

  it("names the limit and what it is taken from", () => {
    expect(limitText(eligibility())).toBe(
      "The most that can be asked for is ₹8,060 (50% of the ₹16,120 earned from the 1st to the 20th).",
    );
  });
});

describe("the checks before sending", () => {
  it("a complete Salary Advance within the limit has no errors; the limit itself is fine", () => {
    expect(validateRequest(form(), eligibility())).toEqual({});
    expect(validateRequest(form({ amount: "8060" }), eligibility())).toEqual({});
  });

  it("blocks a Salary Advance above the limit (there is no override any more)", () => {
    expect(aboveLimit(form({ amount: "8061" }), eligibility())).toBe(true);
    expect(validateRequest(form({ amount: "8061" }), eligibility()).amount).toBe(limitText(eligibility()));
    expect(aboveLimit(form({ amount: "8061" }), undefined)).toBe(false); // nothing known yet
    expect(aboveLimit(form({ advanceType: "term", amount: "80000" }), eligibility())).toBe(false);
  });

  it("asks for the employee, a whole-rupee amount and a purpose", () => {
    const e = validateRequest(form({ employeeId: "", amount: "", purpose: " a " }), eligibility());
    expect(e.employee).toBe("Choose the employee this request is for.");
    expect(e.amount).toBe("Enter the amount.");
    expect(e.purpose).toBe("Write briefly what the money is for (at least 3 characters).");
    expect(validateRequest(form({ amount: "0" }), eligibility()).amount).toBe("The amount must be more than ₹0.");
    expect(validateRequest(form({ amount: "abc" }), eligibility()).amount).toBe("The amount must be more than ₹0.");
    expect(validateRequest(form({ amount: "100.50" }), eligibility()).amount).toBe(
      "Enter the amount in whole rupees (no paise).",
    );
    expect(validateRequest(form({ purpose: "x".repeat(301) }), eligibility()).purpose).toBe(
      "Keep the purpose under 300 characters.",
    );
  });

  it("a Term Loan: from Rs 1,000, at most the maximum, 1 to 12 months", () => {
    const term = (over: Partial<RequestForm>) => form({ advanceType: "term", months: "6", ...over });
    expect(validateRequest(term({ amount: "12000" }), eligibility())).toEqual({});
    expect(validateRequest(term({ amount: "999" }), eligibility()).amount).toBe("A Term Loan starts from ₹1,000.");
    expect(validateRequest(term({ amount: "10000000" }), eligibility()).amount).toBe(
      "The amount cannot be more than ₹99,99,999.",
    );
    expect(validateRequest(term({ amount: "12000", months: "" }), eligibility()).months).toBe(
      "Choose how many months to repay in (1 to 12).",
    );
    for (const months of ["0", "13", "2.5"]) {
      expect(validateRequest(term({ amount: "12000", months }), eligibility()).months, months).toBe(
        "A Term Loan is repaid in 1 to 12 months.",
      );
    }
    // the months are not asked of a Salary Advance
    expect(validateRequest(form({ months: "x" }), eligibility()).months).toBeUndefined();
  });
});

describe("what is sent", () => {
  it("the employee app's form: months only for a Term Loan, the purpose trimmed", () => {
    expect(requestPayload(form({ purpose: "  School fees " }))).toEqual({
      employeeId: 7,
      advanceType: "general",
      amount: 5000,
      purpose: "School fees",
    });
    expect(requestPayload(form({ advanceType: "term", amount: "12000", months: "6" }))).toEqual({
      employeeId: 7,
      advanceType: "term",
      amount: 12000,
      purpose: "Medical",
      repaymentMonths: 6,
    });
  });
});

describe("what payroll will deduct", () => {
  it("a Salary Advance once, in full, from the month the rules fix", () => {
    expect(requestSchedule(form(), eligibility())).toBe("Deducted once, in full, from the November 2026 salary.");
    expect(requestSchedule(form({ amount: "" }), eligibility())).toBeNull();
    expect(requestSchedule(form(), undefined)).toBeNull();
  });

  it("a Term Loan in whole-rupee EMIs from next month, the last one smaller (the server's rule)", () => {
    expect(termEmi(10000, 3)).toBe(3334);
    expect(termEmi(12000, 6)).toBe(2000);
    expect(requestSchedule(form({ advanceType: "term", amount: "10000", months: "3" }), eligibility())).toBe(
      "3 deductions of ₹3,334 from Dec 2026 to Feb 2027 (the last ₹3,332)",
    );
    expect(requestSchedule(form({ advanceType: "term", amount: "12000", months: "6" }), eligibility())).toBe(
      "6 deductions of ₹2,000 from Dec 2026 to May 2027",
    );
    expect(requestSchedule(form({ advanceType: "term", amount: "12000", months: "" }), eligibility())).toBeNull();
  });
});

describe("the server's refusals", () => {
  it("names the rule and puts a field's message beside it", () => {
    expect(requestRefusal(refusal(400, { error: "Outside the window.", code: "window_closed" }))).toEqual({
      text: "Outside the window.",
      code: "window_closed",
      field: null,
      title: "Outside the Salary Advance window",
    });
    expect(
      requestRefusal(
        refusal(400, { error: "The most you can ask for is ₹8,060.", code: "over_limit", field: "amount" }),
      ),
    ).toMatchObject({ field: "amount", title: "Above the Salary Advance limit" });
    expect(
      requestRefusal(refusal(400, { error: "1 to 12.", code: "invalid", field: "repaymentMonths" })),
    ).toMatchObject({ field: "months", title: null });
    expect(requestRefusal(refusal(409, { error: "Already one this month.", code: "duplicate" }))).toMatchObject({
      title: "A request is already there",
    });
    expect(requestRefusal(refusal(403, { error: "Needs 6 months.", code: "service" }))).toMatchObject({
      title: "Not enough service for a Term Loan",
    });
    expect(requestRefusal(refusal(400, { error: "No salary.", code: "no_salary" })).title).toBe(
      "No monthly salary to take it from",
    );
    expect(requestRefusal(new Error("Network down"))).toEqual({
      text: "Network down",
      code: null,
      field: null,
      title: null,
    });
  });

  it("reads the eligibility again after a refusal about the rules, not after a typo", () => {
    for (const code of ["window_closed", "over_limit", "duplicate", "service", "no_salary"]) {
      expect(STALE_ELIGIBILITY_CODES.has(code), code).toBe(true);
    }
    expect(STALE_ELIGIBILITY_CODES.has("invalid")).toBe(false);
  });
});
