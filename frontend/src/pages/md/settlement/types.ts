// MD portal -> Settlement: what the server sends (backend api/md_portal/routes/settlement.py, the rules and the batch JSON in
// api/settlement_automation/service.py). The MD's step of the Settlement Automation Method: HR forwards a batch of the
// month's Salary Advance / Term Loan requests, the MD approves (the asked amount or less) or rejects each one, then
// Confirm & Proceed sends the batch back to HR for the final settlement.

/** Salary Advance ("general") and Term Loan ("term") run independent workflows (owner 2026-11-27): a batch is of one type. */
export type AdvanceType = "general" | "term";

export type SettlementStage =
  | "hr_review"
  | "md_review"
  /** HR Rework (MD Changes) (2026-11-27): the MD returned the batch to HR; HR answers and resubmits it to the MD. */
  | "md_changes"
  | "hr_final"
  | "auditor_send"
  | "auditor_review"
  | "auditor_changes"
  | "accounts_send"
  | "completed";

/** "skipped": a stage the batch went past without it (HR Final Settlement when the MD finalized it directly; HR Review of
 *  Auditor Changes when the auditor changed nothing). */
export type TrackerState = "done" | "current" | "pending" | "skipped";

/** One of the stages of a batch (nine since the Auditor Review Portal): when it was done and by whom, or what to do at the current one. */
export type TrackerStep = {
  key: string;
  label: string;
  state: TrackerState;
  at: string | null;
  by: string | null;
  action: string | null;
  /** What happened there ("Finalized directly by the MD", "Approved by the auditor"). */
  detail?: string | null;
  /** A rework loop (md_changes / auditor_changes) and how many times the batch went round it (2026-11-27). */
  loop?: boolean;
  cycles?: number | null;
  /** md_review / auditor_review: the review round (2+ = a revised settlement). */
  round?: number | null;
};

/** The branching tracker's facts (2026-11-27): rounds, rework cycles, the MD's path, who sent the bank file. */
export type SettlementFlow = {
  mdRound: number;
  auditorRound: number;
  mdCycles: number;
  auditorCycles: number;
  mdPath: "hr" | "direct" | null;
  accountsVia: "hr" | "auditor" | null;
  /** The MD's latest Return to HR for rework, with their instructions. */
  mdReturn: { at: string; by: string | null; note: string } | null;
};

/** Where a request stands with the reviewer of the batch's stage: waiting ones at the top, then approved, then rejected. */
export type ReviewState = "pending" | "approved" | "rejected";

/** One earlier decision on a request, kept when a rework round replaced it. */
export type TrailEntry = {
  at: string;
  by: string;
  role: "hr" | "md" | "hr_final" | "auditor";
  round: number;
  action: string;
  amount: number | null;
  remark: string;
};

export type LeaveFlag = "ok" | "warning" | "critical";

/** Absent days + approved leave on the working days of the 1st-20th of the month the request was raised in (not Casual
 *  Leave). Exactly 3 days = warning (orange), more = critical (red). null until it is worked out. */
export type LeaveCheck = {
  month: number;
  year: number;
  throughDay: number;
  days: number;
  flag: LeaveFlag | null;
  warningAt: number;
};

/** The salary earned from the 1st to the 20th of the month raised in, and the 50 % Salary Advance limit taken from it. */
export type AdvanceEarnings = {
  month: number;
  year: number;
  throughDay: number;
  fixedSalary: number | null;
  /** The paid days of the 1st-20th (present shifts + company holidays). */
  workingDays: number;
  presentShifts?: number;
  holidayDays?: number;
  paidDays: number;
  earnedAmount: number;
  workingSalary: number;
  percent: number;
  limit: number | null;
  workedOutOn: string | null;
};

/** The advance itself (the server's advance_json, MD view: no bank details). Only the fields this page reads. */
export type SettlementAdvance = {
  id: number;
  employeeId: number;
  employeeCode: string | null;
  employeeName: string;
  employeeDepartment: string | null;
  employeeDesignation: string | null;
  employeeBranch: string | null;
  employeeType?: string | null;
  advanceType: string;
  /** "Salary Advance" | "Term Loan". */
  typeLabel?: string;
  amount: number;
  purpose: string | null;
  status: string;
  repaymentStartMonth: number | null;
  repaymentStartYear: number | null;
  repaymentMonths: number | null;
  emiAmount: number | null;
  createdAt: string | null;
  requestedAmount: number | null;
  salaryAtRequest: number | null;
  appliedBy?: string | null;
  earnings: AdvanceEarnings | null;
  limitRemark?: string;
  leaveCheck: LeaveCheck | null;
  /** A Term Loan's limit (the monthly salary x the Settings %), kept when it was raised. */
  termLimit?: number | null;
};

