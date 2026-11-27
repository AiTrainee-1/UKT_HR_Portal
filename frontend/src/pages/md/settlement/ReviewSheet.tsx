import { useId } from "react";
import { ArrowLeft, CornerUpLeft, FileCheck2, GitCompareArrows, Send, Undo2 } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { REJECT_REMARK_MAX } from "@/lib/reject-remark";
import { cn } from "@/lib/utils";
import {
  batchTitle,
  confirmState,
  decisionText,
  money,
  periodLabel,
  plural,
  REVIEW_GROUP_TITLE,
  reviewGroups,
  type DecisionKind,
  type ReviewSummary,
} from "./logic";
import { BTN_MOTION, GHOST_MOTION, LeaveChip } from "./parts";
import type { ConfirmMode, SettlementBatch } from "./types";

const GROUP_TONE: Record<DecisionKind, string> = {
  undecided: "text-md-danger-700",
  reduced: "text-md-warning-800",
  rejected: "text-md-danger-700",
  approved: "text-md-success-700",
};

function Count({ label, value, testId, tone }: { label: string; value: number; testId: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-white/80 bg-white/60 px-3 py-2" data-testid={testId}>
      <p className={cn("text-lg font-black tabular-nums leading-tight text-md-ink", tone)}>{value}</p>
      <p className="text-[11px] font-semibold text-md-ink-soft">{label}</p>
    </div>
  );
}

/**
 * Review decisions: every request with what the MD decided (approved, reduced from -> to, rejected; "from HR" when it is
 * still HR's pre-filled proposal; "changed" when it differs from HR's proposal) and the remark, the counts and totals, the
 * MD's note, and the ways on (owner 2026-11-27), each explained:
 * - no change from HR's proposals: approve - Forward to HR (HR finalizes) or Direct to Auditor (the MD finalizes; HR
 *   Final Settlement is skipped), both off until every request is decided; Return to HR for rework stays possible with
 *   written instructions (corrections);
 * - changes: Return to HR for rework is the way on (HR reworks and resubmits; the MD approves the revised settlement); the
 *   approve options are off, saying why.
 * When the server still finds open requests (another tab cleared one), they are listed first and marked on the page.
 */
