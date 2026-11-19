import { describe, expect, it } from "vitest";
import {
  normalizeBalanceRow,
  normalizeClaim,
  normalizeLedgerRow,
  type HolidayWorkMonthDay,
} from "@/lib/api-client/custom-hooks";
import { claim } from "../fixtures";
import {
  canClaimBirthday,
  claimAmountText,
  claimDateDetail,
  claimEffectText,
  claimStatusText,
  dayCounts,
  groupWeeks,
  inMonth,
  ledgerSourceText,
  outcomeOf,
  overtimeText,
  previousSunday,
  raisedByText,
  signedShifts,
  stepMonth,
  windowWhen,
} from "./claims-logic";
import { switchQuery } from "@/components/ui/subtab-nav";
import { LEAVE_OWN_KEYS, claimLink, creditLink, balanceLink, monthChoice, monthChoiceLabel } from "./leave-url";
import { checkUseBalance } from "./UseBalanceDialog";

// The pure rules of the claim workflow's pages (Compensation Leave B), the birthday outcomes (C) and the announcements
// list (A), and the readers that turn what the server sends into what the pages show.

describe("the Raise strip", () => {
  it("opens on the previous Sunday: the latest one strictly before today", () => {
    expect(previousSunday("2026-10-14")).toBe("2026-10-11"); // a Wednesday
    expect(previousSunday("2026-10-12")).toBe("2026-10-11"); // a Monday
    expect(previousSunday("2026-10-11")).toBe("2026-10-04"); // a Sunday is still being worked
    expect(previousSunday("2026-11-01")).toBe("2026-10-25"); // across a month
  });

  it("groups the days by their week, in order", () => {
    const day = (date: string, weekLabel: string): HolidayWorkMonthDay => ({
      date,
      kind: "sunday",
      holidayName: null,
      weekLabel,
      worked: 0,
      eligible: 0,
      claimed: { pending: 0, approved: 0 },
    });
    const weeks = groupWeeks([day("2026-10-02", "Week 1"), day("2026-10-04", "Week 1"), day("2026-10-11", "Week 2")]);
    expect(weeks.map((w) => [w.label, w.days.map((d) => d.date)])).toEqual([
      ["Week 1", ["2026-10-02", "2026-10-04"]],
      ["Week 2", ["2026-10-11"]],
    ]);
    expect(groupWeeks([])).toEqual([]);
  });

  it("says how many worked and the claims of a day", () => {
    const counts = dayCounts({
      date: "2026-10-11",
      kind: "sunday",
      holidayName: null,
      weekLabel: "Week 2",
      worked: 3,
      eligible: 2,
      claimed: { pending: 1, approved: 0 },
    });
    expect(counts).toEqual({ worked: "3 worked · 2 to claim", claims: "1 waiting" });
  });

  it("steps months across a year, and knows the month of a day", () => {
    expect(stepMonth(1, 2026, -1)).toEqual({ month: 12, year: 2025 });
    expect(stepMonth(12, 2026, 1)).toEqual({ month: 1, year: 2027 });
    expect(stepMonth(10, 2026, 0)).toEqual({ month: 10, year: 2026 });
    expect(inMonth("2026-10-11", 10, 2026)).toBe(true);
    expect(inMonth("2026-10-11", 9, 2026)).toBe(false);
    expect(inMonth("", 10, 2026)).toBe(false);
  });
});

