import { describe, expect, it } from "vitest";
import { CLAIMS, TODAY, WINDOWS, windowOf } from "../fixtures";
import {
  CLAIM_REASON_MAX,
  WINDOW_MAX_DAYS_AHEAD,
  WINDOW_REASON_MAX,
  checkClaim,
  checkRedeem,
  checkWindow,
  claimPayload,
  claimStatusInfo,
  dayKindText,
  decisionText,
  emptyWindowForm,
  entrySourceText,
  lastSunday,
  punchSummary,
  redeemSummary,
  scopeText,
  splitWindows,
  windowKindText,
  windowPayload,
  windowScopeText,
  windowSentence,
  windowTimeText,
  type WindowForm,
} from "./leave-logic";

// Compensation Leave as pure functions: the announce form, the claim form and list, the balance and the redeem form.

describe("announcing a late-in / early-out", () => {
  const good: WindowForm = {
    date: "2026-10-20",
    kind: "late_in",
    time: "10:30",
    reason: "Heavy rain",
    departmentId: "",
    branchId: "",
  };

  it("starts today, as a late-in, with nothing else filled", () => {
    expect(emptyWindowForm(TODAY)).toEqual({
      date: TODAY,
      kind: "late_in",
      time: "",
      reason: "",
      departmentId: "",
      branchId: "",
    });
  });

  it("accepts a complete form, for today or a day up to 180 days ahead", () => {
    expect(checkWindow(good, TODAY)).toEqual({ ok: true, problems: {} });
    expect(checkWindow({ ...good, date: TODAY }, TODAY).ok).toBe(true);
    expect(checkWindow({ ...good, date: "2027-04-12" }, TODAY).ok).toBe(true); // exactly 180 days
    expect(WINDOW_MAX_DAYS_AHEAD).toBe(180);
  });

  it("refuses a past date and a date more than 180 days ahead", () => {
    expect(checkWindow({ ...good, date: "2026-10-13" }, TODAY).problems.date).toMatch(/today or a later date/);
    expect(checkWindow({ ...good, date: "2027-04-13" }, TODAY).problems.date).toMatch(/180 days ahead/);
    expect(checkWindow({ ...good, date: "" }, TODAY).problems.date).toBe("Choose the date.");
    expect(checkWindow({ ...good, date: "2026-02-30" }, TODAY).problems.date).toBe("Enter a valid date.");
  });

  it("needs the time, and asks for the one that fits the kind", () => {
    expect(checkWindow({ ...good, time: "" }, TODAY).problems.time).toBe("Enter the latest arrival time.");
    expect(checkWindow({ ...good, kind: "early_out", time: "" }, TODAY).problems.time).toBe(
      "Enter the earliest leaving time.",
    );
  });

  it("needs a reason of at most 300 characters", () => {
    expect(checkWindow({ ...good, reason: "   " }, TODAY).problems.reason).toMatch(/Give a reason/);
    expect(checkWindow({ ...good, reason: "x".repeat(WINDOW_REASON_MAX + 1) }, TODAY).problems.reason).toMatch(
      /at most 300/,
    );
    expect(checkWindow({ ...good, reason: "x".repeat(WINDOW_REASON_MAX) }, TODAY).ok).toBe(true);
  });

  it("sends the date, kind, time, the trimmed reason and the scope", () => {
    expect(windowPayload({ ...good, reason: "  Heavy rain  ", departmentId: "3", branchId: "2" })).toEqual({
      date: "2026-10-20",
      kind: "late_in",
      time: "10:30",
      reason: "Heavy rain",
      branchId: 2,
      departmentId: 3,
    });
    expect(windowPayload(good)).toMatchObject({ branchId: null, departmentId: null });
  });

  it("says who it covers", () => {
    expect(scopeText({})).toBe("all staff");
    expect(scopeText({ branch: "Head Office" })).toBe("all staff of Head Office");
    expect(scopeText({ department: "Cutting" })).toBe("Cutting staff");
    expect(scopeText({ department: "Cutting", branch: "Head Office" })).toBe("Cutting staff of Head Office");
  });

  it("explains what the announcement will do before it is sent", () => {
    expect(windowSentence(good, {})).toBe(
      "On Tue, 20 Oct 2026, all staff may arrive up to 10:30 AM. Their regular shift start and grace do not apply that day, so nobody arriving by 10:30 AM is marked Late; after 10:30 AM the usual Late rules count from 10:30 AM.",
    );
    expect(windowSentence({ ...good, kind: "early_out", time: "16:00" }, { department: "Cutting" })).toBe(
      "On Tue, 20 Oct 2026, Cutting staff may leave from 4:00 PM. Their regular shift end and grace do not apply that day, so nobody leaving at or after 4:00 PM is marked Early Out.",
    );
    expect(windowSentence({ ...good, time: "" }, {})).toBe("");
  });

  it("lists today and upcoming soonest first, and earlier ones newest first", () => {
    const rows = [
      windowOf(1, { date: "2026-10-25" }),
      windowOf(2, { date: "2026-10-14" }),
      windowOf(3, { date: "2026-09-01" }),
      windowOf(4, { date: "2026-10-10" }),
    ];
    const { upcoming, earlier } = splitWindows(rows, TODAY);
    expect(upcoming.map((r) => r.id)).toEqual([2, 1]);
    expect(earlier.map((r) => r.id)).toEqual([4, 3]);
  });

  it("names the kinds and their times, the older Compensation Day included", () => {
    const [lateIn, earlyOut, day] = WINDOWS.map((w) => ({ ...w })).sort((a, b) => b.id - a.id);
    expect(windowKindText(lateIn)).toBe("Late-in");
    expect(windowTimeText(lateIn)).toBe("Arrive up to 10:30 AM");
    expect(windowKindText(earlyOut)).toBe("Early-out");
    expect(windowTimeText(earlyOut)).toBe("Leave from 4:00 PM");
    expect(windowKindText(day)).toBe("Compensation Day (older kind)");
    expect(windowTimeText(day)).toBe("Whole day exempt from Late / Permission");
    expect(windowTimeText({ ...day, time: "15:00" })).toBe("Leave until 3:00 PM");
    expect(windowScopeText(lateIn)).toBe("all staff");
    expect(windowScopeText({ ...lateIn, employeeCount: 3 })).toBe("3 named employees");
    expect(windowScopeText({ ...lateIn, department: "Cutting", branch: "Head Office" })).toBe(
      "Cutting staff of Head Office",
    );
  });
});

