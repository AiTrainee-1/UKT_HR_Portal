import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertOctagon,
  AlertTriangle,
  BadgeCheck,
  CalendarDays,
  Check,
  GitCompareArrows,
  History,
  Loader2,
  Pencil,
  RotateCcw,
  TrendingDown,
  X,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { groupByReview } from "@/lib/reviewOrder";
import { cn } from "@/lib/utils";
import {
  changeText,
  decisionKind,
  eligibleLimit,
  finalized,
  hrProposal,
  istDate,
  leaveChip,
  mdChangedOf,
  money,
  overLimit,
  pendingLabel,
  requestStatus,
  reviewOf,
  shortMonth,
  shownIds,
  termText,
  trailLine,
  typeLabelOf,
  type DraftMode,
  type StatusTone,
} from "./logic";
import { BTN_MOTION, DecisionChip, GHOST_MOTION, Hint } from "./parts";
import type { ReviewState, SettlementItem, SettlementStage } from "./types";

export type RowHandlers = {
  /** The batch's stage (what the Status column says, how the list is grouped). */
  stage: SettlementStage;
  /** The MD's review round (2+ = HR resubmitted a returned settlement): the earlier round's line on a request. */
  mdRound: number;
  /** The MD may decide (the batch is at MD Review): buttons and checkboxes. */
  canDecide: boolean;
  /** Requests with a decision on its way to the server. */
  busy: ReadonlySet<number>;
  /** Requests the server said still need a decision (Confirm & Proceed refused). */
  highlight: ReadonlySet<number>;
  /** The requests ticked for a bulk decision. */
  selected: ReadonlySet<number>;
  onSelect: (id: number, on: boolean) => void;
  /** Select all / clear for the requests on screen. */
  onToggleAll: (ids: number[]) => void;
  onApprove: (item: SettlementItem) => void;
  onConfirmHr: (item: SettlementItem) => void;
  onOpen: (item: SettlementItem, mode?: DraftMode) => void;
  /** Rework (owner 2026-11-27): reopen a decision (or clear HR's pre-filled proposal) - the request waits again. */
  onRework: (item: SettlementItem) => void;
  /** Opens the request's Leave calendar. */
  onLeave: (item: SettlementItem) => void;
};

const who = (item: SettlementItem) => item.advance.employeeName || item.advance.employeeCode || "the employee";

const STATUS_CHIP: Record<StatusTone, string> = {
  warning: "md-chip md-chip-warning",
  sand: "md-chip md-chip-sand",
  success: "md-chip md-chip-success",
  danger: "md-chip md-chip-danger",
  neutral: "md-chip",
  wine: "md-chip md-chip-wine",
};

const LEAVE_TONE = {
  critical: "border-md-danger-300 bg-md-danger-100 text-md-danger-800",
  warning: "border-md-clay-300 bg-md-clay-100 text-md-clay-800",
  ok: "border-md-ink/10 bg-white/70 text-md-ink",
  unknown: "border-dashed border-md-ink/15 bg-white/40 text-md-ink-soft",
} as const;

// ── the groups (owner 2026-11-27): waiting at the top, approved below, rejected below those ─────────────────────────

const GROUP_TONE: Record<ReviewState, { dot: string; text: string; row: string }> = {
  pending: { dot: "bg-md-wine", text: "text-md-wine-700", row: "bg-md-wine/[0.035]" },
  approved: { dot: "bg-md-success-600", text: "text-md-success-700", row: "bg-md-success-600/[0.05]" },
  rejected: { dot: "bg-md-danger-600", text: "text-md-danger-700", row: "bg-md-danger-600/[0.045]" },
};

function groupLabel(state: ReviewState, stage: SettlementStage): string {
  return state === "pending" ? pendingLabel(stage) : state === "approved" ? "Approved" : "Rejected";
}

/** A group's heading: a dot of its colour, its name in sentence case (the MD table heads stay uppercase) and how many. */
function GroupHeading({ state, stage, count }: { state: ReviewState; stage: SettlementStage; count: number }) {
  const tone = GROUP_TONE[state];
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden="true" className={cn("h-2 w-2 shrink-0 rounded-full", tone.dot)} />
      <span className={cn("text-[12px] font-extrabold normal-case tracking-normal", tone.text)}>
        {groupLabel(state, stage)}
      </span>
      <span className="rounded-full border border-md-ink/10 bg-white/70 px-1.5 text-[10.5px] font-bold tabular-nums text-md-ink-soft">
        {count}
      </span>
    </span>
  );
}

/** The requests whose group just changed (approved, rejected, reworked back to the top): highlighted for a moment so
 *  the MD sees where the row went. Worked out from the previous render (no effect needed for that); the highlight is
 *  cleared after 1.6 s. */