describe("a claim in words", () => {
  it("names what was claimed, per kind", () => {
    expect(claimAmountText(claim(1, { kind: "ot_allowance", minutes: 30 }))).toBe("30 min late-in");
    expect(claimAmountText(claim(1, { kind: "ot_allowance", minutes: null }))).toBe("Late-in allowance");
    expect(claimAmountText(claim(1, { kind: "ot_shift", shifts: 0.75 }))).toBe("0.75 shifts");
    expect(claimAmountText(claim(1, { kind: "birthday", shifts: 1 }))).toBe("1 shift");
  });

  it("says who raised it", () => {
    expect(raisedByText(claim(1, { raisedByRole: "employee", requestedBy: "Asha" }))).toBe("Employee (app)");
    expect(raisedByText(claim(1, { raisedByRole: "hr", requestedBy: "Meena" }))).toBe("HR (Meena)");
    expect(raisedByText(claim(1, { raisedByRole: "hr", requestedBy: null }))).toBe("HR");
  });

  it("puts the OT times in a sentence, the next day included", () => {
    expect(
      overtimeText({
        date: "2026-10-05",
        shiftEnd: "17:30",
        lastPunch: "02:10",
        lastPunchNextDay: true,
        extraMinutes: 520,
      }),
    ).toBe("Shift end 17:30, last punch 02:10 next day, 8 h 40 min past the shift end");
    expect(overtimeText(null)).toBeNull();
    expect(claimDateDetail(claim(1, { kind: "holiday_work", dayKind: "holiday", holidayName: "Diwali" }))).toBe(
      "Holiday: Diwali",
    );
    expect(claimDateDetail(claim(1, { kind: "birthday" }))).toBe("Worked on the birthday");
    expect(claimDateDetail(claim(1, { kind: "use_balance" }))).toBe("Day off from the balance");
  });

  it("says where it stands", () => {
    expect(claimStatusText(claim(1, { status: "approved" }))).toBe("Approved");
    expect(claimStatusText(claim(1, { status: "rejected" }))).toBe("Rejected");
    expect(claimStatusText(claim(1, { status: "pending", approval: null }))).toBe("Waiting for HOD");
  });

  it("says what it did to the balance, per kind and status", () => {
    expect(claimEffectText(claim(1, { status: "rejected" }))).toBe("Rejected: nothing was credited.");
    expect(claimEffectText(claim(1, { status: "pending" }))).toBe(
      "Nothing is credited until the Department Head approves it.",
    );
    expect(claimEffectText(claim(1, { status: "pending", kind: "use_balance" }))).toMatch(/Nothing is taken off/);
    expect(
      claimEffectText(
        claim(1, {
          status: "approved",
          ledger: { id: 9, type: "credit", shifts: 1, date: "2026-10-12", source: "holiday_work" },
        }),
      ),
    ).toBe("1 shift added to the balance on 12 Oct 2026.");
    expect(claimEffectText(claim(1, { status: "approved", kind: "ot_allowance", appliesOn: "2026-10-08" }))).toBe(
      "Applied as a late-in allowance on Thu, 8 Oct 2026 (the next working day).",
    );
    expect(claimEffectText(claim(1, { status: "approved", kind: "ot_allowance" }))).toMatch(/next working day after/);
    expect(
      claimEffectText(claim(1, { status: "approved", kind: "use_balance", shifts: 0.5, workDate: "2026-10-16" })),
    ).toBe("0.50 shifts taken off the balance for Fri, 16 Oct 2026.");
  });
});

describe("the ledger in words", () => {
  it("names where an entry came from", () => {
    expect(ledgerSourceText({ source: "birthday", type: "credit" })).toBe("Birthday credit (worked on the birthday)");
    expect(ledgerSourceText({ source: "ot_shift", type: "credit" })).toMatch(/OT shift credit, Type 2/);
    expect(ledgerSourceText({ source: "redemption", type: "debit", claim: null })).toBe(
      "Redeemed as a day off (by HR)",
    );
    expect(ledgerSourceText({ source: "redemption", type: "debit", claim: { id: 4 } })).toMatch(/request approved/);
    expect(ledgerSourceText({ source: "legacy_credit", type: "debit" })).toBe("Earlier Alternative-Day credit used");
    expect(ledgerSourceText({ source: "other", type: "credit", sourceLabel: "Correction" })).toBe("Correction");
    expect(signedShifts({ type: "credit", shifts: 1 })).toBe("+1");
    expect(signedShifts({ type: "debit", shifts: 0.5 })).toBe("−0.50");
  });
});

describe("the Compensation Leave subtabs keep their own filters", () => {
  it("leaves the announcements' month behind when Sunday & holiday work opens, and gives it back", () => {
    const kept: Record<string, string> = {};
    expect(switchQuery("wmonth=10&wyear=2026", "announcements", "holiday-work", LEAVE_OWN_KEYS, kept)).toBe("");
    expect(switchQuery("hkind=birthday", "holiday-work", "announcements", LEAVE_OWN_KEYS, kept)).toBe(
      "wmonth=10&wyear=2026",
    );
    expect(LEAVE_OWN_KEYS["holiday-work"]).toEqual(expect.arrayContaining(["hdate", "balq", "lmonth", "rmonth"]));
    expect(LEAVE_OWN_KEYS.birthdays).toEqual(expect.arrayContaining(["bperiod", "boutcome"]));
    expect(LEAVE_OWN_KEYS.birthdays).not.toContain("balq");
  });
});

describe("birthdays and announcements", () => {
  it("reads a birthday's outcome, and the older backend's `benefits` when there is none", () => {
    expect(outcomeOf({ outcome: "credit_claimable", benefits: true })).toBe("credit_claimable");
    expect(outcomeOf({ outcome: null, benefits: true })).toBe("old_rule");
    expect(outcomeOf({ benefits: false })).toBe("not_eligible");
  });

  it("offers Claim for employee on what the server calls claimable (a rejected credit may be claimed again)", () => {
    expect(canClaimBirthday({ outcome: "credit_rejected", benefits: true, claimable: true })).toBe(true);
    expect(canClaimBirthday({ outcome: "credit_claimable", benefits: true, claimable: false })).toBe(false);
    expect(canClaimBirthday({ outcome: "credit_claimable", benefits: true })).toBe(true); // older backend
    expect(canClaimBirthday({ outcome: "credit_rejected", benefits: true })).toBe(false);
  });

  it("says when an announcement is", () => {
    expect(windowWhen("2026-10-14", "2026-10-14")).toBe("today");
    expect(windowWhen("2026-10-20", "2026-10-14")).toBe("upcoming");
    expect(windowWhen("2026-10-10", "2026-10-14")).toBe("past");
  });
});

