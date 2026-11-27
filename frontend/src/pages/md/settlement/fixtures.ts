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
  SettlementStage,
  TrackerStep,
} from "./types";

const STAGES: [string, string][] = [
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
const STAGE_INDEX: Record<SettlementStage, number> = {
  hr_review: 1,
  md_review: 2,
  hr_final: 3,
  auditor_send: 4,
  auditor_review: 5,
  auditor_changes: 6,
  accounts_send: 7,
  completed: 9,
};

export const TYPE_LABELS: Record<AdvanceType, string> = { general: "Salary Advance", term: "Term Loan" };

/** The tracker as tracker_json draws it; `finalizedVia: "md"` skips HR Final Settlement. */
export function trackerFor(stage: SettlementStage, finalizedVia?: "md" | "hr" | null): TrackerStep[] {
  const current = STAGE_INDEX[stage];
  return STAGES.map(([key, label], i) => {
    const skipped = (key === "hr_final" && finalizedVia === "md") || (key === "auditor_changes" && current > 6);
    const state = skipped
      ? "skipped"
      : i === 0 || i < current || (i === current && key === "completed")
        ? "done"
        : i === current
          ? "current"
          : "pending";
    return {
      key,
      label,
      state,
      at: state === "done" && i > 0 ? "2026-11-24T06:30:00+00:00" : null,
      by: state === "done" && i > 0 ? (key === "md_review" ? "Test MD (MD)" : "Priya (HR)") : null,
      detail: skipped ? (key === "hr_final" ? "Finalized directly by the MD" : "No auditor changes") : null,
      action: state === "current" ? `${label}: next step.` : null,
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

/** Counts, totals and the MD's buttons worked out from the items, as batch_json does. */
export function withTotals(b: SettlementBatch): SettlementBatch {
  const items = b.items;
  const mdDone = items.filter((i) => i.md.decision).length;
  const decision = (i: SettlementItem) => i.final.decision ?? i.md.decision;
  const approved = items.filter((i) => decision(i) === "approved").length;
  const rejected = items.filter((i) => decision(i) === "rejected").length;
  const flag = (i: SettlementItem) => i.advance.leaveCheck?.flag;
  const md = b.stage === "md_review";
  const type = b.advanceType ?? "general";
  const typeLabel = TYPE_LABELS[type];
  return {
    ...b,
    advanceType: type,
    typeLabel,
    title: `${typeLabel} · ${b.label}`,
    tracker: trackerFor(b.stage, b.finalizedVia),
    counts: {
      total: items.length,
      mdDecided: mdDone,
      approved,
      rejected,
      undecided: items.length - approved - rejected,
      warning: items.filter((i) => flag(i) === "warning").length,
      critical: items.filter((i) => flag(i) === "critical").length,
    },
    amounts: {
      requested: items.reduce((s, i) => s + i.requestedAmount, 0),
      mdApproved: items.reduce((s, i) => s + (i.md.amount ?? 0), 0),
      finalApproved: items.reduce((s, i) => s + (i.final.decision === "approved" ? (i.final.amount ?? 0) : 0), 0),
    },
    actions: { canDecideMd: md, canConfirmMd: md && mdDone === items.length && items.length > 0 },
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
          const value = body.amount ?? current.requestedAmount;
          if (value > current.requestedAmount)
            return refuse(400, "The approved amount cannot be more than the amount asked for.", "amount");
          if (value < current.requestedAmount && remark.length < 3)
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
        const amount = i.hr?.action === "reduce" && i.hr.amount != null ? i.hr.amount : i.requestedAmount;
        const note = remark || (amount < i.requestedAmount ? (i.hr?.remark ?? "") : i.md.remark);
        if (amount < i.requestedAmount && note.length < 3) {
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
