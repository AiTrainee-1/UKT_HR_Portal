import { describe, expect, it } from "vitest";
import { balanceSummaryOf, ledgerSummaryOf, summaryOf } from "./compensation-claims";

// The tiles of Compensation Leave read these summaries. The backend added keys whose meaning the tiles need (the old keys
// keep theirs): creditedShifts (approved shifts that went INTO the balance), withBalance (employees with shifts left) and
// countedDebitShifts (debits that lower the balance). An older backend sends only the old keys.

describe("the claims summary", () => {
  it("credits only what went into the balance", () => {
    const s = summaryOf({ byStatus: { approved: 2 }, approvedShifts: 1.5, creditedShifts: 1, pendingShifts: 0.25 });
    expect(s).toMatchObject({ approvedShifts: 1.5, creditedShifts: 1, pendingShifts: 0.25 });
  });

  it("falls back to approvedShifts on an older backend", () => {
    expect(summaryOf({ approvedShifts: 2 }).creditedShifts).toBe(2);
  });

  it("splits what waits into credits and days off, and says nothing on an older backend", () => {
    expect(summaryOf({ pendingShifts: 2, pendingCreditShifts: 1.5, pendingUseShifts: 0.5 })).toMatchObject({
      pendingShifts: 2,
      pendingCreditShifts: 1.5,
      pendingUseShifts: 0.5,
    });
    expect(summaryOf({ pendingShifts: 2 })).toMatchObject({ pendingCreditShifts: null, pendingUseShifts: null });
  });
});

describe("the balance summary", () => {
  it("counts the employees with shifts left", () => {
    expect(balanceSummaryOf({ employees: 5, withBalance: 3, available: 2.5 })).toMatchObject({
      employees: 3,
      available: 2.5,
    });
    expect(balanceSummaryOf({ employees: 5 }).employees).toBe(5);
  });
});

describe("the ledger summary", () => {
  it("leaves out the debits that only mirror a legacy credit", () => {
    expect(
      ledgerSummaryOf({ credits: 1, debits: 2, creditShifts: 1, debitShifts: 1.5, countedDebitShifts: 0.5 }),
    ).toEqual({ credits: 1, debits: 2, creditShifts: 1, debitShifts: 0.5 });
    expect(ledgerSummaryOf({ debitShifts: 1.5 }).debitShifts).toBe(1.5);
  });
});
