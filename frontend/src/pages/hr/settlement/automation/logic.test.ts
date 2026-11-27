import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api-client/custom-fetch";
import { mergeSettlementBatch } from "@/lib/api-client/custom-hooks/settlement-automation";
import { DEFAULT_COLUMN_KEYS, EXPORT_COLUMNS, TERM_DEFAULT_COLUMN_KEYS } from "../logic";
import {
  AUDITOR_DECISION_LABEL,
  advanceIdsOf,
  auditorChangeText,
  auditorChanged,
  auditorReview,
  batchBankFileName,
  batchBankLines,
  batchBankTotal,
  batchMissingBank,
  buildFinalReport,
  changesFromMd,
  effectiveOf,
  finalChanged,
  finalDefaults,
  finalEmiText,
  finalMonthsOf,
  finalPayload,
  finalProblems,
  finalReview,
  hasProblems,
  historyDetail,
  historyLabel,
  isFutureMonth,
  linkStateText,
  monthFromUrl,
  monthToUrl,
  pickBatch,
  reached,
  shiftMonth,
  workflowRefusal,
  type FinalEdit,
} from "./logic";
import { batchAt, item, monthOf, trackerFor, withAuditor } from "./test-fixtures";

// The Automation Method's rules on the HRMS side (owner 2026-11-26): HR's final decision stays within the MD's, the
// finalized report for the auditor (the Loan & Advance report's 12 columns, the FINAL decisions), the bank file for Accounts
// (the final approved amounts, rounded up), the month and batch shown, and the server's refusals in words.

const NOW = new Date("2026-11-26T06:00:00Z");

describe("the month and the batch shown", () => {
  it("opens on this month in India and keeps a clean address for it", () => {
    expect(monthFromUrl("", "", NOW)).toEqual({ month: 11, year: 2026 });
    expect(monthFromUrl("13", "2026", NOW)).toEqual({ month: 11, year: 2026 });
    expect(monthFromUrl("10", "2026", NOW)).toEqual({ month: 10, year: 2026 });
    expect(monthToUrl({ month: 11, year: 2026 }, NOW)).toEqual({ month: "", year: "" });
    expect(monthToUrl({ month: 10, year: 2026 }, NOW)).toEqual({ month: "10", year: "2026" });
    // 31 Dec 20:00 UTC is already 1 Jan in India
    expect(monthFromUrl("", "", new Date("2026-12-31T20:00:00Z"))).toEqual({ month: 1, year: 2027 });
  });

  it("steps across years and never offers a month after this one", () => {
    expect(shiftMonth({ month: 1, year: 2027 }, -1)).toEqual({ month: 12, year: 2026 });
    expect(shiftMonth({ month: 12, year: 2026 }, 1)).toEqual({ month: 1, year: 2027 });
    expect(isFutureMonth({ month: 12, year: 2026 }, NOW)).toBe(true);
    expect(isFutureMonth({ month: 11, year: 2026 }, NOW)).toBe(false);
  });

  it("shows the batch the address names, else the month's current one, else the last", () => {
    const done = batchAt("completed", { id: 7, number: 1, label: "Batch 1" });
    const open = batchAt("hr_review", { id: 8, number: 2, label: "Batch 2" });
    const month = monthOf([done, open]);
    expect(month.currentBatchId).toBe(8);
    expect(pickBatch(month, "")?.id).toBe(8);
    expect(pickBatch(month, "7")?.id).toBe(7);
    expect(pickBatch(month, "999")?.id).toBe(8);
    expect(pickBatch(monthOf([]), "")).toBeNull();
    expect(pickBatch(undefined, "")).toBeNull();
  });

  it("knows which stages a batch has reached", () => {
    expect(reached(batchAt("md_review"), "md_review")).toBe(true);
    expect(reached(batchAt("md_review"), "hr_final")).toBe(false);
    expect(reached(batchAt("completed"), "hr_final")).toBe(true);
  });
});

