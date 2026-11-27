import { describe, expect, it } from "vitest";
import {
  CARD_FILTERS,
  filterCounts,
  filterItems,
  focusView,
  hrProposalPayload,
  hrProposalProblems,
  outcomeOf,
  parseFocus,
  remarksOf,
  requestColumns,
  requestFigures,
  requestsShown,
  skippedText,
  standingOf,
  trailOf,
} from "./focus";
import { batchAt, item, withAuditor } from "./test-fixtures";

// Round 5 (owner 2026-11-27): what a click on a tracker stage or a summary card lists, where each request stands, the
// table's columns, HR's proposal and the bulk steps' words.

const ids = (items: { id: number }[]) => items.map((i) => i.id);

describe("a click on a stage or a summary card", () => {
  it("reads only a known stage or card from the address", () => {
    expect(parseFocus("md_review")).toBe("md_review");
    expect(parseFocus("approved")).toBe("approved");
    expect(parseFocus("received")).toBe("received");
    expect(parseFocus("nonsense")).toBeNull();
    expect(parseFocus("")).toBeNull();
    expect(CARD_FILTERS).toEqual(["all", "approved", "rejected", "pending", "leave"]);
  });

  it("the cards count as the server does: the final decision (with the auditor's change) once there is one, else the MD's", () => {
    const final = batchAt("hr_final");
    expect(filterCounts(final.items)).toEqual({ all: 3, approved: 2, rejected: 1, pending: 0, leave: 2 });
    expect(ids(filterItems(final.items, "rejected"))).toEqual([3]);
    expect(ids(filterItems(final.items, "leave"))).toEqual([2, 3]); // 3 days (warning) and 5 days (critical)
    // at HR Review nothing is decided
    expect(filterCounts(batchAt("hr_review").items)).toMatchObject({ approved: 0, rejected: 0, pending: 3 });
    // the auditor rejected Asha: she counts as rejected now
    const audited = batchAt("auditor_changes");
    audited.items[0] = withAuditor(audited.items[0], { action: "reject", remark: "No" });
    expect(outcomeOf(audited.items[0])).toBe("rejected");
    expect(ids(filterItems(audited.items, "approved"))).toEqual([2]);
  });

  it("each stage lists what matters there, and a stage not reached yet says so", () => {
    const review = batchAt("hr_review");
    expect(focusView(review, "hr_review")).toMatchObject({ kind: "hr", title: "HR Review: HR's proposals" });
    expect(focusView(review, "hr_review").items).toHaveLength(3);
    expect(focusView(review, "md_review")).toMatchObject({
      kind: "md",
      items: [],
      empty: "Not forwarded to the MD yet.",
    });
    expect(focusView(review, "accounts_send").empty).toBe("The audit is not through yet: no bank file.");

    const final = batchAt("hr_final");
    expect(focusView(final, "md_review").items).toHaveLength(3);
    expect(focusView(final, "hr_final").kind).toBe("final");
    // the auditor's stages: only the requests the auditor changed or wrote on
    const audited = batchAt("auditor_changes", {
      auditor: { ...batchAt("auditor_changes").auditor, submittedAt: "x" },
    });
    audited.items[0] = withAuditor(audited.items[0], { action: "reduce", amount: 5000 });
    audited.items[2] = withAuditor(audited.items[2], { remark: "Checked the attendance" });
    expect(ids(focusView(audited, "auditor_review").items)).toEqual([1, 3]);
    expect(focusView(batchAt("auditor_review"), "auditor_review").empty).toBe("The auditor has not answered yet.");
    // Accounts: the bank-file rows paid (the approved ones as paid)
    expect(focusView(batchAt("accounts_send"), "accounts_send")).toMatchObject({ kind: "bank" });
    expect(ids(focusView(batchAt("accounts_send"), "accounts_send").items)).toEqual([1, 2]);
    // a card
    expect(focusView(final, "approved")).toMatchObject({ kind: "requests", title: "Approved" });
    expect(ids(focusView(final, "all").items)).toEqual([1, 2, 3]);
  });

  it("a batch the MD finalized directly says so at HR Final Settlement", () => {
    const direct = batchAt("auditor_send", { finalizedVia: "md" });
    expect(focusView(direct, "hr_final").title).toBe("Final settlement (finalized by the MD)");
    expect(focusView(direct, "hr_final").hint).toContain("HR Final Settlement was skipped");
  });
});

