import { useId, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCheck,
  CheckCircle2,
  ClipboardCheck,
  CornerUpLeft,
  GitCompareArrows,
  Search,
  X,
} from "lucide-react";
import { EmptyBlock } from "@/components/md/kit/states";
import { LeaveCalendarDialog } from "@/components/leave-calendar/LeaveCalendar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "@/hooks/use-toast";
import { usePayrollSettings } from "@/lib/api-client/custom-hooks";
import { describeMdError } from "@/lib/api-client/custom-hooks/md";
import { num } from "@/lib/md/format";
import { cleanRejectRemark, REJECT_REMARK_MAX, REJECT_REMARK_MIN } from "@/lib/reject-remark";
import { cn } from "@/lib/utils";
import { changedIds, loadLeaveCalendar, undecidedIds, useBulkDecide, useConfirmBatch, useDecideItem } from "./api";
import DecisionDialog, { type DecisionTarget } from "./DecisionDialog";
import { buildDirectFiles } from "./direct";
import HistoryView from "./HistoryView";
import {
  baseOf,
  batchTitle,
  bulkResultText,
  confirmHrBody,
  decisionKind,
  filterItems,
  filterOptions,
  finalized,
  hasLeaveAlert,
  isListFilter,
  istDateTime,
  mdRoundOf,
  money,
  overLimit,
  periodLabel,
  plural,
  REJECT_MESSAGE,
  reviewSummary,
  roundsToZero,
  toggleAll,
  type DraftMode,
  type ListFilter,
  type SettlementView,
} from "./logic";
import OverviewView from "./OverviewView";
import { BTN_MOTION, GHOST_MOTION, Quote, SelectField } from "./parts";
import RequestList, { type RowHandlers } from "./RequestList";
import ReturnDialog from "./ReturnDialog";
import ReviewSheet from "./ReviewSheet";
import ReworkState from "./ReworkState";
import type { ConfirmMode, DecideBody, MdDecision, SettlementBatch, SettlementItem } from "./types";

const STAGE_CHIP: Record<string, string> = {
  md_review: "md-chip md-chip-wine",
  md_changes: "md-chip md-chip-warning",
  hr_final: "md-chip md-chip-sand",
  completed: "md-chip md-chip-success",
};

const without = (set: ReadonlySet<number>, id: number) => new Set([...set].filter((x) => x !== id));

/** Approve or reject the ticked requests at once (owner 2026-11-27): approve takes HR's proposed amount where HR proposed
 *  a smaller one, else the full amount asked (a Salary Advance: its rounded amount; one that rounds to ₹0 is left out);
 *  reject needs one reason for all. */
