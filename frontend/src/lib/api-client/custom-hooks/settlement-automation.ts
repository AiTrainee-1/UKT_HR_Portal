// settlement-automation: the Loan & Advance page's two methods (owner 2026-11-26; the Settlement page renamed 2026-11-27).
// Backend: api/settlement_automation/ (views.py, service.py). Settings -> Loan & Advance chooses the Normal Method (the
// page as it always was) or the Automation Method: a month-wise workflow per batch, HR Review -> MD Review & Approval ->
// HR Final Settlement -> Send to Auditor -> Auditor Review (HR confirms by hand) -> Send Bank File to Accounts ->
// Completed. Re-approval cycles (2026-11-27): the MD's / auditor's changes send a batch back to HR (md_changes /
// auditor_changes), HR answers every flagged request and resubmits it to the same reviewer for approval. Salary Advance and Term Loan run independent workflows (2026-11-27): each type has its own batches, so a
// month is read per type (?type=general|term) and the Overview reads both types side by side. Every write answers the
// updated batch, which is put straight into its month's cache.
//
// Not re-exported from the custom-hooks index on purpose: import it from this file (the MD portal has its own calls).
import { useMutation, useQuery, useQueryClient, type Query, type QueryClient } from "@tanstack/react-query";
import type { LeaveCalendarData } from "@/components/leave-calendar/LeaveCalendar";
import { downloadBlob } from "@/lib/exportUtils";
import { customFetch } from "../custom-fetch";
import type { Advance } from "./requests";

export type SettlementMethod = "normal" | "automation";

/** "general" = Salary Advance, "term" = Term Loan: each runs its own workflow (own batches, own numbers). */
export type SettlementAdvanceType = Advance["advanceType"];

export type SettlementStage =
  | "hr_review"
  | "md_review"
  /** HR Rework (MD Changes) (2026-11-27): the MD changed / rejected requests or asked for corrections; HR answers each
   *  flagged request and resubmits to the MD. */
  | "md_changes"
  | "hr_final"
  | "auditor_send"
  | "auditor_review"
  /** HR Rework (Auditor Changes) (2026-11-27): the auditor reduced / rejected requests or asked for corrections; HR
   *  answers each flagged request and resubmits to the auditor (a new review link goes out). */
  | "auditor_changes"
  | "accounts_send"
  | "completed";

/** The tracker's ten stages: the stages plus "received" (Employee Requests Received). Two are rework LOOPS (md_changes
 *  under md_review, auditor_changes under auditor_review), drawn as branches by the workflow tracker. */
export type SettlementTrackerKey = "received" | SettlementStage;

export type SettlementTrackerStep = {
  key: SettlementTrackerKey;
  label: string;
  /** "skipped": HR Review of Auditor Changes when the auditor changed nothing (or HR confirmed the review by hand). */
  state: "done" | "current" | "pending" | "skipped";
  /** When it was done, and by whom (done stages only). */
  at: string | null;
  by: string | null;
  /** What happened ("Approved by the auditor", "Sent by HR"; a skipped stage: "No auditor changes"). */
  detail?: string | null;
  /** What has to happen to move on (the current stage only). */
  action: string | null;
  /** A rework loop stage (md_changes / auditor_changes; absent from an older server). */
  loop?: boolean;
  /** A loop: how many times the batch went round it. */
  cycles?: number | null;
  /** md_review / auditor_review: the review round (2+ = a revised settlement). */
  round?: number | null;
};

/** The branching tracker's facts (service.flow_json, 2026-11-27). */
export type SettlementFlow = {
  /** The MD's / auditor's review round (1 = the first). */
  mdRound: number;
  auditorRound: number;
  /** How many times the MD / the auditor returned the batch to HR for rework. */
  mdCycles: number;
  auditorCycles: number;
  /** The path the MD approved it on: to HR Final Settlement, or directly to the auditor; null before. */
  mdPath: "hr" | "direct" | null;
  /** Who sent the bank file to Accounts. */
  accountsVia: "hr" | "auditor" | null;
  /** The MD's latest Return to HR for rework, with their instructions. */
  mdReturn: { at: string; by: string | null; note: string } | null;
};

/** Where a request stands with the current stage's reviewer: waiting ones sort to the top, then approved, then
 *  rejected (owner 2026-11-27). */
export type SettlementReviewState = "pending" | "approved" | "rejected";

