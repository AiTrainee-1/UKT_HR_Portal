// Test data for the Automation Method's tests (logic.test.ts, settlement-automation.test.tsx): requests, batches at every
// stage and a month, shaped like the server's batch_json / month_json (api/settlement_automation/service.py).

import type {
  SettlementAdvance,
  SettlementBatch,
  SettlementBatchActions,
  SettlementBatchItem,
  SettlementMonth,
  SettlementOverview,
  SettlementOverviewType,
  SettlementStage,
  SettlementTrackerStep,
} from "@/lib/api-client/custom-hooks/settlement-automation";

export const advance = (over: Partial<SettlementAdvance> = {}): SettlementAdvance => ({
  id: 101,
  employeeId: 1,
  employeeCode: "S101",
  employeeName: "Asha Kumar",
  employeeDepartment: "Accounts",
  employeeDesignation: "Clerk",
  employeeBranch: "Unit 1",
  employeeBranchId: 1,
  employeeType: "staff",
  employeeStatus: "active",
  advanceType: "general",
  amount: 8000,
  requestedAmount: 8000,
  purpose: "Medical",
  status: "pending",
  emiAmount: 0,
  totalRepaid: 0,
  outstanding: 8000,
  repaymentStartMonth: 12,
  repaymentStartYear: 2026,
  createdAt: "2026-11-21T05:00:00Z",
  decisionRemark: "",
  scheduleMonths: [],
  earnings: {
    month: 11,
    year: 2026,
    throughDay: 20,
    fixedSalary: 26000,
    workingDays: 16,
    paidDays: 16,
    earnedAmount: 16000,
    percent: 50,
    limit: 8000,
  },
  leaveCheck: { month: 11, year: 2026, throughDay: 20, days: 1, flag: "ok", warningAt: 3 },
  bankAccount: "123456789",
  bankIfsc: "HDFC0001234",
  bankName: "HDFC Bank",
  ...over,
});

export function item(
  id: number,
  over: {
    advance?: Partial<SettlementAdvance>;
    requestedAmount?: number;
    hrNote?: string;
    /** HR's proposal at HR Review (2026-11-27). */
    hr?: Partial<NonNullable<SettlementBatchItem["hr"]>>;
    md?: Partial<SettlementBatchItem["md"]>;
    final?: Partial<SettlementBatchItem["final"]>;
    auditor?: Partial<SettlementBatchItem["auditor"]>;
    applied?: boolean;
  } = {},
): SettlementBatchItem {
  const adv = advance({ id: 100 + id, employeeId: id, ...over.advance });
  const final: SettlementBatchItem["final"] = {
    decision: null,
    amount: null,
    startMonth: null,
    startYear: null,
    remark: "",
    changedFromMd: false,
    ...over.final,
  };
  const auditor: SettlementBatchItem["auditor"] = { action: null, amount: null, remark: "", at: null, ...over.auditor };
  return {
    id,
    advance: adv,
    requestedAmount: over.requestedAmount ?? adv.requestedAmount ?? adv.amount,
    hrNote: over.hrNote ?? "",
    hr: { action: null, amount: null, remark: over.hrNote ?? "", ...over.hr },
    md: { decision: null, amount: null, remark: "", decidedAt: null, fromHr: false, ...over.md },
    final,
    auditor,
    effective: effectiveFor(final, auditor),
    applied: over.applied ?? false,
  };
}

/** service.effective: the auditor's rejection or reduced amount on top of HR's final decision. */
export function effectiveFor(
  final: SettlementBatchItem["final"],
  auditor: SettlementBatchItem["auditor"],
): SettlementBatchItem["effective"] {
  if (auditor.action === "reject") return { decision: "rejected", amount: null, remark: auditor.remark };
  if (final.decision === "approved" && auditor.action === "reduce" && auditor.amount != null)
    return { decision: "approved", amount: auditor.amount, remark: auditor.remark };
  return { decision: final.decision, amount: final.amount, remark: final.remark };
}

/** An item with the auditor's change (and its effective settlement worked out again). */
export function withAuditor(
  i: SettlementBatchItem,
  auditor: Partial<SettlementBatchItem["auditor"]>,
): SettlementBatchItem {
  const a = { ...i.auditor, ...auditor };
  return { ...i, auditor: a, effective: effectiveFor(i.final, a) };
}

const STAGES: SettlementStage[] = [
  "hr_review",
  "md_review",
  "hr_final",
  "auditor_send",
  "auditor_review",
  "auditor_changes",
  "accounts_send",
  "completed",
];
const LABELS: [SettlementTrackerStep["key"], string][] = [
  ["received", "Employee Requests Received"],
  ["hr_review", "HR Review"],
  ["md_review", "MD Review & Approval"],
  ["hr_final", "HR Final Settlement"],
  ["auditor_send", "Send to Auditor"],
  ["auditor_review", "Auditor Review"],
  ["auditor_changes", "HR Review of Auditor Changes"],
  ["accounts_send", "Send Bank File to Accounts"],
  ["completed", "Settlement Workflow Completed"],
];

