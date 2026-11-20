import type {
  AllowanceStatus,
  OvertimeAssignBody,
  OvertimeClaim,
  OvertimeConfig,
  OvertimeMode,
  OvertimeRow,
  OvertimeSkipped,
  OtClaimKind,
  RaiseOtClaimsBody,
  ShiftsValue,
} from "@/lib/api-client/custom-hooks";
import { ApiError } from "@/lib/api-client/custom-fetch";
import type { Tone } from "@/lib/statusTones";
import { formatDuration } from "@/pages/hr/settings/compensation/time";
import {
  dateShort,
  isIsoDate,
  isShiftsValue,
  matchesText,
  monthBounds,
  monthYear,
  parseIso,
  problemsOf,
  sameMonth,
  shiftsText,
  sumShifts,
  fmtShifts,
} from "../logic";
import { claimLink } from "../leave/leave-url";

// The rules of the OT Detection tab as pure functions: how the month's records are split into the Type 1 list, the Type 2
// candidates and the history, the tiles, the filters, where each record stands in the claim workflow, and everything the
// Claim and Assign dialogs decide (what they start with, what is wrong with them, what they send, what they say).

/** One record is one employee on one OT day. */
export const rowKey = (r: { employeeId: number; date: string }): string => `${r.employeeId}|${r.date}`;

// ── The claim workflow ────────────────────────────────────────────────────────
// From the claims date (Settings -> Compensation, set once by the server) an OT record gives nothing on its own: the
// employee (in the apps) or HR (here) claims it, the employee's Department Head approves, and only then is a Type 1
// allowance applied to the next working day or a Type 2 credit added to the balance. Records before that date keep the old
// rules (Type 1 automatic, Type 2 assigned by HR).

/** The claims date (YYYY-MM-DD) from the first source that has one; null when the server says nothing (an older backend). */
export function claimsFromOf(...sources: (string | null | undefined)[]): string | null {
  for (const source of sources) {
    const day = (source ?? "").slice(0, 10);
    if (isIsoDate(day)) return day;
  }
  return null;
}

/** Is this record under the claim workflow (on or after the claims date, or already claimed)? */
export function inClaimFlow(
  row: Pick<OvertimeRow, "date" | "claim" | "claimable">,
  claimsFrom: string | null,
): boolean {
  if (row.claim) return true;
  if (claimsFrom) return row.date >= claimsFrom;
  return row.claimable === true;
}

/** A claim waiting for the Department Head or approved: the record cannot be claimed again, paid or rejected. */
export const hasOpenClaim = (row: Pick<OvertimeRow, "claim">): boolean =>
  row.claim?.status === "pending" || row.claim?.status === "approved";

/** A Type 2 record whose claim was approved: its shifts are in the employee's balance. */
export const isCredited = (row: Pick<OvertimeRow, "otType" | "claim">): boolean =>
  row.otType === "shift" && row.claim?.status === "approved";

/** Can it be claimed for the employee right now (the server says so, and nothing is open)? */
export const canClaim = (row: Pick<OvertimeRow, "claimable" | "claim">): boolean =>
  row.claimable === true && !hasOpenClaim(row);

type CreditFacts = Pick<OvertimeRow, "creditShifts" | "suggestedShifts" | "creditRule" | "claimRules">;

/**
 * Type 2: does the credit follow the quarters rule? The server says so (`creditRule`); without it, a record that sends a
 * `creditShifts` key and is not marked as before the claims date. A record before the claims date (or with the quarters
 * rule off, or no known shift) sends `creditShifts: null`: that is NOT "below a quarter", its credit is the ladder's.
 */
export function quartersRuleApplies(row: CreditFacts): boolean {
  if (row.creditRule) return row.creditRule === "quarters";
  return row.creditShifts !== undefined && row.claimRules !== false;
}

/** Type 2: the shifts a claim starts on: the quarters-rule credit, else the older ladder's suggestion. */
export function creditOf(row: CreditFacts): number | null {
  if (quartersRuleApplies(row)) return row.creditShifts ?? null;
  return row.suggestedShifts;
}

/** Where a record's claim is shown: the Claims list of Compensation Leave (every month of that employee), its drawer open. */
export const claimHref = (claim: Pick<OvertimeClaim, "id">, employeeId: number): string =>
  claimLink(claim.id, employeeId);

/** "by HR" / "by the employee". */
export const raisedByText = (claim: Pick<OvertimeClaim, "raisedByRole">): string =>
  claim.raisedByRole === "employee" ? "by the employee" : "by HR";