/** One earlier decision on a request, kept when a rework round replaced it. */
export type SettlementTrailEntry = {
  at: string;
  by: string;
  /** hr = HR's proposal, md = the MD's decision, hr_final = HR's final settlement, auditor = the auditor's answer. */
  role: "hr" | "md" | "hr_final" | "auditor";
  round: number;
  /** hr: approve | reduce | reject; md / hr_final: approved | rejected; auditor: approve | reduce | reject | "" (a
   *  remark alone). */
  action: string;
  amount: number | null;
  remark: string;
};

export type SettlementDecision = "approved" | "rejected";

/** The advance as the HR list sends it (advance_json with the bank details). */
export type SettlementAdvance = Advance & {
  employeeBranchId?: number | null;
  employeeBranch?: string | null;
  employeeType?: string | null;
  employeeStatus?: string | null;
  requestedAmount?: number | null;
  salaryAtRequest?: number | null;
  appliedBy?: "hr" | "employee" | null;
};

/** HR's proposal on one request at HR Review (2026-11-27): not reviewed yet (action null; kept as asked), kept as asked
 *  ("approve"), reduced (an amount below the one asked for) or rejected; the remark is the request's hrNote. Forward
 *  copies a reduce / reject into the MD's decision. */
export type SettlementHrProposal = {
  action: "approve" | "reduce" | "reject" | null;
  amount: number | null;
  remark: string;
};

/** HR Review's proposal input (PATCH items/<id>): a remark alone, or with a proposal ("keep" = as asked; "" reopens it:
 *  Rework). Also HR's answer to the MD in HR Rework (MD Changes). */
export type SettlementHrReviewInput = {
  hrNote?: string;
  action?: "" | "keep" | "reduce" | "reject";
  amount?: number;
};

/** A bulk step's answer: the batch, and the requests it left out with why (HR final: "The MD rejected it."). */
export type SettlementBulkReply = SettlementBatch & { skipped?: { id: number; reason: string }[] };

/** A Salary Advance's rounding (owner 2026-11-27, service.rounding_json): the amount asked for, brought down to the
 *  eligible limit when above it, then rounded to the nearest ₹500 (₹250 and up within a step rounds up), never above
 *  the limit. Worked out while the batch is at HR Review and frozen at Forward. */
export type SettlementRounding = {
  /** What the employee asked for. */
  requested: number;
  /** The eligible limit it was capped at (null: no limit known). */
  limit: number | null;
  /** The rounded amount: the workflow's "as asked" amount. */
  rounded: number;
  /** Asked for more than the limit: brought down to it first. */
  capped: boolean;
  /** The rounded amount against what was asked. */
  direction: "up" | "down" | "same";
  /** Rounds to ₹0 within the limit: it can only be rejected. */
  zero: boolean;
};

export type SettlementBatchItem = {
  id: number;
  advance: SettlementAdvance;
  /** What the employee asked for (the advance's own amount; never the rounded one). */
  requestedAmount: number;
  /** The Salary Advance rounding (2026-11-27); null for a Term Loan or an older batch, absent from an older server. */
  rounding?: SettlementRounding | null;
  /** The workflow's "as asked" amount: a Salary Advance's rounded amount, else what was asked (2026-11-27). Keep as
   *  asked keeps it, a reduction is below it, the MD approves it or less. */
  baseAmount?: number;
  /** HR's note to the MD about this request (HR Review). */
  hrNote: string;
  /** HR's proposal (2026-11-27; absent from an older server). */
  hr?: SettlementHrProposal;
  /** Where the request stands with the current stage's reviewer (2026-11-27; the list sorts by it). */
  review?: SettlementReviewState;
  /** Flagged for HR's rework by the MD / the auditor and not answered yet. */
  rework?: "md" | "auditor" | null;
  /** The MD's own decision differs from HR's proposal (the MD must return the settlement to HR). */
  mdChanged?: boolean;
  /** The MD wrote their own remark on it (a correction for HR to look at). */
  mdRemarked?: boolean;
  /** The earlier rounds' decisions on this request. */
  trail?: SettlementTrailEntry[];
  md: {
    decision: SettlementDecision | null;
    amount: number | null;
    remark: string;
    decidedAt: string | null;
    /** Pre-filled from HR's proposal at Forward, not yet confirmed by the MD's own click. */
    fromHr?: boolean;
  };
  /** HR's final settlement, within the MD's decision; starts as the MD's when the MD confirms. */
  final: {
    decision: SettlementDecision | null;
    amount: number | null;
    startMonth: number | null;
    startYear: number | null;
    /** A Term Loan's repayment months as HR finalized them (2026-11-27; null: the request's own). */
    months?: number | null;
    remark: string;
    changedFromMd: boolean;
  };
  /** The auditor's change in the Auditor Review Portal (2026-11-27): a reduced amount or a rejection, and a remark. */
  auditor: SettlementAuditorChange;
  /** The settlement of this request as it will be paid: HR's final decision with the auditor's change on top. */
  effective: SettlementEffective;
  /** The advance itself was decided (once the audit is through: the auditor approved, HR accepted the auditor's
   *  changes, or HR confirmed the review by hand). */
  applied: boolean;
};

