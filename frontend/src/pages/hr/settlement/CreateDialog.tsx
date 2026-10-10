import { useMemo, useState } from "react";
import { AlertTriangle, CalendarClock } from "lucide-react";
import EmployeeSearchSelect from "@/components/EmployeeSearchSelect";
import type { Employee } from "@/lib/api-client";
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
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  describeSchedule,
  emptyForm,
  formPreview,
  startWarning,
  toPayload,
  validateForm,
  type AdvanceForm,
} from "./logic";
import { MONTHS, formatMoney } from "./shared";

type Props = {
  open: boolean;
  onClose: () => void;
  /** Active employees, as the employee list sends them. */
  employees: Employee[] | undefined;
  /** Sends the advance; throws with the server's message when it is refused. */
  onSubmit: (payload: ReturnType<typeof toPayload>) => Promise<void>;
};

function FieldError({ id, text }: { id: string; text?: string }) {
  if (!text) return null;
  return (
    <p id={id} role="alert" className="text-xs font-medium text-red-600">
      {text}
    </p>
  );
}

export default function CreateDialog({ open, onClose, employees, onSubmit }: Props) {
  const [form, setForm] = useState<AdvanceForm>(() => emptyForm());
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const errors = useMemo(() => validateForm(form), [form]);
  const shown = submitted ? errors : {};
  const preview = useMemo(() => formPreview(form), [form]);
  const warning = useMemo(() => startWarning(form), [form]);
  const term = form.advanceType === "term";
  const patch = (p: Partial<AdvanceForm>) => setForm((f) => ({ ...f, ...p }));

  const close = () => {
    if (busy) return;
    setForm(emptyForm());
    setSubmitted(false);
    setServerError(null);
    onClose();
  };

  const submit = async () => {
    setSubmitted(true);
    setServerError(null);
    if (Object.keys(errors).length > 0) return;
    setBusy(true);
    try {
      await onSubmit(toPayload(form));
      setForm(emptyForm());
      setSubmitted(false);
      onClose();
    } catch (err) {
      // e.g. "Advance requests are switched off right now" when HR has turned the workflow OFF (Approval Workflow Control)
      setServerError(err instanceof Error ? err.message : "The advance could not be created.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-h-[92vh] max-w-md overflow-y-auto" data-testid="create-advance-dialog">
        <DialogHeader>
          <DialogTitle>Create new advance</DialogTitle>
          <DialogDescription>
            It is created as pending. Approving it creates the repayment schedule that payroll deducts.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label>
              Employee <span className="text-red-500">*</span>
            </Label>
            <EmployeeSearchSelect
              employees={employees}
              value={form.employeeId}
              onChange={(v) => patch({ employeeId: v })}
              dataTestId="advance-employee"
            />
            <FieldError id="advance-employee-error" text={shown.employee} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="advance-type">Advance type</Label>
              <Select
                value={form.advanceType}
                onValueChange={(v) =>
                  patch({ advanceType: v as AdvanceForm["advanceType"], repaymentMonths: "", emiAmount: "" })
                }
              >
                <SelectTrigger id="advance-type" data-testid="advance-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="general">General advance</SelectItem>
                  <SelectItem value="term">Term advance (loan)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="advance-amount">
                Amount (₹) <span className="text-red-500">*</span>
              </Label>
              <Input
                id="advance-amount"
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                value={form.amount}
                onChange={(e) => patch({ amount: e.target.value })}
                placeholder="0"
                aria-invalid={!!shown.amount}
                aria-describedby={shown.amount ? "advance-amount-error" : undefined}
                data-testid="advance-amount"
              />
              <FieldError id="advance-amount-error" text={shown.amount} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="advance-purpose">Purpose</Label>
            <Input
              id="advance-purpose"
              value={form.purpose}
              onChange={(e) => patch({ purpose: e.target.value })}
              placeholder="Reason for the advance"
              data-testid="advance-purpose"
            />
          </div>

          {term && (
            <div className="space-y-3 rounded-lg border border-purple-100 bg-purple-50 p-3">
              <p className="text-xs font-semibold text-purple-700">Repayment details</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="advance-months" className="text-xs">
                    Repayment months
                  </Label>
                  <Input
                    id="advance-months"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step={1}
                    value={form.repaymentMonths}
                    onChange={(e) => patch({ repaymentMonths: e.target.value, emiAmount: "" })}
                    placeholder="e.g. 12"
                    aria-invalid={!!shown.months}
                    data-testid="advance-months"
                  />
                  <FieldError id="advance-months-error" text={shown.months} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="advance-emi" className="text-xs">
                    Monthly EMI (₹)
                  </Label>
                  <Input
                    id="advance-emi"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="any"
                    value={form.emiAmount}
                    onChange={(e) => patch({ emiAmount: e.target.value, repaymentMonths: "" })}
                    placeholder="e.g. 5000"
                    aria-invalid={!!shown.emi}
                    data-testid="advance-emi"
                  />
                  <FieldError id="advance-emi-error" text={shown.emi} />
                </div>
              </div>
              <p className="text-[11px] text-purple-700/80">Fill in one of the two; the other is worked out from it.</p>
              <FieldError id="advance-repayment-error" text={shown.repayment} />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="advance-start-month">{term ? "Start month" : "Deduction month"}</Label>
              <Select
                value={String(form.repaymentStartMonth)}
                onValueChange={(v) => patch({ repaymentStartMonth: Number(v) })}
              >
                <SelectTrigger id="advance-start-month" data-testid="advance-start-month">
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
            <div className="space-y-1.5">
              <Label htmlFor="advance-start-year">Year</Label>
              <Input
                id="advance-start-year"
                type="number"
                inputMode="numeric"
                value={form.repaymentStartYear}
                onChange={(e) => patch({ repaymentStartYear: Number(e.target.value) })}
                aria-invalid={!!shown.year}
                data-testid="advance-start-year"
              />
              <FieldError id="advance-year-error" text={shown.year} />
            </div>
          </div>

          {preview && (
            <div
              className="flex items-start gap-2 rounded-xl border border-blue-100 bg-blue-50 p-3 text-xs text-blue-800"
              data-testid="advance-preview"
            >
              <CalendarClock size={14} className="mt-0.5 shrink-0" />
              <div>
                <p className="font-semibold">Once approved, payroll will deduct</p>
                <p>{describeSchedule(preview)}</p>
                {preview.shortfall > 0 && (
                  <p className="mt-1 text-amber-700">
                    Rounding leaves {formatMoney(preview.shortfall)} of the amount off that schedule.
                  </p>
                )}
              </div>
            </div>
          )}
          {warning && (
            <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <p>{warning}</p>
            </div>
          )}
          {serverError && (
            <p
              className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs font-medium text-red-700"
              role="alert"
              data-testid="advance-server-error"
            >
              {serverError}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy} data-testid="advance-submit">
            {busy ? "Creating..." : "Create advance"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
