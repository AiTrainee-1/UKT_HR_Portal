import { describe, expect, it } from "vitest";
import { historyLabel } from "@/components/settlement-flow/WorkflowFlow";
import { advance, batch, fourItems, item, leave } from "./fixtures";
import {
  bulkResultText,
  changesReason,
  hrExpected,
  lastHistory,
  mdChangedOf,
  mdRoundOf,
  pendingLabel,
  RETURN_NOTE_MESSAGE,
  returnState,
  reviewOf,
  sentBackToHr,
  trailLine,
  confirmHrBody,
  eligibleLimit,
  hrProposal,
  requestStatus,
  toggleAll,
  batchOptionLabel,
  batchesText,
  batchTitle,
  defaultType,
  confirmState,
  daysText,
  decisionKind,
  decisionText,
  draftBody,
  draftFor,
  draftProblems,
  filterCounts,
  filterItems,
  filterOptions,
  hasProblems,
  historyFacts,
  istDate,
  istDateTime,
  istMonthKey,
  leaveChip,
  monthFromQuery,
  money,
  overLimit,
  parseAmount,
  pickBatch,
  REDUCE_REMARK_MESSAGE,
  REJECT_MESSAGE,
  reviewGroups,
  reviewSummary,
  termText,
  typeFromQuery,
  typeOptions,
  viewFromQuery,
  waitingElsewhere,
  waitingInMonth,
  waitingSentence,
} from "./logic";
import type { SettlementItem } from "./types";

const decided = (it: SettlementItem, decision: "approved" | "rejected" | null, amount: number | null, remark = "") => ({
  ...it,
  md: { decision, amount, remark, decidedAt: decision ? "2026-11-26T05:00:00+00:00" : null },
});

describe("India's clock", () => {
  it("opens on this month in India, whatever the computer's time zone", () => {
    // 31 Oct 2026, 20:00 UTC is already 1 Nov 01:30 in India
    expect(istMonthKey(new Date(Date.UTC(2026, 9, 31, 20, 0)))).toBe("2026-11");
    expect(istMonthKey(new Date(Date.UTC(2026, 9, 31, 18, 0)))).toBe("2026-10");
  });

  it("takes a month from the address only when it is real and not in the future", () => {
    expect(monthFromQuery("2026-10", "2026-11")).toBe("2026-10");
    expect(monthFromQuery("2026-12", "2026-11")).toBeNull();
    expect(monthFromQuery("2026-13", "2026-11")).toBeNull();
    expect(monthFromQuery("oct", "2026-11")).toBeNull();
    expect(monthFromQuery(null, "2026-11")).toBeNull();
  });

  it("shows server moments in India's time", () => {
    expect(istDateTime("2026-11-26T09:12:33.123456+00:00")).toBe("26 Nov 2026, 2:42 pm");
    expect(istDateTime("2026-11-25T19:00:00+00:00")).toBe("26 Nov 2026, 12:30 am");
    expect(istDate("2026-11-20T20:00:00+00:00")).toBe("21 Nov 2026");
    expect(istDateTime(null)).toBe("");
    expect(istDate("not a date")).toBe("");
  });
});

