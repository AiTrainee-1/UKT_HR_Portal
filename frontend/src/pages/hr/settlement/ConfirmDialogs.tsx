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
import { describeSchedule, previewForAdvance, TYPE_LABEL, type SettlementRow } from "./logic";
import { formatMoney } from "./shared";

export type Decision = { row: SettlementRow; status: "approved" | "rejected" };

/** Approving creates the schedule payroll deducts from, so HR sees it before saying yes. Rejecting writes nothing. */
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
  const preview = row ? previewForAdvance(row) : null;
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
                {row && `${TYPE_LABEL[row.advanceType]} of ${formatMoney(row.amount)}`}
                {row?.purpose ? ` for ${row.purpose}` : ""}.
              </p>
              {approve && preview && (
                <>
                  <p data-testid="decision-schedule">
                    Approving creates the repayment schedule, which payroll then deducts: {describeSchedule(preview)}.
                  </p>
                  {preview.shortfall > 0 && (
                    <p className="text-amber-700">
                      Rounding leaves {formatMoney(preview.shortfall)} of the amount off that schedule.
                    </p>
                  )}
                </>
              )}
              {!approve && <p>Nothing will be deducted from payroll for a rejected advance.</p>}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="decision-cancel">Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => decision && onConfirm(decision)}
            className={
              approve ? "bg-green-600 text-white hover:bg-green-700" : "bg-red-600 text-white hover:bg-red-700"
            }
            data-testid="decision-confirm"
          >
            {approve ? "Approve" : "Reject"}
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
