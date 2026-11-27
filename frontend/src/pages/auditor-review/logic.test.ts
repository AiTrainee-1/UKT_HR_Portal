import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api-client/custom-fetch";
import { TIMECARD, portalData, recount, termPortalData } from "./fixtures";
import {
  UNDO_BODY,
  bankLines,
  bankMissing,
  bankTotal,
  bulkBody,
  bulkProblem,
  bulkSummary,
  changeBody,
  changeProblems,
  changeText,
  chosenItems,
  dayMarks,
  dayStatusLabel,
  filterItems,
  firstEmiMonth,
  inCountedDays,
  isTermSettlement,
  linkValidity,
  modifications,
  openDecisions,
  portalBankFileName,
  portalProblem,
  settlementThroughDay,
  portalTotals,
  refusalReloads,
  reviewStatus,
  rowStatus,
  selectionState,
  sendBlocked,
  termEmi,
  termEmiText,
  termFixedSalary,
  termMonths,
  toggleAll,
} from "./logic";

// The Auditor Review Portal's rules (owner 2026-11-27): the checks of a change (the server's: service.auditor_change),
// the totals before and after the audit, the answers open, the bank file's rows, and the time card's words.

const refused = (status: number, data: unknown) =>
  new ApiError(new Response(null, { status, statusText: "x" }), data, { method: "GET", url: "/api/auditor-review/t" });

const withChange = (id: number, auditor: Partial<ReturnType<typeof portalData>["items"][number]["auditor"]>) => {
  const d = portalData();
  return recount({
    ...d,
    items: d.items.map((i) => (i.id === id ? { ...i, auditor: { ...i.auditor, ...auditor } } : i)),
  });
};

describe("a change on one request", () => {
  const item = portalData().items[0]; // HR approved ₹6,000

  it("Reduce: an amount below HR's, more than 0, at most 2 decimals, with a remark", () => {
    expect(changeProblems(item, "reduce", "", "")).toEqual({
      amount: "Enter the reduced amount.",
      remark: "Write a remark for the reduced amount (at least 3 characters).",
    });
    expect(changeProblems(item, "reduce", "6000", "ok ok").amount).toBe(
      "A reduced amount must be less than the approved ₹6,000.",
    );
    expect(changeProblems(item, "reduce", "0", "ok ok").amount).toBe("The reduced amount must be more than ₹0.");
    expect(changeProblems(item, "reduce", "10.555", "ok ok").amount).toBe("Use at most 2 decimal places.");
    expect(changeProblems(item, "reduce", "5999.99", "ok ok")).toEqual({});
    expect(changeBody(item, "reduce", "4,500.5", "  Two  days ")).toEqual({
      action: "reduce",
      amount: 4500.5,
      remark: "Two days",
    });
  });

  it("Reject: the reason; a remark alone: anything, keeping the change the request has", () => {
    expect(changeProblems(item, "reject", "", "no").remark).toBe(
      "Write the reason for rejecting (at least 3 characters).",
    );
    expect(changeBody(item, "reject", "", "Too many leaves")).toEqual({ action: "reject", remark: "Too many leaves" });
    expect(changeProblems(item, "remark", "", "")).toEqual({});
    expect(changeBody(item, "remark", "", "Fine")).toEqual({ action: "", remark: "Fine" });
    const reduced = { ...item, auditor: { action: "reduce" as const, amount: 5000, remark: "a b c", at: null } };
    expect(changeBody(reduced, "remark", "", "New note")).toEqual({
      action: "reduce",
      amount: 5000,
      remark: "New note",
    });
    expect(UNDO_BODY).toEqual({ action: "", remark: "" });
  });

  it("names the row's state and the change", () => {
    const d = withChange(1, { action: "reduce", amount: 4500, remark: "a b c" });
    expect(rowStatus(d.items[0])).toBe("reduced");
    expect(changeText(d.items[0])).toBe("Reduced ₹6,000 → ₹4,500");
    expect(rowStatus(d.items[2])).toBe("rejected_by_hr");
    const r = withChange(2, { action: "reject", remark: "a b c" });
    expect(rowStatus(r.items[1])).toBe("rejected_by_auditor");
    expect(changeText(r.items[1])).toBe("Rejected (HR approved ₹7,500.4)");
  });
});