/** What the auditor did to one request: "approve" (as HR settled it), "reduce" (a smaller amount), "reject", or not
 *  reviewed yet (null; a remark alone is not a change). */
export type SettlementAuditorChange = {
  action: "approve" | "reduce" | "reject" | null;
  amount: number | null;
  remark: string;
  at: string | null;
};

/** The settlement of a request as paid (service.effective): the auditor's reduced amount or rejection, else HR's final. */
export type SettlementEffective = {
  decision: SettlementDecision | null;
  amount: number | null;
  /** The remark the employee is told: the auditor's when they changed it. */
  remark: string;
};

/** The auditor's review link as HR sees it (never its token). */
export type SettlementAuditorLink = {
  sentTo: string[];
  createdAt: string | null;
  createdBy: string | null;
  expiresAt: string;
  expired: boolean;
  /** A newer send replaced it, or HR confirmed the review by hand. */
  revoked: boolean;
  firstOpenedAt: string | null;
  lastOpenedAt: string | null;
  openCount: number;
  submittedAt: string | null;
  decision: SettlementAuditorDecision | null;
  /** It still works: not revoked, not answered, not expired. */
  active: boolean;
};

/** How the auditor answered in the portal. */
export type SettlementAuditorDecision = "approved_send_accounts" | "approved_forward_hr" | "changes_forward_hr";

export type SettlementBatchFile = {
  id: number;
  kind: "report_pdf" | "report_xlsx" | "bank_file";
  kindLabel: string;
  filename: string;
  size: number;
  sentTo: string[];
  /** The e-mail's status ("sent", "failed", "blocked"), null when none was attempted. */
  emailStatus: string | null;
  createdBy: string | null;
  createdAt: string | null;
};

export type SettlementHistoryEntry = {
  at: string;
  by: string;
  action: string;
  note: string;
  count?: number;
  approved?: number;
  rejected?: number;
  total?: number;
  to?: string[];
  cc?: string[];
  /** auditor_changes / md_returned: how many requests the reviewer changed (and remarked on). */
  changes?: number;
  remarks?: number;
  /** md_returned / md_resubmitted / auditor_changes / auditor_resubmitted: the review round it belongs to. */
  round?: number;
  /** auditor_approved: the auditor's decision; accounts_sent: "hr" | "auditor"; finalized: "md" (Direct to Auditor). */
  via?: string;
  /** md_confirmed: the MD finalized it directly (Direct to Auditor). */
  direct?: boolean;
  /** forwarded: how many requests carried an HR proposal (reduce / reject). */
  proposals?: number;
};

export type SettlementBatchActions = {
  canEditHrNotes: boolean;
  canForward: boolean;
  /** Rework: reopen a request HR decided, in HR Review / HR Rework (MD) / HR Final / HR Rework (Auditor). */
  canRework?: boolean;
  canDecideMd: boolean;
  /** The MD approves (to HR or directly to the auditor): every request decided AND no change from HR's proposals. */
  canConfirmMd: boolean;
  /** The MD returns the settlement to HR for rework (changes or corrections). */
  canReturnMd?: boolean;
  /** HR Rework (MD Changes): answer the MD (accept / keep / change), then Resubmit to the MD. */
  canResolveMd?: boolean;
  canResubmitMd?: boolean;
  canEditFinal: boolean;
  canFinalize: boolean;
  canSendAuditor: boolean;
  canResendAuditor: boolean;
  canConfirmAuditor: boolean;
  /** HR Rework (Auditor Changes): answer the auditor, then Resubmit to the auditor. */
  canResolveAuditor?: boolean;
  canResubmitAuditor?: boolean;
  canSendAccounts: boolean;
  canCompleteWithoutBankFile: boolean;
  canResendAccounts: boolean;
};

