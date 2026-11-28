// Test data for the MD Settlement page: a batch of four requests (one of each leave flag, one above its 50 % limit, one
// Term Loan) and a small fake of the server's MD endpoints that applies the same rules as
// api/settlement_automation/service.py (md_decide, md_confirm), so the page tests click through the real round trips.
import type { Fixtures } from "../testing/renderMdPage";
import type {
  AdvanceType,
  LeaveCheck,
  MdSettlementMonth,
  MdSettlementWaiting,
  SettlementAdvance,
  SettlementBatch,
  SettlementItem,
  SettlementRounding,
  SettlementStage,
  TrackerStep,
} from "./types";

const STAGES: [string, string][] = [
  ["received", "Employee Requests Received"],
  ["hr_review", "HR Review"],
  ["md_review", "MD Review & Approval"],
  ["md_changes", "HR Rework (MD Changes)"],
  ["hr_final", "HR Final Settlement"],
  ["auditor_send", "Send to Auditor"],
  ["auditor_review", "Auditor Review"],
  ["auditor_changes", "HR Rework (Auditor Changes)"],
  ["accounts_send", "Send Bank File to Accounts"],
  ["completed", "Settlement Workflow Completed"],
];
const STAGE_INDEX: Record<SettlementStage, number> = {
  hr_review: 1,
  md_review: 2,
  md_changes: 3,
  hr_final: 4,
  auditor_send: 5,
  auditor_review: 6,
  auditor_changes: 7,
  accounts_send: 8,
  completed: 9,
};
/** A rework loop -> the review it hangs under. */
const LOOP_UNDER: Record<string, number> = { md_changes: 2, auditor_changes: 6 };

export const TYPE_LABELS: Record<AdvanceType, string> = { general: "Salary Advance", term: "Term Loan" };

/** The tracker as tracker_json draws it: ten stages, the two rework loops "done" once gone round (with `cycles`),
 *  "current" while HR reworks, "skipped" when their review passed without a return; `finalizedVia: "md"` skips HR Final
 *  Settlement. */
export function trackerFor(
  stage: SettlementStage,
  finalizedVia?: "md" | "hr" | null,
  mdCycles = 0,
  mdRound = 1,
): TrackerStep[] {
  const current = STAGE_INDEX[stage];
  return STAGES.map(([key, label], i) => {
    const loop = key in LOOP_UNDER;
    const cycles = key === "md_changes" ? mdCycles : 0;
    const state: TrackerStep["state"] =
      i === 0
        ? "done"
        : loop && stage === key
          ? "current"
          : loop && cycles > 0
            ? "done"
            : loop
              ? current > LOOP_UNDER[key]
                ? "skipped"
                : "pending"
              : key === "hr_final" && finalizedVia === "md"
                ? "skipped"
                : i < current || (i === current && key === "completed")
                  ? "done"
                  : i === current
                    ? "current"
                    : "pending";
    const detail =
      state === "skipped"
        ? (({ hr_final: "Finalized directly by the MD", md_changes: "No MD changes" } as Record<string, string>)[key] ??
          "No auditor changes")
        : state === "done" && key === "md_review" && stage === "md_changes"
          ? "Returned to HR for rework"
          : state === "done" && key === "md_changes"
            ? `Reworked and resubmitted ${cycles === 1 ? "once" : `${cycles} times`}`
            : null;
    return {
      key,
      label,
      state,
      at: state === "done" && i > 0 ? "2026-11-24T06:30:00+00:00" : null,
      by: state === "done" && i > 0 ? (key === "md_review" ? "Test MD (MD)" : "Priya (HR)") : null,
      detail,
      action: state === "current" ? `${label}: next step.` : null,
      loop,
      cycles: loop ? cycles : null,
      round: key === "md_review" ? mdRound : key === "auditor_review" ? 1 : null,
    };
  });
}

export const leave = (days: number, flag: LeaveCheck["flag"]): LeaveCheck => ({
  month: 11,
  year: 2026,
  throughDay: 20,
  days,
  flag,
  warningAt: 3,
});

