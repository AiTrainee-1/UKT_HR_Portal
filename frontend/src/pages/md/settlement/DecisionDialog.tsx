import { useId, useState } from "react";
import { Check, GitCompareArrows, History, TrendingDown, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/hooks/use-toast";
import { describeMdError } from "@/lib/api-client/custom-hooks/md";
import { REJECT_REMARK_MAX } from "@/lib/reject-remark";
import { cn } from "@/lib/utils";
import { errorCode, useDecideItem } from "./api";
import {
  ROUNDS_TO_ZERO,
  baseOf,
  draftBody,
  draftFor,
  draftProblems,
  eligibleLimit,
  hasProblems,
  hrExpected,
  hrProposal,
  money,
  parseAmount,
  plainAmount,
  roundingChanged,
  roundingSteps,
  roundsToZero,
  trailLine,
  typeLabelOf,
  type Draft,
  type DraftMode,
  type DraftProblems,
} from "./logic";
import { BTN_MOTION, Figure, GHOST_MOTION, LeaveChip, Segmented } from "./parts";
import type { SettlementItem } from "./types";

/** The request, the mode its button asked for, and the MD's review round (2+: the earlier round is shown). */
export type DecisionTarget = { item: SettlementItem; mode?: DraftMode; round?: number };

const MODES: { value: DraftMode; label: string }[] = [
  { value: "approve", label: "Approve in full" },
  { value: "reduce", label: "Reduce amount" },
  { value: "reject", label: "Reject" },
];

const REMARK_LABEL: Record<DraftMode, { text: string; note: string }> = {
  approve: { text: "Remark", note: "optional" },
  reduce: { text: "Remark for the reduced amount", note: "required" },
  reject: { text: "Reason for rejecting (cancelling)", note: "required" },
};

/** The form's choice differs from HR's proposal (2026-11-27): saving it means the settlement goes back to HR for rework
 *  before the MD can approve it. A reduce without a valid amount yet is not judged. Approving in full is the "as asked"
 *  amount (a Salary Advance's rounded amount). */
function differsFromHr(item: SettlementItem, draft: Draft): boolean {
  const hr = hrExpected(item);
  if (draft.mode === "reject") return hr.decision !== "rejected";
  if (hr.decision === "rejected") return true;
  const amount = draft.mode === "reduce" ? parseAmount(draft.amount).value : baseOf(item);
  if (amount === undefined) return false;
  return Math.abs(amount - (hr.amount ?? baseOf(item))) > 0.004;
}

/** What the toast says once the server has the decision. */
function savedTitle(item: SettlementItem, draft: Draft): string {
  const name = item.advance.employeeName;
  if (draft.mode === "reject") return `Rejected: ${name}'s ${typeLabelOf(item.advance)}`;
  if (draft.mode === "reduce")
    return `Reduced: ${name}, ${money(baseOf(item))} → ${money(parseAmount(draft.amount).value)}`;
  return `Approved: ${name}, ${money(baseOf(item))}`;
}

function DecisionForm({
  item,
  mode,
  round,
  onClose,
}: {
  item: SettlementItem;
  mode?: DraftMode;
  round: number;
  onClose: () => void;
}) {
  // a Salary Advance that rounds to ₹0 can only be rejected (2026-11-27): the form opens on Reject
  const zero = roundsToZero(item);
  const [draft, setDraft] = useState<Draft>(() => {
    const d = draftFor(item, mode);
    return zero && d.mode !== "reject" ? { ...d, mode: "reject" } : d;
  });
  const [tried, setTried] = useState(false);
  const [server, setServer] = useState<DraftProblems & { general?: string }>({});
  const decide = useDecideItem();
  const amountId = useId();
  const remarkId = useId();
  const requested = item.requestedAmount;
  // the full approval and the most the MD may approve: the rounded amount of a Salary Advance, else what was asked
  const base = baseOf(item);
  const rounding = item.rounding ?? null;
  const ceiling = rounding ? `the rounded ${money(base)}` : `the ${money(base)} asked`;
  const eligible = eligibleLimit(item);
  const limit = eligible.amount;
  const hrAmount = item.hr?.action === "reduce" ? (item.hr.amount ?? null) : null;

  const problems = draftProblems(draft, base, !!rounding);
  const amountProblem = (tried ? problems.amount : undefined) ?? server.amount;
  const remarkProblem = (tried ? problems.remark : undefined) ?? server.remark;
  const label = REMARK_LABEL[draft.mode];
  const earlier = trailLine(item, round);
  const changes = differsFromHr(item, draft);

  const change = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    // the server's complaint was about what the MD has now changed
    setServer((s) => ({
      ...s,
      general: undefined,
      ...("amount" in patch || "mode" in patch ? { amount: undefined } : {}),
      ...("remark" in patch || "mode" in patch ? { remark: undefined } : {}),
    }));
  };

  const save = () => {
    setTried(true);
    if (zero && draft.mode !== "reject") {
      setServer({ general: ROUNDS_TO_ZERO });
      return;
    }
    if (hasProblems(problems)) return;
    decide.mutate(
      { id: item.id, ...draftBody(draft) },
      {
        onSuccess: () => {
          toast({ title: savedTitle(item, draft), description: "Saved. HR gets it when you Confirm & Proceed." });
          onClose();
        },
        onError: (error) => {
          const message = describeMdError(error);
          const code = errorCode(error);
          setServer(
            code === "remark"
              ? { remark: message }
              : code === "amount" && draft.mode === "reduce"
                ? { amount: message }
                : { general: message },
          );
        },
      },
    );
  };

  const saveLabel =
    draft.mode === "reject"
      ? "Reject request"
      : draft.mode === "reduce"
        ? `Approve ${parseAmount(draft.amount).value != null ? money(parseAmount(draft.amount).value) : "the smaller amount"}`
        : `Approve ${money(base)}`;

  return (
    <>
      <DialogHeader>
        <DialogTitle className="pr-8 text-lg font-black leading-tight text-md-ink">
          {item.advance.employeeName}
          <span className="ml-1.5 text-sm font-semibold text-md-ink-soft">· {typeLabelOf(item.advance)}</span>
        </DialogTitle>
        <DialogDescription className="text-[13px] text-md-ink-soft">
          {[item.advance.employeeCode, item.advance.employeeDepartment, item.advance.employeeDesignation]
            .filter(Boolean)
            .join(" · ") || "Decide this request"}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        <div className="md-panel grid grid-cols-2 gap-3 p-3 sm:grid-cols-4" data-testid="md-settlement-dialog-facts">
          <Figure label="Asked" testId="md-settlement-dialog-asked">
            {money(requested)}
            {roundingChanged(rounding) && (
              <span
                className={cn(
                  "block text-[11px] font-semibold",
                  rounding.zero ? "text-md-danger-700" : "text-md-ink-soft",
                )}
                data-testid="md-settlement-dialog-rounded"
              >
                rounded {money(rounding.rounded)}
              </span>
            )}
          </Figure>
          <Figure label="Eligible limit">{money(limit)}</Figure>
          <Figure label="HR proposes">
            {hrProposal(item).kind === "none" ? "No change" : hrProposal(item).text.replace(/^HR proposes /, "")}
          </Figure>
          <div className="min-w-0">
            <p className="text-[10.5px] font-bold uppercase tracking-wide text-md-ink-soft">Leave</p>
            <div className="mt-1">
              <LeaveChip check={item.advance.leaveCheck} />
            </div>
          </div>
        </div>

        {earlier && (
          <p
            className="flex flex-wrap items-center gap-x-1.5 text-xs font-semibold text-md-ink-soft"
            title={earlier.detail.join("\n")}
            data-testid="md-settlement-dialog-trail"
          >
            <History size={13} aria-hidden="true" className="shrink-0" />
            {earlier.you} · {earlier.hr}
          </p>
        )}

        {roundingChanged(rounding) && (
          <p
            className={cn("text-xs leading-snug", zero ? "font-semibold text-md-danger-700" : "text-md-ink-soft")}
            data-testid="md-settlement-dialog-rounding"
          >
            {zero ? (
              <>Only reject is possible: {roundingSteps(rounding)}.</>
            ) : (
              <>
                <span className="font-bold text-md-ink">Up to the rounded {money(base)}</span>:{" "}
                {roundingSteps(rounding)}.
              </>
            )}
          </p>
        )}

        <Segmented
          label="Decision"
          value={draft.mode}
          options={MODES}
          onChange={(m) => change({ mode: m })}
          testId="md-settlement-mode"
        />

        {changes && (
          <p
            className="md-panel-sand flex items-start gap-1.5 px-3 py-2 text-xs font-semibold text-md-warning-800"
            data-testid="md-settlement-dialog-changes"
          >
            <GitCompareArrows size={14} aria-hidden="true" className="mt-px shrink-0" />
            This differs from HR's proposal: the settlement then goes back to HR for rework, and you approve it once HR
            resubmits.
          </p>
        )}

        {draft.mode === "reduce" && (
          <div>
            <label htmlFor={amountId} className="block text-xs font-bold text-md-ink">
              Approved amount <span className="font-medium text-md-ink-soft">(less than {ceiling})</span>
            </label>
            <div className="relative mt-1">
              <span
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-md-ink-soft"
                aria-hidden="true"
              >
                ₹
              </span>
              <input
                id={amountId}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={draft.amount}
                onChange={(e) => change({ amount: e.target.value })}
                aria-invalid={!!amountProblem || undefined}
                aria-describedby={amountProblem ? `${amountId}-problem` : undefined}
                className={cn(
                  "md-field h-10 w-full pl-7 pr-3 text-sm font-semibold tabular-nums",
                  amountProblem && "border-md-danger-600",
                )}
                placeholder="e.g. 5000"
                data-testid="md-settlement-amount"
              />
            </div>
            {limit != null && limit > 0 && limit < base && (
              <button
                type="button"
                className={cn("md-btn md-btn-ghost md-btn-sm mt-1.5", GHOST_MOTION)}
                onClick={() => change({ amount: plainAmount(limit) })}
                data-testid="md-settlement-use-limit"
              >
                Use the limit ({money(limit)})
              </button>
            )}
            {hrAmount != null && hrAmount < base && hrAmount !== limit && (
              <button
                type="button"
                className={cn("md-btn md-btn-ghost md-btn-sm mt-1.5", GHOST_MOTION)}
                onClick={() => change({ amount: plainAmount(hrAmount) })}
                data-testid="md-settlement-use-hr"
              >
                Use HR's amount ({money(hrAmount)})
              </button>
            )}
            {amountProblem && (
              <p
                id={`${amountId}-problem`}
                role="alert"
                className="mt-1 text-xs font-semibold text-md-danger-700"
                data-testid="md-settlement-amount-problem"
              >
                {amountProblem}
              </p>
            )}
          </div>
        )}

        <div>
          <label htmlFor={remarkId} className="block text-xs font-bold text-md-ink">
            {label.text}{" "}
            <span className={cn("font-medium", label.note === "required" ? "text-md-danger-700" : "text-md-ink-soft")}>
              ({label.note})
            </span>
          </label>
          <textarea
            id={remarkId}
            value={draft.remark}
            onChange={(e) => change({ remark: e.target.value })}
            maxLength={REJECT_REMARK_MAX}
            rows={3}
            aria-invalid={!!remarkProblem || undefined}
            aria-describedby={`${remarkId}-hint${remarkProblem ? ` ${remarkId}-problem` : ""}`}
            className={cn("md-field mt-1 w-full resize-y px-3 py-2 text-sm", remarkProblem && "border-md-danger-600")}
            placeholder={
              draft.mode === "reject"
                ? "Why this request is rejected"
                : draft.mode === "reduce"
                  ? "Why the amount is reduced"
                  : "Anything HR should know"
            }
            data-testid="md-settlement-remark"
          />
          <p id={`${remarkId}-hint`} className="mt-1 text-[11px] text-md-ink-soft">
            HR sees it, and it goes to the employee with the final decision.
          </p>
          {remarkProblem && (
            <p
              id={`${remarkId}-problem`}
              role="alert"
              className="mt-1 text-xs font-semibold text-md-danger-700"
              data-testid="md-settlement-remark-problem"
            >
              {remarkProblem}
            </p>
          )}
        </div>

        {server.general && (
          <p role="alert" className="text-xs font-semibold text-md-danger-700" data-testid="md-settlement-dialog-error">
            {server.general}
          </p>
        )}
      </div>

      <DialogFooter className="gap-2 sm:gap-2">
        <button
          type="button"
          className={cn("md-btn md-btn-ghost", GHOST_MOTION)}
          onClick={onClose}
          disabled={decide.isPending}
        >
          Cancel
        </button>
        <button
          type="button"
          className={cn("md-btn", draft.mode === "reject" ? "md-btn-danger" : "md-btn-primary", BTN_MOTION)}
          onClick={save}
          disabled={decide.isPending}
          aria-busy={decide.isPending || undefined}
          data-testid="md-settlement-save"
        >
          {draft.mode === "reject" ? (
            <X size={15} aria-hidden="true" />
          ) : draft.mode === "reduce" ? (
            <TrendingDown size={15} aria-hidden="true" />
          ) : (
            <Check size={15} aria-hidden="true" />
          )}
          {decide.isPending ? "Saving…" : saveLabel}
        </button>
      </DialogFooter>
    </>
  );
}

/** Approve in full (with an optional remark), approve a smaller amount (remark required) or reject (remark required) one
 *  request. Opens on the mode the row's button asked for, or on the request's current decision ("Change…"). */
export default function DecisionDialog({ target, onClose }: { target: DecisionTarget | null; onClose: () => void }) {
  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg" data-testid="md-settlement-dialog">
        {target && (
          <DecisionForm
            key={`${target.item.id}-${target.mode ?? ""}`}
            item={target.item}
            mode={target.mode}
            round={target.round ?? 1}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