describe("raising Sunday / holiday work claims", () => {
  it("needs somebody ticked, shifts for each, and a reason", () => {
    expect(checkClaim({}, "Dispatch rush", true).first).toBe("Tick the employees who worked.");
    expect(checkClaim({ 21: null }, "Dispatch rush", true)).toMatchObject({
      ok: false,
      first: "Choose the shifts for every ticked employee.",
      missingShifts: [21],
    });
    expect(checkClaim({ 21: 1 }, "  ", true).first).toMatch(/Give a reason/);
    expect(checkClaim({ 21: 1, 22: 0.5 }, "Dispatch rush", true)).toEqual({
      ok: true,
      first: null,
      missingShifts: [],
      reasonProblem: null,
    });
  });

  it("limits the reason to 500 characters", () => {
    expect(checkClaim({ 21: 1 }, "x".repeat(CLAIM_REASON_MAX + 1), true).reasonProblem).toMatch(/at most 500/);
    expect(checkClaim({ 21: 1 }, "x".repeat(CLAIM_REASON_MAX), true).ok).toBe(true);
  });

  it("cannot be sent while raising is paused", () => {
    const result = checkClaim({ 21: 1 }, "Dispatch rush", false);
    expect(result.ok).toBe(false);
    expect(result.first).toMatch(/paused/);
  });

  it("sends the date, the trimmed reason and one item per ticked employee", () => {
    expect(claimPayload("2026-10-11", { 21: 1, 22: 0.25 }, " Dispatch rush ")).toEqual({
      workDate: "2026-10-11",
      reason: "Dispatch rush",
      items: [
        { employeeId: 21, shifts: 1 },
        { employeeId: 22, shifts: 0.25 },
      ],
    });
  });

  it("summarises an employee's punches that day", () => {
    expect(punchSummary({ firstPunch: "09:00", lastPunch: "17:30", spanMinutes: 510, punchCount: 2 })).toBe(
      "09:00 - 17:30 (8 h 30 min, 2 punches)",
    );
    expect(punchSummary({ firstPunch: "10:00", lastPunch: "10:00", spanMinutes: 0, punchCount: 1 })).toBe(
      "10:00 - 10:00 (1 punch)",
    );
    expect(punchSummary({ firstPunch: null, lastPunch: null, spanMinutes: null, punchCount: 0 })).toBe("No punches");
    expect(punchSummary({ firstPunch: null, lastPunch: null, spanMinutes: null, punchCount: 3 })).toBe("3 punches");
  });

  it("starts the date at the last Sunday on or before today", () => {
    expect(lastSunday("2026-10-14")).toBe("2026-10-11");
    expect(lastSunday("2026-10-11")).toBe("2026-10-11");
    expect(lastSunday("2026-10-12")).toBe("2026-10-11");
    expect(lastSunday("2026-10-17")).toBe("2026-10-11");
  });
});