export function advance(id: number, extra: Partial<SettlementAdvance> = {}): SettlementAdvance {
  return {
    id,
    employeeId: id + 100,
    employeeCode: `E${id}`,
    employeeName: `Employee ${id}`,
    employeeDepartment: "Stitching",
    employeeDesignation: "Tailor",
    employeeBranch: "Unit 1",
    employeeType: "staff",
    advanceType: "general",
    typeLabel: "Salary Advance",
    amount: 10000,
    purpose: "Family function",
    status: "pending",
    repaymentStartMonth: 12,
    repaymentStartYear: 2026,
    repaymentMonths: 1,
    emiAmount: 10000,
    createdAt: "2026-11-21T04:15:00+00:00",
    requestedAmount: 10000,
    salaryAtRequest: 30000,
    appliedBy: "employee",
    earnings: {
      month: 11,
      year: 2026,
      throughDay: 20,
      fixedSalary: 30000,
      workingDays: 17,
      presentShifts: 16,
      holidayDays: 1,
      paidDays: 17,
      earnedAmount: 20400,
      workingSalary: 20400,
      percent: 50,
      limit: 10200,
      workedOutOn: "2026-11-21",
    },
    limitRemark: "",
    leaveCheck: leave(1, "ok"),
    ...extra,
  };
}

/** service.rounded_for + rounding_json (2026-11-27): the amount asked for, capped at the limit, rounded to the nearest
 *  ₹500 (₹250 and up rounds up), never above the limit. */
export function roundingFor(requested: number, limit: number | null): SettlementRounding {
  const base = limit == null ? requested : Math.min(requested, limit);
  const steps = Math.floor(base / 500);
  let rounded = base > 0 ? (steps + (base - steps * 500 >= 250 ? 1 : 0)) * 500 : 0;
  if (limit != null && rounded > limit) rounded = Math.max(0, Math.floor(limit / 500) * 500);
  return {
    requested,
    limit,
    rounded,
    capped: limit != null && requested > limit,
    direction: rounded > requested ? "up" : rounded < requested ? "down" : "same",
    zero: rounded <= 0,
  };
}

/** A Salary Advance with the rounding as the server sends it (worked out from its amount and its earned limit). */
export function rounded(i: SettlementItem): SettlementItem {
  if (i.advance.advanceType === "term") return { ...i, rounding: null, baseAmount: i.requestedAmount };
  const r = roundingFor(i.requestedAmount, i.advance.earnings?.limit ?? null);
  return { ...i, rounding: r, baseAmount: r.rounded };
}

/** The "as asked" amount the server works with (service.base_amount). */
const baseOf = (i: SettlementItem) => i.baseAmount ?? i.requestedAmount;

export function item(id: number, adv: SettlementAdvance, extra: Partial<SettlementItem> = {}): SettlementItem {
  return {
    id,
    advance: adv,
    requestedAmount: adv.requestedAmount ?? adv.amount,
    hrNote: "",
    md: { decision: null, amount: null, remark: "", decidedAt: null },
    final: { decision: null, amount: null, startMonth: null, startYear: null, remark: "", changedFromMd: false },
    applied: false,
    ...extra,
  };
}

/** The four requests: Anita (fine), Bala (3 days leave = warning, above the limit), Chitra (Term Loan, 4.5 days = critical),
 *  Dinesh (leave not worked out). */
export function fourItems(): SettlementItem[] {
  return [
    item(11, advance(1, { employeeName: "Anita Rao", employeeCode: "1001", requestedAmount: 10000, amount: 10000 }), {
      hrNote: "Regular attendance, no earlier advance.",
    }),
    item(
      12,
      advance(2, {
        employeeName: "Bala Murugan",
        employeeCode: "1002",
        requestedAmount: 8000,
        amount: 8000,
        leaveCheck: leave(3, "warning"),
        earnings: { ...advance(0).earnings!, earnedAmount: 12000, workingSalary: 12000, limit: 6000, workingDays: 10 },
        limitRemark: "Medical emergency",
      }),
    ),
    item(
      13,
      advance(3, {
        employeeName: "Chitra Devi",
        employeeCode: "1003",
        advanceType: "term",
        typeLabel: "Term Loan",
        requestedAmount: 50000,
        amount: 50000,
        repaymentMonths: 10,
        emiAmount: 5000,
        leaveCheck: leave(4.5, "critical"),
        purpose: "House repair",
      }),
    ),
    item(
      14,
      advance(4, {
        employeeName: "Dinesh Kumar",
        employeeCode: "1004",
        requestedAmount: 5000,
        amount: 5000,
        leaveCheck: null,
      }),
    ),
  ];
}