describe("the decision rules", () => {
  const anita = fourItems()[0]; // asked ₹10,000

  it("approves the full amount with no remark and sends no amount (the server takes the amount asked)", () => {
    const draft = { mode: "approve" as const, amount: "", remark: "" };
    expect(draftProblems(draft, 10000)).toEqual({});
    expect(draftBody(draft)).toEqual({ decision: "approved" });
    expect(draftBody({ ...draft, remark: "  good   record " })).toEqual({
      decision: "approved",
      remark: "good record",
    });
  });

  it("reduces only to less than the amount asked, and only with a remark", () => {
    const base = { mode: "reduce" as const, amount: "6000", remark: "Half now" };
    expect(draftProblems(base, 10000)).toEqual({});
    expect(draftBody(base)).toEqual({ decision: "approved", amount: 6000, remark: "Half now" });
    // the amount asked or more is not a reduction
    expect(draftProblems({ ...base, amount: "10000" }, 10000).amount).toMatch(/less than the ₹10,000 asked for/);
    expect(draftProblems({ ...base, amount: "12,000" }, 10000).amount).toMatch(/less than/);
    // no remark, or one too short
    expect(draftProblems({ ...base, remark: "" }, 10000).remark).toBe(REDUCE_REMARK_MESSAGE);
    expect(draftProblems({ ...base, remark: "  ok " }, 10000).remark).toBe(REDUCE_REMARK_MESSAGE);
    // both wrong at once: both are said
    expect(hasProblems(draftProblems({ mode: "reduce", amount: "", remark: "" }, 10000))).toBe(true);
    expect(draftProblems({ mode: "reduce", amount: "", remark: "" }, 10000)).toEqual({
      amount: "Enter the reduced amount.",
      remark: REDUCE_REMARK_MESSAGE,
    });
  });

  it("reads amounts as people type them, refusing nonsense, zero and paise beyond two places", () => {
    expect(parseAmount("6,000").value).toBe(6000);
    expect(parseAmount("₹ 6,000.50").value).toBe(6000.5);
    expect(parseAmount("0").problem).toMatch(/more than ₹0/);
    expect(parseAmount("12.345").problem).toMatch(/2 decimal places/);
    expect(parseAmount("abc").problem).toMatch(/in rupees/);
    expect(parseAmount("-5").problem).toMatch(/in rupees/);
  });

  it("rejects only with a reason", () => {
    expect(draftProblems({ mode: "reject", amount: "", remark: "" }, 10000)).toEqual({ remark: REJECT_MESSAGE });
    expect(draftProblems({ mode: "reject", amount: "", remark: "no" }, 10000)).toEqual({ remark: REJECT_MESSAGE });
    expect(draftProblems({ mode: "reject", amount: "999999", remark: "Too many advances" }, 10000)).toEqual({});
    expect(draftBody({ mode: "reject", amount: "5", remark: " Too many advances " })).toEqual({
      decision: "rejected",
      remark: "Too many advances",
    });
  });

  it("opens the form on the request's own decision, with its amount and remark", () => {
    expect(draftFor(anita)).toEqual({ mode: "approve", amount: "", remark: "" });
    expect(draftFor(anita, "reject").mode).toBe("reject");
    expect(draftFor(decided(anita, "approved", 6000, "Half now"))).toEqual({
      mode: "reduce",
      amount: "6000",
      remark: "Half now",
    });
    expect(draftFor(decided(anita, "rejected", null, "Not now"))).toEqual({
      mode: "reject",
      amount: "",
      remark: "Not now",
    });
  });

  it("tells a full approval from a reduced one", () => {
    expect(decisionKind(anita)).toBe("undecided");
    expect(decisionKind(decided(anita, "approved", 10000))).toBe("approved");
    expect(decisionKind(decided(anita, "approved", null))).toBe("approved");
    expect(decisionKind(decided(anita, "approved", 9999.99, "x"))).toBe("reduced");
    expect(decisionKind(decided(anita, "rejected", null, "x"))).toBe("rejected");
    expect(decisionText("reduced", 10000, 6000)).toBe("Reduced ₹10,000 → ₹6,000");
    expect(decisionText("approved", 10000, null)).toBe("Approved ₹10,000");
    expect(money(6000.5)).toBe("₹6,000.50");
  });
});

