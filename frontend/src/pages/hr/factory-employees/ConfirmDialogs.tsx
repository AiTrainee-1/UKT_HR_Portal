import { useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { FactoryEmployee, FactoryLabel, FactoryPayCycle } from "@/lib/api-client/custom-hooks";
import { todayIso } from "../shifts/shift-logic";
import { PAY_CYCLE_LABEL, employees, labelConfirmWording, longDay } from "./logic";

const names = (rows: { name: string }[]) =>
  rows.length <= 3
    ? rows.map((r) => r.name).join(", ")
    : `${rows
        .slice(0, 3)
        .map((r) => r.name)
        .join(", ")} and ${rows.length - 3} more`;

/** Taking people out of Factory Employees: they stay employees, and say so. */
export function RemoveDialog({
  rows,
  busy,
  onConfirm,
  onClose,
}: {
  rows: FactoryEmployee[] | null;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <AlertDialog open={rows !== null} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent data-testid="fe-remove-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {rows ? employees(rows.length) : ""} from Factory Employees?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              {rows && <p className="font-medium text-gray-800">{names(rows)}</p>}
              <p>
                They stay employees: their attendance, shift, payroll and records do not change, and they are still in
                All Employees. They only leave this list, and their label is cleared.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
            disabled={busy}
            className="bg-red-600 text-white hover:bg-red-700"
            data-testid="fe-remove-confirm"
          >
            Remove from the list
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** A bulk label change: the label is also the department and designation of everyone in it, so it is said first. */
export function LabelConfirmDialog({
  target,
  busy,
  onConfirm,
  onClose,
}: {
  target: { count: number; label: Pick<FactoryLabel, "name"> | null } | null;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const wording = target ? labelConfirmWording(target.count, target.label) : null;
  return (
    <AlertDialog open={target !== null} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent data-testid="fe-label-confirm-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{wording?.title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              {wording?.lines.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
            disabled={busy}
            data-testid="fe-label-confirm"
          >
            {target?.label ? `Give the label ${target.label.name}` : "Remove the label"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Marking people active or inactive (the employee status endpoint). */
export function StatusDialog({
  target,
  busy,
  onConfirm,
  onClose,
}: {
  target: { rows: FactoryEmployee[]; status: "active" | "inactive" } | null;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const inactive = target?.status === "inactive";
  return (
    <AlertDialog open={target !== null} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent data-testid="fe-status-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            Mark {target ? employees(target.rows.length) : ""} {inactive ? "inactive" : "active"}?
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              {target && <p className="font-medium text-gray-800">{names(target.rows)}</p>}
              <p>
                {inactive
                  ? "Inactive employees are left out of attendance and payroll from now on, everywhere in the HRMS. Their records are kept."
                  : "They are back in attendance and payroll from now on."}
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
            disabled={busy}
            className={inactive ? "bg-amber-600 text-white hover:bg-amber-700" : undefined}
            data-testid="fe-status-confirm"
          >
            {inactive ? "Mark inactive" : "Mark active"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Taking people off their shift from a last day (default today): days up to it keep the shift. */
export function ShiftRemoveDialog({
  people,
  busy,
  onConfirm,
  onClose,
}: {
  people: { id: number; name: string }[] | null;
  busy: boolean;
  onConfirm: (lastDay: string) => void;
  onClose: () => void;
}) {
  const [lastDay, setLastDay] = useState(todayIso());
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(lastDay);
  return (
    <AlertDialog
      open={people !== null}
      onOpenChange={(o) => {
        if (!o) {
          setLastDay(todayIso());
          onClose();
        }
      }}
    >
      <AlertDialogContent data-testid="fe-shift-remove-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Take {people ? employees(people.length) : ""} off their shift?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              {people && <p className="font-medium text-gray-800">{names(people)}</p>}
              <p>
                {valid ? `${longDay(lastDay)} is their last day on it.` : "Pick their last day on it."} Days up to then
                keep the shift, so past attendance and payroll do not change. A shift that has not started yet is
                cancelled.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-1.5">
          <label htmlFor="fe-shift-last-day" className="text-sm font-semibold text-gray-800">
            Last day on the shift
          </label>
          <Input
            id="fe-shift-last-day"
            type="date"
            value={lastDay}
            onChange={(e) => setLastDay(e.target.value)}
            className="h-10 w-44"
            data-testid="fe-shift-last-day"
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              if (valid) onConfirm(lastDay);
            }}
            disabled={busy || !valid}
            className="bg-red-600 text-white hover:bg-red-700"
            data-testid="fe-shift-remove-confirm"
          >
            Take off the shift
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** A worker who was already paid needs a short reason before moving to another frequency (the server asked: 409). */
export function CycleReasonDialog({
  target,
  busy,
  onConfirm,
  onClose,
}: {
  target: { row: FactoryEmployee; cycle: FactoryPayCycle; message: string | null } | null;
  busy: boolean;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(o) => {
        if (!o) {
          setReason("");
          onClose();
        }
      }}
    >
      <AlertDialogContent data-testid="fe-reason-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            Pay {target?.row.name} {target ? PAY_CYCLE_LABEL[target.cycle] : ""}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {target?.message ??
              "This worker has already received salary. The salary already paid will not be paid again."}{" "}
            A short reason is needed; it is kept in their history.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          rows={2}
          placeholder="For example: driver moved to the weekly roster"
          aria-label="Reason"
          data-testid="fe-reason"
        />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              onConfirm(reason.trim());
              setReason("");
            }}
            disabled={busy || !reason.trim()}
            data-testid="fe-reason-confirm"
          >
            Save
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