export type ClaimChip = { text: string; tone: Tone; title: string };

/** A claim's status as a chip: its words, its colour, and a sentence for the tooltip. */
export function claimChip(claim: OvertimeClaim): ClaimChip {
  const who = `Raised ${raisedByText(claim)}`;
  const hod = claim.hodName ? claim.hodName : "the Department Head";
  if (claim.status === "approved") {
    return { text: "Claim approved", tone: "success", title: `${who}; approved by ${hod}.` };
  }
  if (claim.status === "rejected") {
    return { text: "Claim rejected", tone: "danger", title: `${who}; rejected by ${hod}.` };
  }
  return { text: "Claim pending", tone: "warning", title: `${who}; waiting for ${hod} to decide.` };
}

export type OtGroups = {
  /** Type 1: every detected allowance (claimable, claimed, used ...). */
  allowance: OvertimeRow[];
  /** Type 2 records not decided yet: claimable, claimed and waiting for the HOD, or waiting for HR to pay or reject. */
  waiting: OvertimeRow[];
  /** Type 2 already decided: paid or assigned by HR, rejected, or credited by an approved claim. */
  history: OvertimeRow[];
  /** Records made before the new rules, with their old meaning. */
  legacy: OvertimeRow[];
};

export function groupOt(rows: OvertimeRow[]): OtGroups {
  const groups: OtGroups = { allowance: [], waiting: [], history: [], legacy: [] };
  for (const row of rows) {
    if (row.otType === "allowance") groups.allowance.push(row);
    else if (row.otType === "legacy") groups.legacy.push(row);
    else if (isCredited(row)) groups.history.push(row);
    else if (row.status === "detected") groups.waiting.push(row);
    else groups.history.push(row);
  }
  return groups;
}

/**
 * The shifts a record stands for: what HR assigned, or what an approved claim credited; an older announced record is one
 * day (one shift) whatever its mode.
 */
export function shiftsOf(row: OvertimeRow): number | null {
  if (isCredited(row) && row.claim?.shifts != null) return row.claim.shifts;
  if (row.shifts !== null && row.shifts !== undefined) return row.shifts;
  if (row.otType === "legacy" && row.status === "announced") return 1;
  return null;
}

/**
 * Where a Type 1 allowance stands: the server's `allowanceStatus`. A backend that does not send it is read from
 * `allowanceUsed` (used, else not used).
 */
export function allowanceStatusOf(row: Pick<OvertimeRow, "allowanceStatus" | "allowanceUsed">): AllowanceStatus {
  if (row.allowanceStatus) return row.allowanceStatus;
  return row.allowanceUsed ? "used" : "not_used";
}

export type OtKpis = {
  allowanceEarned: number;
  allowanceMinutes: number;
  allowanceUsed: number;
  allowanceUsedMinutes: number;
  /** The next working day has come and the employee did not need the allowance (approved, or automatic before the claims date). */
  allowanceNotUsed: number;
  /** The next working day is today or later: nothing can be said yet. */
  allowancePending: number;
  /** Claim workflow: allowances that can be claimed now, and claims waiting for the Department Head. */
  allowanceClaimable: number;
  allowanceClaimPending: number;
  waiting: number;
  waitingSuggestedShifts: number;
  /** Type 2 records still waiting whose claim is with the Department Head. */
  waitingClaimPending: number;
  /** Paid or assigned by HR. */
  assigned: number;
  assignedShifts: number;
  assignedRelaxation: number;
  assignedPay: number;
  /** Type 2 credited to the balance by an approved claim. */
  credited: number;
  creditedShifts: number;
  rejected: number;
};

/**
 * The figures of the tiles, over every record of the month (the filters do not change them). `claimsFrom` tells a Type 1
 * allowance under the claim workflow (it is "used" or "not used" only once its claim is approved) from an automatic one.
 */