describe("the review before Confirm & Proceed", () => {
  // Anita approved in full (10,000), Bala reduced 8,000 -> 5,000, Chitra rejected (50,000), Dinesh open (5,000); Bala's
  // and Chitra's are HR's proposals confirmed by the MD (no change from HR)
  const [a, b, c, d] = fourItems();
  const items = [
    decided(a, "approved", 10000),
    {
      ...decided(b, "approved", 5000, "Only the limit"),
      hr: { action: "reduce" as const, amount: 5000, remark: "Only the limit" },
    },
    {
      ...decided(c, "rejected", null, "Too many leaves"),
      hr: { action: "reject" as const, amount: null, remark: "Too many leaves" },
    },
    d,
  ];

  it("counts every decision and adds up the amounts", () => {
    const s = reviewSummary(items);
    expect(s).toMatchObject({
      total: 4,
      decided: 3,
      undecided: 1,
      approved: 1,
      reduced: 1,
      rejected: 1,
      requestedTotal: 73000,
      approvedTotal: 15000,
      reducedBy: 3000,
      rejectedTotal: 50000,
      undecidedIds: [14],
    });
    expect(s.rows.find((r) => r.id === 12)).toMatchObject({
      kind: "reduced",
      requested: 8000,
      approved: 5000,
      remark: "Only the limit",
    });
    expect(s.rows.find((r) => r.id === 13)).toMatchObject({ kind: "rejected", approved: null, typeLabel: "Term Loan" });
  });

  it("adds paise without floating-point dust", () => {
    const s = reviewSummary([
      decided(item(1, advance(1, { requestedAmount: 0.1 })), "approved", 0.1),
      decided(item(2, advance(2, { requestedAmount: 0.2 })), "approved", 0.2),
    ]);
    expect(s.approvedTotal).toBe(0.3);
    expect(s.requestedTotal).toBe(0.3);
  });

  it("lists what still needs a decision first, then reductions, rejections and full approvals", () => {
    expect(reviewGroups(reviewSummary(items)).map((g) => [g.kind, g.rows.map((r) => r.id)])).toEqual([
      ["undecided", [14]],
      ["reduced", [12]],
      ["rejected", [13]],
      ["approved", [11]],
    ]);
  });

  it("allows Confirm & Proceed only at MD Review with every request decided", () => {
    const open = batch({ items });
    expect(confirmState(open, reviewSummary(open.items))).toEqual({
      enabled: false,
      reason: "Decide every request first: 1 request still needs your decision.",
    });
    const all = batch({ items: [...items.slice(0, 3), decided(d, "approved", 5000)] });
    expect(all.actions.canConfirmMd).toBe(true);
    expect(confirmState(all, reviewSummary(all.items))).toEqual({ enabled: true, reason: null });
    // the server not agreeing yet (canConfirmMd off) keeps it off
    expect(
      confirmState({ ...all, actions: { canDecideMd: true, canConfirmMd: false } }, reviewSummary(all.items)).enabled,
    ).toBe(false);
    // once sent back to HR there is nothing to confirm
    const sent = batch({ items: all.items, stage: "hr_final" });
    expect(confirmState(sent, reviewSummary(sent.items))).toEqual({
      enabled: false,
      reason: "This batch is no longer waiting for your decision.",
    });
    const empty = batch({ items: [] });
    expect(confirmState(empty, reviewSummary([])).enabled).toBe(false);
  });

  it("never approves a settlement the MD changed from HR's proposals: it goes back to HR first", () => {
    // Bala: HR proposed 5,000, the MD set 4,000; Chitra: HR proposed reject, the MD approved it in full
    const changed = [
      items[0],
      { ...items[1], md: { ...items[1].md, amount: 4000 } },
      { ...items[2], md: { decision: "approved" as const, amount: 50000, remark: "", decidedAt: "2026-11-26" } },
      decided(d, "approved", 5000),
    ];
    const b2 = batch({ items: changed });
    expect(b2.counts.mdChanges).toBe(2);
    expect(b2.actions.canConfirmMd).toBe(false);
    const s = reviewSummary(b2.items);
    expect(s).toMatchObject({ changed: 2, changedIds: [12, 13], undecided: 0 });
    expect(s.rows.filter((r) => r.changed).map((r) => r.id)).toEqual([12, 13]);
    expect(confirmState(b2, s)).toEqual({
      enabled: false,
      reason:
        "You changed 2 requests from HR's proposal — return the settlement to HR; you approve it once HR resubmits.",
    });
    // the change outranks the open requests: approving is off either way
    expect(
      confirmState(batch({ items: [...changed.slice(0, 3), d] }), reviewSummary([...changed.slice(0, 3), d])).reason,
    ).toBe(changesReason(2));
    // a pre-filled proposal not yet confirmed is no change; the server's own flag wins when it sends one
    expect(mdChangedOf({ ...items[1], md: { ...items[1].md, amount: 4000, decidedAt: null, fromHr: true } })).toBe(
      false,
    );
    expect(mdChangedOf({ ...items[0], mdChanged: true })).toBe(true);
    expect(hrExpected(a)).toEqual({ decision: "approved", amount: 10000 });
  });

  it("asks for instructions on a return only when nothing changed and nothing was remarked", () => {
    expect(returnState({ changed: 1, remarked: 0 }, "")).toEqual({ noteRequired: false, problem: null });
    expect(returnState({ changed: 0, remarked: 1 }, "")).toEqual({ noteRequired: false, problem: null });
    expect(returnState({ changed: 0, remarked: 0 }, "  ok ")).toEqual({
      noteRequired: true,
      problem: RETURN_NOTE_MESSAGE,
    });
    expect(returnState({ changed: 0, remarked: 0 }, "Check Bala's leave")).toEqual({
      noteRequired: true,
      problem: null,
    });
  });
});

