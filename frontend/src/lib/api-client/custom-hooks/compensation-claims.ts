// compensation-claims: the one compensation claim workflow as HR sees it (Compensation Leave -> Sunday & holiday work, 2026-11-19).
// Every kind of claim (Sunday / holiday work, OT Type 1 allowance, OT Type 2 shift credit, birthday credit, and a request to
// use the balance) lives in one table and goes to the employee's Department Head. HR lists them all (Claims), sees what each
// employee earned, used and has left (Balance), and every credit and debit of the balances (Credits). The months of the
// Raise strip (the Sundays and holidays of a month with how many worked) are here too.
//
// The list endpoints are read through small normalisers, so a key the server spells the older way (`results` / `count`, a
// flat employee or an `employee` object) still reads the same. Every change marks every Compensation query stale
// (invalidateCompensation), so the Claims, Balance and Credits pages always agree.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";
import {
  invalidateCompensation,
  type BalanceEntryType,
  type HolidayDayKind,
  type HolidayWorkClaim,
  type HolidayWorkEnabled,
  type ShiftsValue,
} from "./compensation";

// ── reading loosely ───────────────────────────────────────────────────────────

type Raw = Record<string, unknown>;

const obj = (value: unknown): Raw => (value && typeof value === "object" ? (value as Raw) : {});
const num = (value: unknown, fallback = 0): number => {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
};
const numOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : num(value, NaN));
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const listOf = (raw: Raw): unknown[] => {
  const items = raw.items ?? raw.results;
  return Array.isArray(items) ? items : [];
};

const query = (path: string, params: Record<string, string | number | boolean | null | undefined>): string => {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "" || value === false) continue;
    qs.set(key, value === true ? "1" : String(value));
  }
  const text = qs.toString();
  return text ? `${path}?${text}` : path;
};

/** The employee of a row, flat (`employeeId`, `employeeName` ...) or as an `employee` object ({id, name, code ...}). */
function employeeOf(raw: Raw) {
  const e = obj(raw.employee);
  const has = Object.keys(e).length > 0;
  const pick = (...values: unknown[]) => values.find((v) => v !== undefined && v !== null);
  return {
    employeeId: num(pick(raw.employeeId, has ? (e.id ?? e.employeeId) : undefined)),
    employeeCode: str(pick(raw.employeeCode, has ? (e.employeeCode ?? e.code) : undefined)) ?? "",
    employeeName: str(pick(raw.employeeName, has ? (e.name ?? e.employeeName) : undefined)) ?? "",
    department: str(pick(raw.department, has ? e.department : undefined)),
    departmentId: numOrNull(pick(raw.departmentId, has ? e.departmentId : undefined)),
    branch: str(pick(raw.branch, has ? e.branch : undefined)),
    branchId: numOrNull(pick(raw.branchId, has ? e.branchId : undefined)),
  };
}

const pageOf = (raw: Raw, asked: { page?: number; pageSize?: number }, rows: number) => ({
  total: num(raw.total ?? raw.count, rows),
  page: num(raw.page, asked.page ?? 1),
  pageSize: num(raw.pageSize, asked.pageSize ?? Math.max(rows, 1)),
});

// ═══════════════════════════════════════════════════════════════════════════
//  Claims
// ═══════════════════════════════════════════════════════════════════════════

/** The five kinds of claim, in the order the page lists them. */
export const CLAIM_KINDS = ["holiday_work", "ot_allowance", "ot_shift", "birthday", "use_balance"] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export const isClaimKind = (value: unknown): value is ClaimKind =>
  typeof value === "string" && (CLAIM_KINDS as readonly string[]).includes(value);

/** pending = waiting for the Department Head. */
export type ClaimStatus = "pending" | "approved" | "rejected";

/** Who raised it: HR on the employee's behalf, or the employee in the mobile app / Employee Web App. */
export type ClaimRaisedBy = "hr" | "employee";

/** The OT behind an ot_allowance / ot_shift claim: the OT day, the shift end, the last punch and the minutes past the end. */
export type ClaimOvertime = {
  date: string;
  shiftEnd: string | null;
  lastPunch: string | null;
  /** The last punch was after midnight ("02:10 next day"). */
  lastPunchNextDay: boolean;
  extraMinutes: number | null;
};

/** The ledger entry a claim produced: the credit of an approved claim, or the debit of an approved use-balance request. */
export type ClaimLedgerLink = { id: number; type: BalanceEntryType; shifts: number; date: string; source: string };