describe("the addresses of the lists", () => {
  it("reads the month of a list: the current one, a chosen one, or every month", () => {
    expect(monthChoice("", "", "2026-10-14")).toEqual({ all: false, month: 10, year: 2026 });
    expect(monthChoice("9", "2025", "2026-10-14")).toEqual({ all: false, month: 9, year: 2025 });
    expect(monthChoice("all", "", "2026-10-14")).toEqual({ all: true, month: null, year: null });
    expect(monthChoice("all", "", "2026-10-14", false)).toEqual({ all: false, month: 10, year: 2026 });
    expect(monthChoiceLabel({ all: true, month: null, year: null })).toBe("every month");
    expect(monthChoiceLabel({ all: false, month: 9, year: 2026 })).toBe("September 2026");
  });

  it("links a claim, a credit and a balance to each other", () => {
    const base = "/hr/compensation/compensation-leave/holiday-work";
    expect(claimLink(3005, 13)).toBe(`${base}/claims?hmonth=all&hemp=13&hclaim=3005`);
    expect(creditLink(13, 3005)).toBe(`${base}/credits?lmonth=all&lemp=13&lclaim=3005`);
    expect(creditLink(13)).toBe(`${base}/credits?lmonth=all&lemp=13`);
    expect(balanceLink(13)).toBe(`${base}/balance?balemp=13`);
  });
});

describe("Use balance", () => {
  it("needs a real day, shifts the balance covers and a reason", () => {
    expect(checkUseBalance({ date: "", shifts: null, reason: "" }, 1)).toMatchObject({
      ok: false,
      dateProblem: "Choose the day off.",
      shiftsProblem: "Choose how many shifts.",
    });
    expect(checkUseBalance({ date: "2026-02-30", shifts: 0.5, reason: "x" }, 1).dateProblem).toBe(
      "Enter a valid date.",
    );
    expect(checkUseBalance({ date: "2026-10-20", shifts: 1, reason: "x" }, 0.5).shiftsProblem).toBe(
      "More than the available balance (0.50).",
    );
    expect(checkUseBalance({ date: "2026-10-20", shifts: 0.5, reason: "  " }, 1).reasonProblem).toMatch(
      /Give a reason/,
    );
    expect(checkUseBalance({ date: "2026-10-20", shifts: 0.5, reason: "Family function" }, 1).ok).toBe(true);
  });
});

describe("reading what the server sends", () => {
  it("reads a claim of any kind, with the older keys and the defaults", () => {
    const c = normalizeClaim({
      id: "12",
      kind: "ot_shift",
      date: "2026-10-05",
      employee: { id: 13, name: "Chitra Devi", code: "E13", department: "Cutting" },
      shifts: "0.5",
      status: "approved",
      raisedByRole: "employee",
      overtime: {
        date: "2026-10-05",
        shiftEndTime: "17:30",
        lastPunchOut: "02:10",
        lastPunchNextDay: true,
        otMinutes: 520,
      },
      ledgerEntry: { id: 15, entryType: "credit", shifts: 0.5, date: "2026-10-06", source: "ot_shift" },
    });
    expect(c).toMatchObject({
      id: 12,
      kind: "ot_shift",
      workDate: "2026-10-05",
      employeeId: 13,
      employeeName: "Chitra Devi",
      employeeCode: "E13",
      department: "Cutting",
      shifts: 0.5,
      status: "approved",
      raisedByRole: "employee",
      credited: true,
      ledger: { id: 15, type: "credit", shifts: 0.5, date: "2026-10-06", source: "ot_shift" },
      overtime: { shiftEnd: "17:30", lastPunch: "02:10", lastPunchNextDay: true, extraMinutes: 520 },
    });
    const bare = normalizeClaim({ id: 1, workDate: "2026-10-11", status: "weird" });
    expect(bare).toMatchObject({
      kind: "holiday_work",
      status: "pending",
      raisedByRole: "hr",
      ledger: null,
      approval: null,
    });
  });

  it("reads a balance row: the four figures, `balance` standing in for `available`", () => {
    expect(
      normalizeBalanceRow({
        employeeId: 21,
        employeeCode: "E21",
        employeeName: "Fara",
        department: "Cutting",
        balance: 1.5,
      }),
    ).toMatchObject({ employeeId: 21, earned: 0, used: 0, pending: 0, available: 1.5, lastActivity: null });
  });

  it("reads a ledger row, its claim and whether it counts", () => {
    const r = normalizeLedgerRow({
      id: 7,
      entryType: "debit",
      shifts: 0.5,
      date: "2026-10-09",
      source: "redemption",
      employee: { id: 21, name: "Fara Khan", employeeCode: "E21" },
      claim: { id: 3007, kind: "use_balance", status: "approved" },
      counted: false,
    });
    expect(r).toMatchObject({
      id: 7,
      type: "debit",
      employeeId: 21,
      employeeCode: "E21",
      claim: { id: 3007, kind: "use_balance", status: "approved" },
      counted: false,
    });
  });
});