describe("rework and re-approval", () => {
  const [a, b, c, d] = fourItems();

  it("puts the requests waiting for the MD first, then approved, then rejected - a reworked one waits again", () => {
    const fromHr = {
      ...b,
      md: { decision: "approved" as const, amount: 6000, remark: "Limit", decidedAt: null, fromHr: true },
    };
    expect(reviewOf(a, "md_review")).toBe("pending");
    expect(reviewOf(fromHr, "md_review")).toBe("pending"); // HR's proposal still to confirm
    expect(reviewOf(decided(a, "approved", 10000), "md_review")).toBe("approved");
    expect(reviewOf(decided(c, "rejected", null, "No"), "md_review")).toBe("rejected");
    expect(reviewOf({ ...decided(c, "rejected", null, "No"), review: "pending" as const }, "md_review")).toBe(
      "pending",
    );
    expect(reviewOf({ ...d, rework: "md" as const }, "md_changes")).toBe("pending");
    expect(pendingLabel("md_review")).toBe("Waiting for your decision");
    expect(pendingLabel("md_changes")).toBe("Waiting for HR's answer");
    expect(pendingLabel("completed")).toBe("Waiting");
  });

  it("says, in round 2, what the MD set in round 1 and what HR answers now", () => {
    const trail = [
      { at: "", by: "Priya (HR)", role: "hr" as const, round: 1, action: "reduce", amount: 6000, remark: "Limit" },
      { at: "", by: "MD", role: "md" as const, round: 1, action: "approved", amount: 3000, remark: "Too much leave" },
    ];
    // HR now proposes 4,000 (changed its proposal)
    const revised = { ...b, trail, hr: { action: "reduce" as const, amount: 4000, remark: "Met halfway" } };
    expect(trailLine(revised, 2)).toEqual({
      round: 1,
      you: "Round 1: you set ₹3,000",
      hr: "HR now proposes ₹4,000",
      detail: ["Round 1: HR proposed ₹6,000 (“Limit”) · you set ₹3,000 (“Too much leave”)"],
    });
    // HR took the MD's amount
    expect(trailLine({ ...revised, hr: { action: "reduce", amount: 3000, remark: "" } }, 2)?.hr).toBe("HR accepted it");
    // a rejection, and HR standing by its full approval
    const rejected = {
      ...c,
      trail: [{ ...trail[1], action: "rejected", amount: null, remark: "No" }],
      hr: { action: "approve" as const, amount: null, remark: "" },
    };
    expect(trailLine(rejected, 2)).toMatchObject({ you: "Round 1: you rejected it", hr: "HR now proposes ₹50,000" });
    // the round being reworked right now (HR Rework, round 1) has no earlier round yet
    expect(trailLine(revised, 1)).toBeNull();
    expect(trailLine(a, 3)).toBeNull();
  });

  it("reads the round, the latest return and where HR Rework stands", () => {
    expect(mdRoundOf(batch())).toBe(1);
    expect(mdRoundOf(batch({ mdRound: 3 }))).toBe(3);
    const h = batch({
      history: [
        { at: "1", by: "MD", action: "md_returned", note: "first", round: 1 },
        { at: "2", by: "HR", action: "md_resubmitted", note: "", round: 2 },
        { at: "3", by: "MD", action: "md_returned", note: "second", round: 2 },
      ],
    });
    expect(lastHistory(h, "md_returned")?.note).toBe("second");
    expect(lastHistory(h, "auditor_sent")).toBeNull();
    expect(sentBackToHr("md_changes")).toBe(false);
    expect(sentBackToHr("hr_final")).toBe(true);
    expect(requestStatus({ ...a, rework: "md" as const }, "md_changes")).toEqual({
      text: "Returned to HR",
      tone: "sand",
    });
    expect(requestStatus(a, "md_changes").text).toBe("No change asked");
  });
});

