// The shapes of GET /api/md/recruitment/* (backend: api/md_portal/analytics/recruitment.py). Every response also carries
// the shared envelope (generatedAt, period, scope, provenance, notes).

import type { MdEnvelope, MdInsightDto, MdPeriod } from "@/lib/md/types";

/** The part of a TanStack query result the page's sections read, so a section can be tested with a plain object. */
export type QueryLike<T> = {
  data: T | undefined;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
};

/** A change against the previous period: `abs` in the figure's own unit, `pct` null when the previous figure was 0. */
export type Change = { abs: number; pct: number | null } | null;

export type SummaryChangeKey =
  | "candidatesReceived"
  | "candidatesSelected"
  | "interviewsHeld"
  | "joiners"
  | "leavers"
  | "net"
  | "resignationsRaised"
  | "attritionPct";

export type SummaryCurrent = {
  // where hiring stands today (not tied to the period)
  openPositions: number;
  vacancies: number | null;
  departmentsWithGap: number | null;
  stalePositions: number;
  avgOpenDays: number | null;
  oldestOpenDays: number | null;
  /** Always null: the system does not record when a position is filled. */
  avgTimeToFillDays: number | null;
  applicantsInPipeline: number;
  pipelineJobBoard: number;
  pipelineScreening: number;
  interviewsNext7Days: number;
  interviewsToday: number;
  resignationsPending: number;
  oldestPendingDays: number | null;
  onNotice: number;
  leaversNext30: number;
  // what happened in the period
  candidatesReceived: number;
  candidatesSelected: number;
  interviewsHeld: number;
  joiners: number;
  joinersStaff: number;
  joinersProduction: number;
  leavers: number;
  leaversResigned: number;
  leaversDeactivated: number;
  earlyLeavers: number;
  net: number;
  resignationsRaised: number;
  attritionPct: number | null;
  attritionAnnualisedPct: number | null;
  averageHeadcount: number | null;
};

export type RecruitmentSummary = MdEnvelope & {
  current: SummaryCurrent;
  previous: Record<SummaryChangeKey, number | null>;
  changes: Record<SummaryChangeKey, Change>;
  previousPeriod: MdPeriod;
  /** The named lines the server judges by, so the page never hard-codes a business rule. */
  thresholds: {
    staleAfterDays: number;
    pipelineActiveDays: number;
    earlyAttritionDays: number;
    resignationWarnAfterDays: number;
  };
};

export type RecruitmentAttention = MdEnvelope & { items: MdInsightDto[] };

// ─── funnel ───

export type FunnelStageId = "applied" | "screened" | "shortlisted" | "interviewed" | "offered" | "joined";

export type FunnelStage = {
  id: FunnelStageId;
  label: string;
  /** null = this view cannot answer the step (not 0: an unknown is not a loss). */
  count: number | null;
  previousCount: number | null;
  previousLabel: string | null;
  ofPrevious: number | null;
  dropOff: number | null;
  dropOffPct: number | null;
  note: string | null;
};

export type FunnelView = "all" | "jobBoard" | "screening";

export type FunnelDepartmentRow = {
  departmentId: number | null;
  department: string;
  applied: number;
  screened: number;
  shortlisted: number;
  interviewed: number;
  offered: number;
  joined: number;
};

export type RecruitmentFunnel = MdEnvelope & {
  stages: FunnelStage[];
  views: { jobBoard: FunnelStage[]; screening: FunnelStage[] };
  byDepartment: FunnelDepartmentRow[];
  departmentsShown: number;
  departmentsTotal: number;
  joiners: { total: number; staff: number; production: number; linked: boolean };
};

export type SourceChannel = {
  id: string;
  label: string;
  candidates: number;
  progressed: number;
  progressedPct: number | null;
  progressedLabel: string;
  detail: string | null;
};

export type RecruitmentSources = MdEnvelope & { channels: SourceChannel[]; total: number; channelsRecorded: number };

// ─── positions ───

export type StageMix = { applied: number; attended: number; selected: number; rejected: number; other: number };

export type OpenPosition = {
  id: number;
  title: string;
  departmentId: number | null;
  department: string | null;
  unit: string | null;
  postedOn: string;
  daysOpen: number;
  stale: boolean;
  applicants: number;
  stageMix: StageMix;
  salaryRange: string | null;
};

