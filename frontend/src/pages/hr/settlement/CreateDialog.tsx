import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CalendarClock, CheckCircle2, Wallet } from "lucide-react";
import EmployeeSearchSelect from "@/components/EmployeeSearchSelect";
import { useAdvanceEarnings, type AdvanceEarningsPreview, type Employee } from "@/lib/api-client";
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
import { Textarea } from "@/components/ui/textarea";
import {
  REMARK_MAX,
  TYPE_LABEL,
  describeSchedule,
  earnedPeriodLabel,
  emptyForm,
  formLimit,
  formOverLimit,
  formPreview,
  formatDays,
  overLimitBy,
  overLimitRefusal,
  serverError,
  startWarning,
  toPayload,
  validateForm,
  type AdvanceForm,
} from "./logic";
import { MONTHS, formatDate, formatMoney } from "./shared";

type Props = {
  open: boolean;
  onClose: () => void;
  /** Active employees, as the employee list sends them. */
  employees: Employee[] | undefined;
  /** Sends the advance; throws with the server's message when it is refused. */
  onSubmit: (payload: ReturnType<typeof toPayload>) => Promise<void>;
  /** The kind the form opens on: the Term Loan tab opens it on a term loan, the others on a salary advance. */
  defaultType?: AdvanceForm["advanceType"];
};

function FieldError({ id, text }: { id: string; text?: string }) {
  if (!text) return null;
  return (
    <p id={id} role="alert" className="text-xs font-medium text-red-600">
      {text}
    </p>
  );
}