describe("the totals and the answers", () => {
  it("compares HR's approved total with what is paid after the audit", () => {
    const d = withChange(1, { action: "reduce", amount: 4500, remark: "a b c" });
    expect(portalTotals(d)).toMatchObject({
      requests: 3,
      hrApprovedCount: 2,
      hrApproved: 13500.4,
      approved: 2,
      afterAudit: 12000.4,
      rejected: 1,
      changes: 1,
      remarks: 1,
      difference: 1500,
    });
    expect(modifications(d).map((m) => m.item.id)).toEqual([1]);
  });

  it("without changes both approvals; with changes only forwarding them to HR", () => {
    expect(openDecisions(portalData())).toEqual(["approved_send_accounts", "approved_forward_hr"]);
    const changed = withChange(1, { action: "reject", remark: "a b c" });
    expect(openDecisions(changed)).toEqual(["changes_forward_hr"]);
    expect(sendBlocked(changed)).toBe("You changed the settlement: forward the changes to HR.");
    expect(sendBlocked(portalData())).toBeNull();
    expect(sendBlocked(portalData({ accounts: { to: [], cc: ["x@y.in"] } }))).toContain("No Accounts e-mail address");
  });

  it("builds one payment per request paid, rounded up to the rupee, and names the file like the HRMS", () => {
    const lines = bankLines(portalData());
    expect(lines.map((l) => [l.employeeCode, l.amount])).toEqual([
      ["S101", 6000],
      ["S102", 7501],
    ]);
    expect(bankTotal(lines)).toBe(13501);
    expect(bankMissing(lines).map((l) => l.employeeCode)).toEqual(["S102"]);
    expect(portalBankFileName(portalData().settlement)).toBe(
      "Loan_Advance_Bank_File_Salary_Advance_November_2026_Batch_1.xlsx",
    );
  });

  it("says how the review stands", () => {
    expect(reviewStatus(portalData()).text).toBe("Awaiting your review");
    expect(reviewStatus(portalData({ canReview: false })).text).toBe("Read-only");
    expect(
      reviewStatus(
        portalData({ canReview: false, link: { expiresAt: "", submittedAt: "2026-11-26T05:00:00Z", decision: null } }),
      ).text,
    ).toBe("Review submitted");
  });
});

describe("when the link does not open", () => {
  it("tells invalid, replaced and expired links apart, and reads the portal again after a conflict", () => {
    expect(portalProblem(refused(404, { error: "x", code: "link_invalid" })).kind).toBe("invalid");
    expect(portalProblem(refused(410, { error: "x", code: "link_revoked" })).kind).toBe("revoked");
    expect(portalProblem(refused(410, { error: "x", code: "link_expired" })).kind).toBe("expired");
    expect(portalProblem(new TypeError("Failed to fetch")).kind).toBe("unavailable");
    expect(refusalReloads(refused(409, { code: "submitted" }))).toBe(true);
    expect(refusalReloads(refused(400, { code: "amount" }))).toBe(false);
  });
});

describe("the time card", () => {
  it("words the day's status and marks, and knows the days the earned salary counts (Settings' day)", () => {
    const [, late, absent, , half] = TIMECARD.days;
    expect(dayStatusLabel(late)).toBe("Present");
    expect(dayMarks(late)).toEqual(["Late"]);
    expect(dayStatusLabel(absent)).toBe("Absent");
    expect(dayStatusLabel(half)).toBe("Half Day");
    expect(dayMarks(half)).toEqual(["Early out"]);
    expect(dayStatusLabel({ status: "present", inProgress: true })).toBe("In progress");
    expect(inCountedDays(late, 20)).toBe(true);
    expect(inCountedDays(half, 20)).toBe(false);
    // the day comes from the request (Settings may say another one); unknown = every day counts
    expect(inCountedDays(half, 25)).toBe(true);
    expect(inCountedDays(half, null)).toBe(true);
  });

  it("takes the settlement's counted day from its requests", () => {
    expect(settlementThroughDay(portalData())).toBe(20);
    expect(settlementThroughDay(portalData({ items: [] }))).toBeNull();
  });
});