export function otKpis(rows: OvertimeRow[], claimsFrom: string | null = null): OtKpis {
  const kpis: OtKpis = {
    allowanceEarned: 0,
    allowanceMinutes: 0,
    allowanceUsed: 0,
    allowanceUsedMinutes: 0,
    allowanceNotUsed: 0,
    allowancePending: 0,
    allowanceClaimable: 0,
    allowanceClaimPending: 0,
    waiting: 0,
    waitingSuggestedShifts: 0,
    waitingClaimPending: 0,
    assigned: 0,
    assignedShifts: 0,
    assignedRelaxation: 0,
    assignedPay: 0,
    credited: 0,
    creditedShifts: 0,
    rejected: 0,
  };
  const assignedShifts: (number | null)[] = [];
  const creditedShifts: (number | null)[] = [];
  const suggested: (number | null)[] = [];
  for (const row of rows) {
    if (row.otType === "allowance") {
      kpis.allowanceEarned += 1;
      kpis.allowanceMinutes += row.allowanceMinutes ?? 0;
      const standing = allowanceStatusOf(row);
      const claimed = inClaimFlow(row, claimsFrom);
      if (standing === "used") {
        kpis.allowanceUsed += 1;
        kpis.allowanceUsedMinutes += row.usedMinutes ?? 0;
      } else if (claimed && row.claim?.status !== "approved") {
        // not given yet: it waits for a claim or for the Department Head
        if (row.claim?.status === "pending") kpis.allowanceClaimPending += 1;
        else if (canClaim(row)) kpis.allowanceClaimable += 1;
      } else if (standing === "pending") {
        kpis.allowancePending += 1;
      } else {
        kpis.allowanceNotUsed += 1;
      }
    } else if (row.otType === "shift" && isCredited(row)) {
      kpis.credited += 1;
      creditedShifts.push(row.claim?.shifts ?? creditOf(row));
    } else if (row.otType === "shift" && row.status === "detected") {
      // an older record still waiting is not a Type 2 candidate: it is listed under Earlier records
      kpis.waiting += 1;
      suggested.push(creditOf(row));
      if (row.claim?.status === "pending") kpis.waitingClaimPending += 1;
    } else if (row.status === "announced") {
      kpis.assigned += 1;
      assignedShifts.push(shiftsOf(row));
      if (row.compensationType === "relaxation") kpis.assignedRelaxation += 1;
      if (row.compensationType === "pay") kpis.assignedPay += 1;
    } else if (row.status === "rejected") {
      kpis.rejected += 1;
    }
  }
  kpis.assignedShifts = sumShifts(assignedShifts);
  kpis.creditedShifts = sumShifts(creditedShifts);
  kpis.waitingSuggestedShifts = sumShifts(suggested);
  return kpis;
}

// ── Filters ───────────────────────────────────────────────────────────────────

export type OtFilters = { q: string; dept: string };

/** Search by name, code or department; `dept` is a department's name ("" = every department). */
export function filterOt(rows: OvertimeRow[], { q, dept }: OtFilters): OvertimeRow[] {
  return rows.filter(
    (r) =>
      (dept === "" || (r.department ?? "") === dept) && matchesText(q, r.employeeName, r.employeeCode, r.department),
  );
}

/** The departments that occur in the month's records, sorted. */
export function otDepartments(rows: OvertimeRow[]): string[] {
  return [...new Set(rows.map((r) => r.department).filter((d): d is string => !!d))].sort((a, b) =>
    a.localeCompare(b, "en", { sensitivity: "base", numeric: true }),
  );
}

export type HistoryStatus = "all" | "assigned" | "credited" | "rejected";
export const HISTORY_STATUSES: { value: HistoryStatus; label: string }[] = [
  { value: "assigned", label: "Assigned" },
  { value: "credited", label: "Credited by claim" },
  { value: "rejected", label: "Rejected" },
];

export const isHistoryStatus = (value: string): value is HistoryStatus =>
  value === "all" || value === "assigned" || value === "credited" || value === "rejected";

/** The Type 2 history by status (a record credited by an approved claim is "credited", never "assigned"). */
export function filterHistory(rows: OvertimeRow[], status: HistoryStatus): OvertimeRow[] {
  if (status === "assigned") return rows.filter((r) => r.status === "announced" && !isCredited(r));
  if (status === "credited") return rows.filter(isCredited);
  if (status === "rejected") return rows.filter((r) => r.status === "rejected" && !isCredited(r));
  return rows;
}

/** Type 1: where an allowance stands, as the status filter and the Status column name it. */
export type Type1Status =
  "claimable" | "claim_pending" | "approved" | "rejected" | "used" | "not_used" | "unclaimed" | "pending";

/** The Type 1 status filter (`?ot1status=`). "Approved" also holds an older automatic allowance whose day has not come. */
export const TYPE1_STATUSES: { value: Type1Status; label: string }[] = [
  { value: "claimable", label: "Claimable" },
  { value: "claim_pending", label: "Claim pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Claim rejected" },
  { value: "used", label: "Used" },
  { value: "not_used", label: "Not used" },
  { value: "unclaimed", label: "Not claimed" },
];

