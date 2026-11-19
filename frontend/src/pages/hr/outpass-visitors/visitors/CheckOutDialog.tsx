import { useEffect, useId, useState } from "react";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fmtMinutes, fmtTime } from "../kit";

/** What the dialog shows of the visit (an HR row and a reception desk row both have it). */
export type CheckOutTarget = {
  id: number;
  name: string;
  visitedAt: string;
  minutesInside: number | null;
};

const NOTE_MAX = 300;

/**
 * "Check out <visitor>" with an optional note, before the check-out is recorded (it cannot be undone). Used by the
 * Visitors page (table row and drawer) and the reception desk console. `onConfirm` does the call; a rejected promise's
 * message is shown in the dialog (e.g. "Ramesh Kumar was already checked out at 14:05.").
 */
export function CheckOutDialog({
  target,
  onClose,
  onConfirm,
}: {
  target: CheckOutTarget | null;
  onClose: () => void;
  onConfirm: (note: string) => Promise<unknown>;
}) {
  const noteId = useId();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setNote("");
    setError(null);
    setBusy(false);
  }, [target?.id]);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(note.trim());
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Could not check out. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-w-md" data-testid="check-out-dialog">
        <DialogHeader>
          <DialogTitle>Check out {target?.name}</DialogTitle>
          <DialogDescription>
            {target
              ? `Checked in at ${fmtTime(target.visitedAt)}${
                  target.minutesInside !== null ? `, inside for ${fmtMinutes(target.minutesInside)}` : ""
                }. The check-out time is now and cannot be changed later.`
              : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <label htmlFor={noteId} className="text-sm font-medium text-slate-700">
            Note <span className="font-normal text-slate-500">(optional)</span>
          </label>
          <textarea
            id={noteId}
            value={note}
            maxLength={NOTE_MAX}
            rows={2}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Returned the visitor badge"
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring/50"
            data-testid="check-out-note"
          />
        </div>
        {error && (
          <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </p>
        )}
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" className="h-11 sm:h-9" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            className="h-11 gap-1.5 sm:h-9"
            onClick={confirm}
            disabled={busy || target === null}
            data-testid="check-out-confirm"
          >
            <LogOut size={15} aria-hidden="true" />
            {busy ? "Checking out…" : "Check out"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