function useMovedRows(items: SettlementItem[], stage: SettlementStage): ReadonlySet<number> {
  const sig = items.map((i) => `${i.id}:${reviewOf(i, stage)}`).join(",");
  const [last, setLast] = useState(() => ({ sig, states: new Map(items.map((i) => [i.id, reviewOf(i, stage)])) }));
  const [moved, setMoved] = useState<ReadonlySet<number>>(() => new Set());
  if (last.sig !== sig) {
    const states = new Map(items.map((i) => [i.id, reviewOf(i, stage)]));
    const changed = [...states].filter(([id, s]) => last.states.has(id) && last.states.get(id) !== s).map(([id]) => id);
    setLast({ sig, states });
    if (changed.length) setMoved(new Set(changed));
  }
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (moved.size === 0) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMoved(new Set()), 1600);
  }, [moved]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return moved;
}

/** The moment a row lands in its new group: it fades and slides in on a soft wine wash (still under "reduce motion"). */
const MOVED = "animate-in fade-in-0 slide-in-from-top-1 duration-500 motion-reduce:animate-none bg-md-wine/[0.07]";

// ── the cells (the same in the table and on the cards) ──────────────────────────────────────────────────────────────

/** The employee: the name with the code, then the department and designation; where they work and when it was applied
 *  for are the hover text in the table (a card shows them as lines). */
function Employee({ item, full }: { item: SettlementItem; full?: boolean }) {
  const a = item.advance;
  const where = [a.employeeDepartment, a.employeeDesignation].filter(Boolean).join(" · ");
  const applied = `Applied ${istDate(a.createdAt) || "—"}${a.appliedBy === "hr" ? " · recorded by HR" : ""}`;
  return (
    <div className="min-w-0" title={full ? undefined : [where, a.employeeBranch, applied].filter(Boolean).join("\n")}>
      <p className={cn("text-[13px] font-extrabold text-md-ink", full ? "break-words" : "truncate")}>
        {a.employeeName}
        {a.employeeCode && (
          <span className="ml-1.5 text-[11px] font-semibold tabular-nums text-md-ink-soft">{a.employeeCode}</span>
        )}
      </p>
      {where && <p className={cn("text-[11.5px] text-md-ink-soft", !full && "truncate")}>{where}</p>}
      {full && a.employeeBranch && <p className="text-[11.5px] text-md-ink-soft">{a.employeeBranch}</p>}
      {full && <p className="text-[11px] text-md-ink-soft">{applied}</p>}
    </div>
  );
}

function Requested({ item }: { item: SettlementItem }) {
  const term = termText(item.advance);
  const over = overLimit(item);
  return (
    <div className="min-w-0 whitespace-nowrap" data-testid="md-settlement-requested">
      <p
        className={cn("text-sm font-black tabular-nums", over ? "text-md-warning-800" : "text-md-ink")}
        data-testid="md-settlement-asked"
      >
        {money(item.requestedAmount)}
      </p>
      {over && (
        <p className="text-[11px] font-bold text-md-warning-800" data-testid="md-settlement-over-limit">
          Above the limit
        </p>
      )}
      {term && (
        <p className="ml-auto max-w-[8.5rem] whitespace-normal text-[11px] leading-snug text-md-ink-soft" title={term}>
          {/* the months and the EMI (two short lines at most); the first EMI month is the hover text */}
          {term.split(" · from ")[0]}
        </p>
      )}
    </div>
  );
}

/** The limit and what it is; how it was worked out shows under it on a wide screen, and is its hover text always. */
function Limit({ item, full }: { item: SettlementItem; full?: boolean }) {
  const limit = eligibleLimit(item);
  return (
    <div className="min-w-0 whitespace-nowrap" data-testid="md-settlement-limit" title={limit.detail || undefined}>
      <p className="text-sm font-bold tabular-nums text-md-ink">{money(limit.amount)}</p>
      <p className="text-[11px] font-semibold text-md-ink-soft">{limit.label}</p>
      {limit.detail && (
        <p
          className={cn(
            "text-[11px] leading-snug text-md-ink-soft",
            full ? "whitespace-normal" : "hidden whitespace-normal @7xl:block @7xl:max-w-[12rem]",
          )}
        >
          {limit.detail}
        </p>
      )}
    </div>
  );
}