export type MdDecision = "approved" | "rejected";

/** A Salary Advance's rounding (owner 2026-11-27, service.rounding_json): what was asked, brought down to the eligible
 *  limit when above it, then rounded to the nearest ₹500 (₹250 and up rounds up), never above the limit. Frozen when HR
 *  forwards the batch. */
export type SettlementRounding = {
  requested: number;
  /** The eligible limit (null: none known). */
  limit: number | null;
  /** The rounded amount: the MD's full approval. */
  rounded: number;
  /** Asked for more than the limit: brought down to it first. */
  capped: boolean;
  direction: "up" | "down" | "same";
  /** Rounds to ₹0 within the limit: it can only be rejected. */
  zero: boolean;
};

export type SettlementItem = {
  id: number;
  advance: SettlementAdvance;
  /** What the employee asked for (never the rounded amount). */
  requestedAmount: number;
  /** The Salary Advance rounding (2026-11-27); null for a Term Loan / an older batch, absent from an older server. */
  rounding?: SettlementRounding | null;
  /** The workflow's "as asked" amount (2026-11-27): a Salary Advance's rounded amount, else what was asked. The MD's
   *  full approval is this amount, and no approval may be above it. */
  baseAmount?: number;
  hrNote: string;
  /** HR's review proposal (2026-11-27): reduce (to `amount`) or reject; approve / null = kept as asked; `remark` is
   *  HR's note. */
  hr?: { action: "approve" | "reduce" | "reject" | null; amount: number | null; remark: string };
  /** Where it stands with the MD now (pending = waiting for the MD's own decision, incl. HR's proposals to confirm). */
  review?: ReviewState;
  /** Flagged for HR's rework (the batch went back to HR) and not answered yet. */
  rework?: "md" | "auditor" | null;
  /** The MD's own decision differs from HR's proposal: the MD cannot approve, they return the settlement to HR. */
  mdChanged?: boolean;
  /** The MD wrote their own remark on it. */
  mdRemarked?: boolean;
  /** The earlier rounds' decisions on it (HR's proposal and the MD's decision of each returned round). */
  trail?: TrailEntry[];
  md: {
    decision: MdDecision | null;
    amount: number | null;
    remark: string;
    decidedAt: string | null;
    /** Pre-filled from HR's proposal at Forward, not yet confirmed by the MD's own click. */
    fromHr?: boolean;
  };
  final: {
    decision: MdDecision | null;
    amount: number | null;
    startMonth: number | null;
    startYear: number | null;
    remark: string;
    changedFromMd: boolean;
    /** A Term Loan's months as finalized (null: the request's own). */
    months?: number | null;
  };
  /** The auditor's change in the Auditor Review Portal (a smaller amount or a rejection) and its remark. */
  auditor?: {
    action: "approve" | "reduce" | "reject" | null;
    amount: number | null;
    remark: string;
    at: string | null;
  };
  /** The settlement as it will be paid: the final decision with the auditor's change on top. */
  effective?: { decision: MdDecision | null; amount: number | null; remark: string };
  applied: boolean;
};

/** One step of a batch's history; the extras depend on the action (count, approved, rejected, total, to, cc). */
export type HistoryEntry = {
  at: string;
  by: string;
  action: string;
  note?: string;
  count?: number;
  approved?: number;
  rejected?: number;
  total?: number;
  /** md_returned / md_resubmitted: the review round; md_returned: how many requests were changed / remarked. */
  round?: number;
  changes?: number;
  remarks?: number;
  /** md_confirmed: sent directly to the auditor; finalized / accounts_sent: who did it. */
  direct?: boolean;
  via?: string;
  [extra: string]: unknown;
};