describe("following the claims", () => {
  const [pending, approved, rejected] = CLAIMS;

  it("reads the status from the approval: waiting for the HOD, approved, rejected", () => {
    expect(claimStatusInfo(pending)).toEqual({ label: "Waiting for HOD", tone: "warning" });
    expect(claimStatusInfo(approved)).toEqual({ label: "Approved", tone: "success" });
    expect(claimStatusInfo(rejected)).toEqual({ label: "Rejected", tone: "danger" });
    // an older server sends no approval block: the claim is still waiting for the Department Head
    expect(claimStatusInfo({ status: "pending", approval: null })).toEqual({
      label: "Waiting for HOD",
      tone: "warning",
    });
  });

  it("says who decided and when", () => {
    expect(decisionText(pending)).toBeNull();
    expect(decisionText(approved)).toBe("Approved by Suresh Raj, 12 Oct 2026");
    expect(decisionText(rejected)).toBe("Rejected by Suresh Raj, 12 Oct 2026");
    expect(decisionText({ status: "approved", reviewedBy: null, reviewedAt: null })).toBe("Approved");
  });

  it("names the day: a Sunday or the holiday", () => {
    expect(dayKindText({ dayKind: "sunday", holidayName: null })).toBe("Sunday");
    expect(dayKindText({ dayKind: "holiday", holidayName: "Diwali" })).toBe("Holiday: Diwali");
    expect(dayKindText({ dayKind: "holiday", holidayName: null })).toBe("Company holiday");
  });
});

describe("the balance", () => {
  it("says where each entry came from", () => {
    expect(entrySourceText({ source: "holiday_work", type: "credit" })).toMatch(/approved by the Department Head/);
    expect(entrySourceText({ source: "redemption", type: "debit" })).toBe("Redeemed as a day off");
    expect(entrySourceText({ source: "legacy_credit", type: "credit" })).toBe("Earlier Alternative-Day credit");
    expect(entrySourceText({ source: "legacy_credit", type: "debit" })).toBe("Earlier Alternative-Day credit used");
    expect(entrySourceText({ source: "ot_shift", type: "credit" })).toBe("Overtime relaxation without a date");
    expect(entrySourceText({ source: "other", type: "debit" })).toBe("Used");
  });

  describe("the redeem form", () => {
    it("needs a day and shifts that are not more than the balance", () => {
      expect(checkRedeem({ date: "", shifts: null }, 1.5)).toMatchObject({
        ok: false,
        dateProblem: "Choose the day the day off is taken.",
        shiftsProblem: "Choose how many shifts.",
        after: null,
      });
      expect(checkRedeem({ date: "2026-10-15", shifts: 0.5 }, 1.5)).toEqual({
        ok: true,
        dateProblem: null,
        shiftsProblem: null,
        after: 1,
      });
    });

    it("allows the whole balance and not a hundredth more", () => {
      expect(checkRedeem({ date: "2026-10-15", shifts: 1 }, 1).ok).toBe(true);
      expect(checkRedeem({ date: "2026-10-15", shifts: 1 }, 1).after).toBe(0);
      const over = checkRedeem({ date: "2026-10-15", shifts: 0.75 }, 0.5);
      expect(over.ok).toBe(false);
      expect(over.shiftsProblem).toBe("More than the balance (0.50).");
      expect(over.after).toBeNull();
    });

    it("refuses a date that is not a day", () => {
      expect(checkRedeem({ date: "2026-13-01", shifts: 0.25 }, 1).dateProblem).toBe("Enter a valid date.");
    });

    it("says what will happen", () => {
      expect(redeemSummary({ date: "2026-10-15", shifts: 0.5 }, 1.5)).toBe(
        "Thu, 15 Oct 2026 is topped up by 0.50 shifts (a day never goes above 1 shift) and marked Compensation in attendance. The balance goes from 1.50 to 1.",
      );
      expect(redeemSummary({ date: "2026-10-15", shifts: null }, 1.5)).toBe("");
    });
  });
});