function Proposal({ item, full }: { item: SettlementItem; full?: boolean }) {
  const p = hrProposal(item);
  return (
    <div className="min-w-0" data-testid="md-settlement-hr-proposal" data-kind={p.kind}>
      <p
        className={cn(
          "whitespace-nowrap text-[12px] font-bold",
          p.kind === "reject" && "text-md-danger-700",
          p.kind === "reduce" && "text-md-warning-800",
          p.kind === "none" && "font-semibold text-md-ink-soft",
        )}
      >
        {full ? (
          p.text
        ) : p.kind === "none" ? (
          <>
            No change<span className="sr-only"> proposed</span>
          </>
        ) : (
          // the column head says whose proposal it is: the table shows the amount (or Reject) alone
          <>
            <span className="sr-only">HR proposes </span>
            {p.kind === "reject" ? <span className="capitalize">reject</span> : p.text.replace(/^HR proposes /, "")}
          </>
        )}
      </p>
      {p.remark && (
        <p
          className={cn("mt-0.5 text-[11px] leading-snug text-md-ink-soft", !full && "max-w-[6.5rem] truncate")}
          title={p.remark}
        >
          “{p.remark}”
        </p>
      )}
    </div>
  );
}

/** "Changed from HR's proposal" (owner 2026-11-27): the MD's own decision differs from HR's, so the settlement goes
 *  back to HR before the MD can approve it. What HR proposed and what the MD set is the hover text. */
function ChangedChip({ item, full }: { item: SettlementItem; full?: boolean }) {
  return (
    <Hint label={changeText(item)}>
      <span
        tabIndex={0}
        className="md-chip md-chip-warning max-w-full cursor-help focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-md-wine"
        data-testid="md-settlement-changed"
      >
        {full && <GitCompareArrows size={12} aria-hidden="true" className="shrink-0" />}
        <span className="truncate">Changed from HR's proposal</span>
      </span>
    </Hint>
  );
}

/** Round 2+ (HR resubmitted): what the MD set in the earlier round and what HR answers now, on one or two short lines
 *  (they break only at the dot); every earlier round in full is the hover text. */
function TrailNote({ item, round }: { item: SettlementItem; round: number }) {
  const line = trailLine(item, round);
  if (!line) return null;
  return (
    <Hint
      label={
        <span className="block space-y-0.5">
          {line.detail.map((d) => (
            <span key={d} className="block">
              {d}
            </span>
          ))}
        </span>
      }
    >
      <p
        tabIndex={0}
        className="max-w-[14rem] cursor-help text-[11px] font-semibold leading-snug text-md-ink-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-md-wine"
        data-testid="md-settlement-trail"
      >
        <History size={11} aria-hidden="true" className="mr-1 inline align-[-1px]" />
        <span className="whitespace-nowrap">{line.you}</span> ·{" "}
        <span
          className={cn(
            "whitespace-nowrap",
            line.hr === "HR accepted it" ? "text-md-success-700" : "text-md-warning-800",
          )}
        >
          {line.hr}
        </span>
      </p>
    </Hint>
  );
}

type Tint = "warning" | "danger" | "wine";

/** On hover each action takes its own tint on a soft wash of it (the HRMS row actions' recipe, in the MD's colours);
 *  `!` because the skin's md-btn rules are unlayered (see BTN_MOTION). Approve / Confirm keep the wine glass. */
const TINT: Record<Tint, string> = {
  warning:
    "enabled:hover:[--btn-fg:var(--color-md-warning-800)]! enabled:hover:[--btn-bg:rgba(246,234,201,0.95)]! enabled:hover:[--btn-line:rgba(185,130,32,0.38)]!",
  danger:
    "enabled:hover:[--btn-fg:var(--color-md-danger-800)]! enabled:hover:[--btn-bg:rgba(250,221,219,0.96)]! enabled:hover:[--btn-line:rgba(183,45,51,0.42)]!",
  wine: "enabled:hover:[--btn-fg:var(--color-md-wine-700)]! enabled:hover:[--btn-bg:rgba(127,1,31,0.08)]! enabled:hover:[--btn-line:rgba(127,1,31,0.22)]!",
};

/** One action of a table row: a round MD-glass icon button with its hover label (the shared Radix tooltip, drawn above
 *  the page, so the table's scroll box never cuts it off; the MD skin dresses it). Hover: its tint, a pixel's lift and a
 *  shadow; pressed it sinks; the wine focus ring; a spinner while it saves. */