describe("where a request stands, and the decisions so far", () => {
  it("HR's proposal first, then the MD's (pre-filled from HR until the MD clicks), the final one, the auditor's", () => {
    const asked = item(1);
    expect(standingOf(asked)).toMatchObject({ decision: null, amount: 8000, source: "asked", label: "as asked" });
    const reduced = item(1, { hr: { action: "reduce", amount: 6000 }, hrNote: "Above the limit" });
    expect(standingOf(reduced)).toMatchObject({ decision: "approved", amount: 6000, source: "hr" });
    expect(standingOf(item(1, { hr: { action: "reject" } }))).toMatchObject({ decision: "rejected", source: "hr" });
    const fromHr = item(1, { md: { decision: "approved", amount: 6000, fromHr: true } });
    expect(standingOf(fromHr)).toMatchObject({ amount: 6000, source: "md", label: "HR's proposal (MD to confirm)" });
    const final = batchAt("hr_final").items[0];
    expect(standingOf(final)).toMatchObject({ decision: "approved", amount: 6000, source: "final" });
    const audited = withAuditor(batchAt("auditor_changes").items[0], { action: "reduce", amount: 5000 });
    expect(standingOf(audited)).toMatchObject({ amount: 5000, source: "auditor", label: "after the audit" });
  });

  it("the trail has one line per stage reached", () => {
    const review = batchAt("hr_review");
    const proposal = item(1, { hr: { action: "reduce", amount: 6000 } });
    expect(trailOf(proposal, review).map((t) => `${t.who}: ${t.text}`)).toEqual(["HR: Proposes ₹6,000"]);
    const md = batchAt("md_review");
    const pre = item(1, { hr: { action: "reject" }, md: { decision: "rejected", fromHr: true } });
    expect(trailOf(pre, md).map((t) => [t.who, t.text, t.note])).toEqual([
      ["HR", "Proposes reject", undefined],
      ["MD", "Rejected", "from HR"],
    ]);
    const direct = batchAt("auditor_review", { finalizedVia: "md" });
    const changed = withAuditor(direct.items[0], { action: "reduce", amount: 5000 });
    expect(trailOf(changed, direct).map((t) => [t.who, t.text, t.note])).toEqual([
      ["HR", "Keep as asked", undefined],
      ["MD", "Approved ₹8,000", undefined],
      ["Final", "Approved ₹6,000", "by the MD"],
      ["Auditor", "Reduced to ₹5,000", "pays ₹5,000"],
    ]);
  });

  it("lists every remark with whose it is", () => {
    const i = batchAt("hr_final").items[1];
    expect(remarksOf(i)).toEqual([{ who: "MD", text: "Reduce" }]);
    expect(remarksOf(batchAt("hr_final").items[0]).map((r) => r.who)).toEqual(["HR", "Final"]);
  });
});