export const isType1Filter = (value: string): value is Type1Status => TYPE1_STATUSES.some((s) => s.value === value);

/** The Type 1 rows of one status ("" or "all" = every row). */
export function filterType1(rows: OvertimeRow[], status: string, claimsFrom: string | null): OvertimeRow[] {
  if (!isType1Filter(status)) return rows;
  return rows.filter((r) => {
    const s = type1State(r, claimsFrom).status;
    return s === status || (status === "approved" && s === "pending");
  });
}

// ── Words ─────────────────────────────────────────────────────────────────────

export type Type1State = {
  status: Type1Status;
  /** The words of the Status column. */
  text: string;
  tone: Tone;
  /** One sentence for the tooltip and a screen reader. */
  title: string;
};

const TYPE1_AUTO_TITLE = {
  used: "Automatic (before the claim workflow): the employee arrived late within the allowance, so that morning is marked Compensation.",
  not_used: "Automatic (before the claim workflow): the next working day has come and the employee did not need it.",
  pending:
    "Automatic (before the claim workflow): the employee's next working day is today or later, so it cannot be said yet whether it is used.",
} as const;

/**
 * Where a Type 1 allowance stands. Before the claims date it is automatic: used, not used or pending (never "Not used"
 * before its day has come). From the claims date it gives nothing until a claim is approved: claimable, claim pending,
 * claim rejected or not claimed; once approved it applies to the next working day, then is used or not used.
 */
export function type1State(row: OvertimeRow, claimsFrom: string | null): Type1State {
  const use = allowanceUseText(row);
  if (!inClaimFlow(row, claimsFrom)) {
    const tone = use.status === "used" ? "success" : use.status === "pending" ? "info" : "neutral";
    return { status: use.status, text: use.text, tone, title: TYPE1_AUTO_TITLE[use.status] };
  }
  const claim = row.claim ?? null;
  if (claim?.status === "approved") {
    if (use.status === "used") {
      return { status: "used", text: use.text, tone: "success", title: `Claim approved; ${use.text.toLowerCase()}.` };
    }
    if (use.status === "not_used") {
      return {
        status: "not_used",
        text: "Approved · not used",
        tone: "neutral",
        title: "The claim was approved, but on the next working day the employee did not need the allowance.",
      };
    }
    const day = row.appliesOn ? dateShort(row.appliesOn) : "the next working day";
    return {
      status: "approved",
      text: `Approved · applies on ${day}`,
      tone: "info",
      title: `The Department Head approved it: the first punch of ${day} may be up to ${row.allowanceMinutes} minutes later without a Late mark.`,
    };
  }
  if (claim?.status === "pending") {
    const chip = claimChip(claim);
    return { status: "claim_pending", text: "Claim pending", tone: "warning", title: chip.title };
  }
  if (canClaim(row)) {
    return {
      status: "claimable",
      text: claim?.status === "rejected" ? "Claim rejected · claimable" : "Claimable",
      tone: "accent",
      title: "Nothing is given until the employee or HR claims it and the Department Head approves.",
    };
  }
  if (claim?.status === "rejected") {
    return { status: "rejected", text: "Claim rejected", tone: "danger", title: claimChip(claim).title };
  }
  return {
    status: "unclaimed",
    text: "Not claimed",
    tone: "neutral",
    title:
      "Nobody claimed it and it can no longer be claimed (too old, or the feature is switched off). It stays here as a record.",
  };
}

export type Type2ClaimState = {
  status: "hr" | "claimable" | "claim_pending" | "rejected" | "unclaimed";
  text: string;
  tone: Tone;
  title: string;
};

/** Type 2 waiting: where the record stands in the claim workflow ("HR decides" for a record before the claims date). */
export function type2ClaimState(row: OvertimeRow, claimsFrom: string | null): Type2ClaimState {
  if (!inClaimFlow(row, claimsFrom)) {
    return {
      status: "hr",
      text: "HR decides",
      tone: "neutral",
      title: "Before the claim workflow started: HR assigns it (Relaxation or Payment) or rejects it.",
    };
  }
  const claim = row.claim ?? null;
  if (claim?.status === "pending") {
    return { status: "claim_pending", text: "Claim pending", tone: "warning", title: claimChip(claim).title };
  }
  if (canClaim(row)) {
    return {
      status: "claimable",
      text: claim?.status === "rejected" ? "Claim rejected · claimable" : "Claimable",
      tone: "accent",
      title: "The employee or HR can claim it; once the Department Head approves, the shifts go to the balance.",
    };
  }
  if (claim?.status === "rejected") {
    return { status: "rejected", text: "Claim rejected", tone: "danger", title: claimChip(claim).title };
  }
  return {
    status: "unclaimed",
    text: "Not claimable",
    tone: "neutral",
    title: row.claimProblem
      ? `${row.claimProblem} HR can still pay or reject it.`
      : "It cannot be claimed (too old, below a quarter of the shift, or switched off). HR can still pay or reject it.",
  };
}