describe("the leave check chip", () => {
  it("says orange 'Leave warning' at exactly 3 days and red 'Frequent leave' above, in words, not colour alone", () => {
    expect(leaveChip(leave(3, "warning"))).toEqual({
      tone: "warning",
      label: "Leave warning · 3 days",
      detail: "Leave warning: 3 days absent or on leave between the 1st and the 20th of Nov 2026 (exactly 3 days).",
    });
    expect(leaveChip(leave(4.5, "critical"))).toMatchObject({
      tone: "critical",
      label: "Frequent leave · 4.5 days",
    });
    expect(leaveChip(leave(4.5, "critical")).detail).toContain("(more than 3 days)");
    expect(leaveChip(leave(1, "ok"))).toMatchObject({ tone: "ok", label: "Leave · 1 day" });
    expect(leaveChip(leave(0, "ok")).label).toBe("Leave · 0 days");
    expect(leaveChip(null)).toMatchObject({ tone: "unknown", label: "Leave not checked" });
  });

  it("works the flag out from the days when the server sent none", () => {
    expect(leaveChip(leave(3, null)).tone).toBe("warning");
    expect(leaveChip(leave(3.5, null)).tone).toBe("critical");
    expect(leaveChip(leave(2.5, null)).tone).toBe("ok");
    expect(daysText(2.5)).toBe("2.5 days");
  });
});

describe("the list", () => {
  const items = fourItems();

  it("filters by what is left to decide and by leave alerts, and searches names, codes and departments", () => {
    const withOne = [decided(items[0], "approved", 10000), ...items.slice(1)];
    expect(filterCounts(withOne)).toEqual({ all: 4, undecided: 3, decided: 1, leave: 2 });
    expect(filterItems(withOne, "leave", "").map((i) => i.id)).toEqual([12, 13]);
    expect(filterItems(withOne, "decided", "").map((i) => i.id)).toEqual([11]);
    expect(filterItems(withOne, "all", "chitra").map((i) => i.id)).toEqual([13]);
    expect(filterItems(withOne, "all", "1004").map((i) => i.id)).toEqual([14]);
    expect(filterItems(withOne, "undecided", "stitching")).toHaveLength(3);
  });

  it("marks a request above its limit (a Term Loan only against its own Term Loan limit)", () => {
    expect(overLimit(items[1])).toBe(true); // 8,000 asked, limit 6,000
    expect(overLimit(items[0])).toBe(false); // 10,000 asked, limit 10,200
    expect(overLimit({ ...items[2], requestedAmount: 999999 })).toBe(false);
  });

  it("writes a Term Loan's plan in a line", () => {
    expect(termText(items[2].advance)).toBe("Over 10 months · EMI ₹5,000 · from Dec 2026");
    expect(termText(items[0].advance)).toBeNull();
  });

  it("shows the batch asked for, else the one waiting for the MD, else the latest", () => {
    const one = batch({ id: 1, stage: "hr_final" });
    const two = batch({ id: 2, number: 2, stage: "md_review" });
    const three = batch({ id: 3, number: 3, stage: "completed" });
    expect(pickBatch([one, two, three], 3)?.id).toBe(3);
    expect(pickBatch([one, two, three], 99)?.id).toBe(2);
    expect(pickBatch([one, three], null)?.id).toBe(3);
    expect(pickBatch([], null)).toBeUndefined();
  });
});