function IconAction({
  label,
  aria,
  onClick,
  disabled,
  saving,
  tone,
  tint,
  icon,
  testId,
}: {
  label: string;
  aria: string;
  onClick: () => void;
  disabled: boolean;
  saving: boolean;
  tone: "primary" | "soft" | "danger" | "ghost";
  tint?: Tint;
  icon: ReactNode;
  testId: string;
}) {
  return (
    <TooltipProvider delayDuration={120} skipDelayDuration={60}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <button
              type="button"
              className={cn(
                // 2rem rather than the skin's 2.25rem: three on one line keep the table inside a 1366 screen
                "md-btn md-btn-icon size-8!",
                `md-btn-${tone}`,
                tone === "ghost" ? GHOST_MOTION : BTN_MOTION,
                tint && TINT[tint],
              )}
              onClick={onClick}
              disabled={disabled || saving}
              aria-label={aria}
              aria-busy={saving || undefined}
              data-testid={testId}
            >
              {saving ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : icon}
            </button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6} collisionPadding={8} data-testid={`${testId}-tip`}>
          {saving ? "Saving…" : label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

const REWORK_TIP = "Rework — reopen this decision";
const REWORK_HR_TIP = "Rework — clear HR's proposal and decide it yourself";

/** The table's Actions column: Approve / Reduce / Reject an open request; Confirm (HR's pre-filled proposal) / Change /
 *  Rework a decided one - icon buttons on one line, as the HRMS tables (owner 2026-11-27). */
function IconActions({ item, h }: { item: SettlementItem; h: RowHandlers }) {
  const saving = h.busy.has(item.id);
  const name = who(item);
  if (decisionKind(item) === "undecided") {
    return (
      <div className="flex items-center justify-end gap-0.5" data-testid="md-settlement-actions">
        <IconAction
          label="Approve"
          aria={`Approve ${money(item.requestedAmount)} for ${name}`}
          onClick={() => h.onApprove(item)}
          disabled={false}
          saving={saving}
          tone="primary"
          icon={<Check size={15} aria-hidden="true" />}
          testId="md-settlement-approve"
        />
        <IconAction
          label="Approve a smaller amount"
          aria={`Approve a smaller amount for ${name}`}
          onClick={() => h.onOpen(item, "reduce")}
          disabled={saving}
          saving={false}
          tone="soft"
          tint="warning"
          icon={<TrendingDown size={15} aria-hidden="true" />}
          testId="md-settlement-reduce"
        />
        <IconAction
          label="Reject"
          aria={`Reject (cancel) ${name}'s request`}
          onClick={() => h.onOpen(item, "reject")}
          disabled={saving}
          saving={false}
          tone="danger"
          tint="danger"
          icon={<X size={15} aria-hidden="true" />}
          testId="md-settlement-reject"
        />
      </div>
    );
  }
  const fromHr = !!item.md.fromHr;
  return (
    <div className="flex items-center justify-end gap-0.5" data-testid="md-settlement-actions">
      {fromHr && (
        <IconAction
          label="Confirm HR's proposal"
          aria={`Confirm HR's proposal for ${name} as your decision`}
          onClick={() => h.onConfirmHr(item)}
          disabled={false}
          saving={saving}
          tone="primary"
          icon={<BadgeCheck size={15} aria-hidden="true" />}
          testId="md-settlement-confirm-hr"
        />
      )}
      <IconAction
        label="Change the decision"
        aria={`Change the decision on ${name}'s request`}
        onClick={() => h.onOpen(item)}
        disabled={saving}
        saving={false}
        tone="ghost"
        tint="wine"
        icon={<Pencil size={14} aria-hidden="true" />}
        testId="md-settlement-change"
      />
      <IconAction
        label={fromHr ? REWORK_HR_TIP : REWORK_TIP}
        aria={
          fromHr
            ? `Rework: clear HR's proposal on ${name}'s request`
            : `Rework: reopen your decision on ${name}'s request`
        }
        onClick={() => h.onRework(item)}
        disabled={saving}
        saving={!fromHr && saving}
        tone="ghost"
        tint="warning"
        icon={<RotateCcw size={14} aria-hidden="true" />}
        testId="md-settlement-rework"
      />
    </div>
  );
}

/** Approve (the full amount, at once) / Reduce… / Reject… for an open request; Confirm (HR's pre-filled proposal) /
 *  Change… / Rework for a decided one: labelled buttons, on a request's card. */
function RowActions({ item, h }: { item: SettlementItem; h: RowHandlers }) {
  const saving = h.busy.has(item.id);
  const name = who(item);
  if (decisionKind(item) === "undecided") {
    return (
      <div className="flex flex-wrap gap-1.5" data-testid="md-settlement-actions">
        <button
          type="button"
          className={cn("md-btn md-btn-primary md-btn-sm", BTN_MOTION)}
          onClick={() => h.onApprove(item)}
          disabled={saving}
          aria-busy={saving || undefined}
          aria-label={`Approve ${money(item.requestedAmount)} for ${name}`}
          data-testid="md-settlement-approve"
        >
          <Check size={14} aria-hidden="true" /> {saving ? "Saving…" : "Approve"}
        </button>
        <button
          type="button"
          className={cn("md-btn md-btn-soft md-btn-sm", BTN_MOTION, TINT.warning)}
          onClick={() => h.onOpen(item, "reduce")}
          disabled={saving}
          aria-label={`Approve a smaller amount for ${name}`}
          data-testid="md-settlement-reduce"
        >
          <TrendingDown size={14} aria-hidden="true" /> Reduce
        </button>
        <button
          type="button"
          className={cn("md-btn md-btn-danger md-btn-sm", BTN_MOTION, TINT.danger)}
          onClick={() => h.onOpen(item, "reject")}
          disabled={saving}
          aria-label={`Reject (cancel) ${name}'s request`}
          data-testid="md-settlement-reject"
        >
          <X size={14} aria-hidden="true" /> Reject
        </button>
      </div>
    );
  }
  const fromHr = !!item.md.fromHr;
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="md-settlement-actions">
      {fromHr && (
        <button
          type="button"
          className={cn("md-btn md-btn-primary md-btn-sm", BTN_MOTION)}
          onClick={() => h.onConfirmHr(item)}
          disabled={saving}
          aria-busy={saving || undefined}
          aria-label={`Confirm HR's proposal for ${name} as your decision`}
          data-testid="md-settlement-confirm-hr"
        >
          <BadgeCheck size={14} aria-hidden="true" /> {saving ? "Saving…" : "Confirm"}
        </button>
      )}
      <button
        type="button"
        className={cn("md-btn md-btn-ghost md-btn-sm", GHOST_MOTION, TINT.wine)}
        onClick={() => h.onOpen(item)}
        disabled={saving}
        aria-label={`Change the decision on ${name}'s request`}
        data-testid="md-settlement-change"
      >
        <Pencil size={13} aria-hidden="true" /> Change
      </button>
      <button
        type="button"
        className={cn("md-btn md-btn-ghost md-btn-sm", GHOST_MOTION, TINT.warning)}
        onClick={() => h.onRework(item)}
        disabled={saving}
        aria-busy={(!fromHr && saving) || undefined}
        title={fromHr ? REWORK_HR_TIP : REWORK_TIP}
        aria-label={
          fromHr
            ? `Rework: clear HR's proposal on ${name}'s request`
            : `Rework: reopen your decision on ${name}'s request`
        }
        data-testid="md-settlement-rework"
      >
        <RotateCcw size={13} aria-hidden="true" /> {!fromHr && saving ? "Saving…" : "Rework"}
      </button>
    </div>
  );
}

/** The MD's decision on a card: its chip, "From HR — not yet confirmed by you" for a pre-filled proposal, "Changed from
 *  HR's proposal", the earlier round, the remark, the buttons. */
function Decision({ item, h }: { item: SettlementItem; h: RowHandlers }) {
  const kind = decisionKind(item);
  const flagged = h.highlight.has(item.id) && kind === "undecided";
  return (
    <div className="min-w-0 space-y-1.5">
      {flagged && (
        <p className="text-[11px] font-extrabold text-md-danger-700" data-testid="md-settlement-needs-decision">
          Needs your decision
        </p>
      )}
      {kind !== "undecided" ? (
        <DecisionChip item={item} />
      ) : (
        !h.canDecide && <span className="text-[12px] text-md-ink-soft">Not decided</span>
      )}
      {kind !== "undecided" && item.md.fromHr && (
        <p className="text-[11px] font-bold text-md-warning-800" data-testid="md-settlement-from-hr">
          From HR — not yet confirmed by you
        </p>
      )}
      {h.stage === "md_review" && mdChangedOf(item) && (
        <div>
          <ChangedChip item={item} full />
        </div>
      )}
      <TrailNote item={item} round={h.mdRound} />
      {kind !== "undecided" && item.md.remark && (
        <p className="text-[11px] leading-snug text-md-ink-soft" data-testid="md-settlement-remark">
          <span className="font-bold text-md-ink">Remark:</span> “{item.md.remark}”
        </p>
      )}
      {h.canDecide && <RowActions item={item} h={h} />}
    </div>
  );
}

/** The table's "Your decision" column (owner 2026-11-27: one value per column, no stacked buttons): the decision chip and,
 *  under it, where the request stands (to decide, from HR - not yet confirmed by you, changed from HR's proposal, decided
 *  by you, with HR, final), the earlier round and the remark on one line each; the buttons are the Actions column. */
function DecisionCell({ item, h }: { item: SettlementItem; h: RowHandlers }) {
  const kind = decisionKind(item);
  const flagged = h.highlight.has(item.id) && kind === "undecided";
  const s = requestStatus(item, h.stage);
  const fromHr = kind !== "undecided" && item.md.fromHr;
  const changed = h.stage === "md_review" && kind !== "undecided" && mdChangedOf(item);
  const start =
    finalized(h.stage) && (item.effective?.decision ?? item.final.decision) === "approved"
      ? shortMonth(item.final.startMonth, item.final.startYear)
      : null;
  const asChip = kind === "undecided" || h.stage !== "md_review";
  return (
    <div className="min-w-0 space-y-1">
      {flagged && (
        <p className="text-[11px] font-extrabold text-md-danger-700" data-testid="md-settlement-needs-decision">
          Needs your decision
        </p>
      )}
      {kind !== "undecided" && <DecisionChip item={item} />}
      {changed ? (
        <div>
          <ChangedChip item={item} />
        </div>
      ) : asChip ? (
        <span className={cn(STATUS_CHIP[s.tone], "max-w-full")} data-testid="md-settlement-status">
          <span className="truncate">{s.text}</span>
        </span>
      ) : (
        <p
          className={cn("whitespace-nowrap text-[11px] font-semibold text-md-ink-soft", fromHr && "sr-only")}
          data-testid="md-settlement-status"
        >
          {s.text}
        </p>
      )}
      {fromHr && (
        <p
          className="max-w-[11rem] text-balance text-[11px] font-bold leading-snug text-md-warning-800"
          data-testid="md-settlement-from-hr"
        >
          From HR — not yet confirmed by you
        </p>
      )}
      <TrailNote item={item} round={h.mdRound} />
      {start && <p className="whitespace-nowrap text-[11px] text-md-ink-soft">First deduction {start}</p>}
      {kind !== "undecided" && item.md.remark && (
        <p
          className="max-w-[11rem] truncate text-[11px] text-md-ink-soft"
          title={item.md.remark}
          data-testid="md-settlement-remark"
        >
          <span className="font-bold text-md-ink">Remark:</span> “{item.md.remark}”
        </p>
      )}
    </div>
  );
}

/** The leave of the 1st-20th as a button with its count: it opens the request's Leave calendar. */
function Leave({ item, h }: { item: SettlementItem; h: RowHandlers }) {
  const info = leaveChip(item.advance.leaveCheck);
  const days = item.advance.leaveCheck?.days;
  return (
    <button
      type="button"
      onClick={() => h.onLeave(item)}
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold leading-none transition-colors hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-md-wine",
        LEAVE_TONE[info.tone],
      )}
      title={`${info.detail} Click to see the calendar.`}
      aria-label={`${info.detail} Open the leave calendar.`}
      data-testid="md-settlement-leave"
      data-tone={info.tone}
    >
      {info.tone === "critical" ? (
        <AlertOctagon size={12} aria-hidden="true" className="shrink-0" />
      ) : info.tone === "warning" ? (
        <AlertTriangle size={12} aria-hidden="true" className="shrink-0" />
      ) : (
        <CalendarDays size={12} aria-hidden="true" className="shrink-0" />
      )}
      {/* the words as the HRMS says them ("3 days leave"), the warning in the icon, the tone and the hover text */}
      <span className="sr-only">
        {info.tone === "critical" ? "Frequent leave: " : info.tone === "warning" ? "Leave warning: " : ""}
      </span>
      <span className="tabular-nums" data-testid="md-settlement-leave-count">
        {days == null ? "—" : days}
      </span>{" "}
      <span className="truncate">
        {info.tone === "unknown"
          ? "Not checked"
          : `${days === 1 ? "day" : "days"}${info.tone === "critical" || info.tone === "warning" ? " leave" : ""}`}
      </span>
    </button>
  );
}

