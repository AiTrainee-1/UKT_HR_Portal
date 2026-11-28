import { describe, expect, it } from "vitest";
import { balanceSummaryOf, ledgerSummaryOf, normalizeClaim, summaryOf } from "./compensation-claims";

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

// Compensation days on a chosen date (2026-11-28): additive keys on every claim; an older backend sends none of them.
describe("a claim", () => {
  it("reads the keys of a date HR chose", () => {
    const c = normalizeClaim({
      id: 77,
      kind: "use_balance",
      workDate: "2026-12-02",
      status: "pending",
      hrStep: true,
      stage: "hr",
      useDate: "2026-12-02",
      useShifts: 0.5,
      sourceClaimId: 40,
      compType: "sunday",
      compTypeLabel: "Sunday compensation",
      placed: null,
      leftToPlace: null,
      statusLabel: "Approved by the Department Head, waiting for HR",
    });
    expect(c).toMatchObject({
      hrStep: true,
      stage: "hr",
      useDate: "2026-12-02",
      useShifts: 0.5,
      sourceClaimId: 40,
      compType: "sunday",
      compTypeLabel: "Sunday compensation",
      placed: null,
      leftToPlace: null,
    });
  });

  it("reads what an approved credit has left to place", () => {
    const c = normalizeClaim({
      id: 40,
      kind: "holiday_work",
      status: "approved",
      shifts: 1,
      placed: 0.25,
      leftToPlace: 0.75,
    });
    expect(c).toMatchObject({ placed: 0.25, leftToPlace: 0.75, hrStep: false, stage: null, useShifts: null });
  });

  it("reads an older claim with none of them", () => {
    const c = normalizeClaim({ id: 1, kind: "holiday_work", status: "pending", shifts: 1 });
    expect(c).toMatchObject({ hrStep: false, stage: null, useShifts: null, sourceClaimId: null, compType: null });
  });
});