export type BatchActions = {
  canDecideMd: boolean;
  /** Every request decided and no change from HR's proposals (2026-11-27). */
  canConfirmMd: boolean;
  /** Return to HR for rework (changes or corrections). */
  canReturnMd?: boolean;
  [action: string]: boolean | undefined;
};

export type SettlementBatch = {
  id: number;
  /** Since 2026-11-27 every batch is of one type (older replies had none). */
  advanceType?: AdvanceType;
  typeLabel?: string;
  /** "Salary Advance · Batch 1". */
  title?: string;
  month: number;
  year: number;
  number: number;
  label: string;
  stage: SettlementStage;
  stageLabel: string;
  nextAction: string;
  tracker: TrackerStep[];
  /** The branching tracker's facts (2026-11-27; absent from an older server). */
  flow?: SettlementFlow;
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
    /** With the stage's reviewer (2026-11-27): waiting, approved, rejected. */
    pending?: number;
    reviewedApproved?: number;
    reviewedRejected?: number;
    /** The MD's decisions that differ from HR's proposals. */
    mdChanges?: number;
    /** Requests waiting for HR's rework answer. */
    rework?: number;
  };
  /** `rounded`: the "as asked" total after the Salary Advance rounding (2026-11-27; = requested for a Term Loan). */
  amounts: { requested: number; rounded?: number; mdApproved: number; finalApproved: number; payable?: number };
  forwardedAt: string | null;
  forwardedBy: string | null;
  hrNote: string;
  mdConfirmedAt: string | null;
  mdConfirmedBy: string | null;
  mdNote: string;
  finalizedAt: string | null;
  finalizedBy: string | null;
  finalNote: string;
  completedAt: string | null;
  /** "md" when the MD finalized it directly (Direct to Auditor), "hr" when HR did. */
  finalizedVia?: "md" | "hr" | null;
  /** What happened to the batch, oldest first (forwarded, md_confirmed, finalized, auditor_sent ...). */
  history?: HistoryEntry[];
  items: SettlementItem[];
  actions: BatchActions;
};

/** GET /api/md/settlement/month: the month's forwarded batches (a batch still at HR Review is left out). */
export type MdSettlementMonth = {
  method: "normal" | "automation";
  /** The type asked for (?type=); the batches are all of it. */
  advanceType?: AdvanceType;
  typeLabel?: string;
  /** Requests of each type waiting for the MD in this month (the type dropdown's counts). */
  waitingByType?: Record<AdvanceType, number>;
  month: number;
  year: number;
  isCurrentMonth: boolean;
  received: number;
  currentBatchId: number | null;
  batches: SettlementBatch[];
  /** A batch of this month is still at HR Review (HR has not forwarded it yet). */
  waitingForHr: boolean;
};

export type WaitingBatch = {
  id: number;
  advanceType?: AdvanceType;
  typeLabel?: string;
  month: number;
  year: number;
  number: number;
  requests: number;
  forwardedAt: string | null;
  forwardedBy: string | null;
};

/** GET /api/md/settlement/waiting: the batches at MD Review; `count` = the requests in them. */
export type MdSettlementWaiting = {
  method: "normal" | "automation";
  count: number;
  /** The requests waiting, per type (all months). */
  byType?: Record<AdvanceType, number>;
  batches: WaitingBatch[];
};

/** PATCH /api/md/settlement/items/<id>: an empty decision clears it; no amount = the full amount asked (a Salary
 *  Advance's rounded amount). */
export type DecideBody = { decision: MdDecision | ""; amount?: number; remark?: string };

/** POST /api/md/settlement/batches/<id>/bulk: several requests at once; the reply is the batch and the requests left out. */
export type BulkBody = { itemIds: number[]; decision: MdDecision; remark?: string };
export type BulkReply = SettlementBatch & { skipped?: { id: number; reason: string }[] };

/** POST /api/md/settlement/batches/<id>/confirm: Forward to HR, or Direct to Auditor (with the finalized report). */
export type ConfirmMode = "hr" | "direct";
export type ConfirmReply = SettlementBatch & { warning?: string | null };

/** POST /api/md/settlement/batches/<id>/return {note}: changes or corrections - the settlement goes back to HR for
 *  rework (2026-11-27); refused (no_changes) without a change, a remark of the MD's or a note. */
export type ReturnBody = { note: string };
