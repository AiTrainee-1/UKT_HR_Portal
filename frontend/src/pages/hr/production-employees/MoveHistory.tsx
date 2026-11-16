import { ArrowRight, History, Loader2 } from "lucide-react";
import { dateTime } from "@/components/payroll/kit/format";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useProductionEmployeeTransfers, type ProductionEmployeeRow } from "@/lib/api-client/custom-hooks";
import { moveDetails } from "./logic";

/**
 * One worker's every move between pay cycles, newest first (owner 2026-11-16): when and by whom, from which cycle to
 * which, why, how much the old cycle had already paid (never paid again) and from which day the new cycle pays.
 */
export function MoveHistoryDialog({ row, onClose }: { row: ProductionEmployeeRow | null; onClose: () => void }) {
  const history = useProductionEmployeeTransfers(row?.id ?? null);
  const moves = history.data?.moves ?? [];
  return (
    <Dialog open={row !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto" data-testid="pe-history-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History size={16} className="text-amber-600" /> Pay cycle history
          </DialogTitle>
          <DialogDescription>
            {row ? (
              <>
                {row.name} <span className="font-mono">({row.employeeCode})</span>: every move between Weekly, BiWeekly,
                Monthly and Unassigned. A day that was already paid is never paid again.
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        {history.isLoading ? (
          <p className="flex items-center gap-2 text-sm text-gray-500" role="status" data-testid="pe-history-loading">
            <Loader2 size={14} className="animate-spin text-amber-600" /> Loading the history…
          </p>
        ) : history.isError ? (
          <p className="text-sm text-red-700" data-testid="pe-history-error">
            The history could not be loaded just now. Close this and try again.
          </p>
        ) : moves.length === 0 ? (
          <p className="text-sm text-gray-500" data-testid="pe-history-empty">
            This worker has never been moved between pay cycles.
          </p>
        ) : (
          <ol className="space-y-2.5" data-testid="pe-history-list">
            {moves.map((move) => (
              <li
                key={move.id}
                className="rounded-xl border border-slate-200 bg-white p-3 text-sm"
                data-testid={`pe-history-move-${move.id}`}
              >
                <p className="flex flex-wrap items-center gap-1.5 font-semibold text-gray-900">
                  {move.fromLabel} <ArrowRight size={13} className="text-gray-400" /> {move.toLabel}
                </p>
                <p className="text-xs text-gray-500">
                  {dateTime(move.changedAt)}
                  {move.changedBy ? ` · by ${move.changedBy}` : ""}
                </p>
                <ul className="mt-1.5 space-y-0.5 text-xs text-gray-700">
                  {moveDetails(move).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