export type SettlementBatch = {
  id: number;
  /** The type whose workflow this batch is (2026-11-27): a batch holds one type only. */
  advanceType: SettlementAdvanceType;
  /** "Salary Advance" | "Term Loan". */
  typeLabel: string;
  /** "Salary Advance · Batch 1". */
  title: string;
  month: number;
  year: number;
  number: number;
  /** "Batch 1". */
  label: string;
  stage: SettlementStage;
  stageLabel: string;
  nextAction: string;
  tracker: SettlementTrackerStep[];
  /** The branching tracker's facts (2026-11-27; absent from an older server). */
  flow?: SettlementFlow;
  /** The MD's / auditor's review round. */
  mdRound?: number;
  auditorRound?: number;
  counts: {
    total: number;
    mdDecided: number;
    approved: number;
    rejected: number;
    undecided: number;
    warning: number;
    critical: number;
    /** With the current stage's reviewer (2026-11-27). */
    pending?: number;
    reviewedApproved?: number;
    reviewedRejected?: number;
    /** The MD's decisions that differ from HR's proposals. */
    mdChanges?: number;
    /** Requests waiting for HR's rework answer. */
    rework?: number;
  };
  amounts: {
    requested: number;
    /** The "as asked" total after the Salary Advance rounding (= requested for a Term Loan / an older batch; absent from
     *  an older server). */
    rounded?: number;
    mdApproved: number;
    finalApproved: number;
    /** What will be paid: HR's final settlement with the auditor's changes (= finalApproved before finalizing). */
    payable: number;
  };
  forwardedAt: string | null;
  forwardedBy: string | null;
  /** HR's note to the MD with the batch. */
  hrNote: string;
  mdConfirmedAt: string | null;
  mdConfirmedBy: string | null;
  /** The MD's instructions for the whole batch. */
  mdNote: string;
  finalizedAt: string | null;
  finalizedBy: string | null;
  /** Who finalized it (2026-11-27): HR at HR Final Settlement, or the MD with "Direct to Auditor" (HR Final skipped). */
  finalizedVia?: "hr" | "md" | null;
  finalNote: string;
  auditor: {
    sentAt: string | null;
    sentBy: string | null;
    recipients: string[];
    confirmedAt: string | null;
    confirmedBy: string | null;
    note: string;
    /** The audit's outcome: approved in the portal, changed in the portal, or confirmed by HR by hand. */
    outcome: "approved" | "changes" | "confirmed_by_hr" | null;
    /** When the auditor answered in the portal, and their note to HR. */
    submittedAt: string | null;
    submittedNote: string;
    /** Requests the auditor reduced or rejected, and requests with an auditor remark. */
    changes: number;
    remarks: number;
    /** HR accepted the auditor's changes (HR Review of Auditor Changes). */
    changesAcceptedAt: string | null;
    changesAcceptedBy: string | null;
    changesNote: string;
    /** The latest review link e-mailed to the auditor (HR only); null before Send to Auditor. */
    link: SettlementAuditorLink | null;
  };
  accounts: {
    sentAt: string | null;
    sentBy: string | null;
    recipients: string[];
    /** Who sent the bank file: HR, or the auditor from the review portal. */
    sentVia: "hr" | "auditor" | null;
  };
  completedAt: string | null;
  history: SettlementHistoryEntry[];
  files: SettlementBatchFile[];
  items: SettlementBatchItem[];
  actions: SettlementBatchActions;
};

export type SettlementRecipients = { auditor: string[]; auditorCc: string[]; accounts: string[]; accountsCc: string[] };

/** A month of ONE type's workflow (GET /month?type=). */
export type SettlementMonth = {
  method: SettlementMethod;
  /** The type this month is about (the `type` asked for). */
  advanceType: SettlementAdvanceType;
  typeLabel: string;
  month: number;
  year: number;
  isCurrentMonth: boolean;
  /** Requests of the month in a batch. */
  received: number;
  /** Requests of the month decided outside the workflow (the Normal Method): in no batch. */
  outsideWorkflow: number;
  /** The batch the page opens on: the first one not completed, else the last. */
  currentBatchId: number | null;
  tracker: SettlementTrackerStep[];
  /** The tracker's batch's flow facts (2026-11-27). */
  flow?: SettlementFlow;
  /** Oldest first. */
  batches: SettlementBatch[];
  /** A branch login: it sees its branch's requests and cannot move a batch. */
  branchScoped: boolean;
  recipients: SettlementRecipients;
};