/** Type 2: the credit as words ("0.50 shifts"; "Below a quarter" when the OT is less than a quarter of the shift). */
export function creditText(row: CreditFacts): string {
  const credit = creditOf(row);
  if (quartersRuleApplies(row) && (credit === null || credit <= 0)) return "Below a quarter";
  return shiftsText(credit);
}

/** Type 2: how the credit was worked out, in a few words ("4 hours over a shift of 8 hours, in quarters"). */
export function creditBasis(row: CreditFacts & Pick<OvertimeRow, "otMinutes" | "shiftMinutes">): string | null {
  if (!quartersRuleApplies(row)) return null;
  if (row.shiftMinutes && row.shiftMinutes > 0) {
    return `${formatDuration(row.otMinutes)} over a shift of ${formatDuration(row.shiftMinutes)}, in quarters`;
  }
  return "Quarters of the employee's shift, rounded down";
}

/**
 * Type 1: whether and when the employee used the allowance. A pending one (the next working day has not come) is never
 * "Not used": nothing can be said about it yet.
 */
export function allowanceUseText(row: OvertimeRow): { status: AllowanceStatus; used: boolean; text: string } {
  const status = allowanceStatusOf(row);
  if (status === "used") {
    const minutes = row.usedMinutes ? ` (${row.usedMinutes} min)` : "";
    const day = row.usedOn ? ` on ${dateShort(row.usedOn)}` : "";
    return { status, used: true, text: `Used${day}${minutes}` };
  }
  if (status === "pending") return { status, used: false, text: "Pending" };
  return { status, used: false, text: "Not used" };
}

/**
 * "18:30", or "02:10 next day" for a punch after midnight: a staff punch on the next morning before the cut-off (Settings
 * -> Attendance, Next-morning cut-off) ends the OT day, so it is that day's last punch.
 */
export function lastPunchText(row: Pick<OvertimeRow, "lastPunchOut" | "lastPunchNextDay">): string {
  if (!row.lastPunchOut) return "—";
  return row.lastPunchNextDay ? `${row.lastPunchOut} next day` : row.lastPunchOut;
}

/** What an assigned record gave, in a few words: "Relaxation on 5 Mar 2026", "Payment", or the older meaning. */
export function assignedText(row: OvertimeRow): string {
  if (isCredited(row)) {
    return `Credited to the balance (claim ${raisedByText(row.claim!)})`;
  }
  const legacy = row.otType === "legacy";
  if (row.compensationType === "relaxation") {
    if (legacy) return "Relaxation: one Alternative-Day credit";
    return row.claimDate ? `Relaxation on ${dateShort(row.claimDate)}` : "Relaxation (added to the balance)";
  }
  if (row.compensationType === "pay") {
    if (legacy) return "Payment: one day's pay";
    return row.claimDate ? `Payment (granted ${dateShort(row.claimDate)})` : "Payment";
  }
  return "—";
}

// ── What can be done ──────────────────────────────────────────────────────────

/** The modes HR can give Type 2 in, in the order the dialog offers them: only those switched on in Settings. */
export function assignModes(config: OvertimeConfig | undefined): OvertimeMode[] {
  if (!config || !config.masterEnabled || !config.shiftEnabled) return [];
  const modes: OvertimeMode[] = [];
  if (config.relaxationEnabled) modes.push("relaxation");
  if (config.payEnabled) modes.push("pay");
  return modes;
}

/**
 * The modes for these records: a record under the claim workflow is credited by a claim instead of Relaxation, so HR can
 * only pay it; records before the claims date keep both modes.
 */
export function assignModesFor(
  modes: OvertimeMode[],
  rows: Pick<OvertimeRow, "date" | "claim" | "claimable">[],
  claimsFrom: string | null,
): OvertimeMode[] {
  if (rows.some((r) => inClaimFlow(r, claimsFrom))) return modes.filter((m) => m === "pay");
  return modes;
}