/** One claim of any kind, read the same way whatever the kind (the Sunday / holiday work claim's keys, plus the kind's). */
export type CompensationClaim = HolidayWorkClaim & {
  kind: ClaimKind;
  kindLabel: string | null;
  raisedByRole: ClaimRaisedBy;
  /** ot_allowance: the late-in allowance minutes claimed. */
  minutes: number | null;
  overtime: ClaimOvertime | null;
  overtimeRecordId: number | null;
  /** use_balance: the day the employee takes off (the same as `workDate`). */
  useDate: string | null;
  /** ot_allowance: the working day an approved allowance applies to. */
  appliesOn: string | null;
  ledger: ClaimLedgerLink | null;
  statusLabel: string | null;
  // ── compensation days on a chosen date (2026-11-28, compensation-placement.ts): additive, an older backend sends none ──
  /** Placed by HR on a chosen date: the Department Head decides first, then HR. */
  hrStep?: boolean;
  /** "hod" = waiting for the Department Head, "hr" = waiting for HR; null once decided or when not hrStep. */
  stage?: "hod" | "hr" | null;
  /** The day a placement gives off and how much (use_balance: its day / shifts; a credit placed at once: use_date /
   *  use_shifts); null otherwise. */
  useShifts?: number | null;
  /** The approved credit a use_balance placement comes from. */
  sourceClaimId?: number | null;
  /** shift | overtime | sunday | holiday | birthday | balance (null for an OT allowance). */
  compType?: string | null;
  /** "Sunday compensation", "Shift compensation" ... */
  compTypeLabel?: string | null;
  /** Approved credit claims only (else null): already placed from it / still to place. */
  placed?: number | null;
  leftToPlace?: number | null;
};

export type ClaimsSummary = {
  byStatus: Partial<Record<ClaimStatus, number>>;
  byKind: Partial<Record<ClaimKind, number>>;
  pendingShifts: number;
  /** Every approved claim's shifts, use-balance requests included (they take shifts out of the balance). */
  approvedShifts: number;
  /** Approved shifts that went INTO the balance (holiday work, OT shift, birthday); older backends: approvedShifts. */
  creditedShifts: number;
  /** Waiting shifts that would go INTO the balance (credit kinds). Older backends: null (only pendingShifts). */
  pendingCreditShifts: number | null;
  /** Waiting shifts asked OUT of the balance (use requests). Older backends: null. */
  pendingUseShifts: number | null;
};

export type ClaimsListParams = {
  kind?: string;
  /** pending | approved | rejected (nothing = every status) */
  status?: string;
  month?: number;
  year?: number;
  /** Every month (when no month or year is given). */
  anyMonth?: boolean;
  employeeId?: number;
  departmentId?: number;
  branchId?: number;
  q?: string;
  /** hr | employee */
  raisedBy?: string;
  page?: number;
  pageSize?: number;
};

export type ClaimsListResponse = {
  items: CompensationClaim[];
  total: number;
  page: number;
  pageSize: number;
  summary: ClaimsSummary;
  /** The switches (like the Sunday / holiday work list): null when the server does not send them. */
  enabled: HolidayWorkEnabled | null;
};

function overtimeOf(value: unknown): ClaimOvertime | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Raw;
  return {
    date: str(o.date) ?? "",
    shiftEnd: str(o.shiftEnd ?? o.shiftEndTime),
    lastPunch: str(o.lastPunch ?? o.lastPunchOut),
    lastPunchNextDay: o.lastPunchNextDay === true,
    extraMinutes: numOrNull(o.extraMinutes ?? o.otMinutes),
  };
}

function ledgerLinkOf(value: unknown): ClaimLedgerLink | null {
  if (!value || typeof value !== "object") return null;
  const l = value as Raw;
  if (l.id === undefined || l.id === null) return null;
  return {
    id: num(l.id),
    type: (l.type ?? l.entryType) === "debit" ? "debit" : "credit",
    shifts: num(l.shifts),
    date: str(l.date) ?? "",
    source: str(l.source) ?? "",
  };
}

