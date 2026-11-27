import { describe, expect, it } from "vitest";
import { sortByReview } from "@/lib/reviewOrder";
import {
  CARD_FILTERS,
  answerText,
  auditorAnswerOf,
  filterCounts,
  filterItems,
  focusView,
  hrProposalPayload,
  hrProposalProblems,
  hrProposalText,
  mdAnswerOf,
  mdDiffers,
  mdRemarkOf,
  outcomeOf,
  parseFocus,
  pendingGroupLabel,
  remarksOf,
  requestColumns,
  requestFigures,
  requestsShown,
  reviewStateOf,
  reworkFlag,
  reworkProgress,
  skippedText,
  standingOf,
  trailOf,
} from "./focus";
import { batchAt, item, trackerFor, withAuditor } from "./test-fixtures";
import { trackerWhere } from "./Tracker";

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
    const from = (type: "general" | "term", actions = false) =>
      Object.fromEntries(
        requestColumns(type, { select: actions, actions })
          .filter((c) => c.from)
          .map((c) => [c.key, c.from]),
      );
    expect(from("general")).toEqual({ fixedSalary: "2xl", workingDays: "2xl", earned: "xl", remarks: "wide" });
    expect(from("term")).toEqual({ fixedSalary: "2xl", months: "xl", emi: "xl", firstEmi: "2xl", remarks: "wide" });
    // with the row actions (up to five icons since Rework) the xl ones wait for 1400 px
    expect(from("general", true)).toEqual({ fixedSalary: "2xl", workingDays: "2xl", earned: "xl2", remarks: "wide" });
    expect(from("term", true)).toMatchObject({ months: "xl2", emi: "xl2", firstEmi: "2xl" });
  });

  it("a Salary Advance with the rounding: the Rounded column after the limit, from a full-HD screen (2026-11-27)", () => {
    const sa = requestColumns("general", { select: true, actions: true, rounding: true });
    expect(sa.map((c) => c.key).slice(5, 9)).toEqual(["requested", "limit", "rounded", "approved"]);
    expect(sa.find((c) => c.key === "rounded")).toMatchObject({ header: "Rounded", align: "right", from: "full" });
    // a Term Loan is never rounded; an older batch (no rounding) has no column
    expect(requestColumns("term", { select: true, actions: true, rounding: true }).map((c) => c.key)).not.toContain(
      "rounded",
    );
    expect(requestColumns("general", { select: true, actions: true }).map((c) => c.key)).not.toContain("rounded");
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
    // a Salary Advance: below its rounded amount (2026-11-27; Asha's ₹8,000 is already a whole ₹500 within her limit)
    expect(hrProposalProblems(asha, { action: "reduce", amount: "8000", remark: "Limit" }).amount).toBe(
      "A reduced amount must be less than the rounded ₹8,000.",
    );
    // an older batch (no rounding): below the amount asked for
    const older = { ...asha, rounding: undefined, baseAmount: undefined };
    expect(hrProposalProblems(older, { action: "reduce", amount: "8000", remark: "Limit" }).amount).toBe(
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

  it("a rounded Salary Advance: the ceiling is the rounded amount, not what was asked (2026-11-27)", () => {
    // ₹15,000 asked, ₹11,560 limit -> ₹11,500
    const capped = item(4, {
      rounding: true,
      advance: { amount: 15000, requestedAmount: 15000, earnings: { ...asha.advance.earnings!, limit: 11560 } },
    });
    expect(capped.baseAmount).toBe(11500);
    expect(hrProposalProblems(capped, { action: "reduce", amount: "11500", remark: "Limit" }).amount).toBe(
      "A reduced amount must be less than the rounded ₹11,500.",
    );
    expect(hrProposalProblems(capped, { action: "reduce", amount: "11000", remark: "Limit" })).toEqual({});
    // ₹4,800 asked rounds UP to ₹5,000: ₹4,900 is a reduction (below the rounded amount, above the ask)
    const up = item(5, { rounding: true, advance: { amount: 4800, requestedAmount: 4800 } });
    expect(up.baseAmount).toBe(5000);
    expect(hrProposalProblems(up, { action: "reduce", amount: "4900", remark: "Limit" })).toEqual({});
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

// ───────────────────── re-approval cycles (owner 2026-11-27) ─────────────────────

describe("where a request stands with the stage's reviewer (service.review_state)", () => {
  it("takes the server's review, else works it out per stage the same way", () => {
    expect(reviewStateOf(item(1, { review: "rejected" }), "hr_review")).toBe("rejected");
    // HR Review: not reviewed = waiting; kept as asked / reduced = approved; rejected
    expect(reviewStateOf(item(1), "hr_review")).toBe("pending");
    expect(reviewStateOf(item(1, { hr: { action: "approve" } }), "hr_review")).toBe("approved");
    expect(reviewStateOf(item(1, { hr: { action: "reduce", amount: 6000 } }), "hr_review")).toBe("approved");
    expect(reviewStateOf(item(1, { hr: { action: "reject" } }), "hr_review")).toBe("rejected");
    // MD Review: HR's pre-filled proposal waits for the MD's own click
    expect(reviewStateOf(item(1, { md: { decision: "rejected", fromHr: true } }), "md_review")).toBe("pending");
    expect(reviewStateOf(item(1, { md: { decision: "rejected", decidedAt: "x" } }), "md_review")).toBe("rejected");
    // HR Rework (MD Changes): a flag waits; answered = HR's proposal
    const mdc = batchAt("md_changes");
    expect(mdc.items.map((i) => reviewStateOf(i, "md_changes"))).toEqual(["approved", "pending", "pending"]);
    // HR Final Settlement / HR Rework (Auditor Changes): no final decision, or a flag, waits
    const fin = batchAt("hr_final");
    expect(fin.items.map((i) => reviewStateOf(i, "hr_final"))).toEqual(["approved", "approved", "rejected"]);
    expect(reviewStateOf({ ...fin.items[0], rework: "auditor" }, "auditor_changes")).toBe("pending");
    // Auditor Review: waiting until the auditor answers it
    const aud = batchAt("auditor_review");
    expect(reviewStateOf(aud.items[0], "auditor_review")).toBe("pending");
    expect(reviewStateOf(withAuditor(aud.items[0], { action: "approve" }), "auditor_review")).toBe("approved");
    expect(reviewStateOf(aud.items[2], "auditor_review")).toBe("rejected");
  });

  it("orders a list waiting first, then approved, then rejected, keeping each group's own order", () => {
    const b = batchAt("hr_review");
    b.items[0] = { ...b.items[0], review: "rejected" };
    b.items[1] = { ...b.items[1], review: "approved" };
    expect(ids(sortByReview(b.items, (i) => reviewStateOf(i, b.stage)))).toEqual([3, 2, 1]);
  });

  it("names the waiting group by who it waits for", () => {
    expect(pendingGroupLabel("hr_review")).toBe("Waiting for your review");
    expect(pendingGroupLabel("md_changes")).toBe("Waiting for your answer to the MD");
    expect(pendingGroupLabel("hr_final")).toBe("Waiting for your final decision");
    expect(pendingGroupLabel("auditor_changes")).toBe("Waiting for your answer to the auditor");
    expect(pendingGroupLabel("md_review")).toBe("Waiting for the MD");
  });

  it("at HR Review a request HR has not looked at is not reviewed yet; later it went as asked", () => {
    expect(hrProposalText(item(1), "hr_review")).toBe("Not reviewed yet");
    expect(hrProposalText(item(1, { hr: { action: "approve" } }), "hr_review")).toBe("Keep as asked");
    expect(hrProposalText(item(1), "md_review")).toBe("Keep as asked");
    expect(trailOf(item(1), batchAt("hr_review"))[0]).toMatchObject({ text: "Not reviewed yet", tone: "warning" });
  });
});

describe("HR's answers to the MD and the auditor", () => {
  it("the MD's change and the MD's own remark, as the server says them", () => {
    const [asha, ravi, meena] = batchAt("md_changes").items;
    expect(mdDiffers(ravi)).toBe(true);
    expect(mdDiffers(asha)).toBe(false); // the MD approved what HR kept as asked
    expect(mdRemarkOf(meena)).toBe("Too many leaves");
    // an older server: worked out from the decisions; HR's remark carried over is not the MD's
    const older = item(1, {
      hrNote: "Limit",
      hr: { action: "reduce", amount: 6000 },
      md: { decision: "approved", amount: 5000, remark: "Limit", decidedAt: "x" },
    });
    expect(mdDiffers(older)).toBe(true);
    expect(mdRemarkOf(older)).toBe("");
    expect(mdDiffers({ ...older, md: { ...older.md, amount: 6000 } })).toBe(false);
  });

  it("the flag on a row, the answer given, and how many still wait", () => {
    const b = batchAt("md_changes");
    expect(reworkFlag(b.items[1], "md_changes")).toEqual({ text: "MD changed this", tone: "caution" });
    expect(reworkFlag(b.items[0], "md_changes")).toBeNull();
    expect(reworkFlag({ ...b.items[0], rework: "md" }, "md_changes")).toEqual({ text: "Reopened", tone: "accent" });
    expect(reworkFlag({ ...b.items[1], mdChanged: false }, "md_changes")).toEqual({
      text: "MD's remark",
      tone: "info",
    });
    expect(mdAnswerOf(b.items[1])).toBe("waiting");
    // answered: kept (still differs from the MD) or accepted (the MD's decision is HR's now)
    expect(mdAnswerOf({ ...b.items[1], rework: null })).toBe("kept");
    expect(mdAnswerOf({ ...b.items[2], rework: null, mdChanged: false })).toBe("accepted");
    expect(answerText("kept", "md")).toBe("You kept your proposal");
    expect(reworkProgress(b)).toEqual({ waiting: 2, flagged: 2 });

    const a = batchAt("auditor_changes");
    const cut = {
      ...withAuditor(a.items[0], { action: "reduce", amount: 5000, remark: "Two absent days" }),
      rework: "auditor" as const,
    };
    expect(reworkFlag(cut, "auditor_changes")).toEqual({ text: "Auditor changed this", tone: "caution" });
    expect(auditorAnswerOf(cut)).toBe("waiting");
    expect(auditorAnswerOf({ ...cut, rework: null })).toBe("kept"); // HR's final is still 6,000
    const accepted = { ...cut, rework: null, final: { ...cut.final, amount: 5000 } };
    expect(auditorAnswerOf(accepted)).toBe("accepted");
    expect(answerText("accepted", "auditor")).toBe("You accepted the auditor's change");
  });

  it("in a rework stage the row's amount is what HR sends back, not the reviewer's", () => {
    const [, ravi] = batchAt("md_changes").items;
    expect(standingOf(ravi, "md_changes")).toMatchObject({
      decision: "approved",
      amount: 30000,
      label: "HR's proposal",
      source: "asked",
    });
    expect(standingOf(ravi)).toMatchObject({ amount: 25000, source: "md" });
    const cut = withAuditor(batchAt("auditor_changes").items[0], { action: "reduce", amount: 5000 });
    expect(standingOf(cut, "auditor_changes")).toMatchObject({ amount: 6000, label: "HR's final" });
    expect(standingOf(cut)).toMatchObject({ amount: 5000, label: "after the audit" });
    // the auditor's line says what is paid only once it is the settlement, not while HR answers
    expect(trailOf(cut, batchAt("auditor_changes")).find((t) => t.step === "auditor")?.note).toBeUndefined();
    expect(trailOf(cut, batchAt("accounts_send")).find((t) => t.step === "auditor")?.note).toBe("pays ₹5,000");
  });

  it("a click on a rework stage lists the requests the reviewer flagged, or says why there are none", () => {
    expect(parseFocus("md_changes")).toBe("md_changes");
    const mdc = focusView(batchAt("md_changes"), "md_changes");
    expect(mdc).toMatchObject({ kind: "md_changes" });
    expect(ids(mdc.items)).toEqual([2, 3]);
    expect(focusView(batchAt("hr_final"), "md_changes")).toMatchObject({
      items: [],
      empty: "The MD approved it without returning it to HR: no rework was needed.",
    });
    expect(focusView(batchAt("md_review"), "md_changes").empty).toBe("The MD has not returned this batch to HR.");
    const aud = batchAt("auditor_changes");
    aud.items[0] = { ...withAuditor(aud.items[0], { action: "reject", remark: "No" }), rework: "auditor" };
    expect(ids(focusView(aud, "auditor_changes").items)).toEqual([1]);
    expect(focusView(aud, "auditor_changes").title).toBe(
      "HR Rework (Auditor Changes): the requests the auditor flagged",
    );
    expect(focusView(batchAt("accounts_send"), "auditor_changes").empty).toBe(
      "The auditor approved it without returning it to HR: no rework was needed.",
    );
  });
});

describe("the tracker at a glance (the Overview)", () => {
  it("counts the eight steps, not the rework loops, and says when HR reworks or which round it is", () => {
    expect(trackerWhere(trackerFor("hr_final"))).toBe("Step 4 of 8 · HR Final Settlement");
    expect(trackerWhere(trackerFor("md_changes", "x", { mdCycles: 1 }))).toBe(
      "Rework after step 3 of 8 · HR Rework (MD Changes)",
    );
    expect(trackerWhere(trackerFor("md_review", "x", { mdCycles: 1, mdRound: 2 }))).toBe(
      "Step 3 of 8 · MD Review & Approval · round 2",
    );
    expect(trackerWhere(trackerFor("completed", "", { mdCycles: 1, auditorCycles: 1 }))).toBe(
      "All 8 steps done · 2 rework cycles",
    );
    expect(trackerWhere([])).toBe("Not started");
  });
});