function Status({ item, stage }: { item: SettlementItem; stage: SettlementStage }) {
  const s = requestStatus(item, stage);
  const start =
    finalized(stage) && (item.effective?.decision ?? item.final.decision) === "approved"
      ? shortMonth(item.final.startMonth, item.final.startYear)
      : null;
  return (
    <div className="min-w-0 space-y-1">
      <span className={cn(STATUS_CHIP[s.tone], "max-w-full")} data-testid="md-settlement-status">
        <span className="truncate">{s.text}</span>
      </span>
      {start && <p className="text-[11px] text-md-ink-soft">First deduction {start}</p>}
    </div>
  );
}

function Remarks({ item, full }: { item: SettlementItem; full?: boolean }) {
  const a = item.advance;
  const lines: { label: string; text: string; testId?: string }[] = [];
  if (a.purpose?.trim()) lines.push({ label: "Purpose", text: a.purpose.trim(), testId: "md-settlement-purpose" });
  if (a.limitRemark?.trim()) lines.push({ label: "Above the limit", text: a.limitRemark.trim() });
  if (item.final.changedFromMd)
    lines.push({
      label: "HR changed your decision",
      text: item.final.remark || "no remark",
      testId: "md-settlement-final-changed",
    });
  if (item.auditor?.remark?.trim()) lines.push({ label: "Auditor", text: item.auditor.remark.trim() });
  if (!lines.length) return <span className="text-[11px] text-md-ink-soft">—</span>;
  return (
    <div className="min-w-0 space-y-1">
      {lines.map((l) => (
        <p
          key={l.label}
          className={cn("text-[11px] leading-snug text-md-ink-soft", !full && "max-w-[8rem] truncate")}
          title={full ? undefined : `${l.label}: ${l.text}`}
          data-testid={l.testId}
        >
          <span className="font-bold text-md-ink">{l.label}:</span> “{l.text}”
        </p>
      ))}
    </div>
  );
}