/** Why a waiting Type 2 record cannot be ticked (paid, assigned or rejected): its claim is open. Null when it can. */
export function type2Lock(row: Pick<OvertimeRow, "claim">): string | null {
  if (row.claim?.status === "pending") {
    return "Claimed: waiting for the Department Head. A claimed record cannot be paid or rejected.";
  }
  if (row.claim?.status === "approved") return "Credited by an approved claim: it cannot be paid as well.";
  return null;
}

export type Pause = { reason: string; setting?: string } | null;

const MASTER_PAUSE = "Paused: the OT / Compensation features are switched off in Settings → Payroll";

/**
 * Why claiming for an employee is paused (null when it is not): the master switch first, then the type's own switch, then
 * the login's own right (`rightProblem`: the Edit on Leave > Holiday work > Claims it lacks, see useClaimRight).
 * Relaxation and Payment do not matter: a claim credits the balance, it is neither of them.
 */
export function claimPause(
  config: OvertimeConfig | undefined,
  featuresOff: boolean,
  type: 1 | 2,
  rightProblem: string | null = null,
): Pause {
  if (featuresOff || config?.masterEnabled === false) return { reason: MASTER_PAUSE };
  if (!config) return rightProblem ? { reason: rightProblem } : null;
  if (type === 1 && !config.allowanceEnabled) {
    return {
      reason: "Paused: Type 1 (next-day late-in allowance) is switched off in Settings → Compensation",
      setting: "allowance-enabled",
    };
  }
  if (type === 2 && !config.shiftEnabled) {
    return {
      reason: "Paused: Type 2 (shift-based compensation) is switched off in Settings → Compensation",
      setting: "shift-enabled",
    };
  }
  return rightProblem ? { reason: rightProblem } : null;
}

/**
 * Why changing Type 2 records is paused right now (null when it is not). The master switch first, since nothing at all
 * works without it, then Type 2's own switch, then the two modes.
 */
export function type2Pause(config: OvertimeConfig | undefined, featuresOff: boolean): Pause {
  if (featuresOff || config?.masterEnabled === false) return { reason: MASTER_PAUSE };
  if (!config) return null;
  if (!config.shiftEnabled) {
    return {
      reason: "Paused: Type 2 (shift-based compensation) is switched off in Settings → Compensation",
      setting: "shift-enabled",
    };
  }
  if (!config.relaxationEnabled && !config.payEnabled) {
    return {
      reason: "Paused: neither Relaxation nor Payment is switched on in Settings → Compensation",
      setting: "shift-relaxation",
    };
  }
  return null;
}

// ── The Assign dialog ─────────────────────────────────────────────────────────

export type AssignRow = {
  key: string;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  /** The OT day. */
  date: string;
  suggested: number | null;
  shifts: ShiftsValue | null;
  /** The date it is granted ("" = not chosen). */
  claimDate: string;
  /** What the server said about this record the last time (shown under the row until it is changed). */
  problem: string | null;
};

/** The dialog starts with every selected record on its suggested shifts and no date. */
export function initialAssignRows(rows: OvertimeRow[]): AssignRow[] {
  return rows.map((r) => ({
    key: rowKey(r),
    employeeId: r.employeeId,
    employeeCode: r.employeeCode,
    employeeName: r.employeeName,
    date: r.date,
    suggested: r.suggestedShifts,
    shifts: isShiftsValue(r.suggestedShifts) ? r.suggestedShifts : null,
    claimDate: "",
    problem: null,
  }));
}

/** The first and last day a record can be granted on: the month of its OT day. */
export const grantBounds = (otDate: string): { min: string; max: string } | null => {
  const b = monthBounds(otDate);
  return b ? { min: b.first, max: b.last } : null;
};

/** The days every row can share: the month the OT days are in (none when they are in different months). */
export function commonBounds(rows: Pick<AssignRow, "date">[]): { min: string; max: string } | null {
  if (rows.length === 0) return null;
  const first = rows[0].date;
  if (!rows.every((r) => sameMonth(r.date, first))) return null;
  return grantBounds(first);
}

/** What is wrong with one row for this mode (null = nothing). */
export function rowProblem(mode: OvertimeMode, row: AssignRow): string | null {
  if (row.shifts === null) return "Choose the shifts: 0.25, 0.50, 0.75 or 1.";
  if (row.claimDate === "") {
    return mode === "relaxation" ? "Choose the date the day off is granted." : null;
  }
  if (!isIsoDate(row.claimDate)) return "Enter a valid date.";
  if (!sameMonth(row.claimDate, row.date)) {
    const d = parseIso(row.date)!;
    return `The date must be in ${monthYear(d.month, d.year)}: the month of the overtime.`;
  }
  return null;
}

