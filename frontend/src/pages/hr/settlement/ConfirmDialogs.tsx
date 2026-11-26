import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  REMARK_MAX,
  REMARK_MIN,
  TYPE_LABEL,
  appliedByEmployee,
  approvalDefaults,
  approvalPayload,
  approvalPreview,
  approvalProblem,
  approvalRemarkProblem,
  cleanRemark,
  describeSchedule,
  earnedLimitOf,
  earnedPeriodLabel,
  workingDaysText,
  overLimitBy,
  rejectionPayload,
  rejectionProblem,
  remarkRequired,
  requestedOf,
  serverError,
  type ApprovalEdit,
  type ApprovalPayload,
  type RejectionPayload,
  type SettlementRow,
} from "./logic";
import { MONTHS, formatMoney } from "./shared";

/** Which advance HR is deciding, and which way. */
export type DecisionRequest = { row: SettlementRow; status: "approved" | "rejected" };

/** ... with what the PUT sends: the approval (amount, deduction month, remark) or the rejection and its reason. */
export type Decision = DecisionRequest & { payload: ApprovalPayload | RejectionPayload };

/**
 * Approve or reject an advance. Approving creates the schedule payroll deducts from, so HR sees it before saying yes, may
 * approve less than was asked for (then a remark is required) and may move the deduction month. Rejecting needs the
 * reason, which the employee sees. The dialog stays open while it saves, and shows the server's own words when it is
 * refused.
 */
