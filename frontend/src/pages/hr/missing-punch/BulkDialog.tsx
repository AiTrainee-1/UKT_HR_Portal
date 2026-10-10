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
import { formatDate } from "../settlement/shared";
import { formatPunchTime, punchLabel, type MissingRow } from "./logic";

/** The confirmation for approving several requests at once: it lists every one, so nothing is approved unseen. */
export default function BulkDialog({
  rows,
  onConfirm,
  onCancel,
}: {
  /** The requests to approve; the dialog is open while there are some. */
  rows: MissingRow[];
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <AlertDialog open={rows.length > 0} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent data-testid="mp-bulk-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            Approve {rows.length} missing punch {rows.length === 1 ? "request" : "requests"}?
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                Each approval follows the approval pipeline: a request that is waiting for another step afterwards is
                only passed on. Once the final approval is given, the punch is added to attendance.
              </p>
              <ul className="max-h-64 divide-y overflow-y-auto rounded-xl border text-xs" data-testid="mp-bulk-list">
                {rows.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="min-w-0">
                      <span className="block truncate font-semibold text-gray-800">
                        {r.employeeName} <span className="font-mono font-normal text-gray-400">{r.employeeCode}</span>
                      </span>
                      <span className="block text-gray-500">{r.reason}</span>
                    </span>
                    <span className="shrink-0 text-right text-gray-700">
                      <span className="block font-medium">{formatDate(r.date)}</span>
                      <span className="block text-gray-500">
                        {punchLabel(r)} {formatPunchTime(r.punchTime)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="mp-bulk-cancel">Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-green-600 text-white hover:bg-green-700"
            data-testid="mp-bulk-confirm"
          >
            Approve {rows.length}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