describe("Salary Advance and Term Loan, and what waits elsewhere", () => {
  const b = (id: number, month: number, number: number, requests: number, advanceType: "general" | "term") => ({
    id,
    advanceType,
    month,
    year: 2026,
    number,
    requests,
    forwardedAt: null,
    forwardedBy: null,
  });
  const waiting = {
    method: "automation" as const,
    count: 12,
    byType: { general: 5, term: 7 },
    batches: [
      b(7, 10, 2, 3, "general"),
      b(5, 10, 1, 1, "general"),
      b(8, 10, 1, 2, "term"),
      b(9, 11, 1, 4, "term"),
      b(3, 9, 1, 1, "general"),
      b(4, 9, 1, 1, "term"),
    ],
  };

  it("reads the type from the address, in the MD's or the HRMS's words", () => {
    expect(typeFromQuery("general")).toBe("general");
    expect(typeFromQuery("salary-advance")).toBe("general");
    expect(typeFromQuery("TERM")).toBe("term");
    expect(typeFromQuery("term-loan")).toBe("term");
    expect(typeFromQuery("loan")).toBeNull();
    expect(typeFromQuery(null)).toBeNull();
  });

  it("opens on the type waiting in the month, else the one waiting anywhere, else Salary Advance", () => {
    expect(defaultType(waiting, "2026-11")).toBe("term"); // November: only a Term Loan batch waits
    expect(defaultType(waiting, "2026-10")).toBe("general"); // both wait in October: Salary Advance first
    expect(defaultType(waiting, "2026-08")).toBe("general"); // nothing in August: Salary Advance waits somewhere
    expect(defaultType({ ...waiting, byType: { general: 0, term: 7 } }, "2026-08")).toBe("term");
    expect(defaultType(undefined, "2026-11")).toBe("general");
  });

  it("counts each type's waiting requests of a month for the Type dropdown", () => {
    expect(waitingInMonth(waiting, "2026-10")).toEqual({ general: 4, term: 2 });
    expect(typeOptions(waitingInMonth(waiting, "2026-10"))).toEqual([
      { value: "general", label: "Salary Advance · 4 waiting" },
      { value: "term", label: "Term Loan · 2 waiting" },
    ]);
    expect(typeOptions({ general: 0, term: 0 }).map((o) => o.label)).toEqual(["Salary Advance", "Term Loan"]);
  });

  it("names a batch with its type", () => {
    expect(batchTitle({ title: "Term Loan · Batch 2", label: "Batch 2" })).toBe("Term Loan · Batch 2");
    expect(batchTitle({ advanceType: "term", label: "Batch 2" })).toBe("Term Loan · Batch 2");
    expect(batchTitle({ label: "Batch 2" })).toBe("Batch 2");
  });

  it("groups what waits elsewhere by month and type, leaving out the month and type on screen, oldest first", () => {
    const groups = waitingElsewhere(waiting, "2026-11", "term");
    expect(groups.map((w) => [w.key, w.type, w.requests, w.batches, w.firstBatchId])).toEqual([
      ["2026-09", "general", 1, [1], 3],
      ["2026-09", "term", 1, [1], 4],
      ["2026-10", "general", 4, [1, 2], 5],
      ["2026-10", "term", 2, [1], 8],
    ]);
    expect(waitingSentence(groups[1])).toBe("Term Loan · Batch 1 waiting in September 2026 (1 request)");
    expect(waitingSentence(groups[2])).toBe("Salary Advance · Batches 1 and 2 waiting in October 2026 (4 requests)");
    // the other type of the month on screen is named too
    expect(waitingElsewhere(waiting, "2026-10", "general").map((w) => `${w.key} ${w.type}`)).toEqual([
      "2026-09 general",
      "2026-09 term",
      "2026-10 term",
      "2026-11 term",
    ]);
    expect(waitingElsewhere(undefined, "2026-11", "general")).toEqual([]);
    expect(batchesText([1, 2, 3])).toBe("Batches 1, 2 and 3");
  });
});