export type GapRow = {
  departmentId: number;
  department: string;
  unit: string;
  required: number;
  current: number;
  vacancy: number;
  surplus: number;
  fillPct: number | null;
  openJobs: number;
  shortlisted: number;
};

export type RecruitmentPositions = MdEnvelope & {
  summary: {
    open: number;
    stale: number;
    avgOpenDays: number | null;
    oldestOpenDays: number | null;
    withApplicants: number;
    staleAfterDays: number;
    avgTimeToFillDays: number | null;
  };
  positions: OpenPosition[];
  positionsShown: number;
  headcountGap: {
    applicable: boolean;
    required: number | null;
    current: number | null;
    vacancies: number | null;
    surplus: number | null;
    departmentsWithGap: number | null;
    departments: GapRow[];
    departmentsTotal: number;
  };
};

// ─── resignations ───

export type PendingResignation = {
  id: number;
  employeeId: number;
  employeeName: string;
  department: string;
  departmentId: number | null;
  designation: string | null;
  requestedOn: string;
  daysWaiting: number;
  lastWorkingDate: string | null;
  noticeDays: number | null;
  daysToLastDay: number | null;
  status: string;
  waitingFor: string[];
  waitingForText: string;
};

export type OnNoticeRow = {
  id: number;
  employeeId: number;
  employeeName: string;
  department: string;
  departmentId: number | null;
  designation: string | null;
  approvedOn: string | null;
  lastWorkingDate: string;
  daysLeft: number;
};

export type ReasonRow = { id: string; label: string; count: number; pct: number | null };

export type ResignationDepartmentRow = {
  department: string;
  departmentId: number | null;
  raised: number;
  pending: number;
  approved: number;
  rejected: number;
};

export type OutlookWindow = { days: number; approved: number; pending: number; total: number };

export type RecruitmentResignations = MdEnvelope & {
  summary: {
    pending: number;
    oldestPendingDays: number | null;
    waitingOn: { label: string; count: number }[];
    onNotice: number;
    raised: number;
    approved: number;
    rejected: number;
    stillPending: number;
    avgDaysToDecision: number | null;
    warnAfterDays: number;
  };
  pending: PendingResignation[];
  pendingShown: number;
  onNotice: OnNoticeRow[];
  onNoticeShown: number;
  reasons: ReasonRow[];
  byDepartment: ResignationDepartmentRow[];
  outlook: {
    next30: OutlookWindow;
    next60: OutlookWindow;
    withoutDate: number;
    byDepartment: { department: string; departmentId: number | null; count: number }[];
  };
};

// ─── joiners and trend ───

export type JoinerRow = {
  employeeId: number;
  employeeName: string;
  department: string;
  designation: string | null;
  unit: string;
  type: string | null;
  joinDate: string;
  active: boolean;
  /** Required documents still missing; null for someone who has already left. */
  docsMissing: number | null;
};

export type EarlyLeaverRow = {
  employeeId: number;
  employeeName: string;
  department: string;
  joinDate: string;
  exitDate: string;
  daysServed: number;
  approximate: boolean;
};

export type RecruitmentJoiners = MdEnvelope & {
  summary: {
    joiners: number;
    staff: number;
    production: number;
    stillActive: number;
    leftSinceJoining: number;
    docsPending: number;
    withoutJoinDate: number;
  };
  list: JoinerRow[];
  listShown: number;
  byDepartment: { department: string; joiners: number }[];
  byUnit: { unit: string; joiners: number }[];
  earlyAttrition: {
    windowDays: number;
    leavers: number;
    totalLeavers: number;
    pct: number | null;
    list: EarlyLeaverRow[];
    listShown: number;
    byDepartment: { department: string; leavers: number }[];
  };
};

export type TrendMonth = {
  /** "2026-09" */
  month: string;
  label: string;
  /** The current month: the month so far. */
  partial: boolean;
  joiners: number;
  leavers: number;
  net: number;
  headcount: number;
  staffHeadcount: number | null;
  vacancies: number | null;
};

export type RecruitmentTrend = MdEnvelope & {
  months: TrendMonth[];
  required: number | null;
  totals: { joiners: number; leavers: number; net: number };
};
