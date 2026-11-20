import { useState } from "react";
import { Hand, Loader2, PlayCircle } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import type { SlipCenterEmployee } from "@/lib/api-client/custom-hooks/salary-slip-center";
import { employeeCount } from "./logic";

const REASON_MAX = 200;

/** "SURYA M, ARUN K and 3 more". */
function names(rows: readonly SlipCenterEmployee[], shown = 3): string {
  const first = rows.slice(0, shown).map((r) => r.name);
  const more = rows.length - first.length;
  if (more > 0) return `${first.join(", ")} and ${more} more`;
  return first.length > 1 ? `${first.slice(0, -1).join(", ")} and ${first[first.length - 1]}` : (first[0] ?? "");
}

/** Hold employees for the month: a reason (optional) and the confirmation. */
export function HoldDialog({
  rows,
  period,
  pending,
  onConfirm,
  onClose,
}: {
  /** Who would be held; null = closed. */
  rows: SlipCenterEmployee[] | null;
  period: string;
  pending: boolean;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  // another set of employees is a fresh dialog: the reason typed for the last one is not carried over (a refused hold
  // keeps the same rows, so the reason stays for another try)
  const [reasonFor, setReasonFor] = useState(rows);
  if (rows !== reasonFor) {
    setReasonFor(rows);
    setReason("");
  }
  const open = rows !== null && rows.length > 0;
  const count = rows?.length ?? 0;
  return (
    <Dialog open={open} onOpenChange={(next) => !next && !pending && onClose()}>
      <DialogContent className="max-w-md" data-testid="ssc-hold-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Hand size={18} className="text-orange-600" /> Hold {employeeCount(count)} for {period}
          </DialogTitle>
          <DialogDescription>
            {rows && names(rows)}. Held employees still get their slips and stay on the salary statement (Remarks HOLD),
            but are left out of the bank file until released.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <label htmlFor="ssc-hold-reason" className="text-sm font-semibold text-gray-800">
            Reason <span className="font-normal text-gray-400">(optional)</span>
          </label>
          <Textarea
            id="ssc-hold-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value.slice(0, REASON_MAX))}
            placeholder="For example: pending documents"
            rows={3}
            data-testid="ssc-hold-reason"
          />
          <p className="text-right text-[11px] text-gray-400">
            {reason.length}/{REASON_MAX}
          </p>
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            className="gap-1.5 bg-orange-600 text-white hover:bg-orange-700"
            onClick={() => onConfirm(reason)}
            disabled={pending}
            data-testid="ssc-hold-confirm"
          >
            {pending ? <Loader2 size={14} className="animate-spin" /> : <Hand size={14} />}
            Hold {employeeCount(count)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Release held employees: they are back in the bank file. */
export function ReleaseDialog({
  rows,
  period,
  pending,
  onConfirm,
  onClose,
}: {
  rows: SlipCenterEmployee[] | null;
  period: string;
  pending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const open = rows !== null && rows.length > 0;
  const count = rows?.length ?? 0;
  const reasons = (rows ?? []).filter((r) => r.holdReason);
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && !pending && onClose()}>
      <AlertDialogContent className="max-w-md" data-testid="ssc-release-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <PlayCircle size={18} className="text-emerald-600" /> Release {employeeCount(count)} for {period}?
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>{rows && names(rows)} will be back in the bank file for this month.</p>
              {reasons.length > 0 && (
                <ul className="space-y-0.5 rounded-lg bg-gray-50 p-2 text-xs">
                  {reasons.slice(0, 5).map((r) => (
                    <li key={r.id}>
                      <span className="font-semibold text-gray-700">{r.name}</span>: held for &ldquo;{r.holdReason}
                      &rdquo;
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-emerald-600 text-white hover:bg-emerald-700"
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
            disabled={pending}
            data-testid="ssc-release-confirm"
          >
            {pending && <Loader2 size={14} className="mr-1.5 animate-spin" />}
            Release {employeeCount(count)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