/** One claim as the page reads it, from whatever the server sent. */
export function normalizeClaim(value: unknown): CompensationClaim {
  const raw = obj(value);
  const kind: ClaimKind = isClaimKind(raw.kind) ? raw.kind : "holiday_work";
  const workDate = str(raw.workDate ?? raw.date ?? raw.useDate) ?? "";
  const status = raw.status === "approved" || raw.status === "rejected" ? raw.status : "pending";
  return {
    ...(raw as unknown as HolidayWorkClaim),
    ...employeeOf(raw),
    id: num(raw.id),
    designation: str(raw.designation),
    employmentType: str(raw.employmentType),
    workDate,
    dayKind: (raw.dayKind === "holiday" || raw.dayKind === "off_saturday" ? raw.dayKind : "sunday") as HolidayDayKind,
    holidayName: str(raw.holidayName),
    shifts: num(raw.shifts),
    reason: str(raw.reason) ?? "",
    status,
    requestedBy: str(raw.requestedBy),
    reviewedBy: str(raw.reviewedBy),
    reviewComment: str(raw.reviewComment),
    reviewedAt: str(raw.reviewedAt),
    createdAt: str(raw.createdAt),
    hodName: str(raw.hodName),
    credited: raw.credited === true || !!ledgerLinkOf(raw.ledger ?? raw.ledgerEntry),
    approval: (raw.approval as HolidayWorkClaim["approval"]) ?? null,
    kind,
    kindLabel: str(raw.kindLabel),
    raisedByRole: raw.raisedByRole === "employee" ? "employee" : "hr",
    minutes: numOrNull(raw.minutes),
    overtime: overtimeOf(raw.overtime),
    overtimeRecordId: numOrNull(raw.overtimeRecordId),
    useDate: str(raw.useDate) ?? (kind === "use_balance" ? workDate : null),
    appliesOn: str(raw.appliesOn ?? raw.appliedOn),
    ledger: ledgerLinkOf(raw.ledger ?? raw.ledgerEntry),
    statusLabel: str(raw.statusLabel),
    hrStep: raw.hrStep === true,
    stage: raw.stage === "hod" || raw.stage === "hr" ? raw.stage : null,
    useShifts: numOrNull(raw.useShifts),
    sourceClaimId: numOrNull(raw.sourceClaimId),
    compType: str(raw.compType),
    compTypeLabel: str(raw.compTypeLabel),
    placed: numOrNull(raw.placed),
    leftToPlace: numOrNull(raw.leftToPlace),
  };
}

export function summaryOf(value: unknown): ClaimsSummary {
  const s = obj(value);
  const counts = (v: unknown) =>
    Object.fromEntries(Object.entries(obj(v)).map(([k, n]) => [k, num(n)])) as Record<string, number>;
  return {
    byStatus: counts(s.byStatus),
    byKind: counts(s.byKind),
    pendingShifts: num(s.pendingShifts),
    approvedShifts: num(s.approvedShifts),
    creditedShifts: num(s.creditedShifts ?? s.approvedShifts),
    pendingCreditShifts: s.pendingCreditShifts == null ? null : num(s.pendingCreditShifts),
    pendingUseShifts: s.pendingUseShifts == null ? null : num(s.pendingUseShifts),
  };
}

export const getCompensationClaimsQueryKey = (params: ClaimsListParams) =>
  ["/api/compensation/claims", params] as const;

/** One page of the claims of every kind, with the counts by status and by kind. */
export const useCompensationClaims = (params: ClaimsListParams, options: { enabled?: boolean } = {}) =>
  useQuery<ClaimsListResponse>({
    queryKey: getCompensationClaimsQueryKey(params),
    enabled: options.enabled ?? true,
    queryFn: async () => {
      const raw = obj(await customFetch<unknown>(query("/api/compensation/claims", { ...params })));
      const items = listOf(raw).map(normalizeClaim);
      const enabled = raw.enabled && typeof raw.enabled === "object" ? (raw.enabled as HolidayWorkEnabled) : null;
      return { items, ...pageOf(raw, params, items.length), summary: summaryOf(raw.summary), enabled };
    },
  });

/** One employee's line of a claim made by HR: the shifts (holiday work, ot_shift) and the OT record (ot_*). */
export type ClaimItemBody = { employeeId: number; shifts?: ShiftsValue; overtimeRecordId?: number };

/** POST /api/compensation/claims: HR claims for employees, on their behalf (all or nothing, like raising holiday work). */
export type RaiseClaimsBody = { kind: ClaimKind; date: string; reason: string; items: ClaimItemBody[] };

export type RaiseClaimsResult = { created: number; claims: CompensationClaim[]; warnings: string[] };

export const useRaiseCompensationClaims = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: RaiseClaimsBody): Promise<RaiseClaimsResult> => {
      const raw = obj(
        await customFetch<unknown>("/api/compensation/claims", { method: "POST", body: JSON.stringify(body) }),
      );
      const claims = Array.isArray(raw.claims) ? raw.claims.map(normalizeClaim) : [];
      const warnings = Array.isArray(raw.warnings)
        ? raw.warnings.filter((w): w is string => typeof w === "string")
        : [];
      return { created: num(raw.created, claims.length), claims, warnings };
    },
    onSuccess: () => invalidateCompensation(queryClient),
  });
};

