import { useEffect, useRef, type ReactNode } from "react";
import {
  AlertOctagon,
  AlertTriangle,
  BadgeCheck,
  CalendarDays,
  Check,
  Loader2,
  Pencil,
  TrendingDown,
  Undo2,
  X,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  decisionKind,
  eligibleLimit,
  finalized,
  hrProposal,
  istDate,
  leaveChip,
  money,
  overLimit,
  requestStatus,
  shortMonth,
  shownIds,
  termText,
  typeLabelOf,
  type DraftMode,
  type StatusTone,
} from "./logic";
import { DecisionChip } from "./parts";
import type { SettlementItem, SettlementStage } from "./types";

export type RowHandlers = {
  /** The batch's stage (what the Status column says). */
  stage: SettlementStage;
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
  onUndo: (item: SettlementItem) => void;
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
        {p.text}
      </p>
      {p.remark && (
        <p
          className={cn("mt-0.5 text-[11px] leading-snug text-md-ink-soft", !full && "max-w-[8rem] truncate")}
          title={p.remark}
        >
          “{p.remark}”
        </p>
      )}
    </div>
  );
}

/** One action of a table row: a round MD-glass icon button with its hover label (the shared Radix tooltip, drawn above
 *  the page, so the table's scroll box never cuts it off; the MD skin dresses it). */