/** A batch as the Overview sends it: the batch JSON without its requests, files and history. */
export type SettlementBatchSummary = Omit<SettlementBatch, "items" | "files" | "history">;

/** One type's side of the Overview (GET /overview): its month at a glance. */
export type SettlementOverviewType = {
  advanceType: SettlementAdvanceType;
  /** "Salary Advance" | "Term Loan". */
  label: string;
  /** Requests of the month in this type's batches. */
  received: number;
  batchCount: number;
  completed: number;
  /** Batches forwarded to the MD and not confirmed yet. */
  waitingForMd: number;
  /** The first batch not completed, else the last; null when the month has none. */
  currentBatch: SettlementBatchSummary | null;
  tracker: SettlementTrackerStep[];
  flow?: SettlementFlow;
};

/** The Loan & Advance main page with the Automation Method: both types' month side by side. */
export type SettlementOverview = {
  method: SettlementMethod;
  month: number;
  year: number;
  isCurrentMonth: boolean;
  /** Salary Advance first, then Term Loan. */
  types: SettlementOverviewType[];
};

export type SettlementInProgress = {
  id: number;
  month: number;
  year: number;
  number: number;
  /** The batch's type (2026-11-27; absent from an older server). */
  advanceType?: SettlementAdvanceType;
  typeLabel?: string;
  stage: SettlementStage;
  stageLabel: string;
};

export type SettlementSettings = {
  method: SettlementMethod;
  methods: { key: SettlementMethod; label: string }[];
  auditorEmails: string[];
  auditorCc: string[];
  accountsEmails: string[];
  accountsCc: string[];
  /** How many days the auditor's review link works (1-30, 7 by default; 2026-11-27). */
  auditorLinkDays?: number;
  auditorLinkDaysLimits?: { min: number; max: number; default: number };
  updatedBy: string | null;
  updatedAt: string | null;
  /** The Settings edit right and a login for all units. */
  canChange: boolean;
  /** Batches between Forward and Completed: the Normal Method cannot be switched on while there are any. */
  inProgress: SettlementInProgress[];
  /** The Salary Advance and Term Loan rules (Settings -> Loan & Advance, 2026-11-27; advance_rules.py). */
  salaryAdvanceRules?: SalaryAdvanceRules;
  termLoanRules?: TermLoanRules;
  /** Each rule's range, by the server's field name (sa_percent, tl_max_months ...). */
  ruleLimits?: Record<string, { min: number; max: number }>;
  ruleDefaults?: { salaryAdvance: SalaryAdvanceRules; termLoan: TermLoanRules };
};

/** The Salary Advance rules (advance_rules.Rules.sa_json). */
export type SalaryAdvanceRules = {
  /** Up to this % of the salary earned from the 1st to `earnedThroughDay`. */
  percent: number;
  windowFromDay: number;
  windowToDay: number;
  earnedThroughDay: number;
  /** How many Salary Advances a month. */
  perMonth: number;
  /** A rejected request does not count against perMonth. */
  rejectedAllowsReapply: boolean;
  /** "the 21st and 22nd of each month". */
  windowText?: string;
};

/** The Term Loan rules (advance_rules.Rules.tl_json). Staff only. */
export type TermLoanRules = {
  /** The most, as a % of the fixed monthly salary (above 100 only with allowAboveSalary). */
  limitPercent: number;
  /** The % in force: never above 100 unless allowAboveSalary. */
  effectivePercent?: number;
  allowAboveSalary: boolean;
  maxMonths: number;
  /** The most months Settings may allow (12). */
  absoluteMaxMonths?: number;
  minAmount: number;
  /** Term Loans approved per calendar year. */
  perYear: number;
  minServiceMonths: number;
  /** After a rejection, apply again from the 1st of the next month. */
  reapplyNextMonth: boolean;
  /** One waiting or active Term Loan at a time. */
  oneOpenAtATime: boolean;
  staffOnly?: boolean;
};

export type SettlementSettingsInput = Partial<{
  method: SettlementMethod;
  auditorEmails: string[];
  auditorCc: string[];
  accountsEmails: string[];
  accountsCc: string[];
  auditorLinkDays: number;
  /** Only the rules that changed (the block is partial). */
  salaryAdvanceRules: Partial<SalaryAdvanceRules>;
  termLoanRules: Partial<TermLoanRules>;
}>;