export type AssignCheck = { ok: boolean; problems: Record<string, string>; general: string | null };

/** Everything wrong with the dialog as it stands: per row, and as a whole (no mode chosen, nothing to assign). */
export function checkAssign(mode: OvertimeMode | null, modes: OvertimeMode[], rows: AssignRow[]): AssignCheck {
  const problems: Record<string, string> = {};
  if (mode === null || !modes.includes(mode)) {
    return { ok: false, problems, general: "Choose how to give it: Relaxation or Payment." };
  }
  if (rows.length === 0) return { ok: false, problems, general: "There is nothing left to assign." };
  for (const row of rows) {
    const problem = rowProblem(mode, row);
    if (problem) problems[row.key] = problem;
  }
  return { ok: Object.keys(problems).length === 0, problems, general: null };
}

/** The request: every record carries its own shifts and date, so the server needs no batch defaults. */
export function assignPayload(mode: OvertimeMode, rows: AssignRow[]): OvertimeAssignBody {
  return {
    mode,
    records: rows.map((r) => ({
      employeeId: r.employeeId,
      date: r.date,
      shifts: r.shifts as ShiftsValue,
      ...(r.claimDate ? { claimDate: r.claimDate } : {}),
    })),
  };
}

/** What will happen to one record, as the row of the dialog says it. */
export function effectText(mode: OvertimeMode, row: AssignRow): string {
  if (row.shifts === null) return "—";
  if (mode === "relaxation") {
    return row.claimDate
      ? `${dateShort(row.claimDate)} is topped up by ${shiftsText(row.shifts)} (a day never goes above 1 shift).`
      : "Choose the day to top up.";
  }
  const d = parseIso(row.claimDate || row.date)!;
  return `${shiftsText(row.shifts)} × the daily rate is added to the ${monthYear(d.month, d.year)} payslip as OT pay.`;
}

/** The one-paragraph summary above the buttons. */
export function assignSummary(mode: OvertimeMode, rows: AssignRow[]): string {
  const people = new Set(rows.map((r) => r.employeeId)).size;
  const total = sumShifts(rows.map((r) => r.shifts));
  const who = `${rows.length} ${rows.length === 1 ? "record" : "records"} for ${people} ${people === 1 ? "employee" : "employees"}, ${fmtShifts(total)} ${total === 1 ? "shift" : "shifts"} in all.`;
  const what =
    mode === "relaxation"
      ? "Relaxation: each granted day's attendance is topped up by the shifts (never above 1 shift in a day), marked Compensation in attendance."
      : "Payment: each record adds its shifts × the employee's daily rate to the payslip of that month as OT pay (payslips already generated are not changed).";
  return `${who} ${what}`;
}

/** The server's refusals, matched onto the rows (a row is matched by employee and OT day). */
export function applySkipped(rows: AssignRow[], skipped: OvertimeSkipped[]): AssignRow[] {
  return rows.map((row) => {
    const hit = skipped.find((s) => s.employeeId === row.employeeId && s.date === row.date);
    return { ...row, problem: hit ? hit.reason : null };
  });
}

/** The rows the server could not assign (they stay in the dialog with the reason); the others are done. */
export function remainingAfter(rows: AssignRow[], skipped: OvertimeSkipped[]): AssignRow[] {
  return applySkipped(rows, skipped).filter((r) => r.problem !== null);
}

/** The refusals of an assign request that assigned nothing (HTTP 400), or the single sentence. */
export function assignFailure(error: unknown): { message: string; skipped: OvertimeSkipped[] } {
  if (error instanceof ApiError) {
    const data = error.data as { error?: unknown; skipped?: unknown } | null;
    const skipped = Array.isArray(data?.skipped)
      ? (data.skipped as OvertimeSkipped[]).filter((s) => s && typeof s.reason === "string")
      : [];
    const message = typeof data?.error === "string" && data.error ? data.error : "";
    if (message || skipped.length > 0) {
      return { message: message || skipped[0].reason, skipped };
    }
  }
  return { message: "The records could not be assigned. Check the connection and try again.", skipped: [] };
}

// ── The Claim dialog (HR claims for employees) ────────────────────────────────

/** The longest reason a claim takes (the same limit as a holiday-work claim). */
export const OT_CLAIM_REASON_MAX = 500;