export default function ReviewSheet({
  open,
  onClose,
  batch,
  summary,
  note,
  onNote,
  onConfirm,
  onReturn,
  confirming,
  error,
}: {
  open: boolean;
  onClose: () => void;
  batch: SettlementBatch;
  summary: ReviewSummary;
  note: string;
  onNote: (note: string) => void;
  /** Forward to HR ("hr") or Direct to Auditor ("direct"). */
  onConfirm: (mode: ConfirmMode) => void;
  /** Return to HR for rework: opens its dialog (the instructions are the note). */
  onReturn: () => void;
  /** The option on its way to the server, if any. */
  confirming: ConfirmMode | null;
  error: string | null;
}) {
  const noteId = useId();
  const state = confirmState(batch, summary);
  const groups = reviewGroups(summary);
  const changes = summary.changed;
  const canReturn = batch.actions.canReturnMd ?? (batch.stage === "md_review" && batch.actions.canDecideMd);
  const returnPanel = (primary: boolean) => (
    <div
      className={cn("space-y-2 p-3.5", primary ? "md-panel-sand" : "md-panel")}
      data-testid="md-settlement-option-return"
      data-primary={primary || undefined}
    >
      <p className="flex items-center gap-2 text-[13px] font-extrabold text-md-ink">
        <CornerUpLeft size={15} aria-hidden="true" className={primary ? "text-md-warning-700" : "text-md-wine"} />{" "}
        Return to HR for rework
      </p>
      <p className="text-xs leading-relaxed text-md-ink-soft">
        {primary
          ? `You changed ${plural(changes, "request")} from HR's proposal. HR reviews your changes and instructions, corrects the settlement and resubmits it to you; you approve the revised settlement then.`
          : "Nothing differs from HR's proposals. To ask HR for corrections, return it with your instructions (required); HR resubmits it for your approval."}
      </p>
      <button
        type="button"
        className={cn("md-btn w-full sm:w-auto", primary ? "md-btn-primary" : "md-btn-soft", BTN_MOTION)}
        onClick={onReturn}
        disabled={!canReturn || confirming !== null}
        data-testid="md-settlement-return-open"
      >
        <CornerUpLeft size={15} aria-hidden="true" /> Return to HR for rework
      </button>
    </div>
  );
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        className="md-analytics-sheet flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-xl"
        data-testid="md-settlement-review"
      >
        <div className="space-y-4 p-5 sm:p-6">
          <div className="pr-8">
            <SheetTitle className="text-lg font-black leading-tight text-md-ink">Review your decisions</SheetTitle>
            <SheetDescription className="mt-1 text-[13px] text-md-ink-soft">
              {batchTitle(batch)} · {periodLabel(batch.month, batch.year)} · {plural(summary.total, "request")}
            </SheetDescription>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Count label="Approved in full" value={summary.approved} testId="md-settlement-review-approved" />
            <Count label="Reduced" value={summary.reduced} testId="md-settlement-review-reduced" />
            <Count label="Rejected" value={summary.rejected} testId="md-settlement-review-rejected" />
            <Count
              label="Not decided"
              value={summary.undecided}
              testId="md-settlement-review-undecided"
              tone={summary.undecided ? "text-md-danger-700" : undefined}
            />
          </div>

          <dl
            className="md-panel grid grid-cols-2 gap-x-4 gap-y-2 p-3 text-xs"
            data-testid="md-settlement-review-totals"
          >
            <div>
              <dt className="text-md-ink-soft">Requested</dt>
              <dd className="text-sm font-black tabular-nums text-md-ink">{money(summary.requestedTotal)}</dd>
            </div>
            <div>
              <dt className="text-md-ink-soft">You approve</dt>
              <dd
                className="text-sm font-black tabular-nums text-md-success-700"
                data-testid="md-settlement-review-approved-total"
              >
                {money(summary.approvedTotal)}
              </dd>
            </div>
            <div>
              <dt className="text-md-ink-soft">Taken off by reductions</dt>
              <dd className="font-bold tabular-nums text-md-ink">{money(summary.reducedBy)}</dd>
            </div>
            <div>
              <dt className="text-md-ink-soft">Asked by rejected requests</dt>
              <dd className="font-bold tabular-nums text-md-ink">{money(summary.rejectedTotal)}</dd>
            </div>
          </dl>

          {groups.map((g) => (
            <section
              key={g.kind}
              aria-label={REVIEW_GROUP_TITLE[g.kind]}
              data-testid={`md-settlement-review-group-${g.kind}`}
            >
              <p className={cn("mb-1.5 text-[11px] font-extrabold uppercase tracking-wide", GROUP_TONE[g.kind])}>
                {REVIEW_GROUP_TITLE[g.kind]} · {g.rows.length}
              </p>
              <ul className="divide-y divide-md-line rounded-2xl border border-white/80 bg-white/55">
                {g.rows.map((r) => (
                  <li key={r.id} className="space-y-1 px-3 py-2.5" data-testid={`md-settlement-review-row-${r.id}`}>
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                      <p className="min-w-0 text-[13px] font-extrabold text-md-ink">
                        {r.name}
                        {r.code && <span className="ml-1.5 text-[11px] font-semibold text-md-ink-soft">{r.code}</span>}
                        <span className="ml-1.5 text-[11px] font-semibold text-md-ink-soft">· {r.typeLabel}</span>
                      </p>
                      <p className={cn("text-xs font-bold tabular-nums", GROUP_TONE[r.kind])}>
                        {r.kind === "undecided"
                          ? `Asked ${money(r.requested)}`
                          : decisionText(r.kind, r.requested, r.approved)}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <LeaveChip check={r.leave} />
                      {r.fromHr && <span className="md-chip md-chip-sand">From HR</span>}
                      {r.changed && (
                        <span className="md-chip md-chip-warning" data-testid="md-settlement-review-changed">
                          <GitCompareArrows size={12} aria-hidden="true" /> Changed from HR's proposal
                        </span>
                      )}
                      {r.remark && <p className="min-w-0 text-[11.5px] text-md-ink-soft">“{r.remark}”</p>}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}

          {summary.fromHr > 0 && (
            <p
              className="md-panel-sand px-3 py-2 text-xs font-semibold text-md-warning-800"
              data-testid="md-settlement-review-from-hr"
            >
              {plural(summary.fromHr, "decision is", "decisions are")} still HR's proposal, not confirmed by you.
              Confirm & Proceed takes them as they are.
            </p>
          )}

          <div>
            <label htmlFor={noteId} className="block text-xs font-bold text-md-ink">
              {changes > 0 ? "Instructions to HR" : "Your note"}{" "}
              <span className="font-medium text-md-ink-soft">
                {changes > 0
                  ? "(optional: what HR should look at in your changes)"
                  : "(optional: instructions for HR, or for the record)"}
              </span>
            </label>
            <textarea
              id={noteId}
              value={note}
              onChange={(e) => onNote(e.target.value)}
              maxLength={REJECT_REMARK_MAX}
              rows={3}
              className="md-field mt-1 w-full resize-y px-3 py-2 text-sm"
              placeholder="e.g. Pay the approved advances with this month's salary"
              data-testid="md-settlement-review-note"
            />
          </div>

          <section aria-label="How to proceed" className="space-y-2.5" data-testid="md-settlement-confirm-options">
            <p className="text-[11px] font-extrabold uppercase tracking-wide text-md-ink-soft">How to proceed</p>
            {changes > 0 && returnPanel(true)}
            {changes > 0 && (
              <p
                className="flex items-start gap-1.5 text-xs font-semibold text-md-warning-800"
                data-testid="md-settlement-approve-blocked"
              >
                <GitCompareArrows size={14} aria-hidden="true" className="mt-px shrink-0" />
                {state.reason}
              </p>
            )}
            <div className="md-panel space-y-2 p-3.5" data-testid="md-settlement-option-hr">
              <p className="flex items-center gap-2 text-[13px] font-extrabold text-md-ink">
                <Undo2 size={15} aria-hidden="true" className="text-md-wine" /> Forward to HR
              </p>
              <p className="text-xs leading-relaxed text-md-ink-soft">
                HR checks your decisions and does the final settlement: it may lower an amount or move the first
                deduction month (with a remark), never go above what you approved. HR then sends it to the auditor.
              </p>
              <button
                type="button"
                className={cn("md-btn w-full sm:w-auto", changes > 0 ? "md-btn-soft" : "md-btn-primary", BTN_MOTION)}
                onClick={() => onConfirm("hr")}
                disabled={!state.enabled || confirming !== null}
                data-testid="md-settlement-confirm-hr-mode"
              >
                <Send size={15} aria-hidden="true" /> {confirming === "hr" ? "Sending…" : "Forward to HR"}
              </button>
            </div>
            <div className="md-panel-wine space-y-2 p-3.5" data-testid="md-settlement-option-direct">
              <p className="flex items-center gap-2 text-[13px] font-extrabold text-md-ink">
                <FileCheck2 size={15} aria-hidden="true" className="text-md-wine" /> Direct to Auditor
              </p>
              <p className="text-xs leading-relaxed text-md-ink-soft">
                You confirm and finalize: your decisions become the final settlement now and HR Final Settlement is
                skipped. The finalized report (PDF and Excel, built from your decisions) goes to the auditor at once
                with the review link. If the auditor e-mail cannot be sent, the settlement stays finalized and HR can
                send it.
              </p>
              <button
                type="button"
                className={cn("md-btn md-btn-ink w-full sm:w-auto", BTN_MOTION)}
                onClick={() => onConfirm("direct")}
                disabled={!state.enabled || confirming !== null}
                data-testid="md-settlement-confirm-direct"
              >
                <FileCheck2 size={15} aria-hidden="true" />{" "}
                {confirming === "direct" ? "Finalizing and sending…" : "Finalize & send to auditor"}
              </button>
            </div>
            {changes === 0 && returnPanel(false)}
          </section>

          {error && (
            <p
              role="alert"
              className="rounded-xl bg-md-danger-600/[0.07] px-3 py-2 text-xs font-semibold text-md-danger-800"
              data-testid="md-settlement-confirm-error"
            >
              {error}
            </p>
          )}
        </div>

        <div className="sticky bottom-0 mt-auto border-t border-md-line bg-md-vanilla/95 px-5 py-3 backdrop-blur sm:px-6">
          {state.reason && changes === 0 && (
            <p className="mb-2 text-xs font-semibold text-md-ink-soft" data-testid="md-settlement-confirm-reason">
              {state.reason}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] text-md-ink-soft">
              {changes > 0
                ? "After the return, you approve the settlement once HR resubmits it."
                : "Once approved, your decisions can't be changed."}
            </p>
            <button
              type="button"
              className={cn("md-btn md-btn-ghost", GHOST_MOTION)}
              onClick={onClose}
              disabled={confirming !== null}
            >
              <ArrowLeft size={15} aria-hidden="true" /> Back to the list
            </button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