/** The tracker as service.tracker_json draws it for a batch at `stage`. After the audit, HR Review of Auditor Changes
 *  is skipped unless `auditorChanged`; the audit and Accounts steps say what happened. */
export function trackerFor(
  stage: SettlementStage,
  action = "Do the next thing.",
  { auditorChanged = false, sentVia = "hr" }: { auditorChanged?: boolean; sentVia?: "hr" | "auditor" } = {},
): SettlementTrackerStep[] {
  const current = stage === "completed" ? 8 : STAGES.indexOf(stage) + 1;
  const changesAt = LABELS.findIndex(([key]) => key === "auditor_changes");
  return LABELS.map(([key, label], index) => {
    const skipped = key === "auditor_changes" && current > changesAt && !auditorChanged;
    const state: SettlementTrackerStep["state"] =
      index === 0
        ? "done"
        : skipped
          ? "skipped"
          : index < current
            ? "done"
            : index === current
              ? key === "completed"
                ? "done"
                : "current"
              : "pending";
    const detail =
      state === "skipped"
        ? "No auditor changes"
        : state === "done" && key === "auditor_review"
          ? auditorChanged
            ? "The auditor changed the settlement"
            : "Approved by the auditor"
          : state === "done" && key === "accounts_send"
            ? sentVia === "auditor"
              ? "Sent by the auditor"
              : "Sent by HR"
            : null;
    return {
      key,
      label,
      state,
      at: state === "done" && index > 0 ? "2026-11-22T05:30:00Z" : null,
      by: state === "done" && index > 0 ? "Priya HR" : null,
      detail,
      action: state === "current" ? action : null,
    };
  });
}

export const NO_ACTIONS: SettlementBatchActions = {
  canEditHrNotes: false,
  canForward: false,
  canDecideMd: false,
  canConfirmMd: false,
  canEditFinal: false,
  canFinalize: false,
  canSendAuditor: false,
  canResendAuditor: false,
  canConfirmAuditor: false,
  canAcceptAuditorChanges: false,
  canSendAccounts: false,
  canCompleteWithoutBankFile: false,
  canResendAccounts: false,
};

/** The actions the server allows HR at a stage (service.batch_json, viewer "hr"). */
export function actionsFor(stage: SettlementStage, anyApproved: boolean, accountsSent = false): SettlementBatchActions {
  return {
    ...NO_ACTIONS,
    canEditHrNotes: stage === "hr_review",
    canForward: stage === "hr_review",
    canEditFinal: stage === "hr_final",
    canFinalize: stage === "hr_final",
    canSendAuditor: stage === "auditor_send",
    canResendAuditor: stage === "auditor_review",
    canConfirmAuditor: stage === "auditor_review",
    canAcceptAuditorChanges: stage === "auditor_changes",
    canSendAccounts: stage === "accounts_send" && anyApproved,
    canCompleteWithoutBankFile: stage === "accounts_send" && !anyApproved,
    canResendAccounts: stage === "completed" && anyApproved && accountsSent,
  };
}

/** A batch of three requests at `stage`: Asha (Salary Advance 8,000), Ravi (Term Loan 30,000, 3 days of leave) and Meena
 *  (Salary Advance 5,000, 5 days of leave). From the MD's review on, the MD approved Asha in full, Ravi for 25,000 and
 *  rejected Meena; from HR's final settlement on, HR kept the MD's decisions except Asha's, lowered to 6,000. */
