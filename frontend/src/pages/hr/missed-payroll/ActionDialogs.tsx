import { useState } from "react";
import { BadgeCheck, Loader2, Trash2, Wallet } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { inr } from "@/components/payroll/kit/format";
import type { MissedKind, MissedRow } from "@/lib/api-client/custom-hooks/missed-payroll";
import { MAIN_PAYROLL, employeeCount, paidOnProblem, todayIso } from "./logic";

/** "SURYA M, ARUN K and 3 more". */
export function names(rows: readonly MissedRow[], shown = 3): string {
  const first = rows.slice(0, shown).map((r) => r.name);
  const more = rows.length - first.length;
  if (more > 0) return `${first.join(", ")} and ${more} more`;
  return first.length > 1 ? `${first.slice(0, -1).join(", ")} and ${first[first.length - 1]}` : (first[0] ?? "");
}

const netOf = (rows: readonly MissedRow[]): number => rows.reduce((sum, r) => sum + (r.entry?.net ?? 0), 0);

/** Done: the cleared figures go into the month's payroll. Cannot be undone here. */
export function DoneDialog({
  rows,
  kind,
  period,
  pending,
  onConfirm,
  onClose,
}: {
  /** The cleared employees Done would take; null = closed. */
  rows: MissedRow[] | null;
  kind: MissedKind;
  period: string;
  pending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const open = rows !== null && rows.length > 0;
  const count = rows?.length ?? 0;
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && !pending && onClose()}>
      <AlertDialogContent className="max-w-lg" data-testid="mp-done-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <BadgeCheck size={18} className="text-emerald-600" /> Add {employeeCount(count)} to the {period} payroll?
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                {rows && names(rows)} (net {inr(netOf(rows ?? []))}) will be written into the {period}{" "}
                {MAIN_PAYROLL[kind]} records and salary statement, marked Cleared, with the remark MISSED PAYROLL.
              </p>
              <ul className="list-disc space-y-1 pl-5 text-xs">
                <li>This cannot be undone here.</li>
                <li>
                  They are paid from this page: download their bank file here, then mark them Paid here. The{" "}
                  {MAIN_PAYROLL[kind]} bank file never includes them.
                </li>
                <li>
                  A held salary or a waiting new joiner is worked out again and released by this, not added twice.
                </li>
              </ul>
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
            data-testid="mp-done-confirm"
          >
            {pending && <Loader2 size={14} className="mr-1.5 animate-spin" />}
            Done: add {employeeCount(count)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Paid: the day the bank paid them (not after today). Staff get the salary-paid notification once. */
export function PaidDialog({
  rows,
  kind,
  period,
  pending,
  onConfirm,
  onClose,
}: {
  rows: MissedRow[] | null;
  kind: MissedKind;
  period: string;
  pending: boolean;
  onConfirm: (paidOn: string) => void;
  onClose: () => void;
}) {
  const today = todayIso();
  const [paidOn, setPaidOn] = useState(today);
  // another set of employees starts again from today (a refused try keeps the same rows and the day picked)
  const [dayFor, setDayFor] = useState(rows);
  if (rows !== dayFor) {
    setDayFor(rows);
    setPaidOn(todayIso());
  }
  const open = rows !== null && rows.length > 0;
  const count = rows?.length ?? 0;
  const problem = paidOnProblem(paidOn, today);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && !pending && onClose()}>
      <DialogContent className="max-w-md" data-testid="mp-paid-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wallet size={18} className="text-emerald-600" /> Mark {employeeCount(count)} paid
          </DialogTitle>
          <DialogDescription>
            {rows && names(rows)}: their {period} missed payroll (net {inr(netOf(rows ?? []))}) is marked paid on the
            day below.{" "}
            {kind === "staff"
              ? "Each employee gets the salary-paid notification once."
              : "Production workers get no phone notification for this."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <label htmlFor="mp-paid-on" className="text-sm font-semibold text-gray-800">
            Paid on
          </label>
          <Input
            id="mp-paid-on"
            type="date"
            value={paidOn}
            max={today}
            onChange={(e) => setPaidOn(e.target.value)}
            aria-invalid={problem !== null}
            aria-describedby="mp-paid-on-help"
            data-testid="mp-paid-on"
          />
          <p
            id="mp-paid-on-help"
            className={problem ? "text-xs text-red-700" : "text-xs text-gray-500"}
            data-testid="mp-paid-on-help"
          >
            {problem ?? "The day the bank paid them. It cannot be in the future."}
          </p>
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
            onClick={() => onConfirm(paidOn)}
            disabled={pending || problem !== null}
            data-testid="mp-paid-confirm"
          >
            {pending ? <Loader2 size={14} className="animate-spin" /> : <Wallet size={14} />}
            Mark {employeeCount(count)} paid
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Remove: the generated figures are dropped (nothing was written anywhere); they can be generated again. */
export function RemoveDialog({
  rows,
  pending,
  onConfirm,
  onClose,
}: {
  rows: MissedRow[] | null;
  pending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const open = rows !== null && rows.length > 0;
  const count = rows?.length ?? 0;
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && !pending && onClose()}>
      <AlertDialogContent className="max-w-md" data-testid="mp-remove-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Trash2 size={18} className="text-red-600" /> Remove the figures of {employeeCount(count)}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {rows && names(rows)}: their generated figures are dropped. Nothing was written to the payroll yet, and they
            stay in the list, so they can be generated again.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-red-600 text-white hover:bg-red-700"
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
            disabled={pending}
            data-testid="mp-remove-confirm"
          >
            {pending && <Loader2 size={14} className="mr-1.5 animate-spin" />}
            Remove {employeeCount(count)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