describe("a Term Loan batch's own figures", () => {
  const d = termPortalData();
  const [kavin, lakshmi, gopal] = d.items;

  it("is read as a Term Loan: the fixed salary and the eligible limit kept on the loan, not 50 % of the earned salary", () => {
    expect(isTermSettlement(d)).toBe(true);
    expect(isTermSettlement(portalData())).toBe(false);
    expect(termFixedSalary(kavin)).toBe(26000);
    expect(kavin.advance.termLimit).toBe(26000);
    expect(kavin.advance.earnings?.limit).toBe(6370); // the Salary Advance figure the page must not show for a loan
    expect(termFixedSalary({ ...kavin, advance: { ...kavin.advance, salaryAtRequest: null } })).toBe(26000);
  });

  it("takes HR's final months and first month, else the request's own", () => {
    expect(termMonths(kavin)).toBe(6);
    expect(termMonths(lakshmi)).toBe(4);
    expect(firstEmiMonth(kavin)).toBe("Dec 2026");
    expect(firstEmiMonth(lakshmi)).toBe("Jan 2027");
    expect(firstEmiMonth({ ...gopal, advance: { ...gopal.advance, repaymentStartMonth: null } })).toBeNull();
  });

  it("works the EMI out in whole rupees rounded up, the last one smaller", () => {
    expect(termEmi(20000, 6)).toEqual({ emi: 3334, last: 3330 });
    expect(termEmi(10000, 3)).toEqual({ emi: 3334, last: 3332 });
    expect(termEmi(10000, 4)).toEqual({ emi: 2500, last: 2500 });
    expect(termEmi(10000.5, 2)).toEqual({ emi: 5001, last: 4999.5 });
    expect(termEmi(0, 4)).toBeNull();
    expect(termEmi(5000, null)).toBeNull();
    expect(termEmiText(10000, 3)).toBe("₹3,334 a month (the last ₹3,332)");
    expect(termEmiText(10000, 4)).toBe("₹2,500 a month");
    expect(termEmiText(null, 4)).toBe("");
  });
});

describe("finding and choosing requests", () => {
  const d = portalData(); // 1 Asha (approved), 2 Ravi (approved, 3 days leave), 3 Meena (rejected by HR, 5 days)

  it("searches name, code and department, and filters by state", () => {
    expect(filterItems(d.items, "all", "").map((i) => i.id)).toEqual([1, 2, 3]);
    expect(filterItems(d.items, "all", "ravi").map((i) => i.id)).toEqual([2]);
    expect(filterItems(d.items, "all", "s103").map((i) => i.id)).toEqual([3]);
    expect(filterItems(d.items, "all", "accounts asha").map((i) => i.id)).toEqual([1]);
    expect(filterItems(d.items, "rejected", "").map((i) => i.id)).toEqual([3]);
    expect(filterItems(d.items, "leave", "").map((i) => i.id)).toEqual([2, 3]);
    expect(filterItems(d.items, "approved", "").map((i) => i.id)).toEqual([1, 2]);
    const changed = recount({
      ...d,
      items: d.items.map((i) =>
        i.id === 2 ? { ...i, auditor: { ...i.auditor, action: "reject", remark: "a b c" } } : i,
      ),
    });
    expect(filterItems(changed.items, "changed", "").map((i) => i.id)).toEqual([2]);
    expect(filterItems(changed.items, "remarks", "").map((i) => i.id)).toEqual([2]);
    expect(filterItems(changed.items, "approved", "").map((i) => i.id)).toEqual([1]);
  });

  it("Select All chooses every request shown that HR approved, and clears them again", () => {
    const none = new Set<number>();
    expect(selectionState(d.items, none)).toBe("none");
    const all = toggleAll(d.items, none);
    expect([...all].sort()).toEqual([1, 2]); // Meena was rejected by HR: never chosen
    expect(selectionState(d.items, all)).toBe("all");
    expect(selectionState(d.items, new Set([1]))).toBe("some");
    expect([...toggleAll(d.items, all)]).toEqual([]);
    // a request hidden by the search is never acted on
    expect(chosenItems(filterItems(d.items, "all", "ravi"), all).map((i) => i.id)).toEqual([2]);
    expect(chosenItems(d.items, new Set([3])).map((i) => i.id)).toEqual([]);
  });

  it("a bulk Reject needs one reason; a bulk Approve's remark is optional", () => {
    expect(bulkProblem("reject", " no ")).toBe("Write the reason for rejecting (at least 3 characters).");
    expect(bulkProblem("reject", "On hold")).toBeNull();
    expect(bulkProblem("approve", "")).toBeNull();
    expect(bulkBody(d.items.slice(0, 2), "reject", "  On   hold ")).toEqual({
      itemIds: [1, 2],
      action: "reject",
      remark: "On hold",
    });
    expect(bulkSummary(d.items.slice(0, 2))).toEqual({ count: 2, amount: 13500.4, changed: 0 });
  });
});

describe("the link's validity", () => {
  const now = new Date("2026-11-27T05:30:00Z");
  it("says how long the link still works", () => {
    expect(linkValidity("2026-12-01T05:30:00Z", now)).toBe("4 days left");
    expect(linkValidity("2026-11-28T06:00:00Z", now)).toBe("1 day left");
    expect(linkValidity("2026-11-27T20:00:00Z", now)).toBe("Expires today");
    expect(linkValidity("2026-11-26T05:30:00Z", now)).toBe("Expired");
    expect(linkValidity("", now)).toBe("");
  });
});
