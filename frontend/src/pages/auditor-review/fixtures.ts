// Test data for the Auditor Review Portal's tests: a settlement shaped like service.portal_json and a time card shaped
// like service.timecard_json (api/settlement_automation/service.py).

import type { LeaveCalendarData } from "@/components/leave-calendar/LeaveCalendar";
import type { PortalData, PortalItem, PortalReviewState, PortalTrailEntry, TimeCard } from "./api";

const earnings = (fixed: number, days: number, earned: number) => ({
  month: 11,
  year: 2026,
  throughDay: 20,
  fixedSalary: fixed,
  workingDays: days,
  paidDays: days,
  earnedAmount: earned,
  percent: 50,
  limit: Math.floor(earned / 2),
});

/** The effective settlement of an item from HR's final decision and the auditor's change (service.effective), and
 *  where it stands with the auditor (service.review_state at Auditor Review). */
export function settle(i: PortalItem): PortalItem {
  const a = i.auditor;
  const effective =
    a.action === "reject"
      ? { decision: "rejected" as const, amount: null, remark: a.remark }
      : i.final.decision === "approved" && a.action === "reduce" && a.amount != null
        ? { decision: "approved" as const, amount: a.amount, remark: a.remark }
        : { decision: i.final.decision, amount: i.final.amount, remark: i.final.remark };
  const review: PortalReviewState =
    i.final.decision === "rejected" || a.action === "reject"
      ? "rejected"
      : a.action === "approve" || a.action === "reduce"
        ? "approved"
        : "pending";
  return { ...i, effective, review };
}

export function portalItem(
  id: number,
  over: {
    code: string;
    name: string;
    final: PortalItem["final"]["decision"];
    amount: number | null;
    requested: number;
    leave?: { days: number; flag: "ok" | "warning" | "critical" };
    bank?: boolean;
  },
): PortalItem {
  return settle({
    id,
    advance: {
      id: 100 + id,
      employeeCode: over.code,
      employeeName: over.name,
      employeeDepartment: "Accounts",
      employeeDesignation: "Clerk",
      advanceType: "general",
      typeLabel: "Salary Advance",
      requestedAmount: over.requested,
      earnings: earnings(26000, 16, 16000),
      leaveCheck: over.leave
        ? { month: 11, year: 2026, throughDay: 20, days: over.leave.days, flag: over.leave.flag, warningAt: 3 }
        : null,
      ...(over.final === "approved"
        ? over.bank === false
          ? { bankAccount: "", bankIfsc: "", bankName: "" }
          : { bankAccount: `5000${id}`, bankIfsc: "HDFC0001234", bankName: "HDFC Bank" }
        : {}),
    },
    requestedAmount: over.requested,
    md: { decision: over.final, amount: over.amount, remark: "" },
    final: { decision: over.final, amount: over.amount, startMonth: 11, startYear: 2026, remark: "" },
    auditor: { action: null, amount: null, remark: "", at: null },
    effective: { decision: null, amount: null, remark: "" },
  });
}

/** Asha (approved ₹6,000), Ravi (approved ₹7,500.4, 3 days of leave, no IFSC) and Meena (rejected by HR, 5 days). */
export function portalData(over: Partial<PortalData> = {}): PortalData {
  const items = [
    portalItem(1, { code: "S101", name: "Asha Kumar", final: "approved", amount: 6000, requested: 8000 }),
    portalItem(2, {
      code: "S102",
      name: "Ravi Shankar",
      final: "approved",
      amount: 7500.4,
      requested: 7500.4,
      leave: { days: 3, flag: "warning" },
      bank: false,
    }),
    portalItem(3, {
      code: "S103",
      name: "Meena Iyer",
      final: "rejected",
      amount: null,
      requested: 5000,
      leave: { days: 5, flag: "critical" },
    }),
  ];
  return recount({
    company: {
      name: "UK Textiles",
      tagline: "Quality garments",
      address: "Tiruppur",
      contact: "+91 90000 00000",
      logo: null,
    },
    settlement: {
      advanceType: "general",
      typeLabel: "Salary Advance",
      month: 11,
      year: 2026,
      period: "November 2026",
      number: 1,
      title: "Salary Advance · Batch 1",
      stage: "auditor_review",
      stageLabel: "Auditor Review",
      finalizedAt: "2026-11-24T05:30:00Z",
      finalizedBy: "Priya HR",
      finalNote: "",
      mdConfirmedBy: "Managing Director",
      mdNote: "",
    },
    items,
    totals: {
      requests: 0,
      approved: 0,
      rejected: 0,
      approvedAmount: 0,
      hrApprovedAmount: 0,
      changes: 0,
      remarks: 0,
      pending: 0,
    },
    accounts: { to: ["accounts@uktextiles.in"], cc: ["md@uktextiles.in"] },
    link: { expiresAt: "2026-12-01T05:30:00Z", submittedAt: null, decision: null },
    canReview: true,
    hasChanges: false,
    ...over,
  });
}