describe("the tabs, the dropdowns and the history", () => {
  it("opens on Requests unless the address asks for another tab", () => {
    expect(viewFromQuery(null)).toBe("requests");
    expect(viewFromQuery("overview")).toBe("overview");
    expect(viewFromQuery("history")).toBe("history");
    expect(viewFromQuery("files")).toBe("requests");
  });

  it("writes a batch's dropdown line and the filter's choices with their counts", () => {
    expect(batchOptionLabel(batch())).toBe("Batch 1 · Waiting for you · 4 requests");
    expect(
      batchOptionLabel(batch({ stage: "hr_final", stageLabel: "HR Final Settlement", items: fourItems().slice(0, 1) })),
    ).toBe("Batch 1 · HR Final Settlement · 1 request");
    expect(filterOptions(fourItems()).map((o) => o.label)).toEqual([
      "All requests (4)",
      "To decide (4)",
      "Decided (0)",
      "Leave alerts (2)",
    ]);
  });

  it("says what each history step was (the shared tracker's words), with its figures", () => {
    const forwarded = { at: "", by: "Priya (HR)", action: "forwarded", count: 4 };
    expect(historyLabel(forwarded).text).toBe("HR forwarded it to the MD");
    expect(historyFacts(forwarded)).toBe("4 requests");
    expect(historyFacts({ at: "", by: "", action: "finalized", approved: 3, rejected: 1, total: 23000 })).toBe(
      "3 approved · 1 rejected · ₹23,000",
    );
    const back = { at: "", by: "MD", action: "md_returned", round: 1, changes: 2, remarks: 1 };
    expect(historyLabel(back)).toEqual({ text: "MD returned it to HR for rework (round 1)", tone: "rework" });
    expect(historyFacts(back)).toBe("2 changed · 1 with your remark");
    expect(historyFacts({ at: "", by: "HR", action: "md_resubmitted", round: 2, count: 1 })).toBe(
      "1 request to look at again",
    );
    expect(historyFacts({ at: "", by: "", action: "something_new" })).toBe("");
  });
});