describe("HR's final decision stays within the MD's", () => {
  const approvedByMd = item(1, {
    md: { decision: "approved", amount: 8000 },
    final: { decision: "approved", amount: 8000, startMonth: 12, startYear: 2026 },
  });
  const rejectedByMd = item(2, { md: { decision: "rejected", remark: "No" }, final: { decision: "rejected" } });
  const edit = (over: Partial<FinalEdit> = {}): FinalEdit => ({ ...finalDefaults(approvedByMd, NOW), ...over });

  it("starts from the MD's decision and the request's first deduction month", () => {
    expect(finalDefaults(approvedByMd, NOW)).toEqual({
      decision: "approved",
      amount: "8000",
      startMonth: 12,
      startYear: 2026,
      remark: "",
      months: "", // a Salary Advance has no months
    });
    expect(finalDefaults(rejectedByMd, NOW).decision).toBe("rejected");
  });

  describe("a Term Loan's repayment months (owner 2026-11-27)", () => {
    // ₹30,000 asked for over 3 months, the MD approved ₹30,000; raised by the employee = whole-rupee EMIs
    const loan = item(5, {
      advance: {
        advanceType: "term",
        amount: 30000,
        requestedAmount: 30000,
        repaymentMonths: 3,
        emiAmount: 10000,
        appliedBy: "employee",
        termLimit: 30000,
        salaryAtRequest: 30000,
      },
      md: { decision: "approved", amount: 30000 },
      final: { decision: "approved", amount: 30000, startMonth: 12, startYear: 2026 },
    });
    const loanEdit = (over: Partial<FinalEdit> = {}): FinalEdit => ({ ...finalDefaults(loan, NOW), ...over });

    it("starts on the request's months, HR may change them within 1 to Settings' most", () => {
      expect(finalDefaults(loan, NOW).months).toBe("3");
      expect(finalMonthsOf(loan)).toBe(3);
      expect(finalMonthsOf({ ...loan, final: { ...loan.final, months: 5 } })).toBe(5);
      expect(finalProblems(loan, loanEdit({ months: "6" }), 6).months).toBeUndefined();
      expect(finalProblems(loan, loanEdit({ months: "7" }), 6).months).toBe("A Term Loan is repaid in 1 to 6 months.");
      expect(finalProblems(loan, loanEdit({ months: "" }), 6).months).toBe("A Term Loan is repaid in 1 to 6 months.");
      expect(hasProblems(finalProblems(loan, loanEdit({ months: "0" }), 6))).toBe(true);
      // a Salary Advance has no months to check
      expect(finalProblems(approvedByMd, edit(), 6).months).toBeUndefined();
    });

    it("sends the months with the decision and previews the EMI in whole rupees", () => {
      expect(finalPayload(loanEdit({ months: "4" }))).toEqual({
        decision: "approved",
        amount: 30000,
        startMonth: 12,
        startYear: 2026,
        months: 4,
        remark: "",
      });
      expect(finalPayload(loanEdit({ decision: "rejected", remark: "No" }))).not.toHaveProperty("months");
      expect(finalEmiText(loan, 30000, 3)).toBe("₹10,000 a month for 3 months");
      expect(finalEmiText(loan, 10000, 3)).toBe("₹3,334 a month for 3 months (the last ₹3,332)");
      expect(finalEmiText(loan, 0, 3)).toBe("");
      expect(finalEmiText(approvedByMd, 8000, 3)).toBe(""); // a Salary Advance has no EMI
    });
  });

  it("never approves what the MD rejected", () => {
    const p = finalProblems(rejectedByMd, { ...finalDefaults(rejectedByMd, NOW), decision: "approved", amount: "100" });
    expect(p.decision).toBe("The MD rejected this request: it can only stay rejected.");
    expect(hasProblems(p)).toBe(true);
    // keeping it rejected needs no remark (it is the MD's decision)
    expect(hasProblems(finalProblems(rejectedByMd, finalDefaults(rejectedByMd, NOW)))).toBe(false);
  });

  it("never pays more than the MD approved, and checks the amount like the server", () => {
    expect(finalProblems(approvedByMd, edit({ amount: "8000.01", remark: "More" })).amount).toBe(
      "The final amount cannot be more than the ₹8,000 the MD approved.",
    );
    expect(finalProblems(approvedByMd, edit({ amount: "" })).amount).toBe("Enter the final amount.");
    expect(finalProblems(approvedByMd, edit({ amount: "0" })).amount).toBe("The final amount must be more than ₹0.");
    expect(finalProblems(approvedByMd, edit({ amount: "5000.555", remark: "Less" })).amount).toBe(
      "Use at most 2 decimal places.",
    );
    expect(finalProblems(approvedByMd, edit({ startYear: 26 })).start).toBe("Enter a 4-digit year.");
    expect(hasProblems(finalProblems(approvedByMd, edit()))).toBe(false);
  });

  it("asks for a remark when it differs from the MD: a lower amount or a rejection, not a moved month", () => {
    expect(finalChanged(approvedByMd, edit({ amount: "6000" }))).toBe(true);
    expect(finalProblems(approvedByMd, edit({ amount: "6000" })).remark).toBe(
      "Write a remark for changing the MD's decision (at least 3 characters).",
    );
    expect(finalProblems(approvedByMd, edit({ amount: "6000", remark: "Budget" })).remark).toBeUndefined();
    expect(finalProblems(approvedByMd, edit({ decision: "rejected" })).remark).toBeDefined();
    expect(finalChanged(approvedByMd, edit({ startMonth: 2, startYear: 2027 }))).toBe(false);
    expect(hasProblems(finalProblems(approvedByMd, edit({ startMonth: 2, startYear: 2027 })))).toBe(false);
  });

  it("sends the decision, the amount and the month, and always the remark", () => {
    expect(finalPayload(edit({ amount: "6000", remark: "  Budget   limit " }))).toEqual({
      decision: "approved",
      amount: 6000,
      startMonth: 12,
      startYear: 2026,
      remark: "Budget limit",
    });
    expect(finalPayload(edit({ decision: "rejected", remark: "Too many leaves" }))).toEqual({
      decision: "rejected",
      remark: "Too many leaves",
    });
  });

  it("words what changed from the MD and totals the review before Finalize", () => {
    const b = batchAt("hr_final");
    expect(changesFromMd(b.items[0])).toEqual(["Amount ₹8,000 -> ₹6,000"]);
    expect(changesFromMd(b.items[1])).toEqual([]);
    expect(changesFromMd(b.items[2])).toEqual([]);
    const r = finalReview(b);
    expect(r).toMatchObject({
      approved: 2,
      rejected: 1,
      undecided: 0,
      changed: 1,
      requested: 43000,
      mdApproved: 33000,
      finalApproved: 31000,
    });
  });
});