function IconAction({
  label,
  aria,
  onClick,
  disabled,
  saving,
  tone,
  icon,
  testId,
}: {
  label: string;
  aria: string;
  onClick: () => void;
  disabled: boolean;
  saving: boolean;
  tone: "primary" | "soft" | "danger" | "ghost";
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
              className={cn("md-btn md-btn-icon", `md-btn-${tone}`)}
              onClick={onClick}
              disabled={disabled}
              aria-label={aria}
              data-testid={testId}
            >
              {saving ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : icon}
            </button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6} collisionPadding={8}>
          {saving ? "Saving…" : label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** The table's Actions column: Approve / Reduce / Reject an open request; Confirm (HR's pre-filled proposal) / Change /
 *  Undo a decided one - icon buttons on one line, as the HRMS tables (owner 2026-11-27). */
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
          disabled={saving}
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
          icon={<X size={15} aria-hidden="true" />}
          testId="md-settlement-reject"
        />
      </div>
    );
  }
  return (
    <div className="flex items-center justify-end gap-0.5" data-testid="md-settlement-actions">
      {item.md.fromHr && (
        <IconAction
          label="Confirm HR's proposal"
          aria={`Confirm HR's proposal for ${name} as your decision`}
          onClick={() => h.onConfirmHr(item)}
          disabled={saving}
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
        icon={<Pencil size={14} aria-hidden="true" />}
        testId="md-settlement-change"
      />
      <IconAction
        label="Undo the decision"
        aria={`Undo the decision on ${name}'s request`}
        onClick={() => h.onUndo(item)}
        disabled={saving}
        saving={!item.md.fromHr && saving}
        tone="ghost"
        icon={<Undo2 size={14} aria-hidden="true" />}
        testId="md-settlement-undo"
      />
    </div>
  );
}

/** Approve (the full amount, at once) / Reduce… / Reject… for an open request; Confirm (HR's pre-filled proposal) /
 *  Change… / Undo for a decided one: labelled buttons, on a request's card. */
function RowActions({ item, h }: { item: SettlementItem; h: RowHandlers }) {
  const saving = h.busy.has(item.id);
  const name = who(item);
  if (decisionKind(item) === "undecided") {
    return (
      <div className="flex flex-wrap gap-1.5" data-testid="md-settlement-actions">
        <button
          type="button"
          className="md-btn md-btn-primary md-btn-sm"
          onClick={() => h.onApprove(item)}
          disabled={saving}
          aria-label={`Approve ${money(item.requestedAmount)} for ${name}`}
          data-testid="md-settlement-approve"
        >
          <Check size={14} aria-hidden="true" /> {saving ? "Saving…" : "Approve"}
        </button>
        <button
          type="button"
          className="md-btn md-btn-soft md-btn-sm"
          onClick={() => h.onOpen(item, "reduce")}
          disabled={saving}
          aria-label={`Approve a smaller amount for ${name}`}
          data-testid="md-settlement-reduce"
        >
          <TrendingDown size={14} aria-hidden="true" /> Reduce
        </button>
        <button
          type="button"
          className="md-btn md-btn-danger md-btn-sm"
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
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="md-settlement-actions">
      {item.md.fromHr && (
        <button
          type="button"
          className="md-btn md-btn-primary md-btn-sm"
          onClick={() => h.onConfirmHr(item)}
          disabled={saving}
          aria-label={`Confirm HR's proposal for ${name} as your decision`}
          data-testid="md-settlement-confirm-hr"
        >
          <BadgeCheck size={14} aria-hidden="true" /> {saving ? "Saving…" : "Confirm"}
        </button>
      )}
      <button
        type="button"
        className="md-btn md-btn-ghost md-btn-sm"
        onClick={() => h.onOpen(item)}
        disabled={saving}
        aria-label={`Change the decision on ${name}'s request`}
        data-testid="md-settlement-change"
      >
        <Pencil size={13} aria-hidden="true" /> Change
      </button>
      <button
        type="button"
        className="md-btn md-btn-ghost md-btn-sm"
        onClick={() => h.onUndo(item)}
        disabled={saving}
        aria-label={`Undo the decision on ${name}'s request`}
        data-testid="md-settlement-undo"
      >
        <Undo2 size={13} aria-hidden="true" /> {!item.md.fromHr && saving ? "Saving…" : "Undo"}
      </button>
    </div>
  );
}

/** The MD's decision: its chip, "From HR — not yet confirmed by you" for a pre-filled proposal, the remark, the buttons. */
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
 *  under it, where the request stands (To decide, from HR - not yet confirmed by you, decided by you, with HR, final) and
 *  the remark on one line; the buttons are the Actions column. */
function DecisionCell({ item, h }: { item: SettlementItem; h: RowHandlers }) {
  const kind = decisionKind(item);
  const flagged = h.highlight.has(item.id) && kind === "undecided";
  const s = requestStatus(item, h.stage);
  const fromHr = kind !== "undecided" && item.md.fromHr;
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
      {asChip ? (
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
        <p className="whitespace-nowrap text-[11px] font-bold text-md-warning-800" data-testid="md-settlement-from-hr">
          From HR — not yet confirmed by you
        </p>
      )}
      {start && <p className="whitespace-nowrap text-[11px] text-md-ink-soft">First deduction {start}</p>}
      {kind !== "undecided" && item.md.remark && (
        <p
          className="max-w-[14rem] truncate text-[11px] text-md-ink-soft"
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
          className={cn("text-[11px] leading-snug text-md-ink-soft", !full && "max-w-[10rem] truncate")}
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

const TH = "whitespace-nowrap px-3 py-2.5 align-bottom";
const TD = "px-3 py-3 align-middle";
/** Remarks show from a wide card on (the purpose and every remark are also each one's hover text). */
const WIDE = "hidden @6xl:table-cell";

/**
 * The table (owner 2026-11-27: "the same quality as the HRMS tables"): one value per column, each on one or two short
 * lines (the longer detail is the hover text), the decision and where the request stands in one column, and the buttons
 * as round icon buttons on one line in their own column - no stacked buttons, no wrapping columns.
 */
function RequestTable({ items, h, label }: { items: SettlementItem[]; h: RowHandlers; label: string }) {
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
          {items.map((item) => {
            const flagged = h.highlight.has(item.id) && decisionKind(item) === "undecided";
            return (
              <tr
                key={item.id}
                className={cn(
                  "border-b border-md-line last:border-b-0",
                  flagged && "bg-md-danger-50/70",
                  h.selected.has(item.id) && "bg-md-wine/[0.04]",
                )}
                data-testid={`md-settlement-row-${item.id}`}
                data-flagged={flagged || undefined}
              >
                {h.canDecide && (
                  <td className={TD}>
                    <RowCheck item={item} h={h} />
                  </td>
                )}
                <td className={cn(TD, "max-w-[11rem]")}>
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

function RequestCards({ items, h, label }: { items: SettlementItem[]; h: RowHandlers; label: string }) {
  return (
    <div className="space-y-3 @5xl:hidden">
      {h.canDecide && items.length > 0 && (
        <label className="flex items-center gap-2 text-xs font-bold text-md-ink">
          <SelectAll items={items} h={h} label={`Select all ${items.length} requests shown`} />
          Select all ({items.length})
        </label>
      )}
      <ul
        className="grid grid-cols-1 items-start gap-3 @2xl:grid-cols-2"
        aria-label={label}
        data-testid="md-settlement-cards"
      >
        {items.map((item) => {
          const flagged = h.highlight.has(item.id) && decisionKind(item) === "undecided";
          return (
            <li key={item.id}>
              <article
                className={cn(
                  "rounded-2xl border border-white/80 bg-white/55 p-4 shadow-sm",
                  flagged && "ring-2 ring-md-danger-400",
                  h.selected.has(item.id) && "ring-2 ring-md-wine/40",
                )}
                aria-label={`${typeLabelOf(item.advance)} request from ${who(item)}`}
                data-testid={`md-settlement-card-${item.id}`}
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
    </div>
  );
}

/** The batch's requests: a table on a wide screen, cards on a phone (the same handlers drive both), every value under
 *  its own header: employee, requested, eligible limit, HR's proposal, your decision, leave, status, remarks. */
export default function RequestList({
  items,
  handlers,
  label,
}: {
  items: SettlementItem[];
  handlers: RowHandlers;
  label: string;
}) {
  return (
    <>
      <RequestTable items={items} h={handlers} label={label} />
      <RequestCards items={items} h={handlers} label={label} />
    </>
  );
}