/**
 * A Term Loan batch (the owner's bug, 2026-11-27: it was read in the Salary Advance columns, "Limit ₹6,370" = 50 % of
 * the salary earned, for a loan whose eligible limit is ₹26,000). Kavin: fixed ₹26,000, limit ₹26,000, asked ₹24,000, HR
 * approved ₹20,000 over 6 months from Dec 2026 (EMI ₹3,334, the last ₹3,330). Lakshmi: HR approved ₹10,000 over the
 * request's own 4 months from its own Jan 2027 (EMI ₹2,500). Gopal: rejected by HR.
 */
export function termPortalData(over: Partial<PortalData> = {}): PortalData {
  const term = (
    id: number,
    o: {
      code: string;
      name: string;
      final: PortalItem["final"]["decision"];
      amount: number | null;
      requested: number;
      months: number | null;
      start: [number, number] | null;
      requestMonths: number;
      requestStart: [number, number];
    },
  ): PortalItem => {
    const base = portalItem(id, {
      code: o.code,
      name: o.name,
      final: o.final,
      amount: o.amount,
      requested: o.requested,
    });
    return settle({
      ...base,
      advance: {
        ...base.advance,
        advanceType: "term",
        typeLabel: "Term Loan",
        employeeDepartment: "Cutting",
        // the earned figures a Term Loan must NOT be read by: 50 % of ₹12,740 earned = ₹6,370
        earnings: earnings(26000, 13, 12740),
        salaryAtRequest: 26000,
        termLimit: 26000,
        repaymentMonths: o.requestMonths,
        repaymentStartMonth: o.requestStart[0],
        repaymentStartYear: o.requestStart[1],
      },
      final: {
        ...base.final,
        months: o.months,
        startMonth: o.start ? o.start[0] : null,
        startYear: o.start ? o.start[1] : null,
      },
    });
  };
  const base = portalData();
  return recount({
    ...base,
    settlement: { ...base.settlement, advanceType: "term", typeLabel: "Term Loan", title: "Term Loan · Batch 1" },
    items: [
      term(1, {
        code: "T201",
        name: "Kavin Raj",
        final: "approved",
        amount: 20000,
        requested: 24000,
        months: 6,
        start: [12, 2026],
        requestMonths: 8,
        requestStart: [12, 2026],
      }),
      term(2, {
        code: "T202",
        name: "Lakshmi Devi",
        final: "approved",
        amount: 10000,
        requested: 10000,
        months: null,
        start: null,
        requestMonths: 4,
        requestStart: [1, 2027],
      }),
      term(3, {
        code: "T203",
        name: "Gopal Swamy",
        final: "rejected",
        amount: null,
        requested: 30000,
        months: null,
        start: null,
        requestMonths: 10,
        requestStart: [12, 2026],
      }),
    ],
    ...over,
  });
}

const step = (
  role: PortalTrailEntry["role"],
  round: number,
  action: string,
  amount: number | null,
  remark: string,
): PortalTrailEntry => ({
  at: role === "hr_final" ? "2026-11-24T05:30:00Z" : "2026-11-25T09:00:00Z",
  by: role === "hr_final" ? "Priya HR" : "Auditor",
  role,
  round,
  action,
  amount,
  remark,
});

/**
 * Round 2 (owner 2026-11-27: the auditor returned round 1 to HR, HR reworked it and resubmitted it; every request waits
 * for the auditor again). Round 1: Asha - HR ₹6,000, the auditor reduced it to ₹3,000, HR accepted (now ₹3,000); Ravi -
 * HR ₹7,500.4, the auditor rejected it, HR kept ₹7,500.4 with its reason; Meena - rejected by HR (no trail); Karthik - HR
 * ₹5,000, the auditor left a remark only, HR changed it to ₹4,000.
 */