describe("the Requests table", () => {
  it("every value under its own heading, numbers right-aligned; the type decides the figures", () => {
    const sa = requestColumns("general", { select: true, actions: true });
    // the owner's report order: fixed salary, working days, earned, requested, limit, approved
    expect(sa.map((c) => c.header)).toEqual([
      "",
      "Employee",
      "Fixed salary",
      "Working days",
      "Earned",
      "Requested",
      "Eligible limit",
      "Approved",
      "Leave",
      "Status",
      "Remarks",
      "Actions",
    ]);
    const tl = requestColumns("term", { select: false, actions: false });
    expect(tl.map((c) => c.key)).toEqual([
      "employee",
      "fixedSalary",
      "requested",
      "limit",
      "approved",
      "months",
      "emi",
      "firstEmi",
      "leave",
      "decision",
      "remarks",
    ]);
    const right = tl.filter((c) => c.align === "right").map((c) => c.key);
    expect(right).toEqual(["fixedSalary", "requested", "limit", "approved", "months", "emi"]);
    expect(tl.find((c) => c.key === "leave")?.align).toBe("center");
  });

  it("the less needed columns show from a wider screen on, so the table fits a laptop (All Employees' way)", () => {
    const from = (type: "general" | "term") =>
      Object.fromEntries(
        requestColumns(type, { select: true, actions: true })
          .filter((c) => c.from)
          .map((c) => [c.key, c.from]),
      );
    expect(from("general")).toEqual({ fixedSalary: "2xl", workingDays: "2xl", earned: "xl", remarks: "wide" });
    expect(from("term")).toEqual({ fixedSalary: "2xl", months: "xl", emi: "xl", firstEmi: "2xl", remarks: "wide" });
  });

  it("a Salary Advance's earned figures, a Term Loan's limit, months, EMI and first EMI", () => {
    const sa = requestFigures(batchAt("hr_review").items[0]);
    expect(sa).toMatchObject({ fixedSalary: 26000, workingDays: 16, earned: 16000, limit: 8000, overLimit: false });
    const loan = item(2, {
      advance: {
        advanceType: "term",
        amount: 30000,
        requestedAmount: 30000,
        repaymentMonths: 6,
        emiAmount: 5000,
        termLimit: 26000,
        salaryAtRequest: 26000,
        earnings: null,
        repaymentStartMonth: 12,
        repaymentStartYear: 2026,
      },
    });
    expect(requestFigures(loan)).toMatchObject({
      fixedSalary: 26000,
      limit: 26000,
      overLimit: true,
      months: 6,
      emi: 5000,
      firstEmi: "Dec 2026",
    });
    // reduced by HR: the EMI follows the proposed amount
    const reduced = { ...loan, hr: { action: "reduce" as const, amount: 24000, remark: "Limit" } };
    expect(requestFigures(reduced).emi).toBe(4000);
    // rejected: no EMI to show
    expect(requestFigures({ ...loan, hr: { action: "reject" as const, amount: null, remark: "No" } })).toMatchObject({
      emi: null,
      firstEmi: "",
    });
  });

  it("the filter and the search narrow the list", () => {
    const final = batchAt("hr_final");
    expect(ids(requestsShown(final.items, "all", ""))).toEqual([1, 2, 3]);
    expect(ids(requestsShown(final.items, "approved", "ravi"))).toEqual([2]);
    expect(ids(requestsShown(final.items, "all", "S103"))).toEqual([3]);
  });

  it("names what a bulk step left out", () => {
    expect(skippedText(batchAt("hr_final"), [{ id: 3, reason: "The MD rejected it." }])).toBe(
      "Meena Iyer: The MD rejected it.",
    );
  });
});

describe("HR's proposal at HR Review", () => {
  const asha = batchAt("hr_review").items[0]; // 8,000 asked for

  it("a reduced amount is below the amount asked for, and a reduction or a rejection needs a remark", () => {
    expect(hrProposalProblems(asha, { action: "reduce", amount: "", remark: "Limit" }).amount).toBe(
      "Enter the reduced amount.",
    );
    expect(hrProposalProblems(asha, { action: "reduce", amount: "8000", remark: "Limit" }).amount).toBe(
      "A reduced amount must be less than the ₹8,000 asked for.",
    );
    expect(hrProposalProblems(asha, { action: "reduce", amount: "6000", remark: "x" }).remark).toBe(
      "Write a remark for the reduced amount (at least 3 characters).",
    );
    expect(hrProposalProblems(asha, { action: "reject", amount: "", remark: "" }).remark).toBe(
      "Write the reason for rejecting (at least 3 characters).",
    );
    expect(hrProposalProblems(asha, { action: "reduce", amount: "6000", remark: "Above the limit" })).toEqual({});
  });

  it("sends the proposal with its remark", () => {
    expect(hrProposalPayload({ action: "reduce", amount: "6,000", remark: "  Above   the limit " })).toEqual({
      hrNote: "Above the limit",
      action: "reduce",
      amount: 6000,
    });
    expect(hrProposalPayload({ action: "reject", amount: "", remark: "Too many leaves" })).toEqual({
      hrNote: "Too many leaves",
      action: "reject",
    });
  });
});
