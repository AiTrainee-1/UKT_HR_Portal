import { describe, expect, it } from "vitest";
import type { CasualLeaveBalance } from "@/lib/api-client/custom-hooks";
import {
  BOARD_EXPORT_HEADERS,
  balanceDetail,
  balanceLevel,
  balanceText,
  boardExportRows,
  countByReason,
  isYearlyRule,
  notEligibleRows,
  summarize,
  whyNot,
  type BoardRow,
} from "./logic";

// The yearly Casual Leave balance (2026-11-02): 12 days a year, any number a month while the balance lasts. The board's
// `eligible` decides; "no_balance" replaced "used_this_month" as the reason under the yearly rule.

const balance = (over: Partial<CasualLeaveBalance> = {}): CasualLeaveBalance => ({
  total: 12,
  used: 0,
  pending: 0,
  remaining: 12,
  year: 2026,
  since: "2026-11-02",
  endsOn: "2026-12-31",
  cutOver: "2026-11-02",
  tracked: true,
  ...over,
});

const row = (over: Partial<BoardRow> & { employeeId: number }): BoardRow => ({
  employeeName: `Person ${over.employeeId}`,
  employeeCode: `E${over.employeeId}`,
  department: "Cutting",
  branch: "Head Office",
  employmentType: "staff",
  serviceMonths: 24,
  eligible: true,
  usedThisMonth: false,
  balance: balance(),
  ...over,
});

describe("the yearly balance in words", () => {
  it("says how much is left of the year's 12", () => {
    expect(balanceText(balance({ used: 1, remaining: 11 }))).toBe("11 of 12 left");
    expect(balanceText(balance({ used: 1, pending: 0.5, remaining: 10.5 }))).toBe("10.5 of 12 left");
    expect(balanceDetail(balance({ used: 1, pending: 0.5, remaining: 10.5 }))).toBe("1 used · 0.5 waiting");
    expect(balanceDetail(balance())).toBeNull();
  });

  it("has nothing to say without a balance (production, an older server, a year before the cut-over)", () => {
    expect(balanceText(null)).toBeNull();
    expect(balanceText(undefined)).toBeNull();
    expect(balanceText(balance({ tracked: false, since: null }))).toBeNull();
    expect(balanceLevel(null)).toBeNull();
  });

  it("grades how full the balance is", () => {
    expect(balanceLevel(balance())).toBe("full");
    expect(balanceLevel(balance({ remaining: 6, used: 6 }))).toBe("some");
    expect(balanceLevel(balance({ remaining: 0.5, used: 11.5 }))).toBe("low");
    expect(balanceLevel(balance({ remaining: 0, used: 12 }))).toBe("none");
  });

  it("knows which rule the board's month follows", () => {
    expect(isYearlyRule({ rule: "yearly_balance" })).toBe(true);
    expect(isYearlyRule({ rule: "one_per_month" })).toBe(false);
    expect(isYearlyRule({})).toBe(false);
    expect(isYearlyRule(null)).toBe(false);
  });
});

describe("who cannot take Casual Leave under the yearly rule", () => {
  it("lets someone who took CL this month take more while the balance lasts (eligible decides)", () => {
    const tookOne = row({ employeeId: 1, usedThisMonth: true, usedStatus: "approved", usedDate: "2026-11-05" });
    expect(whyNot(tookOne)).toBeNull();
    // even with no reason code at all, an eligible row is never "already used this month"
    expect(whyNot({ ...tookOne, reasonCode: null })).toBeNull();
    expect(countByReason([tookOne]).used_this_month).toBe(0);
  });

  it("names an empty balance as no Casual Leave left this year", () => {
    const empty = row({
      employeeId: 2,
      eligible: false,
      reasonCode: "no_balance",
      reason: "No Casual Leave left for 2026: all 12 days are used or waiting for approval",
      usedThisMonth: true,
      balance: balance({ used: 11, pending: 1, remaining: 0 }),
    });
    const why = whyNot(empty);
    expect(why).toMatchObject({ code: "no_balance", title: "No Casual Leave left this year", tone: "info" });
    expect(why?.detail).toBe(
      "All 12 days of 2026 are used or asked for (1 of them waiting for approval). A fresh balance of 12 starts on 1 January.",
    );
  });

  it("finds the empty balance when a row carries no reason code", () => {
    const empty = row({
      employeeId: 3,
      eligible: false,
      reasonCode: null,
      balance: balance({ used: 12, remaining: 0 }),
    });
    expect(whyNot(empty)?.code).toBe("no_balance");
  });

  it("falls back to the server's sentence when the balance is missing", () => {
    const why = whyNot(
      row({ employeeId: 4, eligible: false, reasonCode: "no_balance", balance: null, reason: "No Casual Leave left" }),
    );
    expect(why?.detail).toBe("No Casual Leave left");
  });

  it("counts, orders and summarises the no-balance reason like the other reasons", () => {
    const rows = [
      row({ employeeId: 10, employeeName: "Zara", eligible: false, reasonCode: "not_staff", employmentType: "production", balance: null }),
      row({ employeeId: 11, employeeName: "Yusuf", eligible: false, reasonCode: "under_service", serviceMonths: 4, eligibleFrom: "2027-01-02" }),
      row({ employeeId: 12, employeeName: "Xavier", eligible: false, reasonCode: "no_balance", balance: balance({ used: 12, remaining: 0 }) }),
      row({ employeeId: 13, employeeName: "Asha" }),
    ]; // prettier-ignore
    expect(countByReason(rows)).toEqual({
      not_staff: 1,
      no_join_date: 0,
      under_service: 1,
      used_this_month: 0,
      no_balance: 1,
    });
    // nothing left first, then soonest to qualify, then production
    expect(notEligibleRows(rows).map((r) => r.employeeId)).toEqual([12, 11, 10]);
    const s = summarize(rows, []);
    expect(s.byReason.no_balance).toBe(1);
    expect(Object.values(s.byReason).reduce((a, b) => a + b, 0)).toBe(s.notEligible);
  });

  it("keeps the old one-a-month reason for a month before the cut-over", () => {
    const used = row({
      employeeId: 5,
      eligible: false,
      reasonCode: "used_this_month",
      usedThisMonth: true,
      usedStatus: "approved",
      usedDate: "2026-10-03",
    });
    expect(whyNot(used)?.code).toBe("used_this_month");
  });
});

describe("the board export", () => {
  it("adds what is left of the year as the last column", () => {
    expect(BOARD_EXPORT_HEADERS.at(-1)).toBe("CL left this year");
    const out = boardExportRows([
      row({ employeeId: 1, balance: balance({ used: 1, remaining: 11 }) }),
      row({ employeeId: 2, employmentType: "production", balance: null }),
    ]);
    expect(out[0].at(-1)).toBe("11 of 12 left");
    expect(out[1].at(-1)).toBe("");
    expect(out[0]).toHaveLength(BOARD_EXPORT_HEADERS.length);
  });
});