/** HR's proposal as an MD decision (service.py hr_expected). */
function expected(i: SettlementItem): { decision: "approved" | "rejected"; amount: number | null } {
  if (i.hr?.action === "reject") return { decision: "rejected", amount: null };
  if (i.hr?.action === "reduce" && i.hr.amount != null) return { decision: "approved", amount: i.hr.amount };
  if (baseOf(i) <= 0) return { decision: "rejected", amount: null };
  return { decision: "approved", amount: baseOf(i) };
}

/** service.py md_changed: the MD's OWN decision differs from HR's proposal (a pre-filled one is no change). */
export function changedFromHr(i: SettlementItem): boolean {
  if (!i.md.decision || !i.md.decidedAt || i.md.fromHr) return false;
  const e = expected(i);
  if (i.md.decision !== e.decision) return true;
  return e.decision === "approved" && Math.abs((i.md.amount ?? 0) - (e.amount ?? 0)) > 0.004;
}

/** service.py md_remarked: the MD wrote their own remark (not HR's carried over). */
const remarkedByMd = (i: SettlementItem) =>
  !!i.md.decidedAt && !i.md.fromHr && !!i.md.remark.trim() && i.md.remark.trim() !== (i.hr?.remark ?? i.hrNote).trim();

/** service.py review_state for the stages the MD sees. */
function reviewIn(i: SettlementItem, stage: SettlementStage): SettlementItem["review"] {
  if (stage === "md_review") {
    if (!i.md.decision || !i.md.decidedAt || i.md.fromHr) return "pending";
    return i.md.decision === "rejected" ? "rejected" : "approved";
  }
  if (stage === "md_changes") {
    if (i.rework) return "pending";
    return i.hr?.action === "reject" ? "rejected" : "approved";
  }
  const d = i.effective?.decision ?? i.final.decision ?? i.md.decision;
  return d === "rejected" ? "rejected" : d === "approved" ? "approved" : "pending";
}

/** Counts, totals, the rework facts and the MD's buttons worked out from the items, as batch_json does. */
export function withTotals(b: SettlementBatch): SettlementBatch {
  const items = b.items.map((i) => ({
    ...i,
    md: { ...i.md, fromHr: !!i.md.decision && !i.md.decidedAt },
    review: reviewIn(i, b.stage),
    mdChanged: changedFromHr(i),
    mdRemarked: remarkedByMd(i),
    rework: i.rework ?? null,
    trail: i.trail ?? [],
  }));
  const mdDone = items.filter((i) => i.md.decision).length;
  const decision = (i: SettlementItem) => i.final.decision ?? i.md.decision;
  const approved = items.filter((i) => decision(i) === "approved").length;
  const rejected = items.filter((i) => decision(i) === "rejected").length;
  const flag = (i: SettlementItem) => i.advance.leaveCheck?.flag;
  const md = b.stage === "md_review";
  const type = b.advanceType ?? "general";
  const typeLabel = TYPE_LABELS[type];
  const mdChanges = items.filter((i) => i.mdChanged).length;
  const mdCycles = (b.history ?? []).filter((h) => h.action === "md_returned").length;
  const mdRound = b.mdRound ?? 1;
  return {
    ...b,
    items,
    advanceType: type,
    typeLabel,
    title: `${typeLabel} · ${b.label}`,
    tracker: trackerFor(b.stage, b.finalizedVia, mdCycles, mdRound),
    mdRound,
    auditorRound: 1,
    flow: {
      mdRound,
      auditorRound: 1,
      mdCycles,
      auditorCycles: 0,
      mdPath: b.finalizedVia === "md" ? "direct" : b.mdConfirmedAt ? "hr" : null,
      accountsVia: null,
      mdReturn: b.flow?.mdReturn ?? null,
    },
    counts: {
      total: items.length,
      mdDecided: mdDone,
      approved,
      rejected,
      undecided: items.length - approved - rejected,
      warning: items.filter((i) => flag(i) === "warning").length,
      critical: items.filter((i) => flag(i) === "critical").length,
      pending: items.filter((i) => i.review === "pending").length,
      reviewedApproved: items.filter((i) => i.review === "approved").length,
      reviewedRejected: items.filter((i) => i.review === "rejected").length,
      mdChanges,
      rework: items.filter((i) => i.rework).length,
    },
    amounts: {
      requested: items.reduce((s, i) => s + i.requestedAmount, 0),
      rounded: items.reduce((s, i) => s + baseOf(i), 0),
      mdApproved: items.reduce((s, i) => s + (i.md.amount ?? 0), 0),
      finalApproved: items.reduce((s, i) => s + (i.final.decision === "approved" ? (i.final.amount ?? 0) : 0), 0),
    },
    actions: {
      canDecideMd: md,
      canConfirmMd: md && mdDone === items.length && items.length > 0 && mdChanges === 0,
      canReturnMd: md && items.length > 0,
    },
  };
}