export function DecisionDialog({
  decision,
  onConfirm,
  onCancel,
}: {
  decision: DecisionRequest | null;
  /** Saves the decision; throws when the server refuses it (the dialog then shows why and stays open). */
  onConfirm: (d: Decision) => Promise<void>;
  onCancel: () => void;
}) {
  const row = decision?.row;
  const approve = decision?.status === "approved";
  const [edit, setEdit] = useState<ApprovalEdit | null>(null);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<{ text: string; code: string | null } | null>(null);
  const [tried, setTried] = useState(false);
  const remarkRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setEdit(decision ? approvalDefaults(decision.row) : null);
    setBusy(false);
    setRefused(null);
    setTried(false);
  }, [decision]);

  const patch = (p: Partial<ApprovalEdit>) => {
    setEdit((e) => (e ? { ...e, ...p } : e));
    setRefused(null);
  };

  const amountProblem = row && edit && approve ? approvalProblem(row, edit) : null;
  // the remark's own message waits until the amount is right (an amount above the one asked for is refused anyway)
  const remarkProblem =
    row && edit
      ? approve
        ? amountProblem
          ? null
          : approvalRemarkProblem(row, edit)
        : rejectionProblem(edit.remark)
      : null;
  const preview = row && edit && approve && !amountProblem ? approvalPreview(row, edit) : null;
  const byEmployee = row ? appliedByEmployee(row) : false;
  const asked = row ? requestedOf(row) : 0;
  const approvedNow = edit ? Number(edit.amount) : 0;
  const partial = !!(row && edit && approve && !amountProblem && remarkRequired(row, edit));
  const needsRemark = !approve || partial;
  const term = row?.advanceType === "term";
  // a Salary Advance's earned limit (50 % of the salary earned 1st-20th): information only, HR may approve more
  const earned = row && !term ? (row.earnings ?? null) : null;
  const limit = row && !term ? earnedLimitOf(row) : null;
  const aboveLimit = approve && !amountProblem ? overLimitBy(approvedNow, limit) : 0;
  const remarkLength = edit ? cleanRemark(edit.remark).length : 0;
  // a missing remark does not grey the button out: pressing it says what is missing and puts the cursor there
  const blocked = busy || !!amountProblem;

  const confirm = async () => {
    if (!decision || !row || !edit) return;
    setTried(true);
    if (amountProblem || remarkProblem) {
      if (remarkProblem) remarkRef.current?.focus();
      return;
    }
    setBusy(true);
    setRefused(null);
    try {
      await onConfirm({
        ...decision,
        payload: approve ? approvalPayload(row, edit) : rejectionPayload(edit.remark),
      });
    } catch (err) {
      const said = serverError(
        err,
        approve ? "The advance could not be approved." : "The advance could not be rejected.",
      );
      setRefused(said);
    } finally {
      setBusy(false);
    }
  };

  // the server asked for a remark: put the cursor in it once the fields are editable again
  useEffect(() => {
    if (refused?.code === "remark" && !busy) remarkRef.current?.focus();
  }, [refused, busy]);

  return (
    <AlertDialog open={decision !== null} onOpenChange={(o) => !o && !busy && onCancel()}>
      <AlertDialogContent className="max-h-[92vh] overflow-y-auto" data-testid="decision-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {approve ? "Approve" : "Reject"} the {row ? TYPE_LABEL[row.advanceType] : "advance"} for {row?.employeeName}
            ?
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                {row && `${formatMoney(asked)} asked for`}
                {term && row?.repaymentMonths ? `, over ${row.repaymentMonths} months` : ""}
                {row?.purpose ? `, for ${row.purpose}` : ""}.
                {byEmployee && " The employee applied from the mobile app."}
              </p>
              {earned ? (
                <p className="text-xs" data-testid="decision-earned">
                  Earned in {earnedPeriodLabel(earned)}: Fixed salary {formatMoney(earned.fixedSalary)} · Working days{" "}
                  {workingDaysText(earned)} · Earned salary {formatMoney(earned.earnedAmount)}
                  {limit != null && ` · Limit (${earned.percent}% of earned salary) ${formatMoney(limit)}`}.
                </p>
              ) : (
                row?.salaryAtRequest != null &&
                row.advanceType === "general" && (
                  <p className="text-xs" data-testid="decision-salary">
                    Monthly fixed salary: {formatMoney(row.salaryAtRequest)}.
                  </p>
                )
              )}
              {row && !term && (row.limitRemark ?? "").trim() && (
                <p className="text-xs" data-testid="decision-limit-remark">
                  Recorded above the limit: &ldquo;{row.limitRemark}&rdquo;
                </p>
              )}
              {!approve && <p>Nothing will be deducted from payroll for a rejected advance.</p>}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        {approve && row && edit && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div className="col-span-2 space-y-1 sm:col-span-1">
                <Label htmlFor="decision-amount" className="text-xs">
                  Amount to approve (₹)
                </Label>
                <Input
                  id="decision-amount"
                  inputMode="decimal"
                  value={edit.amount}
                  onChange={(e) => patch({ amount: e.target.value })}
                  aria-invalid={!!amountProblem}
                  aria-describedby="decision-requested"
                  disabled={busy}
                  data-testid="decision-amount"
                />
                <p id="decision-requested" className="text-[11px] text-gray-500" data-testid="decision-requested">
                  Asked for {formatMoney(asked)}; no more than that.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="decision-start-month" className="text-xs">
                  {term ? "First deduction" : "Deducted in"}
                </Label>
                <Select
                  value={String(edit.startMonth)}
                  onValueChange={(v) => patch({ startMonth: Number(v) })}
                  disabled={busy}
                >
                  <SelectTrigger id="decision-start-month" data-testid="decision-start-month">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MONTHS.map((m, i) => (
                      <SelectItem key={m} value={String(i + 1)}>
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="decision-start-year" className="text-xs">
                  Year
                </Label>
                <Input
                  id="decision-start-year"
                  inputMode="numeric"
                  value={String(edit.startYear)}
                  onChange={(e) => patch({ startYear: Number(e.target.value) })}
                  disabled={busy}
                  data-testid="decision-start-year"
                />
              </div>
            </div>
            {term && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-gray-700" id="decision-emi-label">
                  Monthly EMI (worked out from the approved amount)
                </p>
                <p
                  aria-labelledby="decision-emi-label"
                  className="rounded-md border border-dashed bg-gray-50 px-3 py-2 text-sm text-gray-700"
                  data-testid="decision-emi"
                >
                  {preview && preview.items.length > 0
                    ? `${formatMoney(preview.items[0].amount)} a month for ${preview.items.length} ${
                        preview.items.length === 1 ? "month" : "months"
                      }`
                    : "-"}
                </p>
              </div>
            )}
            {amountProblem && (
              <p className="text-xs font-medium text-red-600" role="alert" data-testid="decision-problem">
                {amountProblem}
              </p>
            )}
            {aboveLimit > 0 && (
              <p className="text-xs font-medium text-amber-700" data-testid="decision-over-limit">
                {formatMoney(approvedNow)} is {formatMoney(aboveLimit)} above the earned limit of {formatMoney(limit)}.
                You can still approve it.
              </p>
            )}
            {partial && !remarkProblem && (
              <p className="text-xs font-medium text-amber-700" data-testid="decision-less">
                Approving {formatMoney(approvedNow)} of the {formatMoney(asked)} asked for. The employee sees both, and
                your remark.
              </p>
            )}
            {preview && (
              <div className="space-y-1 text-sm text-muted-foreground">
                <p data-testid="decision-schedule">
                  Approving creates the repayment schedule, which payroll then deducts: {describeSchedule(preview)}.
                </p>
                {preview.shortfall > 0 && (
                  <p className="text-amber-700">
                    Rounding leaves {formatMoney(preview.shortfall)} of the amount off that schedule.
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {row && edit && (
          <div className="space-y-1">
            <Label htmlFor="decision-remark" className="text-xs">
              {approve ? "Remark" : "Reason for rejecting"}{" "}
              <span className={needsRemark ? "text-red-600" : "font-normal text-gray-400"}>
                {needsRemark ? "(required)" : "(optional)"}
              </span>
            </Label>
            <Textarea
              id="decision-remark"
              ref={remarkRef}
              value={edit.remark}
              onChange={(e) => patch({ remark: e.target.value })}
              maxLength={REMARK_MAX}
              rows={3}
              placeholder={
                approve
                  ? partial
                    ? "Why less than asked for, e.g. Budget limit this month"
                    : "Anything the employee should know (optional)"
                  : "e.g. A Term Loan is already running"
              }
              aria-invalid={!!remarkProblem && (tried || remarkLength > 0)}
              aria-describedby="decision-remark-help"
              disabled={busy}
              data-testid="decision-remark"
            />
            <div id="decision-remark-help" className="flex items-start justify-between gap-3 text-[11px]">
              <p
                className={cn(
                  remarkProblem ? (tried ? "font-medium text-red-600" : "font-medium text-amber-700") : "text-gray-500",
                )}
                data-testid={remarkProblem ? "decision-remark-problem" : undefined}
              >
                {remarkProblem ??
                  (needsRemark
                    ? "The employee sees this in the app."
                    : "Saved with the approval; the employee sees it in the app.")}
              </p>
              <p className="shrink-0 tabular-nums text-gray-400" data-testid="decision-remark-count">
                {edit.remark.length}/{REMARK_MAX}
                {needsRemark && remarkLength < REMARK_MIN ? ` · at least ${REMARK_MIN}` : ""}
              </p>
            </div>
          </div>
        )}

        {refused && (
          <p
            className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs font-medium text-red-700"
            role="alert"
            data-testid="decision-server-error"
          >
            {refused.text}
          </p>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} data-testid="decision-cancel">
            Cancel
          </AlertDialogCancel>
          <Button
            type="button"
            onClick={confirm}
            disabled={blocked}
            className={
              approve ? "bg-green-600 text-white hover:bg-green-700" : "bg-red-600 text-white hover:bg-red-700"
            }
            data-testid="decision-confirm"
          >
            {approve
              ? busy
                ? "Approving..."
                : partial
                  ? `Approve ${formatMoney(approvedNow)}`
                  : "Approve"
              : busy
                ? "Rejecting..."
                : "Reject"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function DeleteDialog({
  row,
  busy,
  onConfirm,
  onCancel,
}: {
  row: SettlementRow | null;
  busy: boolean;
  onConfirm: (row: SettlementRow) => void;
  onCancel: () => void;
}) {
  return (
    <AlertDialog open={row !== null} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent data-testid="delete-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this {row ? TYPE_LABEL[row.advanceType] : "advance"}?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                This permanently deletes the waiting {row ? TYPE_LABEL[row.advanceType] : "advance"} for{" "}
                <strong>{row?.employeeName}</strong> ({formatMoney(row ? requestedOf(row) : 0)}). This cannot be undone.
              </p>
              <p className="text-xs">Only an advance still waiting for approval can be deleted.</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="delete-cancel">Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-red-600 text-white hover:bg-red-700"
            disabled={busy}
            onClick={() => row && onConfirm(row)}
            data-testid="delete-confirm"
          >
            {busy ? "Deleting..." : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
