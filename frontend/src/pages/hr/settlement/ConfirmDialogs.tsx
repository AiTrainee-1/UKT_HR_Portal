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
import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  appliedByEmployee,
  approvalDefaults,
  approvalPayload,
  approvalPreview,
  approvalProblem,
  describeSchedule,
  requestedOf,
  TYPE_LABEL,
  type ApprovalEdit,
  type SettlementRow,
} from "./logic";
import { MONTHS, formatMoney } from "./shared";

export type Decision = {
  row: SettlementRow;
  status: "approved" | "rejected";
  /** What the approve call sends: `{status}` plus a smaller approved amount and/or another first deduction month. */
  payload?: ReturnType<typeof approvalPayload>;
};

/** Approving creates the schedule payroll deducts from, so HR sees it before saying yes, and may approve less than was
 *  asked for or move the first deduction month. Rejecting writes nothing. */
export function DecisionDialog({
  decision,
  onConfirm,
  onCancel,
}: {
  decision: Decision | null;
  onConfirm: (d: Decision) => void;
  onCancel: () => void;
}) {
  const row = decision?.row;
  const approve = decision?.status === "approved";
  const [edit, setEdit] = useState<ApprovalEdit | null>(null);
  useEffect(() => {
    setEdit(row && approve ? approvalDefaults(row) : null);
  }, [row, approve]);

  const problem = row && edit ? approvalProblem(row, edit) : null;
  const preview = row && edit && !problem ? approvalPreview(row, edit) : null;
  const byEmployee = row ? appliedByEmployee(row) : false;
  const asked = row ? requestedOf(row) : 0;
  const approvedNow = edit ? Number(edit.amount) : 0;
  const term = row?.advanceType === "term";

  return (
    <AlertDialog open={decision !== null} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent data-testid="decision-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {approve ? "Approve" : "Reject"} the advance for {row?.employeeName}?
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                {row && `${TYPE_LABEL[row.advanceType]} of ${formatMoney(asked)}`}
                {term && row?.repaymentMonths ? ` over ${row.repaymentMonths} months` : ""}
                {row?.purpose ? ` for ${row.purpose}` : ""}.{byEmployee && " The employee applied from the mobile app."}
              </p>
              {byEmployee && row?.salaryAtRequest != null && row.advanceType === "general" && (
                <p className="text-xs" data-testid="decision-salary">
                  Monthly salary when applying: {formatMoney(row.salaryAtRequest)} (60% limit{" "}
                  {formatMoney(Math.floor(row.salaryAtRequest * 0.6))}).
                </p>
              )}
              {!approve && <p>Nothing will be deducted from payroll for a rejected advance.</p>}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        {approve && row && edit && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="space-y-1 sm:col-span-1">
                <Label htmlFor="decision-amount" className="text-xs">
                  Amount to approve
                </Label>
                <Input
                  id="decision-amount"
                  inputMode="decimal"
                  value={edit.amount}
                  onChange={(e) => setEdit({ ...edit, amount: e.target.value })}
                  aria-invalid={!!problem}
                  data-testid="decision-amount"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="decision-start-month" className="text-xs">
                  {term ? "First deduction" : "Deducted in"}
                </Label>
                <Select
                  value={String(edit.startMonth)}
                  onValueChange={(v) => setEdit({ ...edit, startMonth: Number(v) })}
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
                  onChange={(e) => setEdit({ ...edit, startYear: Number(e.target.value) })}
                  data-testid="decision-start-year"
                />
              </div>
            </div>
            {problem ? (
              <p className="text-xs font-medium text-red-600" data-testid="decision-problem">
                {problem}
              </p>
            ) : (
              approvedNow < asked && (
                <p className="text-xs font-medium text-amber-700" data-testid="decision-less">
                  Approving {formatMoney(approvedNow)} of the {formatMoney(asked)} asked for. The employee sees both.
                </p>
              )
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

        <AlertDialogFooter>
          <AlertDialogCancel data-testid="decision-cancel">Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              if (!decision) return;
              if (approve && row && edit) {
                if (problem) {
                  e.preventDefault();
                  return;
                }
                onConfirm({ ...decision, payload: approvalPayload(row, edit) });
                return;
              }
              onConfirm(decision);
            }}
            disabled={approve && !!problem}
            className={
              approve ? "bg-green-600 text-white hover:bg-green-700" : "bg-red-600 text-white hover:bg-red-700"
            }
            data-testid="decision-confirm"
          >
            {approve
              ? approvedNow > 0 && approvedNow < asked
                ? `Approve ${formatMoney(approvedNow)}`
                : "Approve"
              : "Reject"}
          </AlertDialogAction>
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
  const recovered = row?.totalRepaid ?? 0;
  return (
    <AlertDialog open={row !== null} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent data-testid="delete-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this advance?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                This permanently deletes the advance for <strong>{row?.employeeName}</strong> (
                {formatMoney(row?.amount)}) and its repayment schedule. This cannot be undone.
              </p>
              {recovered > 0 && (
                <p className="font-medium text-red-700">
                  {formatMoney(recovered)} has already been recovered through payroll. Deleting removes that record too.
                </p>
              )}
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
