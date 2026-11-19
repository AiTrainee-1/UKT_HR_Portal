import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useUseCompensationBalance, type ShiftsValue } from "@/lib/api-client/custom-hooks";
import { dateLong, errorMessage, fmtShifts, isIsoDate, shiftsText } from "../logic";
import { ErrorNotice, Field, Notice, ShiftsPicker, useSingleFlight } from "../ui";
import { CLAIM_REASON_MAX } from "./leave-logic";

export type UseBalanceTarget = { employeeId: number; employeeName: string; employeeCode: string; available: number };

type Form = { date: string; shifts: ShiftsValue | null; reason: string };

/** The request to use part of a balance: a real day, a quarter to a whole shift that the balance covers, and a reason. */
export function checkUseBalance(form: Form, available: number) {
  const dateProblem = !form.date ? "Choose the day off." : !isIsoDate(form.date) ? "Enter a valid date." : null;
  const shiftsProblem =
    form.shifts === null
      ? "Choose how many shifts."
      : form.shifts > available + 1e-9
        ? `More than the available balance (${fmtShifts(available)}).`
        : null;
  const text = form.reason.trim();
  const reasonProblem =
    text === ""
      ? "Give a reason: the Department Head reads it before deciding."
      : text.length > CLAIM_REASON_MAX
        ? `The reason can be at most ${CLAIM_REASON_MAX} characters.`
        : null;
  return { ok: !dateProblem && !shiftsProblem && !reasonProblem, dateProblem, shiftsProblem, reasonProblem };
}

/**
 * Use balance, on the employee's behalf: HR asks to take part of the balance as a day off on a date, exactly like the
 * employee asking in the app. The request goes to the employee's Department Head; once approved the day is topped up and
 * the shifts come off the balance. (HR's direct Redeem, without the Department Head, stays next to it.)
 */
export function UseBalanceDialog({
  target,
  onOpenChange,
}: {
  target: UseBalanceTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent data-testid="use-dialog">
        {target && <UseForm key={target.employeeId} target={target} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function UseForm({ target, onClose }: { target: UseBalanceTarget; onClose: () => void }) {
  const { toast } = useToast();
  const use = useUseCompensationBalance();
  const [form, setForm] = useState<Form>({ date: "", shifts: null, reason: "" });
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = useMemo(() => checkUseBalance(form, target.available), [form, target.available]);
  const patch = (change: Partial<Form>) => {
    setForm((f) => ({ ...f, ...change }));
    setError(null);
  };

  const once = useSingleFlight();
  const submit = () =>
    once(async () => {
      setTouched(true);
      if (!check.ok || use.isPending) return;
      setError(null);
      try {
        await use.mutateAsync({
          employeeId: target.employeeId,
          date: form.date,
          shifts: form.shifts as ShiftsValue,
          reason: form.reason.trim(),
        });
        toast({
          title: "Sent to the Department Head",
          description: `${target.employeeName}: ${shiftsText(form.shifts)} on ${dateLong(form.date)}. It comes off the balance once approved.`,
        });
        onClose();
      } catch (err) {
        setError(errorMessage(err, "The request could not be sent. Check the connection and try again."));
      }
    });

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      noValidate
    >
      <DialogHeader>
        <DialogTitle>Use the balance of {target.employeeName}</DialogTitle>
        <DialogDescription>
          <span className="font-mono">{target.employeeCode}</span> has{" "}
          <strong data-testid="use-available">{shiftsText(target.available)}</strong> available. This asks the
          employee&apos;s Department Head, like a request from the employee&apos;s app.
        </DialogDescription>
      </DialogHeader>

      <Field
        label="Day off on"
        htmlFor="use-date"
        problem={touched || form.date ? check.dateProblem : null}
        hint="A working day of the current request window, not already a full day off. The server says why when it cannot be."
      >
        <Input
          id="use-date"
          type="date"
          value={form.date}
          onChange={(e) => patch({ date: e.target.value })}
          data-testid="use-date"
        />
      </Field>

      <Field label="Shifts to use" problem={touched || form.shifts !== null ? check.shiftsProblem : null}>
        <ShiftsPicker
          value={form.shifts}
          max={target.available}
          label={`Shifts to use for ${target.employeeName}`}
          onChange={(shifts) => patch({ shifts })}
          testId="use-shifts"
        />
      </Field>

      <Field
        label="Reason"
        htmlFor="use-reason"
        problem={touched ? check.reasonProblem : null}
        hint={`${form.reason.trim().length} / ${CLAIM_REASON_MAX}.`}
      >
        <Textarea
          id="use-reason"
          rows={2}
          value={form.reason}
          maxLength={CLAIM_REASON_MAX + 50}
          onChange={(e) => patch({ reason: e.target.value })}
          placeholder="e.g. Family function"
          data-testid="use-reason"
        />
      </Field>

      {check.ok && (
        <Notice accent="slate" testId="use-summary">
          <p>
            {dateLong(form.date)} is topped up by {shiftsText(form.shifts)} once the Department Head approves. Until
            then it shows as waiting, and the available balance goes from {fmtShifts(target.available)} to{" "}
            {fmtShifts(Math.round((target.available - (form.shifts ?? 0)) * 100) / 100)}.
          </p>
        </Notice>
      )}
      {error && <ErrorNotice testId="use-error">{error}</ErrorNotice>}

      <DialogFooter className="gap-2">
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={use.isPending} data-testid="use-submit">
          {use.isPending && <Loader2 size={14} className="mr-2 animate-spin" />}
          Send to the Department Head
        </Button>
      </DialogFooter>
    </form>
  );
}