function RowCheck({ item, h }: { item: SettlementItem; h: RowHandlers }) {
  return (
    <input
      type="checkbox"
      className="h-4 w-4 cursor-pointer accent-md-wine"
      checked={h.selected.has(item.id)}
      onChange={(e) => h.onSelect(item.id, e.target.checked)}
      aria-label={`Select ${who(item)}`}
      data-testid="md-settlement-select"
    />
  );
}

function SelectAll({ items, h, label }: { items: SettlementItem[]; h: RowHandlers; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const ids = shownIds(items);
  const chosen = ids.filter((id) => h.selected.has(id)).length;
  const all = ids.length > 0 && chosen === ids.length;
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = chosen > 0 && !all;
  }, [chosen, all]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className="h-4 w-4 cursor-pointer accent-md-wine"
      checked={all}
      onChange={() => h.onToggleAll(ids)}
      aria-label={label}
      data-testid="md-settlement-select-all"
    />
  );
}

// ── the table (a wide screen) ───────────────────────────────────────────────────────────────────────────────────────

const TH = "whitespace-nowrap px-2.5 py-2.5 align-bottom";
const TD = "px-2.5 py-3 align-middle";
/** Remarks show from a wide card on (the purpose and every remark are also each one's hover text). */
const WIDE = "hidden @6xl:table-cell";