function Figure({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right font-semibold text-slate-800" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

/** What the chosen employee earned this month from the 1st to the 20th, the Salary Advance limit, and for a Term Loan the
 *  6-month service check. Information only: HR may still record either. */
function EarningsPanel({
  data,
  loading,
  failed,
  term,
}: {
  data: AdvanceEarningsPreview | undefined;
  loading: boolean;
  failed: boolean;
  term: boolean;
}) {
  if (loading) {
    return (
      <p className="rounded-xl border bg-slate-50 p-3 text-xs text-slate-500" data-testid="advance-earnings-loading">
        Working out the salary earned this month...
      </p>
    );
  }
  if (failed || !data) {
    return (
      <p className="rounded-xl border bg-slate-50 p-3 text-xs text-slate-500" data-testid="advance-earnings-error">
        The salary earned this month could not be loaded. The server still checks the limit when you create it.
      </p>
    );
  }
  const e = data.earnings;
  const service = data.termLoanService;
  return (
    <div className="space-y-2">
      <div
        className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs"
        data-testid="advance-earnings"
      >
        <p className="flex items-center gap-1.5 font-semibold text-slate-700">
          <Wallet size={13} className="shrink-0" />
          Earned in {earnedPeriodLabel(e ?? data)}
        </p>
        {e ? (
          <dl className="space-y-1">
            <Figure label="Fixed salary" value={formatMoney(e.fixedSalary)} testId="advance-earned-fixed" />
            <Figure label="Working days" value={formatDays(e.workingDays)} testId="advance-earned-days" />
            <Figure label="Earned salary" value={formatMoney(e.earnedAmount)} testId="advance-earned-amount" />
            {!term && (
              <Figure
                label={`Limit (${e.percent}% of earned salary)`}
                value={formatMoney(e.limit)}
                testId="advance-limit"
              />
            )}
          </dl>
        ) : (
          <p className="text-slate-600" data-testid="advance-no-salary">
            {data.noSalaryReason ?? "There are no salary figures for this employee."}
            {!term && " No limit applies."}
          </p>
        )}
      </div>
      {term &&
        (service.eligible ? (
          <p
            className="flex items-start gap-1.5 rounded-xl border border-green-200 bg-green-50 p-3 text-xs text-green-800"
            data-testid="advance-service-ok"
          >
            <CheckCircle2 size={13} className="mt-0.5 shrink-0" />
            {service.serviceMonths ?? service.requiredMonths} months of service: a Term Loan is allowed (
            {service.requiredMonths} needed).
          </p>
        ) : (
          <div
            className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"
            role="status"
            data-testid="advance-service-warning"
          >
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <div className="space-y-0.5">
              <p className="font-semibold">Less than {service.requiredMonths} months of service</p>
              <p>
                {service.reason ??
                  `A Term Loan needs ${service.requiredMonths} months of service${
                    service.eligibleFrom ? `, from ${formatDate(service.eligibleFrom)}` : ""
                  }.`}
              </p>
              <p>You can still record it.</p>
            </div>
          </div>
        ))}
    </div>
  );
}

export default function CreateDialog({ open, onClose, employees, onSubmit, defaultType = "general" }: Props) {
  const [form, setForm] = useState<AdvanceForm>(() => emptyForm(new Date(), defaultType));
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverProblem, setServerProblem] = useState<string | null>(null);
  // the limit the server named when it refused the amount (400 over_limit): used when the preview could not say
  const [serverLimit, setServerLimit] = useState<number | null>(null);

  const employeeId = Number(form.employeeId) || null;
  const earnings = useAdvanceEarnings(open ? employeeId : null);
  const term = form.advanceType === "term";
  const limit = term || !employeeId ? null : formLimit(earnings.data, serverLimit);
  const over = formOverLimit(form, limit);
  const overBy = over ? overLimitBy(Number(form.amount), limit) : 0;

  const errors = useMemo(() => validateForm(form, limit), [form, limit]);
  const shown = submitted ? errors : {};
  const preview = useMemo(() => formPreview(form), [form]);
  const warning = useMemo(() => startWarning(form), [form]);
  const patch = (p: Partial<AdvanceForm>) => setForm((f) => ({ ...f, ...p }));

  // every opening starts on a blank form of the tab's kind
  useEffect(() => {
    if (open) {
      setForm(emptyForm(new Date(), defaultType));
      setServerLimit(null);
    }
  }, [open, defaultType]);

  const close = () => {
    if (busy) return;
    setForm(emptyForm(new Date(), defaultType));
    setSubmitted(false);
    setServerProblem(null);
    setServerLimit(null);
    onClose();
  };

  const submit = async () => {
    setSubmitted(true);
    setServerProblem(null);
    if (Object.keys(errors).length > 0) return;
    setBusy(true);
    try {
      await onSubmit(toPayload(form));
      setForm(emptyForm(new Date(), defaultType));
      setSubmitted(false);
      setServerLimit(null);
      onClose();
    } catch (err) {
      // e.g. "Advance requests are switched off right now" (Approval Workflow Control), or a Salary Advance above the
      // earned limit without a reason: the reason field then shows, with the server's own words
      const refusedLimit = overLimitRefusal(err);
      if (refusedLimit != null) setServerLimit(refusedLimit);
      setServerProblem(serverError(err, "The advance could not be created.").text);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-h-[92vh] max-w-md overflow-y-auto" data-testid="create-advance-dialog">
        <DialogHeader>
          <DialogTitle data-testid="create-advance-title">New {TYPE_LABEL[form.advanceType]}</DialogTitle>
          <DialogDescription>
            A Salary Advance is deducted once and is at most 50% of the salary earned from the 1st to the 20th; a Term
            Loan is repaid in monthly EMIs. It is created as pending, and approving it creates the schedule payroll
            deducts.
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
              onChange={(v) => {
                patch({ employeeId: v });
                setServerLimit(null);
              }}
              dataTestId="advance-employee"
            />
            <FieldError id="advance-employee-error" text={shown.employee} />
          </div>

          {employeeId && (
            <EarningsPanel data={earnings.data} loading={earnings.isLoading} failed={earnings.isError} term={term} />
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="advance-type">Type</Label>
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
                  <SelectItem value="general">Salary Advance (deducted once)</SelectItem>
                  <SelectItem value="term">Term Loan (monthly EMIs)</SelectItem>
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

          {over && (
            <div
              className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3"
              data-testid="advance-over-limit"
            >
              <p className="flex items-start gap-1.5 text-xs font-medium text-amber-900">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                {formatMoney(overBy)} above the {formatMoney(limit)} Salary Advance limit. You can record it with a
                reason.
              </p>
              <div className="space-y-1">
                <Label htmlFor="advance-limit-remark" className="text-xs">
                  Reason for going over the limit <span className="text-red-500">*</span>
                </Label>
                <Textarea
                  id="advance-limit-remark"
                  rows={2}
                  maxLength={REMARK_MAX}
                  value={form.limitRemark}
                  onChange={(e) => patch({ limitRemark: e.target.value })}
                  placeholder="e.g. Medical emergency, approved by the MD"
                  aria-invalid={!!shown.limitRemark}
                  aria-describedby={shown.limitRemark ? "advance-limit-remark-error" : undefined}
                  className="bg-white"
                  data-testid="advance-limit-remark"
                />
                <FieldError id="advance-limit-remark-error" text={shown.limitRemark} />
              </div>
            </div>
          )}

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
          {serverProblem && (
            <p
              className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs font-medium text-red-700"
              role="alert"
              data-testid="advance-server-error"
            >
              {serverProblem}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy} data-testid="advance-submit">
            {busy ? "Creating..." : `Create ${TYPE_LABEL[form.advanceType]}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
