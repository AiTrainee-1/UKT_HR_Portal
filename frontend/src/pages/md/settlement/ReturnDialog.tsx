import { useId, useState } from "react";
import { CornerUpLeft, GitCompareArrows } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { describeMdError } from "@/lib/api-client/custom-hooks/md";
import { cleanRejectRemark, REJECT_REMARK_MAX } from "@/lib/reject-remark";
import { cn } from "@/lib/utils";
import { useReturnBatch } from "./api";
import {
  baseOf,
  batchTitle,
  changeText,
  hrExpected,
  money,
  periodLabel,
  plural,
  returnState,
  type ReviewSummary,
} from "./logic";
import { BTN_MOTION, GHOST_MOTION } from "./parts";
import type { SettlementBatch, SettlementItem } from "./types";

/** "HR ₹6,000 → you ₹5,000", "HR reject → you ₹8,000": a changed request in a line. */
function changeLine(item: SettlementItem): string {
  const hr = hrExpected(item);
  const hrText = hr.decision === "rejected" ? "reject" : money(hr.amount);
  const mine = item.md.decision === "rejected" ? "reject" : money(item.md.amount ?? baseOf(item));
  return `HR ${hrText} → you ${mine}`;
}

/**
 * Return to HR for rework (owner 2026-11-27): the MD changed an amount, rejected a request or wants corrections, so the
 * settlement goes back to HR (HR Rework (MD Changes)). HR answers every request the MD changed or remarked on, corrects
 * the settlement and resubmits it; the MD approves the revised one. The instructions are optional when there are
 * changes or remarks, required otherwise (the server refuses an empty return: `no_changes`).
 */
export default function ReturnDialog({
  open,
  batch,
  summary,
  note,
  onNote,
  onClose,
  onDone,
}: {
  open: boolean;
  batch: SettlementBatch;
  summary: ReviewSummary;
  note: string;
  onNote: (note: string) => void;
  onClose: () => void;
  onDone: (batch: SettlementBatch) => void;
}) {
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noteId = useId();
  const send = useReturnBatch();
  const state = returnState(summary, note);
  const changed = batch.items.filter((i) => summary.changedIds.includes(i.id));
  const problem = tried ? state.problem : null;

  const close = () => {
    if (send.isPending) return;
    setTried(false);
    setError(null);
    onClose();
  };

  const submit = async () => {
    setTried(true);
    setError(null);
    if (state.problem) return;
    try {
      const next = await send.mutateAsync({ id: batch.id, note: cleanRejectRemark(note) });
      setTried(false);
      onDone(next);
    } catch (e) {
      // no_changes: the server found nothing to rework (the page reloads the batch); stage / 409: the batch moved on
      setError(describeMdError(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg" data-testid="md-settlement-return-dialog">
        <DialogHeader>
          <DialogTitle className="pr-8 text-lg font-black leading-tight text-md-ink">
            Return to HR for rework?
          </DialogTitle>
          <DialogDescription className="text-[13px] leading-relaxed text-md-ink-soft">
            {batchTitle(batch)} · {periodLabel(batch.month, batch.year)}.{" "}
            {summary.changed + summary.remarked > 0
              ? `${plural(summary.changed + summary.remarked, "request goes", "requests go")} back to HR with your decision. HR answers each one, corrects the settlement and resubmits it; you approve it then.`
              : "Nothing differs from HR's proposals: write what HR should correct. HR resubmits the settlement; you approve it then."}
          </DialogDescription>
        </DialogHeader>

        {changed.length > 0 && (
          <ul
            className="md-panel-sand divide-y divide-md-warning-200/70 px-3 py-1"
            aria-label="Changed from HR's proposal"
            data-testid="md-settlement-return-changes"
          >
            {changed.map((i) => (
              <li
                key={i.id}
                className="flex flex-wrap items-baseline justify-between gap-x-3 py-1.5"
                title={changeText(i)}
              >
                <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] font-extrabold text-md-ink">
                  <GitCompareArrows size={13} aria-hidden="true" className="shrink-0 text-md-warning-700" />
                  <span className="truncate">{i.advance.employeeName}</span>
                </span>
                <span className="text-[12px] font-bold tabular-nums text-md-warning-800">{changeLine(i)}</span>
              </li>
            ))}
          </ul>
        )}
        {summary.remarked > 0 && (
          <p className="text-xs text-md-ink-soft" data-testid="md-settlement-return-remarked">
            {plural(summary.remarked, "request has", "requests have")} your remark for HR to look at.
          </p>
        )}

        <div>
          <label htmlFor={noteId} className="block text-xs font-bold text-md-ink">
            Instructions to HR{" "}
            <span className={cn("font-medium", state.noteRequired ? "text-md-danger-700" : "text-md-ink-soft")}>
              ({state.noteRequired ? "required" : "optional"})
            </span>
          </label>
          <textarea
            id={noteId}
            value={note}
            onChange={(e) => {
              onNote(e.target.value);
              setError(null);
            }}
            maxLength={REJECT_REMARK_MAX}
            rows={3}
            aria-invalid={!!problem || undefined}
            aria-describedby={problem ? `${noteId}-problem` : undefined}
            className={cn("md-field mt-1 w-full resize-y px-3 py-2 text-sm", problem && "border-md-danger-600")}
            placeholder="e.g. Keep Bala's advance to the 50% limit and check Chitra's leave"
            data-testid="md-settlement-return-note"
          />
          {problem && (
            <p
              id={`${noteId}-problem`}
              role="alert"
              className="mt-1 text-xs font-semibold text-md-danger-700"
              data-testid="md-settlement-return-problem"
            >
              {problem}
            </p>
          )}
        </div>

        {error && (
          <p
            role="alert"
            className="rounded-xl bg-md-danger-600/[0.07] px-3 py-2 text-xs font-semibold text-md-danger-800"
            data-testid="md-settlement-return-error"
          >
            {error}
          </p>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <button
            type="button"
            className={cn("md-btn md-btn-ghost", GHOST_MOTION)}
            onClick={close}
            disabled={send.isPending}
          >
            Cancel
          </button>
          <button
            type="button"
            className={cn("md-btn md-btn-primary", BTN_MOTION)}
            onClick={() => void submit()}
            disabled={send.isPending}
            aria-busy={send.isPending || undefined}
            data-testid="md-settlement-return-send"
          >
            <CornerUpLeft size={15} aria-hidden="true" /> {send.isPending ? "Returning…" : "Return to HR"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