describe("the finalized report for the auditor", () => {
  const b = batchAt("auditor_send");
  const report = buildFinalReport(b);

  it("has the Loan & Advance report's 12 default columns and the batch's title, naming its type", () => {
    expect(report.columns.map((c) => c.key)).toEqual([...DEFAULT_COLUMN_KEYS]);
    expect(report.columns.map((c) => c.header)).toEqual(EXPORT_COLUMNS.slice(0, 12).map((c) => c.header));
    expect(report.title).toBe("Loan & Advance – Salary Advance – November 2026 – Batch 1 – Final");
    expect(report.fileStem).toBe("Loan_Advance_Salary_Advance_November_2026_Batch_1_Final");
    const term = buildFinalReport(batchAt("auditor_send", { advanceType: "term" }));
    expect(term.title).toBe("Loan & Advance – Term Loan – November 2026 – Batch 1 – Final");
    expect(term.fileStem).toBe("Loan_Advance_Term_Loan_November_2026_Batch_1_Final");
    // a Term Loan batch: the Term Loan report's own columns and Final Summary (owner 2026-11-27)
    expect(term.columns.map((c) => c.key)).toEqual([...TERM_DEFAULT_COLUMN_KEYS]);
    expect(term.summary.map((c) => c.label)).toEqual([
      "Total Employees",
      "Total Requested",
      "Total Approved",
      "Total Monthly EMI",
      "Total Outstanding",
    ]);
    expect(report.sheet).toBe("Nov 2026 Batch 1");
    expect(report.subtitle).toContain("3 requests · 2 approved (₹31,000) · 1 rejected");
    expect(report.subtitle).toContain("Finalized by Priya HR");
  });

  it("has one row per request with its FINAL decision: Approved Amount is the final approved amount", () => {
    const col = (key: string) => report.columns.findIndex((c) => c.key === key);
    expect(report.rows).toHaveLength(3);
    const [asha, ravi, meena] = report.rows;
    expect(asha[col("sno")]).toBe(1);
    expect(asha[col("employee")]).toBe("Asha Kumar");
    expect(asha[col("type")]).toBe("Salary Advance");
    expect(asha[col("fixedSalary")]).toBe(26000);
    expect(asha[col("workingDays")]).toBe(16);
    expect(asha[col("earned")]).toBe(16000);
    expect(asha[col("requested")]).toBe(8000);
    expect(asha[col("limit")]).toBe(8000);
    expect(asha[col("approved")]).toBe(6000);
    expect(asha[col("remarks")]).toBe(""); // Remarks is always an empty cell (owner)
    expect(ravi[col("type")]).toBe("Term Loan");
    expect(ravi[col("approved")]).toBe(25000);
    // the MD's remark when HR kept the MD's decision
    expect(ravi[col("remarks")]).toBe("");
    expect(ravi[col("earned")]).toBe("");
    expect(meena[col("approved")]).toBe("");
    expect(meena[col("remarks")]).toBe("");
  });

  it("totals the money columns and sums the Final Summary from the final decisions", () => {
    const col = (key: string) => report.columns.findIndex((c) => c.key === key);
    expect(report.totals[col("employee")]).toBe("Total (3 requests)");
    expect(report.totals[col("requested")]).toBe(43000);
    expect(report.totals[col("approved")]).toBe(31000);
    expect(report.summary.map((c) => [c.label, c.value])).toEqual([
      ["Total Employee Count", 3],
      ["Total Earned Salary", 32000],
      ["Total Requested Amount", 43000],
      ["Total Approved Amount", 31000],
      ["Total Limit Amount", 16000],
    ]);
  });
});