describe("round 5: HR's proposal, the eligible limit, the status and bulk decisions", () => {
  const [a, b, c] = fourItems();

  it("shows what HR proposed, with HR's remark", () => {
    expect(hrProposal({ ...b, hr: { action: "reduce", amount: 6000, remark: "Only the limit" } })).toEqual({
      kind: "reduce",
      text: "HR proposes ₹6,000",
      remark: "Only the limit",
    });
    expect(hrProposal({ ...c, hr: { action: "reject", amount: null, remark: "Too much leave" } }).text).toBe(
      "HR proposes reject",
    );
    expect(hrProposal({ ...a, hr: { action: null, amount: null, remark: "Regular attendance" } })).toEqual({
      kind: "none",
      text: "No change proposed",
      remark: "Regular attendance",
    });
  });

  it("gives the eligible limit of each type with how it was worked out", () => {
    expect(eligibleLimit(a)).toEqual({
      amount: 10200,
      label: "50% of earned",
      detail: "₹20,400 earned in 17 days · fixed ₹30,000",
    });
    const term = { ...c, advance: { ...c.advance, termLimit: 30000 } };
    expect(eligibleLimit(term)).toEqual({
      amount: 30000,
      label: "Term Loan limit",
      detail: "salary ₹30,000 · 10 months · EMI ₹5,000",
    });
    expect(overLimit(term)).toBe(true); // 50,000 asked, limit 30,000
  });

  it("says where a request stands", () => {
    expect(requestStatus(a, "md_review")).toEqual({ text: "To decide", tone: "warning" });
    const fromHr = {
      ...b,
      md: { decision: "approved" as const, amount: 6000, remark: "x", decidedAt: null, fromHr: true },
    };
    expect(requestStatus(fromHr, "md_review").text).toBe("HR's proposal — confirm it");
    expect(
      requestStatus(
        { ...fromHr, trail: [{ at: "", by: "", role: "md", round: 1, action: "approved", amount: 5000, remark: "" }] },
        "md_review",
      ).text,
    ).toBe("HR's revised proposal — confirm it");
    expect(requestStatus({ ...fromHr, md: { ...fromHr.md, fromHr: false } }, "md_review").text).toBe("Decided by you");
    expect(requestStatus(fromHr, "hr_final").text).toBe("With HR (final settlement)");
    const paid = { ...fromHr, applied: true, effective: { decision: "approved" as const, amount: 6000, remark: "" } };
    expect(requestStatus(paid, "completed")).toEqual({ text: "Paid ₹6,000", tone: "success" });
    const cut = {
      ...paid,
      applied: false,
      auditor: { action: "reject" as const, amount: null, remark: "No", at: null },
    };
    expect(
      requestStatus({ ...cut, effective: { decision: "rejected", amount: null, remark: "No" } }, "auditor_changes")
        .text,
    ).toBe("Final: rejected (by the auditor)");
    // confirming HR's proposal sends it again as the MD's own
    expect(confirmHrBody(fromHr)).toEqual({ decision: "approved", amount: 6000, remark: "x" });
    expect(
      confirmHrBody({ ...fromHr, md: { ...fromHr.md, decision: "rejected", amount: null, remark: "Too much" } }),
    ).toEqual({
      decision: "rejected",
      remark: "Too much",
    });
    expect(confirmHrBody({ ...fromHr, md: { ...fromHr.md, amount: 8000, remark: "" } })).toEqual({
      decision: "approved",
    });
  });

  it("selects all on screen or clears them, and words the bulk result", () => {
    expect([...toggleAll(new Set([1]), [1, 2, 3])]).toEqual([1, 2, 3]);
    expect([...toggleAll(new Set([1, 2, 3, 9]), [1, 2, 3])]).toEqual([9]);
    expect([...toggleAll(new Set(), [])]).toEqual([]);
    expect(bulkResultText("approved", 4, [], fourItems())).toEqual({ title: "Approved 4 requests" });
    expect(
      bulkResultText("approved", 4, [{ id: 12, reason: "A reduced amount needs a remark." }], fourItems()),
    ).toEqual({
      title: "Approved 3 requests, 1 request left out",
      description: "Bala Murugan: A reduced amount needs a remark.",
    });
  });

  it("counts HR's unconfirmed proposals in the review", () => {
    const items = [
      { ...b, md: { decision: "approved" as const, amount: 6000, remark: "Limit", decidedAt: null, fromHr: true } },
      a,
    ];
    const s = reviewSummary(items);
    expect(s.fromHr).toBe(1);
    expect(s.rows.find((r) => r.id === 12)?.fromHr).toBe(true);
  });
});