/** HR's final settlement of one request (PATCH items/<id>/final). */
export type SettlementFinalInput = {
  decision: SettlementDecision;
  amount?: number;
  startMonth?: number;
  startYear?: number;
  /** A Term Loan's repayment months (1 to Settings' most; 2026-11-27). */
  months?: number;
  remark: string;
};

const ROOT = "/api/settlement-automation";
const METHOD = `${ROOT}/method`;
const MONTH = `${ROOT}/month`;
const OVERVIEW = `${ROOT}/overview`;
const SETTINGS = "/api/settlement-settings";

export const getSettlementMethodQueryKey = () => [METHOD] as const;
export const getSettlementMonthQueryKey = (month: number, year: number, type: SettlementAdvanceType) =>
  [MONTH, month, year, type] as const;
export const getSettlementOverviewQueryKey = (month: number, year: number) => [OVERVIEW, month, year] as const;
export const getSettlementSettingsQueryKey = () => [SETTINGS] as const;

/** Which method the Loan & Advance page runs. */
export const useSettlementMethod = () =>
  useQuery<{ method: SettlementMethod }>({
    queryKey: getSettlementMethodQueryKey(),
    queryFn: () => customFetch<{ method: SettlementMethod }>(METHOD),
  });

/** A month of one type's workflow: its batches with their requests, the tracker and the numbers. */
export const useSettlementMonth = (month: number, year: number, type: SettlementAdvanceType, enabled = true) =>
  useQuery<SettlementMonth>({
    queryKey: getSettlementMonthQueryKey(month, year, type),
    queryFn: () => customFetch<SettlementMonth>(`${MONTH}?month=${month}&year=${year}&type=${type}`),
    enabled,
  });

/** Both types' month at a glance (the Loan & Advance Overview with the Automation Method). */
export const useSettlementOverview = (month: number, year: number, enabled = true) =>
  useQuery<SettlementOverview>({
    queryKey: getSettlementOverviewQueryKey(month, year),
    queryFn: () => customFetch<SettlementOverview>(`${OVERVIEW}?month=${month}&year=${year}`),
    enabled,
  });

export const useSettlementSettings = () =>
  useQuery<SettlementSettings>({
    queryKey: getSettlementSettingsQueryKey(),
    queryFn: () => customFetch<SettlementSettings>(SETTINGS),
  });

const isMonthQuery = (query: Query) => query.queryKey[0] === MONTH;
const isOverviewQuery = (query: Query) => query.queryKey[0] === OVERVIEW;

/** Reads every month and the Overview again (a new request joins a month's open batch; a write changes the numbers). */
export function refreshSettlementWorkflow(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ predicate: isMonthQuery });
  void queryClient.invalidateQueries({ predicate: isOverviewQuery });
}

/** The month with `batch` put in place of the one with its id (added when it is new); the month's own tracker follows
 *  the batch it is drawn from. Pure: the cache update of every write. */
export function mergeSettlementBatch(month: SettlementMonth, batch: SettlementBatch): SettlementMonth {
  const known = month.batches.some((b) => b.id === batch.id);
  const batches = known
    ? month.batches.map((b) => (b.id === batch.id ? batch : b))
    : [...month.batches, batch].sort((a, b) => a.number - b.number);
  return {
    ...month,
    batches,
    tracker: month.currentBatchId === batch.id ? batch.tracker : month.tracker,
  };
}

/** Puts an answered batch into its month's cache (the month of its own type). */
export function putSettlementBatch(queryClient: QueryClient, batch: SettlementBatch): void {
  queryClient.setQueryData<SettlementMonth>(
    getSettlementMonthQueryKey(batch.month, batch.year, batch.advanceType ?? "general"),
    (old) => (old ? mergeSettlementBatch(old, batch) : old),
  );
}

/** A write that answers the batch. `moves`: it moves the batch to another stage (the month's numbers, the advances, the
 *  Settings tab's "in progress" list and the MD's waiting count may all change then). The Overview's numbers follow
 *  every write. */