export type ClaimRow = {
  key: string;
  /** The OT record. */
  recordId: number;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  /** The OT date (the claim's date). */
  date: string;
  otMinutes: number;
  /** Type 1: the allowance minutes the claim asks for. */
  allowanceMinutes: number;
  /** Type 2: the quarters-rule credit, and the shifts claimed (null = not chosen yet). */
  credit: number | null;
  shifts: ShiftsValue | null;
  /** What the server said about this record the last time (shown under the row until it is changed). */
  problem: string | null;
};

/** The dialog starts with every chosen record; a Type 2 claim starts on the record's credit. */
export function initialClaimRows(rows: OvertimeRow[]): ClaimRow[] {
  return rows.map((r) => {
    const credit = creditOf(r);
    return {
      key: rowKey(r),
      recordId: r.id,
      employeeId: r.employeeId,
      employeeCode: r.employeeCode,
      employeeName: r.employeeName,
      date: r.date,
      otMinutes: r.otMinutes,
      allowanceMinutes: r.allowanceMinutes,
      credit,
      shifts: isShiftsValue(credit) ? credit : null,
      problem: null,
    };
  });
}

export type OtClaimCheck = {
  ok: boolean;
  /** Why it cannot be sent yet, in one sentence (null when it can). */
  first: string | null;
  reasonProblem: string | null;
  /** Rows without shifts (Type 2), by key. */
  problems: Record<string, string>;
};

export function checkOtClaim(kind: OtClaimKind, rows: ClaimRow[], reason: string): OtClaimCheck {
  const problems: Record<string, string> = {};
  if (kind === "ot_shift") {
    for (const row of rows) {
      if (row.shifts === null) problems[row.key] = "Choose the shifts: 0.25, 0.50, 0.75 or 1.";
    }
  }
  const text = reason.trim();
  const reasonProblem =
    text === ""
      ? "Give a reason (what was the extra work?): the Department Head reads it before deciding."
      : text.length > OT_CLAIM_REASON_MAX
        ? `The reason can be at most ${OT_CLAIM_REASON_MAX} characters.`
        : null;
  let first: string | null = null;
  if (rows.length === 0) first = "There is nothing left to claim.";
  else if (Object.keys(problems).length > 0) first = "Choose the shifts for every record.";
  else if (reasonProblem) first = reasonProblem;
  return { ok: first === null, first, reasonProblem, problems };
}

/**
 * The requests: one per OT date (a claim request carries one date), in date order, each with every record of that date.
 * Type 2 items carry their shifts; Type 1 items only the record (the server reads the allowance minutes from it).
 */
export function claimRequests(kind: OtClaimKind, rows: ClaimRow[], reason: string): RaiseOtClaimsBody[] {
  const byDate = new Map<string, ClaimRow[]>();
  for (const row of rows) byDate.set(row.date, [...(byDate.get(row.date) ?? []), row]);
  return [...byDate.keys()].sort().map((date) => ({
    kind,
    date,
    reason: reason.trim(),
    items: byDate.get(date)!.map((r) => ({
      employeeId: r.employeeId,
      overtimeRecordId: r.recordId,
      ...(kind === "ot_shift" && r.shifts !== null ? { shifts: r.shifts } : {}),
    })),
  }));
}

/** The server's refusal of one request: its sentence, and the employees it names (all-or-nothing, so none was made). */
export function claimFailure(error: unknown): { message: string; problems: { employeeId: number; error: string }[] } {
  const problems = problemsOf(error);
  if (error instanceof ApiError) {
    const data = error.data as { error?: unknown } | null;
    const sentence = typeof data?.error === "string" && data.error.trim() ? data.error.trim() : "";
    if (sentence || problems.length > 0) return { message: sentence || problems[0].error, problems };
    if (error.status === 403) return { message: "Your login is not allowed to claim for employees.", problems };
  }
  return { message: "The claim could not be sent. Check the connection and try again.", problems };
}

/** What the employee gets once the Department Head approves, for one row of the dialog. */
export function claimEffectText(kind: OtClaimKind, row: ClaimRow): string {
  if (kind === "ot_allowance") {
    return `Once approved: up to ${row.allowanceMinutes} minutes later on the next working day after ${dateShort(row.date)}, without a Late mark.`;
  }
  if (row.shifts === null) return "—";
  return `Once approved: ${shiftsText(row.shifts)} added to the compensation balance, to use on another day.`;
}