describe("the bank file for Accounts", () => {
  it("pays only the final approved requests, at the final amount rounded up to the rupee", () => {
    const b = batchAt("accounts_send");
    b.items[0].final.amount = 6000.25;
    b.items[0].effective.amount = 6000.25;
    expect(batchBankLines(b)).toEqual([
      {
        employeeCode: "S101",
        employeeName: "Asha Kumar",
        bankAccount: "123456789",
        bankIfsc: "HDFC0001234",
        bankName: "HDFC Bank",
        amount: 6001,
      },
      {
        employeeCode: "S102",
        employeeName: "Ravi Shankar",
        bankAccount: "123456789",
        bankIfsc: "",
        bankName: "HDFC Bank",
        amount: 25000,
      },
    ]);
    expect(batchBankTotal(b)).toBe(31001);
    expect(batchMissingBank(b).map((a) => a.employeeName)).toEqual(["Ravi Shankar"]);
    expect(batchBankFileName(b)).toBe("Loan_Advance_Bank_File_Salary_Advance_November_2026_Batch_1.xlsx");
    expect(batchBankFileName({ ...b, advanceType: "term", number: 2 })).toBe(
      "Loan_Advance_Bank_File_Term_Loan_November_2026_Batch_2.xlsx",
    );
  });

  it("has nothing to pay when every request was rejected", () => {
    const b = batchAt("accounts_send");
    b.items.forEach((i) => {
      i.final = { ...i.final, decision: "rejected", amount: null };
      i.effective = { decision: "rejected", amount: null, remark: "" };
    });
    expect(batchBankLines(b)).toEqual([]);
  });

  it("pays the settlement as the auditor left it: a reduced amount, and nothing for a request the auditor rejected", () => {
    const b = batchAt("accounts_send");
    b.items[0] = withAuditor(b.items[0], { action: "reduce", amount: 4999.5, remark: "Two absent days" });
    b.items[1] = withAuditor(b.items[1], { action: "reject", remark: "Loan already running" });
    expect(batchBankLines(b).map((l) => [l.employeeCode, l.amount])).toEqual([["S101", 5000]]);
    expect(batchBankTotal(b)).toBe(5000);
    // the report for the auditor (and its resend) reads the same settlement
    const report = buildFinalReport(b);
    const col = (key: string) => report.columns.findIndex((c) => c.key === key);
    expect(report.rows.map((r) => r[col("approved")])).toEqual([4999.5, "", ""]);
    expect(report.subtitle).toContain("1 approved (₹4,999.5) · 2 rejected");
  });
});