export function batch(extra: Partial<SettlementBatch> = {}): SettlementBatch {
  return withTotals({
    id: 1,
    month: 11,
    year: 2026,
    number: 1,
    label: "Batch 1",
    stage: "md_review",
    stageLabel: "MD Review & Approval",
    nextAction: "MD: approve, reduce or reject each request, then Confirm & Proceed.",
    tracker: [],
    counts: { total: 0, mdDecided: 0, approved: 0, rejected: 0, undecided: 0, warning: 0, critical: 0 },
    amounts: { requested: 0, mdApproved: 0, finalApproved: 0 },
    forwardedAt: "2026-11-24T06:30:00+00:00",
    forwardedBy: "Priya (HR)",
    hrNote: "Please look at Bala's request first.",
    mdConfirmedAt: null,
    mdConfirmedBy: null,
    mdNote: "",
    finalizedAt: null,
    finalizedBy: null,
    finalNote: "",
    completedAt: null,
    history: [
      {
        at: "2026-11-24T06:30:00+00:00",
        by: "Priya (HR)",
        action: "forwarded",
        note: "Please look at Bala's request first.",
        count: 4,
      },
    ],
    items: fourItems(),
    actions: { canDecideMd: true, canConfirmMd: false },
    ...extra,
  });
}

export function monthReply(
  month: number,
  year: number,
  batches: SettlementBatch[],
  extra: Partial<MdSettlementMonth> = {},
) {
  return {
    method: "automation",
    month,
    year,
    isCurrentMonth: true,
    received: batches.reduce((s, b) => s + b.items.length, 0),
    currentBatchId: batches[0]?.id ?? null,
    batches,
    waitingForHr: false,
    ...extra,
  } satisfies MdSettlementMonth;
}

export const NOTHING_WAITING: MdSettlementWaiting = { method: "automation", count: 0, batches: [] };

const refuse = (status: number, error: string, code: string, extra: Record<string, unknown> = {}) => ({
  status,
  body: { error, code, ...extra },
});

/**
 * A fake of the MD endpoints over `batches` (kept in memory, changed by the page's PATCH / POST): GET month answers the
 * batches of the month asked for, the waiting count follows the batches at MD Review, and every write answers the batch.
 * `calls` records the writes (path + body) for the assertions.
 */