export function batchAt(stage: SettlementStage, over: Partial<SettlementBatch> = {}): SettlementBatch {
  const md = STAGES.indexOf(stage) >= STAGES.indexOf("hr_final");
  const fin = md;
  const finalized = STAGES.indexOf(stage) >= STAGES.indexOf("auditor_send");
  // since 2026-11-27 the advances are decided once the audit is through
  const applied = STAGES.indexOf(stage) >= STAGES.indexOf("accounts_send");
  const items = [
    item(1, {
      hrNote: "Regular, no earlier advance",
      md: md ? { decision: "approved", amount: 8000, remark: "", decidedAt: "2026-11-23T05:00:00Z" } : {},
      final: fin
        ? {
            decision: "approved",
            amount: 6000,
            startMonth: 12,
            startYear: 2026,
            remark: "Budget limit",
            changedFromMd: true,
          }
        : {},
      applied,
    }),
    item(2, {
      advance: {
        employeeCode: "S102",
        employeeName: "Ravi Shankar",
        advanceType: "term",
        amount: 30000,
        requestedAmount: 30000,
        repaymentMonths: 6,
        emiAmount: 5000,
        earnings: null,
        bankIfsc: "",
        leaveCheck: { month: 11, year: 2026, throughDay: 20, days: 3, flag: "warning", warningAt: 3 },
      },
      md: md ? { decision: "approved", amount: 25000, remark: "Reduce", decidedAt: "2026-11-23T05:00:00Z" } : {},
      final: fin ? { decision: "approved", amount: 25000, startMonth: 1, startYear: 2027, remark: "" } : {},
      applied,
    }),
    item(3, {
      advance: {
        employeeCode: "S103",
        employeeName: "Meena Iyer",
        amount: 5000,
        requestedAmount: 5000,
        leaveCheck: { month: 11, year: 2026, throughDay: 20, days: 5, flag: "critical", warningAt: 3 },
      },
      md: md
        ? { decision: "rejected", amount: null, remark: "Too many leaves", decidedAt: "2026-11-23T05:00:00Z" }
        : {},
      final: fin ? { decision: "rejected", amount: null, remark: "" } : {},
      applied,
    }),
  ];
  const approved = md ? 2 : 0;
  const advanceType = over.advanceType ?? "general";
  const typeLabel = advanceType === "term" ? "Term Loan" : "Salary Advance";
  return {
    id: 7,
    advanceType,
    typeLabel,
    title: `${typeLabel} · Batch ${over.number ?? 1}`,
    month: 11,
    year: 2026,
    number: 1,
    label: "Batch 1",
    stage,
    stageLabel: stage,
    nextAction: stage === "completed" ? "" : `Next action at ${stage}.`,
    tracker: trackerFor(stage, `Next action at ${stage}.`),
    counts: {
      total: 3,
      mdDecided: md ? 3 : 0,
      approved,
      rejected: md ? 1 : 0,
      undecided: md ? 0 : 3,
      warning: 1,
      critical: 1,
    },
    amounts: {
      requested: 43000,
      mdApproved: md ? 33000 : 0,
      finalApproved: fin ? 31000 : 0,
      payable: fin ? 31000 : 0,
    },
    forwardedAt: stage === "hr_review" ? null : "2026-11-22T05:30:00Z",
    forwardedBy: stage === "hr_review" ? null : "Priya HR",
    hrNote: "",
    mdConfirmedAt: md ? "2026-11-23T05:30:00Z" : null,
    mdConfirmedBy: md ? "Managing Director" : null,
    mdNote: md ? "Pay before the 30th" : "",
    finalizedAt: finalized ? "2026-11-24T05:30:00Z" : null,
    finalizedBy: finalized ? "Priya HR" : null,
    finalNote: "",
    auditor: {
      sentAt: null,
      sentBy: null,
      recipients: [],
      confirmedAt: null,
      confirmedBy: null,
      note: "",
      outcome: STAGES.indexOf(stage) >= STAGES.indexOf("accounts_send") ? "approved" : null,
      submittedAt: STAGES.indexOf(stage) >= STAGES.indexOf("accounts_send") ? "2026-11-25T06:00:00Z" : null,
      submittedNote: "",
      changes: 0,
      remarks: 0,
      changesAcceptedAt: null,
      changesAcceptedBy: null,
      changesNote: "",
      link: null,
    },
    accounts: { sentAt: null, sentBy: null, recipients: [], sentVia: null },
    completedAt: stage === "completed" ? "2026-11-26T05:30:00Z" : null,
    history: [],
    files: [],
    items,
    actions: actionsFor(stage, approved > 0, stage === "completed"),
    ...over,
  };
}

export function monthOf(batches: SettlementBatch[], over: Partial<SettlementMonth> = {}): SettlementMonth {
  const current = batches.find((b) => b.stage !== "completed") ?? batches[batches.length - 1];
  const advanceType = over.advanceType ?? batches[0]?.advanceType ?? "general";
  return {
    method: "automation",
    advanceType,
    typeLabel: advanceType === "term" ? "Term Loan" : "Salary Advance",
    month: 11,
    year: 2026,
    isCurrentMonth: true,
    received: batches.reduce((n, b) => n + b.items.length, 0),
    outsideWorkflow: 0,
    currentBatchId: current?.id ?? null,
    tracker: current ? current.tracker : trackerFor("hr_review"),
    batches,
    branchScoped: false,
    recipients: {
      auditor: ["auditor@firm.in"],
      auditorCc: ["md@uktextiles.in"],
      accounts: ["accounts@uktextiles.in"],
      accountsCc: [],
    },
    ...over,
  };
}

/** One type's side of the Overview (GET /overview), from its batches (the current one without items, files, history). */
export function overviewType(
  advanceType: SettlementOverviewType["advanceType"],
  batches: SettlementBatch[],
  over: Partial<SettlementOverviewType> = {},
): SettlementOverviewType {
  const current = batches.find((b) => b.stage !== "completed") ?? batches[batches.length - 1] ?? null;
  const summary = current ? (({ items: _items, files: _files, history: _history, ...rest }) => rest)(current) : null;
  return {
    advanceType,
    label: advanceType === "term" ? "Term Loan" : "Salary Advance",
    received: batches.reduce((n, b) => n + b.items.length, 0),
    batchCount: batches.length,
    completed: batches.filter((b) => b.stage === "completed").length,
    waitingForMd: batches.filter((b) => b.stage === "md_review").length,
    currentBatch: summary,
    tracker: current ? current.tracker : trackerFor("hr_review"),
    ...over,
  };
}

export function overviewOf(
  types: SettlementOverviewType[],
  over: Partial<SettlementOverview> = {},
): SettlementOverview {
  return { method: "automation", month: 11, year: 2026, isCurrentMonth: true, types, ...over };
}