describe("the auditor's changes (Auditor Review Portal, 2026-11-27)", () => {
  it("words each change, counts the remarks, and totals HR's final settlement against what is paid", () => {
    const b = batchAt("auditor_changes");
    b.items[0] = withAuditor(b.items[0], { action: "reduce", amount: 5000, remark: "Two absent days" });
    b.items[1] = withAuditor(b.items[1], { action: "reject", remark: "Loan already running" });
    b.items[2] = withAuditor(b.items[2], { remark: "Agree with HR" });
    expect(auditorChangeText(b.items[0])).toBe("Reduced ₹6,000 -> ₹5,000");
    expect(auditorChangeText(b.items[1])).toBe("Rejected (HR approved ₹25,000)");
    expect(auditorChangeText(b.items[2])).toBeNull();
    expect(auditorChanged(b.items[2])).toBe(false);
    const r = auditorReview(b);
    expect(r.lines.map((l) => [l.item.id, l.change, l.remark])).toEqual([
      [1, "Reduced ₹6,000 -> ₹5,000", "Two absent days"],
      [2, "Rejected (HR approved ₹25,000)", "Loan already running"],
      [3, null, "Agree with HR"],
    ]);
    expect(r).toMatchObject({ changes: 2, remarks: 3, hrApproved: 31000, payable: 5000, approved: 1, rejected: 2 });
    expect(effectiveOf(b.items[0])).toEqual({ decision: "approved", amount: 5000, remark: "Two absent days" });
  });

  it("says how the review link stands", () => {
    const link = {
      sentTo: ["auditor@firm.in"],
      createdAt: "2026-11-25T05:00:00Z",
      createdBy: "Priya HR",
      expiresAt: "2026-12-02T05:00:00Z",
      expired: false,
      revoked: false,
      firstOpenedAt: null,
      lastOpenedAt: null,
      openCount: 0,
      submittedAt: null,
      decision: null,
      active: true,
    };
    expect(linkStateText(link)).toEqual({ text: "Active", tone: "success" });
    expect(linkStateText({ ...link, expired: true, active: false }).text).toBe("Expired");
    expect(linkStateText({ ...link, revoked: true, active: false }).text).toBe(
      "Closed (replaced or confirmed by hand)",
    );
    expect(linkStateText({ ...link, submittedAt: "2026-11-26T05:00:00Z", decision: "approved_forward_hr" }).text).toBe(
      "Answered",
    );
    expect(AUDITOR_DECISION_LABEL.changes_forward_hr).toBe("Changes forwarded to HR");
  });

  it("words the audit's history entries", () => {
    expect(historyLabel({ action: "auditor_approved" })).toBe("Approved by the auditor");
    expect(historyLabel({ action: "auditor_changes_accepted" })).toBe("HR accepted the auditor's changes");
    expect(historyDetail({ at: "", by: "", action: "auditor_changes", note: "", changes: 2 })).toBe("2 changes");
    expect(historyDetail({ at: "", by: "", action: "auditor_approved", note: "", via: "approved_send_accounts" })).toBe(
      "Sent the bank file to Accounts",
    );
  });
});

describe("the rest", () => {
  it("forwards the ids HR saw", () => {
    expect(advanceIdsOf(batchAt("hr_review"))).toEqual([101, 102, 103]);
  });

  it("words the history", () => {
    expect(historyLabel({ action: "forwarded" })).toBe("Forwarded to the MD");
    expect(historyLabel({ action: "completed_no_payments" })).toBe("Completed without a bank file (nothing approved)");
    expect(
      historyDetail({ at: "", by: "", action: "finalized", note: "", approved: 2, rejected: 1, total: 31000 }),
    ).toBe("2 approved · 1 rejected · ₹31,000");
    expect(historyDetail({ at: "", by: "", action: "auditor_sent", note: "", to: ["a@x.in"], cc: ["b@x.in"] })).toBe(
      "To a@x.in · CC b@x.in",
    );
  });

  it("says what to do about a refused e-mail", () => {
    const refusal = (code: string) =>
      new ApiError(
        new Response(null, { status: 400, statusText: "Bad Request" }),
        { error: `Not sent (${code})`, code },
        {
          method: "POST",
          url: "/x",
        },
      );
    expect(workflowRefusal(refusal("email_off"), "x")).toMatchObject({
      text: "Not sent (email_off)",
      code: "email_off",
      hint: expect.stringContaining("Gmail Control"),
    });
    expect(workflowRefusal(refusal("email_blocked"), "x").hint).toContain("Nothing moved on");
    expect(workflowRefusal(refusal("email_failed"), "x").hint).toContain("try again");
    expect(workflowRefusal(new Error("boom"), "x")).toMatchObject({ text: "boom", code: null });
  });

  it("puts an answered batch into its month and the month's tracker follows its current batch", () => {
    const b = batchAt("hr_review");
    const month = monthOf([b]);
    const moved = batchAt("md_review");
    const next = mergeSettlementBatch(month, moved);
    expect(next.batches).toHaveLength(1);
    expect(next.batches[0].stage).toBe("md_review");
    expect(next.tracker).toEqual(trackerFor("md_review", "Next action at md_review."));
    const added = mergeSettlementBatch(month, batchAt("hr_review", { id: 9, number: 2 }));
    expect(added.batches.map((x) => x.id)).toEqual([7, 9]);
    expect(added.tracker).toBe(month.tracker);
  });
});