/**
 * The table (owner 2026-11-27: "the same quality as the HRMS tables"): one value per column, each on one or two short
 * lines (the longer detail is the hover text), the decision and where the request stands in one column, and the buttons
 * as round icon buttons on one line in their own column - no stacked buttons, no wrapping columns. The rows come in
 * three groups under a divider row each: waiting for the MD, approved, rejected (a reworked request goes back to the top).
 */
function RequestTable({
  items,
  h,
  label,
  moved,
}: {
  items: SettlementItem[];
  h: RowHandlers;
  label: string;
  moved: ReadonlySet<number>;
}) {
  const groups = groupByReview(items, (i) => reviewOf(i, h.stage));
  // the divider spans the columns always shown; the Remarks (wide only) and Actions cells follow it, so the row has
  // exactly the table's columns at every width
  const lead = (h.canDecide ? 1 : 0) + 6;
  return (
    <div className="md-panel hidden overflow-x-auto @5xl:block" data-testid="md-settlement-table">
      <table className="w-full border-collapse text-left text-xs">
        <caption className="sr-only">{label}</caption>
        <thead>
          <tr className="border-b border-md-line text-[10.5px] font-bold uppercase tracking-wide text-md-ink-soft">
            {h.canDecide && (
              <th scope="col" className={cn(TH, "w-9")}>
                <SelectAll items={items} h={h} label={`Select all ${items.length} requests shown`} />
              </th>
            )}
            <th scope="col" className={TH}>
              Employee
            </th>
            <th scope="col" className={cn(TH, "text-right")}>
              Requested
            </th>
            <th scope="col" className={cn(TH, "text-right")}>
              Eligible limit
            </th>
            <th scope="col" className={TH}>
              HR's proposal
            </th>
            <th scope="col" className={TH}>
              Your decision
            </th>
            <th scope="col" className={TH}>
              Leave
              <span className="block text-[10px] font-semibold normal-case tracking-normal">1st–20th</span>
            </th>
            <th scope="col" className={cn(TH, WIDE)}>
              Remarks
            </th>
            {h.canDecide && (
              <th scope="col" className={cn(TH, "text-right")}>
                Actions
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <Fragment key={g.state}>
              <tr
                className={cn("border-b border-md-line", GROUP_TONE[g.state].row)}
                data-testid={`md-settlement-group-${g.state}`}
              >
                <th scope="colgroup" colSpan={lead} className="px-2.5 py-1.5 text-left font-normal">
                  <GroupHeading state={g.state} stage={h.stage} count={g.rows.length} />
                </th>
                <td className={WIDE} aria-hidden="true" />
                {h.canDecide && <td aria-hidden="true" />}
              </tr>
              {g.rows.map((item) => {
                const flagged = h.highlight.has(item.id) && decisionKind(item) === "undecided";
                return (
                  <tr
                    key={item.id}
                    className={cn(
                      "border-b border-md-line transition-colors duration-700 last:border-b-0",
                      flagged && "bg-md-danger-50/70",
                      h.selected.has(item.id) && "bg-md-wine/[0.04]",
                      moved.has(item.id) && MOVED,
                    )}
                    data-testid={`md-settlement-row-${item.id}`}
                    data-review={g.state}
                    data-moved={moved.has(item.id) || undefined}
                    data-flagged={flagged || undefined}
                  >
                    {h.canDecide && (
                      <td className={TD}>
                        <RowCheck item={item} h={h} />
                      </td>
                    )}
                    <td className={cn(TD, "max-w-[10rem]")}>
                      <Employee item={item} />
                    </td>
                    <td className={cn(TD, "text-right")}>
                      <Requested item={item} />
                    </td>
                    <td className={cn(TD, "text-right")}>
                      <Limit item={item} />
                    </td>
                    <td className={TD}>
                      <Proposal item={item} />
                    </td>
                    <td className={TD}>
                      <DecisionCell item={item} h={h} />
                    </td>
                    <td className={cn(TD, "whitespace-nowrap")}>
                      <Leave item={item} h={h} />
                    </td>
                    <td className={cn(TD, WIDE)}>
                      <Remarks item={item} />
                    </td>
                    {h.canDecide && (
                      <td className={cn(TD, "text-right")}>
                        <IconActions item={item} h={h} />
                      </td>
                    )}
                  </tr>
                );
              })}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── the cards (a phone or a narrow window): every value under its own label ────────────────────────────────────────

function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={cn("min-w-0", wide && "col-span-2")}>
      <dt className="text-[10.5px] font-bold uppercase tracking-wide text-md-ink-soft">{label}</dt>
      <dd className="mt-1">{children}</dd>
    </div>
  );
}

function RequestCards({
  items,
  h,
  label,
  moved,
}: {
  items: SettlementItem[];
  h: RowHandlers;
  label: string;
  moved: ReadonlySet<number>;
}) {
  const groups = groupByReview(items, (i) => reviewOf(i, h.stage));
  return (
    <div className="space-y-3 @5xl:hidden">
      {h.canDecide && items.length > 0 && (
        <label className="flex items-center gap-2 text-xs font-bold text-md-ink">
          <SelectAll items={items} h={h} label={`Select all ${items.length} requests shown`} />
          Select all ({items.length})
        </label>
      )}
      {groups.map((g) => (
        <section
          key={g.state}
          className="space-y-2"
          aria-label={`${groupLabel(g.state, h.stage)}: ${g.rows.length}`}
          data-testid={`md-settlement-card-group-${g.state}`}
        >
          <div className={cn("rounded-xl px-3 py-1.5", GROUP_TONE[g.state].row)}>
            <GroupHeading state={g.state} stage={h.stage} count={g.rows.length} />
          </div>
          <ul
            className="grid grid-cols-1 items-start gap-3 @2xl:grid-cols-2"
            aria-label={`${label}: ${groupLabel(g.state, h.stage)}`}
            data-testid="md-settlement-cards"
          >
            {g.rows.map((item) => {
              const flagged = h.highlight.has(item.id) && decisionKind(item) === "undecided";
              return (
                <li key={item.id}>
                  <article
                    className={cn(
                      "rounded-2xl border border-white/80 bg-white/55 p-4 shadow-sm transition-colors duration-700",
                      flagged && "ring-2 ring-md-danger-400",
                      h.selected.has(item.id) && "ring-2 ring-md-wine/40",
                      moved.has(item.id) && MOVED,
                    )}
                    aria-label={`${typeLabelOf(item.advance)} request from ${who(item)}`}
                    data-testid={`md-settlement-card-${item.id}`}
                    data-review={g.state}
                    data-flagged={flagged || undefined}
                  >
                    <div className="flex items-start gap-3">
                      {h.canDecide && (
                        <div className="pt-0.5">
                          <RowCheck item={item} h={h} />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <Employee item={item} full />
                      </div>
                    </div>
                    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-md-line pt-3">
                      <Field label="Requested">
                        <Requested item={item} />
                      </Field>
                      <Field label="Eligible limit">
                        <Limit item={item} full />
                      </Field>
                      <Field label="HR's proposal">
                        <Proposal item={item} full />
                      </Field>
                      <Field label="Leave (1st–20th)">
                        <Leave item={item} h={h} />
                      </Field>
                      <Field label="Your decision" wide>
                        <Decision item={item} h={h} />
                      </Field>
                      <Field label="Status">
                        <Status item={item} stage={h.stage} />
                      </Field>
                      <Field label="Remarks">
                        <Remarks item={item} full />
                      </Field>
                    </dl>
                  </article>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** The batch's requests: a table on a wide screen, cards on a phone (the same handlers drive both), every value under
 *  its own header: employee, requested, eligible limit, HR's proposal, your decision, leave, status, remarks. Both are
 *  grouped the same way: waiting for the MD at the top, then approved, then rejected (owner 2026-11-27). */
export default function RequestList({
  items,
  handlers,
  label,
}: {
  items: SettlementItem[];
  handlers: RowHandlers;
  label: string;
}) {
  const moved = useMovedRows(items, handlers.stage);
  return (
    <>
      <RequestTable items={items} h={handlers} label={label} moved={moved} />
      <RequestCards items={items} h={handlers} label={label} moved={moved} />
    </>
  );
}