function useBatchWrite<V, R extends SettlementBatch = SettlementBatch>(call: (input: V) => Promise<R>, moves: boolean) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: (reply) => {
      // a bulk reply's `skipped` is about the call, not the batch: the cache keeps the batch alone
      const { skipped: _skipped, ...batch } = reply as SettlementBulkReply;
      putSettlementBatch(queryClient, batch);
      void queryClient.invalidateQueries({ predicate: isOverviewQuery });
      if (moves) {
        void queryClient.invalidateQueries({ predicate: isMonthQuery });
        void queryClient.invalidateQueries({ queryKey: ["/api/advances"] });
        void queryClient.invalidateQueries({ queryKey: getSettlementSettingsQueryKey() });
      }
    },
  });
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

/** HR Review: HR's note to the MD on one request. */
export const useSettlementHrNote = () =>
  useBatchWrite(
    ({ itemId, hrNote }: { itemId: number; hrNote: string }) =>
      customFetch<SettlementBatch>(`${ROOT}/items/${itemId}`, json("PATCH", { hrNote })),
    false,
  );

/** HR Review: HR's proposal on one request (keep / reduce / reject) and its remark; carried to the MD at Forward. */
export const useSettlementHrReview = () =>
  useBatchWrite(
    ({ itemId, body }: { itemId: number; body: SettlementHrReviewInput }) =>
      customFetch<SettlementBatch>(`${ROOT}/items/${itemId}`, json("PATCH", body)),
    false,
  );

/** HR Review, several requests at once: approve (keep as asked) or reject (one remark for all). */
export const useSettlementHrReviewBulk = () =>
  useBatchWrite(
    ({
      batchId,
      itemIds,
      action,
      remark,
    }: {
      batchId: number;
      itemIds: number[];
      action: "approve" | "reject";
      remark: string;
    }) =>
      customFetch<SettlementBulkReply>(
        `${ROOT}/batches/${batchId}/hr-review-bulk`,
        json("POST", { itemIds, action, remark }),
      ),
    false,
  );

/** HR Final Settlement, several requests at once, within the MD's decisions: approve (at the MD's amount; a request the
 *  MD rejected is skipped) or reject (one remark for all). The answer's `skipped` says which were left out and why. */
export const useSettlementFinalBulk = () =>
  useBatchWrite(
    ({
      batchId,
      itemIds,
      decision,
      remark,
    }: {
      batchId: number;
      itemIds: number[];
      decision: SettlementDecision;
      remark: string;
    }) =>
      customFetch<SettlementBulkReply>(
        `${ROOT}/batches/${batchId}/final-bulk`,
        json("POST", { itemIds, decision, remark }),
      ),
    false,
  );

/** HR Review -> MD Review. `advanceIds`: the requests HR saw (409 `changed` when the batch holds others now). */
export const useSettlementForward = () =>
  useBatchWrite(
    ({ batchId, advanceIds, note }: { batchId: number; advanceIds: number[]; note: string }) =>
      customFetch<SettlementBatch>(`${ROOT}/batches/${batchId}/forward`, json("POST", { advanceIds, note })),
    true,
  );

/** HR Final Settlement: one request's final decision, within the MD's. */
export const useSettlementFinalDecision = () =>
  useBatchWrite(
    ({ itemId, body }: { itemId: number; body: SettlementFinalInput }) =>
      customFetch<SettlementBatch>(`${ROOT}/items/${itemId}/final`, json("PATCH", body)),
    false,
  );

/** HR Final Settlement -> Send to Auditor: every advance is decided. */
export const useSettlementFinalize = () =>
  useBatchWrite(
    ({ batchId, note }: { batchId: number; note: string }) =>
      customFetch<SettlementBatch>(`${ROOT}/batches/${batchId}/finalize`, json("POST", { note })),
    true,
  );

/** Send to Auditor (or again): e-mails the auditor a secure review link with the finalized report as PDF + Excel; a
 *  new send replaces the older link. Only a sent e-mail moves the batch on. */
export const useSettlementSendAuditor = () =>
  useBatchWrite(({ batchId, pdf, xlsx }: { batchId: number; pdf: File; xlsx: File }) => {
    const form = new FormData();
    form.append("pdf", pdf, pdf.name);
    form.append("xlsx", xlsx, xlsx.name);
    return customFetch<SettlementBatch>(`${ROOT}/batches/${batchId}/send-auditor`, { method: "POST", body: form });
  }, true);

/** Auditor Review -> Send Bank File to Accounts, by hand (the fallback when the auditor confirmed another way): HR's
 *  final settlement is written to the advances as finalized and the review link stops working. */
