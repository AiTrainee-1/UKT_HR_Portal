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
import { useToast } from "@/hooks/use-toast";
import { useRedeemBalance, type ShiftsValue } from "@/lib/api-client/custom-hooks";
import { errorMessage, fmtShifts, shiftsText } from "../logic";
import { ErrorNotice, Field, Notice, ShiftsPicker, useSingleFlight } from "../ui";
import { checkRedeem, redeemSummary, type RedeemForm } from "./leave-logic";

export type RedeemTarget = { employeeId: number; employeeName: string; employeeCode: string; balance: number };

/**
 * Redeem: HR takes part of an employee's compensation balance as a day off on a date (employees never redeem themselves).
 * The shifts cannot be more than the balance, and the server refuses a day that cannot take them (a Sunday, a holiday, a
 * day already fully paid): its sentence is shown as it is.
 */
export function RedeemDialog({
  target,
  onOpenChange,
}: {
  /** The employee to redeem for; the dialog is open while this is set. */
  target: RedeemTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent data-testid="redeem-dialog">
        {target && <RedeemForm key={target.employeeId} target={target} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function RedeemForm({ target, onClose }: { target: RedeemTarget; onClose: () => void }) {
  const { toast } = useToast();
  const redeem = useRedeemBalance();
  const [form, setForm] = useState<RedeemForm>({ date: "", shifts: null });
  const [error, setError] = useState<string | null>(null);
  const check = useMemo(() => checkRedeem(form, target.balance), [form, target.balance]);

  const once = useSingleFlight();
  const submit = () =>
    once(async () => {
      if (!check.ok || redeem.isPending) return;
      setError(null);
      try {
        const res = await redeem.mutateAsync({
          employeeId: target.employeeId,
          date: form.date,
          shifts: form.shifts as ShiftsValue,
        });
        toast({
          title: "Day off recorded",
          description: `${target.employeeName}: ${shiftsText(form.shifts)} redeemed. The balance is now ${fmtShifts(res.balance)}.`,
        });
        onClose();
      } catch (err) {
        setError(errorMessage(err, "The balance could not be redeemed. Check the connection and try again."));
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
        <DialogTitle>Redeem the balance of {target.employeeName}</DialogTitle>
        <DialogDescription>
          <span className="font-mono">{target.employeeCode}</span> has{" "}
          <strong data-testid="redeem-balance">{shiftsText(target.balance)}</strong> to take. Choose the day and how
          much of it is taken.
        </DialogDescription>
      </DialogHeader>

      <Field
        label="Day off on"
        htmlFor="redeem-date"
        problem={form.date ? check.dateProblem : null}
        hint="The day is topped up by the shifts: never above 1 shift in a day, and not on a Sunday or a company holiday."
      >
        <Input
          id="redeem-date"
          type="date"
          value={form.date}
          onChange={(e) => {
            setForm((f) => ({ ...f, date: e.target.value }));
            setError(null);
          }}
          data-testid="redeem-date"
        />
      </Field>

      <Field label="Shifts to redeem" problem={form.shifts !== null ? check.shiftsProblem : null}>
        <ShiftsPicker
          value={form.shifts}
          max={target.balance}
          label={`Shifts to redeem for ${target.employeeName}`}
          onChange={(shifts) => {
            setForm((f) => ({ ...f, shifts }));
            setError(null);
          }}
          testId="redeem-shifts"
        />
      </Field>

      {form.shifts !== null && check.ok && (
        <Notice accent="slate" testId="redeem-summary">
          <p>{redeemSummary(form, target.balance)}</p>
        </Notice>
      )}
      {error && <ErrorNotice testId="redeem-error">{error}</ErrorNotice>}

      <DialogFooter className="gap-2">
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={!check.ok || redeem.isPending}
          title={check.ok ? undefined : "Choose the day and the shifts first"}
          data-testid="redeem-submit"
        >
          {redeem.isPending && <Loader2 size={14} className="mr-2 animate-spin" />}
          Redeem and save
        </Button>
      </DialogFooter>
    </form>
  );
}