function BulkDialog({
  decision,
  items,
  onClose,
  onSubmit,
  pending,
  error,
}: {
  decision: MdDecision | null;
  items: SettlementItem[];
  onClose: () => void;
  onSubmit: (remark: string) => void;
  pending: boolean;
  error: string | null;
}) {
  const [remark, setRemark] = useState("");
  const [tried, setTried] = useState(false);
  const remarkId = useId();
  const rejecting = decision === "rejected";
  const problem = rejecting && cleanRejectRemark(remark).length < REJECT_REMARK_MIN ? REJECT_MESSAGE : null;
  const alerts = items.filter(hasLeaveAlert).length;
  const above = items.filter(overLimit).length;
  const reducedByHr = items.filter((i) => i.hr?.action === "reduce").length;
  // a Salary Advance that rounds to ₹0 can only be rejected: the server leaves it out of an approval (2026-11-27)
  const zero = items.filter(roundsToZero).length;
  const rounded = items.some((i) => i.rounding);
  const total = items
    .filter((i) => !roundsToZero(i))
    .reduce((s, i) => s + (i.hr?.action === "reduce" && i.hr.amount != null ? i.hr.amount : baseOf(i)), 0);
  const send = () => {
    setTried(true);
    if (problem) return;
    onSubmit(cleanRejectRemark(remark));
  };
  return (
    <Dialog open={decision !== null} onOpenChange={(next) => !next && !pending && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="md-settlement-bulk-dialog">
        <DialogHeader>
          <DialogTitle className="text-lg font-black text-md-ink">
            {rejecting ? "Reject" : "Approve"} {plural(items.length, "request")}?
          </DialogTitle>
          <DialogDescription className="text-[13px] text-md-ink-soft">
            {rejecting
              ? "Each ticked request is rejected with the reason below."
              : `Each ticked request is approved for the amount HR proposed${
                  reducedByHr ? ` (${reducedByHr} smaller)` : ""
                }, else the full amount asked${rounded ? " (a Salary Advance: its rounded amount)" : ""}: ${money(
                  total,
                )} in all.`}
          </DialogDescription>
        </DialogHeader>
        {(alerts > 0 || above > 0 || zero > 0) && !rejecting && (
          <ul
            className="md-panel-sand space-y-1 p-3 text-xs text-md-warning-800"
            data-testid="md-settlement-bulk-warnings"
          >
            {alerts > 0 && (
              <li className="flex items-start gap-1.5">
                <AlertTriangle size={13} className="mt-px shrink-0" aria-hidden="true" />
                {plural(alerts, "of them has", "of them have")} a leave warning or frequent leave (1st–20th).
              </li>
            )}
            {above > 0 && (
              <li className="flex items-start gap-1.5">
                <AlertTriangle size={13} className="mt-px shrink-0" aria-hidden="true" />
                {plural(above, "of them asks", "of them ask")} for more than the limit.
              </li>
            )}
            {zero > 0 && (
              <li className="flex items-start gap-1.5 text-md-danger-700" data-testid="md-settlement-bulk-zero">
                <AlertTriangle size={13} className="mt-px shrink-0" aria-hidden="true" />
                {zero === 1
                  ? "1 of them rounds to ₹0 and is left out: reject it instead."
                  : `${plural(zero, "of them", "of them")} round to ₹0 and are left out: reject them instead.`}
              </li>
            )}
          </ul>
        )}
        <div>
          <label htmlFor={remarkId} className="block text-xs font-bold text-md-ink">
            {rejecting ? "Reason for rejecting" : "Remark"}{" "}
            <span className={cn("font-medium", rejecting ? "text-md-danger-700" : "text-md-ink-soft")}>
              ({rejecting ? "required, for all of them" : "optional; a smaller amount without one keeps HR's"})
            </span>
          </label>
          <textarea
            id={remarkId}
            value={remark}
            onChange={(e) => setRemark(e.target.value)}
            maxLength={REJECT_REMARK_MAX}
            rows={3}
            aria-invalid={(tried && !!problem) || undefined}
            className={cn(
              "md-field mt-1 w-full resize-y px-3 py-2 text-sm",
              tried && problem && "border-md-danger-600",
            )}
            data-testid="md-settlement-bulk-remark"
          />
          {tried && problem && (
            <p
              role="alert"
              className="mt-1 text-xs font-semibold text-md-danger-700"
              data-testid="md-settlement-bulk-problem"
            >
              {problem}
            </p>
          )}
        </div>
        {error && (
          <p role="alert" className="text-xs font-semibold text-md-danger-700" data-testid="md-settlement-bulk-error">
            {error}
          </p>
        )}
        <DialogFooter className="gap-2 sm:gap-2">
          <button
            type="button"
            className={cn("md-btn md-btn-ghost", GHOST_MOTION)}
            onClick={onClose}
            disabled={pending}
          >
            Cancel
          </button>
          <button
            type="button"
            className={cn("md-btn", rejecting ? "md-btn-danger" : "md-btn-primary", BTN_MOTION)}
            onClick={send}
            disabled={pending || items.length === 0}
            aria-busy={pending || undefined}
            data-testid="md-settlement-bulk-send"
          >
            {rejecting ? <X size={15} aria-hidden="true" /> : <CheckCheck size={15} aria-hidden="true" />}
            {pending ? "Saving…" : `${rejecting ? "Reject" : "Approve"} ${plural(items.length, "request")}`}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** After the MD's Direct to Auditor: finalized by the MD and sent to the auditor, or finalized but not sent (why). */
function DirectState({ batch, warning }: { batch: SettlementBatch; warning: string | null }) {
  if (batch.finalizedVia !== "md") return null;
  const waitingToSend = batch.stage === "auditor_send";
  return (
    <div
      className={cn("space-y-1 p-3.5", waitingToSend ? "md-panel-sand" : "md-panel")}
      data-testid="md-settlement-direct-state"
    >
      <p
        className={cn(
          "flex items-center gap-1.5 text-[13px] font-extrabold",
          waitingToSend ? "text-md-warning-800" : "text-md-success-700",
        )}
      >
        {waitingToSend ? <AlertTriangle size={15} aria-hidden="true" /> : <CheckCircle2 size={15} aria-hidden="true" />}
        {waitingToSend ? "Finalized by you — not sent to the auditor yet" : "Finalized by you and sent to the auditor"}
      </p>
      <p className="text-xs leading-relaxed text-md-ink-soft">
        {batch.finalizedAt ? `Finalized on ${istDateTime(batch.finalizedAt)}. ` : ""}
        {waitingToSend
          ? warning || "The auditor e-mail could not be sent. HR can send it from the Loan & Advance page."
          : "HR Final Settlement was skipped; the auditor reviews your decisions."}
      </p>
      {batch.mdNote && <Quote label="Your note">{batch.mdNote}</Quote>}
    </div>
  );
}

/**
 * One forwarded batch, one section at a time (owner 2026-11-27: one row of tabs at the top of the page, each section its
 * own tab, nothing nested): `requests` = the requests (grouped: waiting for the MD, approved, rejected; checkboxes for
 * bulk decisions) with the MD's buttons while the batch is at MD Review, the note and the Review bar; `overview` = the
 * branching tracker, the headline numbers, HR's note and "Sent back to HR" (OverviewView); `history` (HistoryView).
 * Without changes from HR's proposals the MD approves: Forward to HR or Direct to Auditor (the MD finalizes; the report
 * goes with it). With changes (or corrections) the MD returns the settlement to HR for rework (ReturnDialog); HR
 * resubmits it and the MD reviews the revised settlement (round 2, 3 ...; ReworkState says where it stands). The state
 * (selection, filter, search, note) lives here, so it survives a switch of tab.
 */
export default function BatchView({ batch, view }: { batch: SettlementBatch; view: SettlementView }) {
  const summary = useMemo(() => reviewSummary(batch.items), [batch.items]);
  const canDecide = batch.stage === "md_review" && batch.actions.canDecideMd;
  const showFinal = finalized(batch.stage);
  const period = periodLabel(batch.month, batch.year);
  const { user } = useAuth();
  const { data: settings } = usePayrollSettings();

  const [filter, setFilter] = useState<ListFilter>("all");
  const [q, setQ] = useState("");
  const [target, setTarget] = useState<DecisionTarget | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<number>>(new Set());
  const [highlight, setHighlight] = useState<ReadonlySet<number>>(new Set());
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [bulkDecision, setBulkDecision] = useState<MdDecision | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [leaveItem, setLeaveItem] = useState<SettlementItem | null>(null);
  const [note, setNote] = useState("");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<ConfirmMode | null>(null);
  const [directWarning, setDirectWarning] = useState<string | null>(null);
  const [returnOpen, setReturnOpen] = useState(false);
  const decide = useDecideItem();
  const bulk = useBulkDecide();
  const confirm = useConfirmBatch();

  const shown = filterItems(batch.items, filter, q);
  const remaining = batch.items.filter((i) => decisionKind(i) === "undecided");
  const chosen = batch.items.filter((i) => selected.has(i.id));

  const quick = async (item: SettlementItem, body: DecideBody, done: string) => {
    setBusy((s) => new Set(s).add(item.id));
    try {
      await decide.mutateAsync({ id: item.id, ...body });
      toast({ title: done });
    } catch (error) {
      toast({ title: "Not saved", description: describeMdError(error), variant: "destructive" });
    } finally {
      setBusy((s) => without(s, item.id));
    }
  };

  const handlers: RowHandlers = {
    stage: batch.stage,
    mdRound: mdRoundOf(batch),
    canDecide,
    busy,
    highlight,
    selected,
    onSelect: (id, on) => setSelected((s) => (on ? new Set(s).add(id) : without(s, id))),
    onToggleAll: (ids) => setSelected((s) => toggleAll(s, ids)),
    onApprove: (item) =>
      void quick(item, { decision: "approved" }, `Approved: ${item.advance.employeeName}, ${money(baseOf(item))}`),
    onConfirmHr: (item) =>
      void quick(item, confirmHrBody(item), `Confirmed HR's proposal: ${item.advance.employeeName}`),
    onOpen: (item: SettlementItem, mode?: DraftMode) => setTarget({ item, mode, round: mdRoundOf(batch) }),
    onRework: (item) =>
      void quick(
        item,
        { decision: "" },
        item.md.fromHr
          ? `HR's proposal cleared: ${item.advance.employeeName} waits for your decision`
          : `Reopened: ${item.advance.employeeName} waits for your decision again`,
      ),
    onLeave: (item) => setLeaveItem(item),
  };

  const openBulk = (decision: MdDecision) => {
    setBulkError(null);
    setBulkDecision(decision);
  };

  const sendBulk = (remark: string) => {
    if (!bulkDecision) return;
    const ids = chosen.map((i) => i.id);
    const decision = bulkDecision;
    setBulkError(null);
    bulk.mutate(
      { batchId: batch.id, itemIds: ids, decision, ...(remark ? { remark } : {}) },
      {
        onSuccess: (reply) => {
          const skipped = reply.skipped ?? [];
          setBulkDecision(null);
          setSelected(new Set(skipped.map((s) => s.id)));
          toast(bulkResultText(decision, ids.length, skipped, batch.items));
        },
        onError: (error) => setBulkError(describeMdError(error)),
      },
    );
  };

  const doConfirm = async (mode: ConfirmMode) => {
    setConfirmError(null);
    setConfirming(mode);
    try {
      let files: { pdf: File; xlsx: File } | undefined;
      if (mode === "direct") {
        const by = `${user?.name || "MD"} (MD)`;
        const company = {
          company: settings?.companyName || "Company",
          branchLabel: "All Branches",
          logoDataUrl: settings?.companyLogo ?? null,
        };
        try {
          files = await buildDirectFiles(batch, company, by);
        } catch {
          setConfirmError("The finalized report could not be built on this computer. Try again.");
          return;
        }
      }
      const next = await confirm.mutateAsync({ id: batch.id, note: note.trim(), mode, files });
      setReviewOpen(false);
      setHighlight(new Set());
      setSelected(new Set());
      const counts = `${num(next.counts.approved)} approved, ${num(next.counts.rejected)} rejected`;
      if (mode === "hr") {
        toast({ title: "Sent back to HR", description: `${batchTitle(batch)} of ${period}: ${counts}.` });
      } else if (next.warning) {
        setDirectWarning(next.warning);
        toast({ title: "Finalized — not sent to the auditor", description: next.warning, variant: "destructive" });
      } else {
        toast({
          title: "Finalized and sent to the auditor",
          description: `${batchTitle(batch)} of ${period}: ${counts}.`,
        });
      }
    } catch (error) {
      const ids = undecidedIds(error);
      if (ids.length) setHighlight(new Set(ids));
      const changed = changedIds(error);
      // has_changes (409): the page's copy was out of date - the reloaded batch marks the changed requests and offers
      // Return to HR for rework instead
      setConfirmError(
        changed.length
          ? `${describeMdError(error)} The page has been refreshed: return it to HR for rework.`
          : describeMdError(error),
      );
    } finally {
      setConfirming(null);
    }
  };

  const openReturn = () => {
    setReviewOpen(false);
    setReturnOpen(true);
  };

  const returned = (next: SettlementBatch) => {
    setReturnOpen(false);
    setReviewOpen(false);
    setHighlight(new Set());
    setSelected(new Set());
    setNote("");
    const flagged = next.counts.rework ?? next.items.filter((i) => i.rework).length;
    toast({
      title: "Returned to HR for rework",
      description: `${batchTitle(batch)} of ${period}${
        flagged ? `: ${plural(flagged, "request")} for HR to answer` : ""
      }. You approve it once HR resubmits.`,
    });
  };

  const listLabel = `Requests in ${batchTitle(batch)} of ${period}`;
  const stageChip = (
    <span className={STAGE_CHIP[batch.stage] ?? "md-chip"} data-testid="md-settlement-stage">
      {batch.stage === "md_review" ? "Waiting for your decision" : batch.stageLabel}
    </span>
  );
  const changes = summary.changed;

  return (
    <div className="space-y-5" data-testid="md-settlement-batch" data-batch={batch.id} data-stage={batch.stage}>
      {/* Review decisions at the top too (owner 2026-11-27: easier to reach than the bar at the bottom) */}
      {canDecide && view !== "history" && (
        <div
          className="md-card flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3"
          data-testid="md-settlement-top-review"
        >
          <p className="min-w-0 text-[13px] font-extrabold text-md-ink">
            {num(summary.decided)} of {num(summary.total)} decided
            <span className="font-semibold text-md-ink-soft">
              {" "}
              · approving {money(summary.approvedTotal)} of {money(summary.requestedTotal)} asked
            </span>
          </p>
          <button
            type="button"
            className={cn(
              "md-btn md-btn-sm",
              changes > 0 ? "md-btn-soft" : summary.undecided === 0 ? "md-btn-primary" : "md-btn-ink",
              BTN_MOTION,
            )}
            onClick={() => {
              setConfirmError(null);
              setReviewOpen(true);
            }}
            data-testid="md-settlement-review-top"
          >
            <ClipboardCheck size={14} aria-hidden="true" /> Review decisions
          </button>
        </div>
      )}
      {view === "overview" && (
        <>
          <ReworkState batch={batch} />
          <DirectState batch={batch} warning={directWarning} />
          <OverviewView batch={batch} summary={summary} stageChip={stageChip} />
        </>
      )}

      {view === "history" && <HistoryView batch={batch} />}

      {view === "requests" && (
        <>
          <ReworkState batch={batch} />
          <DirectState batch={batch} warning={directWarning} />
          <section
            className="md-card space-y-4 p-4 @2xl:p-6"
            aria-label={listLabel}
            data-testid="md-settlement-view-requests"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-[15px] font-extrabold text-md-ink">
                    {batchTitle(batch)} · {period}
                  </h3>
                  {stageChip}
                </div>
                <p className="mt-0.5 max-w-[42rem] text-xs leading-snug text-md-ink-soft">
                  {canDecide
                    ? "Approve, reduce or reject each request, or tick several and decide them at once. HR's proposals come pre-filled: confirm or change them. Rework reopens a decision until you approve or return the settlement."
                    : batch.stage === "md_changes"
                      ? "Your decisions as you returned them to HR, read-only until HR resubmits."
                      : showFinal
                        ? "Your decisions and the final settlement, read-only."
                        : "Your decisions as you sent them to HR, read-only."}
                </p>
              </div>
              {canDecide && remaining.length > 1 && (
                <button
                  type="button"
                  className={cn("md-btn md-btn-soft md-btn-sm", BTN_MOTION)}
                  onClick={() => {
                    setSelected(new Set(remaining.map((i) => i.id)));
                    openBulk("approved");
                  }}
                  data-testid="md-settlement-bulk"
                >
                  <CheckCheck size={14} aria-hidden="true" /> Approve all remaining ({remaining.length})
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5">
              <SelectField
                label="Show"
                value={filter}
                options={filterOptions(batch.items)}
                onChange={(next) => isListFilter(next) && setFilter(next)}
                className="w-full sm:w-60"
                testId="md-settlement-filter"
              />
              <div className="relative w-full sm:w-64">
                <Search
                  size={15}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-md-ink-soft"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search name, code or department"
                  aria-label="Search requests"
                  className="md-field h-9 w-full pl-9 pr-9 text-xs"
                  data-testid="md-settlement-search"
                />
                {q && (
                  <button
                    type="button"
                    aria-label="Clear search"
                    onClick={() => setQ("")}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full p-1 text-md-ink-soft hover:text-md-ink"
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>

            {canDecide && selected.size > 0 && (
              <div
                className="md-panel-wine flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-2.5"
                role="region"
                aria-label="Decide the ticked requests"
                data-testid="md-settlement-bulk-bar"
              >
                <p className="min-w-0 flex-1 text-[13px] font-extrabold text-md-ink">
                  {plural(selected.size, "request")} ticked
                </p>
                <button
                  type="button"
                  className={cn("md-btn md-btn-primary md-btn-sm", BTN_MOTION)}
                  onClick={() => openBulk("approved")}
                  data-testid="md-settlement-bulk-approve"
                >
                  <CheckCheck size={14} aria-hidden="true" /> Approve
                </button>
                <button
                  type="button"
                  className={cn("md-btn md-btn-danger md-btn-sm", BTN_MOTION)}
                  onClick={() => openBulk("rejected")}
                  data-testid="md-settlement-bulk-reject"
                >
                  <X size={14} aria-hidden="true" /> Reject
                </button>
                <button
                  type="button"
                  className={cn("md-btn md-btn-ghost md-btn-sm", GHOST_MOTION)}
                  onClick={() => setSelected(new Set())}
                  data-testid="md-settlement-bulk-clear"
                >
                  Clear
                </button>
              </div>
            )}

            {shown.length === 0 ? (
              <EmptyBlock
                title={
                  batch.items.length === 0
                    ? "This batch has no requests."
                    : filter === "undecided"
                      ? "Every request has your decision."
                      : "No request matches. Try another choice or search."
                }
              />
            ) : (
              <RequestList items={shown} handlers={handlers} label={listLabel} />
            )}
          </section>

          {canDecide && (
            <>
              <section className="md-card space-y-2 p-4 @2xl:p-6" data-testid="md-settlement-instructions">
                <h3 className="text-[15px] font-extrabold text-md-ink">
                  <label htmlFor={`md-settlement-note-${batch.id}`}>
                    {changes > 0 ? "Instructions to HR" : "Your note"}
                  </label>
                </h3>
                <p className="text-xs text-md-ink-soft">
                  {changes > 0
                    ? "Optional. What HR should look at when you return the settlement for rework (you can still edit it before you send it)."
                    : "Optional. Instructions for HR when you forward it or return it for corrections, or the note on the final settlement when you send it directly to the auditor (you can still edit it in the review)."}
                </p>
                <textarea
                  id={`md-settlement-note-${batch.id}`}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={REJECT_REMARK_MAX}
                  rows={3}
                  className="md-field w-full resize-y px-3 py-2 text-sm"
                  placeholder="e.g. Pay the approved advances with this month's salary"
                  data-testid="md-settlement-note"
                />
              </section>

              {/* md-dock-clear: the bar ends before the floating AI radio's corner (md-theme/areas/assistant.css) */}
              <div className="md-dock-clear sticky bottom-3 z-20" data-testid="md-settlement-bar">
                <div className="md-card md-card-strong flex flex-wrap items-center gap-x-4 gap-y-2.5 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-extrabold text-md-ink" data-testid="md-settlement-progress">
                      {num(summary.decided)} of {num(summary.total)} decided
                      {summary.undecided > 0 && (
                        <span className="font-semibold text-md-ink-soft"> · {num(summary.undecided)} to go</span>
                      )}
                      {summary.fromHr > 0 && (
                        <span className="font-semibold text-md-warning-800"> · {num(summary.fromHr)} from HR</span>
                      )}
                    </p>
                    {changes > 0 && (
                      <p
                        className="mt-0.5 flex items-center gap-1 text-[11.5px] font-bold text-md-warning-800"
                        data-testid="md-settlement-bar-changes"
                      >
                        <GitCompareArrows size={13} aria-hidden="true" className="shrink-0" />
                        {plural(changes, "request")} changed from HR's proposal — return it to HR; you approve it once
                        HR resubmits
                      </p>
                    )}
                    <div
                      className="mt-1.5 h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-md-ink/10"
                      role="progressbar"
                      aria-label="Requests decided"
                      aria-valuemin={0}
                      aria-valuemax={summary.total}
                      aria-valuenow={summary.decided}
                    >
                      <div
                        className="h-full rounded-full bg-md-wine transition-[width]"
                        style={{ width: `${summary.total ? (summary.decided / summary.total) * 100 : 0}%` }}
                      />
                    </div>
                    <p className="mt-1 text-[11px] text-md-ink-soft">
                      Approving {money(summary.approvedTotal)} of {money(summary.requestedTotal)} asked
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className={cn(
                        "md-btn",
                        changes > 0 ? "md-btn-soft" : summary.undecided === 0 ? "md-btn-primary" : "md-btn-ink",
                        BTN_MOTION,
                      )}
                      onClick={() => {
                        setConfirmError(null);
                        setReviewOpen(true);
                      }}
                      data-testid="md-settlement-review-open"
                    >
                      <ClipboardCheck size={15} aria-hidden="true" /> Review decisions
                    </button>
                    {changes > 0 && (
                      <button
                        type="button"
                        className={cn("md-btn md-btn-primary", BTN_MOTION)}
                        onClick={openReturn}
                        disabled={batch.actions.canReturnMd === false}
                        data-testid="md-settlement-bar-return"
                      >
                        <CornerUpLeft size={15} aria-hidden="true" /> Return to HR for rework
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </>
      )}

      {canDecide && (
        <>
          <ReviewSheet
            open={reviewOpen}
            onClose={() => setReviewOpen(false)}
            batch={batch}
            summary={summary}
            note={note}
            onNote={setNote}
            onConfirm={(mode) => void doConfirm(mode)}
            onReturn={openReturn}
            confirming={confirming}
            error={confirmError}
          />
          <BulkDialog
            key={bulkDecision ?? "closed"}
            decision={bulkDecision}
            items={chosen}
            onClose={() => setBulkDecision(null)}
            onSubmit={sendBulk}
            pending={bulk.isPending}
            error={bulkError}
          />
        </>
      )}

      {/* outside the MD Review block: a successful return moves the batch on while the dialog is still open */}
      <ReturnDialog
        open={returnOpen && batch.stage === "md_review"}
        batch={batch}
        summary={summary}
        note={note}
        onNote={setNote}
        onClose={() => setReturnOpen(false)}
        onDone={returned}
      />
      <DecisionDialog target={target} onClose={() => setTarget(null)} />
      <LeaveCalendarDialog
        open={leaveItem !== null}
        onClose={() => setLeaveItem(null)}
        load={() => loadLeaveCalendar(leaveItem!.id)}
        title={leaveItem ? `${leaveItem.advance.employeeName} · leave` : undefined}
      />
    </div>
  );
}