export const useSettlementAuditorDone = () =>
  useBatchWrite(
    ({ batchId, note }: { batchId: number; note: string }) =>
      customFetch<SettlementBatch>(`${ROOT}/batches/${batchId}/auditor-done`, json("POST", { note })),
    true,
  );

/** Rework (2026-11-27): HR reopens a request it decided in its current stage; it waits again, at the top of the list. */
export const useSettlementRework = () =>
  useBatchWrite(
    ({ itemId }: { itemId: number }) =>
      customFetch<SettlementBatch>(`${ROOT}/items/${itemId}/rework`, json("POST", {})),
    false,
  );

/** HR's answer to the MD's / auditor's change on one request in a rework stage: "accept" (take the reviewer's decision)
 *  or "keep" (stand by HR's own; the reviewer sees it again on resubmission). */
export type SettlementResolveHow = "accept" | "keep";

export const useSettlementResolve = () =>
  useBatchWrite(
    ({ itemId, how }: { itemId: number; how: SettlementResolveHow }) =>
      customFetch<SettlementBatch>(`${ROOT}/items/${itemId}/resolve`, json("POST", { how })),
    false,
  );

/** The same answer on several requests (requests with nothing to accept come back in `skipped`). */
export const useSettlementResolveBulk = () =>
  useBatchWrite(
    ({ batchId, itemIds, how }: { batchId: number; itemIds: number[]; how: SettlementResolveHow }) =>
      customFetch<SettlementBulkReply>(`${ROOT}/batches/${batchId}/resolve-bulk`, json("POST", { itemIds, how })),
    false,
  );

/** HR Rework (MD Changes) -> MD Review, the next round (every flagged request answered). */
export const useSettlementResubmitMd = () =>
  useBatchWrite(
    ({ batchId, note }: { batchId: number; note: string }) =>
      customFetch<SettlementBatch>(`${ROOT}/batches/${batchId}/resubmit-md`, json("POST", { note })),
    true,
  );

/** HR Rework (Auditor Changes) -> Send to Auditor, the next round: the revised settlement and a new review link go out
 *  next (useSettlementSendAuditor). Nothing reaches Accounts before the auditor approves it. */
export const useSettlementResubmitAuditor = () =>
  useBatchWrite(
    ({ batchId, note }: { batchId: number; note: string }) =>
      customFetch<SettlementBatch>(`${ROOT}/batches/${batchId}/resubmit-auditor`, json("POST", { note })),
    true,
  );

/** Send the bank file to Accounts (or again once completed) -> Completed. */
export const useSettlementSendAccounts = () =>
  useBatchWrite(({ batchId, bank }: { batchId: number; bank: File }) => {
    const form = new FormData();
    form.append("bank", bank, bank.name);
    return customFetch<SettlementBatch>(`${ROOT}/batches/${batchId}/send-accounts`, { method: "POST", body: form });
  }, true);

/** Nothing approved: Completed without a bank file. */
export const useSettlementComplete = () =>
  useBatchWrite(
    ({ batchId, note }: { batchId: number; note: string }) =>
      customFetch<SettlementBatch>(`${ROOT}/batches/${batchId}/complete`, json("POST", { note })),
    true,
  );

/** The leave calendar of one request (2026-11-27): the leave days of the counted days of the month it was raised in
 *  (GET /api/advances/<id>/leave-calendar; both methods). */
export const fetchAdvanceLeaveCalendar = (advanceId: number): Promise<LeaveCalendarData> =>
  customFetch<LeaveCalendarData>(`/api/advances/${advanceId}/leave-calendar`);

/** Downloads a file the workflow sent. */
export async function downloadSettlementBatchFile(file: Pick<SettlementBatchFile, "id" | "filename">): Promise<void> {
  const blob = await customFetch<Blob>(`${ROOT}/files/${file.id}`, { responseType: "blob" });
  downloadBlob(blob, file.filename);
}

/** Settings -> Loan & Advance: the method and the e-mail addresses. A changed method changes what the Loan & Advance
 *  page is. */
export const useUpdateSettlementSettings = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SettlementSettingsInput) =>
      customFetch<SettlementSettings>(SETTINGS, { method: "PUT", body: JSON.stringify(input) }),
    onSuccess: (saved) => {
      queryClient.setQueryData(getSettlementSettingsQueryKey(), saved);
      queryClient.setQueryData(getSettlementMethodQueryKey(), { method: saved.method });
      refreshSettlementWorkflow(queryClient);
    },
  });
};