export function fakeServer(
  start: SettlementBatch[],
  options: {
    waiting?: MdSettlementWaiting;
    extra?: Partial<MdSettlementMonth>;
    /** Direct to Auditor: the auditor e-mail fails (the batch stays finalized at Send to Auditor, with a warning). */
    auditorFails?: boolean;
  } = {},
) {
  let batches = start.map(withTotals);
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const find = (itemId: number) => batches.find((b) => b.items.some((i) => i.id === itemId));
  const save = (next: SettlementBatch) => {
    const updated = withTotals(next);
    batches = batches.map((b) => (b.id === updated.id ? updated : b));
    return updated;
  };

  const fixtures: Fixtures = {
    "/api/md/settlement/month": (params) => {
      const month = Number(params.get("month"));
      const year = Number(params.get("year"));
      const raw = params.get("type") ?? "general";
      const type: AdvanceType = raw === "term" || raw === "term-loan" ? "term" : "general";
      const ofMonth = batches.filter((b) => b.month === month && b.year === year);
      const waitingIn = (t: AdvanceType) =>
        ofMonth.filter((b) => b.advanceType === t && b.stage === "md_review").reduce((n, b) => n + b.items.length, 0);
      return monthReply(
        month,
        year,
        ofMonth.filter((b) => b.advanceType === type && b.stage !== "hr_review"),
        {
          advanceType: type,
          typeLabel: TYPE_LABELS[type],
          waitingByType: { general: waitingIn("general"), term: waitingIn("term") },
          ...options.extra,
        },
      );
    },
    "/api/md/settlement/waiting": () =>
      options.waiting ?? {
        method: "automation",
        count: batches.filter((b) => b.stage === "md_review").reduce((s, b) => s + b.items.length, 0),
        byType: {
          general: batches
            .filter((b) => b.stage === "md_review" && b.advanceType === "general")
            .reduce((s, b) => s + b.items.length, 0),
          term: batches
            .filter((b) => b.stage === "md_review" && b.advanceType === "term")
            .reduce((s, b) => s + b.items.length, 0),
        },
        batches: batches
          .filter((b) => b.stage === "md_review")
          .map((b) => ({
            id: b.id,
            advanceType: b.advanceType,
            typeLabel: b.typeLabel,
            month: b.month,
            year: b.year,
            number: b.number,
            requests: b.items.length,
            forwardedAt: b.forwardedAt,
            forwardedBy: b.forwardedBy,
          })),
      },
  };

  for (const b of batches) {
    for (const it of b.items) {
      fixtures[`/api/md/settlement/items/${it.id}`] = (_params, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { decision?: string; amount?: number; remark?: string };
        calls.push({ path: `/api/md/settlement/items/${it.id}`, body });
        const owner = find(it.id)!;
        if (owner.stage !== "md_review") return refuse(409, "This step is not open.", "stage", { stage: owner.stage });
        const current = owner.items.find((i) => i.id === it.id)!;
        const remark = (body.remark ?? "").trim();
        let md: SettlementItem["md"];
        if (!body.decision) md = { decision: null, amount: null, remark, decidedAt: null };
        else if (body.decision === "approved") {
          const asked = baseOf(current);
          if (asked <= 0 && body.amount == null)
            return refuse(400, "This request rounds to ₹0: reject it.", "rounds_to_zero");
          const value = body.amount ?? asked;
          if (value > asked)
            return refuse(400, "The approved amount cannot be more than the amount asked for.", "amount");
          if (value < asked && remark.length < 3)
            return refuse(400, "Write a remark for the reduced amount (at least 3 characters).", "remark");
          md = { decision: "approved", amount: value, remark, decidedAt: "2026-11-26T05:00:00+00:00" };
        } else if (body.decision === "rejected") {
          if (remark.length < 3)
            return refuse(400, "Write the reason for rejecting (at least 3 characters).", "remark");
          md = { decision: "rejected", amount: null, remark, decidedAt: "2026-11-26T05:00:00+00:00" };
        } else return refuse(400, "Choose approve or reject.", "decision");
        return save({ ...owner, items: owner.items.map((i) => (i.id === it.id ? { ...i, md } : i)) });
      };
    }
    fixtures[`/api/md/settlement/batches/${b.id}/bulk`] = (_params, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { itemIds?: number[]; decision?: string; remark?: string };
      calls.push({ path: `/api/md/settlement/batches/${b.id}/bulk`, body });
      const owner = batches.find((x) => x.id === b.id)!;
      if (owner.stage !== "md_review") return refuse(409, "This step is not open.", "stage", { stage: owner.stage });
      const remark = (body.remark ?? "").trim();
      if (body.decision === "rejected" && remark.length < 3)
        return refuse(400, "Write the reason for rejecting (at least 3 characters).", "remark");
      const ids = new Set(body.itemIds ?? []);
      if (!ids.size) return refuse(400, "Choose at least one request.", "empty");
      const skipped: { id: number; reason: string }[] = [];
      const items = owner.items.map((i) => {
        if (!ids.has(i.id)) return i;
        if (body.decision === "rejected")
          return {
            ...i,
            md: {
              decision: "rejected" as const,
              amount: null,
              remark,
              decidedAt: "2026-11-26T05:00:00+00:00",
              fromHr: false,
            },
          };
        const asked = baseOf(i);
        if (asked <= 0) {
          skipped.push({ id: i.id, reason: "It rounds to ₹0: reject it." });
          return i;
        }
        const amount = i.hr?.action === "reduce" && i.hr.amount != null ? i.hr.amount : asked;
        const note = remark || (amount < asked ? (i.hr?.remark ?? "") : i.md.remark);
        if (amount < asked && note.length < 3) {
          skipped.push({ id: i.id, reason: "A reduced amount needs a remark." });
          return i;
        }
        return {
          ...i,
          md: {
            decision: "approved" as const,
            amount,
            remark: note,
            decidedAt: "2026-11-26T05:00:00+00:00",
            fromHr: false,
          },
        };
      });
      return { ...save({ ...owner, items }), skipped };
    };
    fixtures[`/api/md/settlement/batches/${b.id}/confirm`] = (_params, init) => {
      let body: Record<string, unknown>;
      if (init?.body instanceof FormData) {
        const form = init.body;
        const file = (key: string) => {
          const f = form.get(key);
          return f instanceof File ? { name: f.name, type: f.type, size: f.size } : null;
        };
        body = { note: form.get("note"), mode: form.get("mode"), pdf: file("pdf"), xlsx: file("xlsx") };
      } else body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ path: `/api/md/settlement/batches/${b.id}/confirm`, body });
      const owner = batches.find((x) => x.id === b.id)!;
      if (owner.stage !== "md_review") return refuse(409, "This step is not open.", "stage", { stage: owner.stage });
      const open = owner.items.filter((i) => !i.md.decision);
      if (open.length)
        return refuse(400, `${open.length} request(s) still need your decision before you can confirm.`, "undecided", {
          undecided: open.map((i) => i.id),
        });
      const changed = owner.items.filter(changedFromHr);
      if (changed.length)
        return refuse(
          409,
          `You changed ${changed.length} request(s) from HR's proposal. Return the settlement to HR for rework; you approve it once HR resubmits.`,
          "has_changes",
          { changed: changed.map((i) => i.id) },
        );
      const direct = body.mode === "direct";
      if (direct && (!body.pdf || !body.xlsx)) return refuse(400, "Attach the report.", "file");
      const note = String(body.note ?? "").trim();
      const approved = owner.items.filter((i) => i.md.decision === "approved").length;
      const sent = direct && !options.auditorFails;
      const saved = save({
        ...owner,
        stage: !direct ? "hr_final" : sent ? "auditor_review" : "auditor_send",
        stageLabel: !direct ? "HR Final Settlement" : sent ? "Auditor Review" : "Send to Auditor",
        nextAction: !direct ? "HR: check the MD's decisions, adjust within them, and Finalize the settlement." : "",
        mdConfirmedAt: "2026-11-26T09:12:33.123456+00:00",
        mdConfirmedBy: "Test MD (MD)",
        mdNote: note,
        ...(direct
          ? {
              finalizedAt: "2026-11-26T09:12:33.123456+00:00",
              finalizedBy: "Test MD (MD)",
              finalizedVia: "md" as const,
              finalNote: note,
            }
          : {}),
        history: [
          ...(owner.history ?? []),
          {
            at: "2026-11-26T09:12:33.123456+00:00",
            by: "Test MD (MD)",
            action: "md_confirmed",
            note,
            approved,
            rejected: owner.items.length - approved,
          },
          ...(direct
            ? [
                {
                  at: "2026-11-26T09:12:33.123456+00:00",
                  by: "Test MD (MD)",
                  action: "finalized",
                  note: "Finalized directly by the MD",
                },
              ]
            : []),
        ],
        items: owner.items.map((i) => ({
          ...i,
          final: {
            decision: i.md.decision,
            amount: i.md.amount,
            startMonth: i.advance.repaymentStartMonth,
            startYear: i.advance.repaymentStartYear,
            remark: "",
            changedFromMd: false,
          },
          effective: { decision: i.md.decision, amount: i.md.amount, remark: "" },
        })),
      });
      return {
        ...saved,
        warning:
          direct && !sent
            ? "The settlement is finalized, but it could not be sent to the auditor (Not sent: e-mail is switched off). HR can send it from the Loan & Advance page."
            : null,
      };
    };
    fixtures[`/api/md/settlement/batches/${b.id}/return`] = (_params, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { note?: string };
      calls.push({ path: `/api/md/settlement/batches/${b.id}/return`, body });
      const owner = batches.find((x) => x.id === b.id)!;
      if (owner.stage !== "md_review") return refuse(409, "This step is not open.", "stage", { stage: owner.stage });
      const note = (body.note ?? "").trim();
      const changed = owner.items.filter(changedFromHr);
      const remarked = owner.items.filter((i) => !changedFromHr(i) && remarkedByMd(i));
      if (!changed.length && !remarked.length && note.length < 3)
        return refuse(
          400,
          "Nothing to rework: approve the settlement, or write what HR should correct (at least 3 characters).",
          "no_changes",
        );
      const round = owner.mdRound ?? 1;
      const at = "2026-11-27T05:30:00+00:00";
      const flagged = new Set([...changed, ...remarked].map((i) => i.id));
      return save({
        ...owner,
        stage: "md_changes",
        stageLabel: "HR Rework (MD Changes)",
        nextAction: "HR: answer each request the MD changed, then Resubmit to the MD.",
        flow: { ...owner.flow!, mdReturn: { at, by: "Test MD (MD)", note } },
        history: [
          ...(owner.history ?? []),
          {
            at,
            by: "Test MD (MD)",
            action: "md_returned",
            note,
            round,
            changes: changed.length,
            remarks: remarked.length,
          },
        ],
        items: owner.items.map((i) =>
          flagged.has(i.id)
            ? {
                ...i,
                rework: "md" as const,
                trail: [
                  ...(i.trail ?? []),
                  {
                    at,
                    by: owner.forwardedBy ?? "",
                    role: "hr" as const,
                    round,
                    action: i.hr?.action ?? "approve",
                    amount: i.hr?.amount ?? null,
                    remark: i.hr?.remark ?? "",
                  },
                  {
                    at,
                    by: "Test MD (MD)",
                    role: "md" as const,
                    round,
                    action: i.md.decision ?? "",
                    amount: i.md.amount,
                    remark: i.md.remark,
                  },
                ],
              }
            : i,
        ),
      });
    };
    for (const it of b.items) {
      fixtures[`/api/md/settlement/items/${it.id}/leave-calendar`] = () => ({
        employee: { code: it.advance.employeeCode ?? "", name: it.advance.employeeName },
        month: 11,
        year: 2026,
        throughDay: 20,
        days: [
          { date: "2026-11-03", kind: "absent", label: "Absent", weight: 1 },
          { date: "2026-11-10", kind: "on_leave", label: "On leave", weight: 1 },
          { date: "2026-11-12", kind: "half_day_leave", label: "Half-day leave", weight: 0.5 },
        ],
        holidays: [{ date: "2026-11-08", name: "Deepavali" }],
        total: 2.5,
        flag: "ok",
      });
    }
  }

  return {
    fixtures,
    calls,
    /** Change a batch behind the page's back (another tab, HR). */
    set: (id: number, change: (b: SettlementBatch) => SettlementBatch) => {
      batches = batches.map((b) => (b.id === id ? withTotals(change(b)) : b));
    },
    batch: (id: number) => batches.find((b) => b.id === id),
  };
}