/** Withdraws a claim of any kind that is still waiting for the Department Head. */
export const useWithdrawCompensationClaim = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => customFetch<void>(`/api/compensation/claims/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidateCompensation(queryClient),
  });
};

/** POST /api/compensation/use: HR asks, for an employee, to use part of the balance on a day. It goes to the HOD. */
export type UseBalanceBody = { employeeId: number; date: string; shifts: ShiftsValue; reason: string };

export const useUseCompensationBalance = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: UseBalanceBody) =>
      normalizeClaim(
        await customFetch<unknown>("/api/compensation/use", { method: "POST", body: JSON.stringify(body) }),
      ),
    onSuccess: () => invalidateCompensation(queryClient),
  });
};

// ═══════════════════════════════════════════════════════════════════════════
//  Balance: earned / used / waiting / available per employee
// ═══════════════════════════════════════════════════════════════════════════

export type BalanceListRow = {
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  departmentId: number | null;
  branch: string | null;
  branchId: number | null;
  /** Every credit (approved claims, earlier Alternative-Day credits). */
  earned: number;
  /** Every day off taken from it. */
  used: number;
  /** Asked to use and still waiting for the Department Head. */
  pending: number;
  /** What can still be asked for: earned - used - pending. */
  available: number;
  lastActivity: string | null;
};

export type BalanceListParams = {
  departmentId?: number;
  branchId?: number;
  q?: string;
  page?: number;
  pageSize?: number;
};

export type BalanceListSummary = {
  employees: number;
  earned: number;
  used: number;
  pending: number;
  available: number;
};

export type BalanceListResponse = {
  items: BalanceListRow[];
  total: number;
  page: number;
  pageSize: number;
  summary: BalanceListSummary | null;
};

export function normalizeBalanceRow(value: unknown): BalanceListRow {
  const raw = obj(value);
  const available = num(raw.available ?? raw.balance);
  return {
    ...employeeOf(raw),
    earned: num(raw.earned),
    used: num(raw.used),
    pending: num(raw.pending),
    available,
    lastActivity: str(raw.lastActivity),
  };
}

export function balanceSummaryOf(s: Raw): BalanceListSummary {
  return {
    // withBalance: the employees with shifts left (employees also counts those with nothing left)
    employees: num(s.withBalance ?? s.employees),
    earned: num(s.earned),
    used: num(s.used),
    pending: num(s.pending),
    available: num(s.available ?? s.balance),
  };
}

export const useCompensationBalanceList = (params: BalanceListParams) =>
  useQuery<BalanceListResponse>({
    queryKey: ["/api/compensation/balance", "list", params],
    queryFn: async () => {
      const raw = obj(await customFetch<unknown>(query("/api/compensation/balance", { ...params })));
      const items = listOf(raw).map(normalizeBalanceRow);
      const s = raw.summary && typeof raw.summary === "object" ? (raw.summary as Raw) : null;
      return {
        items,
        ...pageOf(raw, params, items.length),
        summary: s ? balanceSummaryOf(s) : null,
      };
    },
  });

// ═══════════════════════════════════════════════════════════════════════════
//  Credits: every credit and debit of the balances (the ledger)
// ═══════════════════════════════════════════════════════════════════════════

/** The claim behind a ledger entry (none for an HR redeem or an earlier credit). */
export type LedgerClaimLink = { id: number; kind: ClaimKind; status: string | null };

export type LedgerRow = {
  /** null for an earlier Alternative-Day credit that is only shown. */
  id: number | null;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  departmentId: number | null;
  branch: string | null;
  branchId: number | null;
  type: BalanceEntryType;
  shifts: number;
  date: string;
  /** holiday_work | ot_shift | birthday | redemption | legacy_credit */
  source: string;
  sourceLabel: string | null;
  note: string | null;
  createdBy: string | null;
  createdAt: string | null;
  /** false for a debit that only mirrors an earlier credit being used (not taken off twice). */
  counted: boolean;
  claim: LedgerClaimLink | null;
  overtimeRecordId: number | null;
  overtime: ClaimOvertime | null;
};

export type LedgerParams = {
  /** credit | debit */
  entryType?: string;
  source?: string;
  month?: number;
  year?: number;
  employeeId?: number;
  departmentId?: number;
  branchId?: number;
  q?: string;
  page?: number;
  pageSize?: number;
};

export type LedgerSummary = { credits: number; debits: number; creditShifts: number; debitShifts: number };

export type LedgerResponse = {
  items: LedgerRow[];
  total: number;
  page: number;
  pageSize: number;
  summary: LedgerSummary | null;
};

function claimLinkOf(value: unknown): LedgerClaimLink | null {
  if (!value || typeof value !== "object") return null;
  const c = value as Raw;
  if (c.id === undefined || c.id === null) return null;
  return { id: num(c.id), kind: isClaimKind(c.kind) ? c.kind : "holiday_work", status: str(c.status) };
}

export function normalizeLedgerRow(value: unknown): LedgerRow {
  const raw = obj(value);
  return {
    ...employeeOf(raw),
    id: numOrNull(raw.id),
    type: (raw.type ?? raw.entryType) === "debit" ? "debit" : "credit",
    shifts: num(raw.shifts),
    date: str(raw.date) ?? "",
    source: str(raw.source) ?? "",
    sourceLabel: str(raw.sourceLabel),
    note: str(raw.note),
    createdBy: str(raw.createdBy),
    createdAt: str(raw.createdAt),
    counted: raw.counted !== false,
    claim: claimLinkOf(raw.claim),
    overtimeRecordId: numOrNull(raw.overtimeRecordId ?? obj(raw.overtime).id),
    overtime: overtimeOf(raw.overtime),
  };
}

export function ledgerSummaryOf(s: Raw): LedgerSummary {
  return {
    credits: num(s.credits),
    debits: num(s.debits),
    creditShifts: num(s.creditShifts),
    // the debits that lower the balance (a legacy credit's mirror debit is not counted twice)
    debitShifts: num(s.countedDebitShifts ?? s.debitShifts),
  };
}

export const useCompensationLedger = (params: LedgerParams) =>
  useQuery<LedgerResponse>({
    queryKey: ["/api/compensation/ledger", params],
    queryFn: async () => {
      const raw = obj(await customFetch<unknown>(query("/api/compensation/ledger", { ...params })));
      const items = listOf(raw).map(normalizeLedgerRow);
      const s = raw.summary && typeof raw.summary === "object" ? (raw.summary as Raw) : null;
      return {
        items,
        ...pageOf(raw, params, items.length),
        summary: s ? ledgerSummaryOf(s) : null,
      };
    },
  });

// ═══════════════════════════════════════════════════════════════════════════
//  Raise: the Sundays and declared holidays of a month, with how many worked
// ═══════════════════════════════════════════════════════════════════════════

export type HolidayWorkMonthDay = {
  date: string;
  kind: HolidayDayKind;
  /** "Sunday" | "Holiday" | "Off Saturday": the server's own word for the day. Absent on an older backend. */
  kindLabel?: string | null;
  holidayName: string | null;
  /** "Week 2" (the server's own label). */
  weekLabel: string;
  /** Staff with punches or a present attendance that day. */
  worked: number;
  /** Of them, the ones who can still be claimed for. */
  eligible: number;
  claimed: { pending: number; approved: number };
};

export type HolidayWorkMonthResponse = {
  days: HolidayWorkMonthDay[];
  /** The day the strip opens on: the previous Sunday (the latest one before today). */
  defaultDate: string | null;
  maxAgeDays: number;
  enabled: HolidayWorkEnabled | null;
};

export type HolidayWorkMonthParams = { month: number; year: number; departmentId?: number; branchId?: number };

export const useHolidayWorkMonth = (params: HolidayWorkMonthParams) =>
  useQuery<HolidayWorkMonthResponse>({
    queryKey: ["/api/compensation/holiday-work/month", params],
    queryFn: async () => {
      const raw = obj(await customFetch<unknown>(query("/api/compensation/holiday-work/month", { ...params })));
      const days = (Array.isArray(raw.days) ? raw.days : []).map((value): HolidayWorkMonthDay => {
        const d = obj(value);
        const claimed = obj(d.claimed);
        return {
          date: str(d.date) ?? "",
          kind: d.kind === "holiday" || d.kind === "off_saturday" ? d.kind : "sunday",
          kindLabel: str(d.kindLabel),
          holidayName: str(d.holidayName),
          weekLabel: str(d.weekLabel) ?? "",
          worked: num(d.worked),
          eligible: num(d.eligible),
          claimed: { pending: num(claimed.pending), approved: num(claimed.approved) },
        };
      });
      return {
        days,
        defaultDate: str(raw.defaultDate),
        maxAgeDays: num(raw.maxAgeDays, 45),
        enabled: raw.enabled && typeof raw.enabled === "object" ? (raw.enabled as HolidayWorkEnabled) : null,
      };
    },
  });