export function round2PortalData(over: Partial<PortalData> = {}): PortalData {
  const base = portalData();
  const [asha, ravi, meena] = base.items;
  const karthik = portalItem(4, {
    code: "S104",
    name: "Karthik Raja",
    final: "approved",
    amount: 4000,
    requested: 5000,
  });
  return recount({
    ...base,
    settlement: {
      ...base.settlement,
      round: 2,
      resubmittedAt: "2026-11-26T04:30:00Z",
      resubmittedBy: "Priya HR",
      resubmitNote: "Took your reduction for Asha; Ravi's earlier loan is closed, so his advance stays.",
    },
    items: [
      {
        ...asha,
        final: { ...asha.final, amount: 3000, remark: "Only 8 days worked" },
        trail: [step("hr_final", 1, "approved", 6000, ""), step("auditor", 1, "reduce", 3000, "Only 8 days worked")],
      },
      {
        ...ravi,
        final: { ...ravi.final, remark: "The earlier loan closed in October" },
        trail: [
          step("hr_final", 1, "approved", 7500.4, ""),
          step("auditor", 1, "reject", null, "Loan already running"),
        ],
      },
      meena,
      {
        ...karthik,
        final: { ...karthik.final, remark: "Corrected to the days worked" },
        trail: [step("hr_final", 1, "approved", 5000, ""), step("auditor", 1, "", null, "Check the days worked")],
      },
    ],
    ...over,
  });
}

/** The leave calendar of Ravi's request (GET /api/auditor-review/<token>/leave/2): 3 days of leave in the 1st-20th. */
export const LEAVE_CALENDAR: LeaveCalendarData = {
  employee: { code: "S102", name: "Ravi Shankar" },
  month: 11,
  year: 2026,
  throughDay: 20,
  days: [
    { date: "2026-11-03", kind: "absent", label: "Absent", weight: 1 },
    { date: "2026-11-10", kind: "on_leave", label: "Approved leave", weight: 1 },
    { date: "2026-11-17", kind: "half_day_leave", label: "Half-day leave", weight: 0.5 },
    { date: "2026-11-18", kind: "half_day_leave", label: "Half-day leave", weight: 0.5 },
  ],
  holidays: [{ date: "2026-11-14", name: "Deepavali" }],
  total: 3,
  flag: "warning",
};

/** The totals and hasChanges worked out from the items, as the server does. */
export function recount(d: PortalData): PortalData {
  const items = d.items.map(settle);
  const paid = items.filter((i) => i.effective.decision === "approved");
  return {
    ...d,
    items,
    totals: {
      requests: items.length,
      approved: paid.length,
      rejected: items.length - paid.length,
      approvedAmount: paid.reduce((s, i) => s + (i.effective.amount ?? 0), 0),
      hrApprovedAmount: items.reduce((s, i) => s + (i.final.decision === "approved" ? (i.final.amount ?? 0) : 0), 0),
      changes: items.filter((i) => i.auditor.action === "reduce" || i.auditor.action === "reject").length,
      remarks: items.filter((i) => i.auditor.remark.trim()).length,
      pending: items.filter((i) => i.review === "pending").length,
    },
    hasChanges: items.some((i) => i.auditor.action === "reduce" || i.auditor.action === "reject"),
  };
}

export const TIMECARD: TimeCard = {
  employee: {
    code: "S101",
    name: "Asha Kumar",
    department: "Accounts",
    designation: "Clerk",
    type: "staff",
    joinDate: "2024-01-10",
  },
  shift: { name: "General", startTime: "09:00", endTime: "18:00" },
  month: 11,
  year: 2026,
  days: [
    {
      date: "2026-11-01",
      day: "Sun",
      status: "holiday",
      shiftsEarned: "0.00",
      firstPunch: null,
      lastPunch: null,
      isSunday: true,
      holidayName: null,
    },
    {
      date: "2026-11-02",
      day: "Mon",
      status: "present",
      isLate: true,
      shiftsEarned: "1.00",
      firstPunch: "09:12",
      lastPunch: "18:02",
      isSunday: false,
      holidayName: null,
    },
    {
      date: "2026-11-03",
      day: "Tue",
      status: "absent",
      shiftsEarned: "0.00",
      firstPunch: null,
      lastPunch: null,
      isSunday: false,
      holidayName: null,
    },
    {
      date: "2026-11-14",
      day: "Sat",
      status: "holiday",
      shiftsEarned: "1.00",
      firstPunch: null,
      lastPunch: null,
      isSunday: false,
      holidayName: "Deepavali",
    },
    {
      date: "2026-11-24",
      day: "Tue",
      status: "half_shift",
      earlyLeave: true,
      shiftsEarned: "0.50",
      firstPunch: "09:00",
      lastPunch: "13:00",
      isSunday: false,
      holidayName: null,
    },
  ],
  summary: {
    totalDays: 30,
    workingDays: 26,
    present: 20,
    halfShift: 1,
    absent: 2,
    onLeave: 1,
    holidays: 4,
    late: 3,
    totalShifts: "21.50",
    effectiveDays: "20.5",
    inProgressDays: 0,
  },
  earnings: earnings(26000, 16, 16000),
  leaveCheck: { month: 11, year: 2026, throughDay: 20, days: 1, flag: "ok", warningAt: 3 },
};
