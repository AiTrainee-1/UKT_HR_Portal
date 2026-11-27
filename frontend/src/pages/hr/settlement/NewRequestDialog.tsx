import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Banknote,
  CalendarClock,
  CheckCircle2,
  CircleSlash,
  Clock,
  Landmark,
  ListChecks,
  UserRound,
  Wallet,
} from "lucide-react";
import EmployeeSearchSelect from "@/components/EmployeeSearchSelect";
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
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  getAdvanceEligibilityQueryKey,
  useAdvanceEligibility,
  useCreateAdvance,
  useListEmployeesLite,
  type Advance,
  type AdvanceEligibility,
} from "@/lib/api-client";
import { refreshSettlementWorkflow, useSettlementMethod } from "@/lib/api-client/custom-hooks/settlement-automation";
import { cn } from "@/lib/utils";
import { TYPE_LABEL, earnedPeriodLabel, workingDaysText } from "./logic";
import {
  PURPOSE_MAX,
  STALE_ELIGIBILITY_CODES,
  aboveLimit,
  emptyRequestForm,
  limitText,
  requestPayload,
  requestRefusal,
  requestSchedule,
  typeEligibility,
  validateRequest,
  type RequestErrors,
  type RequestForm,
  type RequestRefusal,
  type RequestType,
} from "./new-request";
import { ABSOLUTE_MAX_MONTHS } from "./rules";
import { MONTH_FULL, formatDate, formatMoney } from "./shared";

type Props = {
  open: boolean;
  onClose: () => void;
  /** A type page's own type (fixed); null on the Overview, where HR picks the type. */
  fixedType: RequestType | null;
  /** The request the server created (the page may show it). */
  onCreated?: (created: Advance) => void;
};

const TYPE_ICON: Record<RequestType, typeof Banknote> = { general: Banknote, term: Landmark };

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

/** Who the request is for, as the server knows them. */
function EmployeeLine({ e }: { e: AdvanceEligibility["employee"] }) {
  const kind = e.type === "production" ? "Production" : e.type === "staff" ? "Staff" : null;
  return (
    <p
      className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600"
      data-testid="new-request-employee"
    >
      <UserRound size={13} className="shrink-0 text-slate-400" aria-hidden />
      <b className="text-slate-900">
        {e.code} · {e.name}
      </b>
      {[e.department, e.branch, kind, e.joinDate ? `joined ${formatDate(e.joinDate)}` : null]
        .filter(Boolean)
        .map((part) => (
          <span key={part}>· {part}</span>
        ))}
    </p>
  );
}

/** The Overview's type choice: both types with whether the employee may apply for each now. A choice, not a tab row. */
function TypeChoice({
  e,
  value,
  onChange,
}: {
  e: AdvanceEligibility;
  value: RequestType;
  onChange: (next: RequestType) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label id="new-request-type-label">
        Type <span className="text-red-500">*</span>
      </Label>
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-labelledby="new-request-type-label">
        {(["general", "term"] as const).map((type) => {
          const on = value === type;
          const ok = typeEligibility(e, type).canApply;
          const Icon = TYPE_ICON[type];
          return (
            <button
              key={type}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(type)}
              className={cn(
                "flex flex-col items-start gap-1 rounded-xl border p-2.5 text-left transition-colors",
                on ? "border-indigo-500 bg-indigo-50 ring-2 ring-indigo-100" : "border-slate-200 hover:bg-slate-50",
              )}
              data-testid={`new-request-type-${type}`}
            >
              <span className="flex items-center gap-1.5 text-sm font-bold text-slate-900">
                <Icon size={14} aria-hidden /> {TYPE_LABEL[type]}
              </span>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[10.5px] font-bold",
                  ok ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800",
                )}
              >
                {ok ? "Can apply now" : "Cannot apply now"}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** What the employee app would tell this employee about the chosen type: the window, the 1st-20th earned figures and the
 *  limit (Salary Advance), the 6 months of service (Term Loan), and why it cannot be sent now. */
function EligibilityPanel({ e, type }: { e: AdvanceEligibility; type: RequestType }) {
  const { canApply, reason } = typeEligibility(e, type);
  const sa = e.salaryAdvance;
  const tl = e.termLoan;
  const earned = sa.earned;
  return (
    <div className="space-y-2" data-testid="new-request-eligibility">
      {!canApply && (
        <div
          className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"
          role="status"
          data-testid="new-request-blocked"
        >
          <CircleSlash size={14} className="mt-0.5 shrink-0" aria-hidden />
          <div className="space-y-0.5">
            <p className="font-semibold">A {TYPE_LABEL[type]} cannot be raised for this employee now</p>
            <p>{reason}</p>
          </div>
        </div>
      )}

      {type === "general" ? (
        <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs">
          <p className="flex items-start gap-1.5 text-slate-700" data-testid="new-request-window">
            <Clock size={13} className="mt-0.5 shrink-0" aria-hidden />
            <span>
              <b className={e.window.isOpen ? "text-emerald-700" : "text-amber-800"}>
                {e.window.isOpen ? "Window open" : "Window closed"}
              </b>{" "}
              · {e.window.message}
            </span>
          </p>
          {earned ? (
            <>
              <p className="flex items-center gap-1.5 font-semibold text-slate-700">
                <Wallet size={13} className="shrink-0" aria-hidden />
                Earned in {earnedPeriodLabel(earned)}
                {earned.final === false && <span className="font-normal text-slate-500">(so far)</span>}
              </p>
              <dl className="space-y-1" data-testid="new-request-earned">
                <Figure
                  label="Fixed salary"
                  value={formatMoney(earned.fixedSalary)}
                  testId="new-request-earned-fixed"
                />
                <Figure label="Working days" value={workingDaysText(earned)} testId="new-request-earned-days" />
                <Figure
                  label="Earned salary"
                  value={formatMoney(earned.earnedAmount)}
                  testId="new-request-earned-amount"
                />
                <Figure
                  label={`Limit (${sa.percent}% of earned salary)`}
                  value={formatMoney(sa.limit)}
                  testId="new-request-limit"
                />
              </dl>
            </>
          ) : (
            <p className="text-slate-600" data-testid="new-request-no-earned">
              No earned-salary figures to take a limit from right now.
            </p>
          )}
          <p className="flex items-start gap-1.5 text-slate-600">
            <CalendarClock size={13} className="mt-0.5 shrink-0" aria-hidden />
            Deducted once, in full, from the {sa.deductionLabel} salary.
            {sa.rules
              ? ` ${sa.rules.perMonth === 1 ? "One Salary Advance" : `Up to ${sa.rules.perMonth} Salary Advances`} a month.`
              : ""}
          </p>
        </div>
      ) : (
        <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs">
          {tl.code === "staff_only" && (
            <p className="font-semibold text-slate-700" data-testid="new-request-staff-only">
              Term Loans are for staff employees only.
            </p>
          )}
          {tl.limit != null && (
            <dl className="space-y-1" data-testid="new-request-term-figures">
              <Figure
                label="Fixed monthly salary"
                value={formatMoney(tl.monthlySalary ?? e.monthlySalary)}
                testId="new-request-term-salary"
              />
              <Figure
                label={`Eligible limit${tl.limitPercent != null ? ` (${tl.limitPercent}% of the salary)` : ""}`}
                value={formatMoney(tl.limit)}
                testId="new-request-term-limit"
              />
              {tl.perYear != null && (
                <Figure
                  label="Approved this year"
                  value={`${tl.approvedThisYear ?? 0} of ${tl.perYear}`}
                  testId="new-request-term-year"
                />
              )}
            </dl>
          )}
          {tl.open && (
            <p className="text-slate-700" data-testid="new-request-term-open">
              {tl.open.status === "pending" ? "Waiting for a decision" : "Being repaid"}: a Term Loan of{" "}
              {formatMoney(tl.open.amount)}.
            </p>
          )}
          {tl.rejectedThisMonth && (
            <p className="text-slate-700" data-testid="new-request-term-rejected">
              A Term Loan of this employee was rejected this month: a new one can be asked for from the next month.
            </p>
          )}
          {!tl.canApply && tl.nextEligibleOn && (
            <p className="font-semibold text-amber-900" data-testid="new-request-next">
              Can apply again from {formatDate(tl.nextEligibleOn)}.
            </p>
          )}
          {tl.service.eligible ? (
            <p className="flex items-start gap-1.5 text-emerald-800" data-testid="new-request-service">
              <CheckCircle2 size={13} className="mt-0.5 shrink-0" aria-hidden />
              <span>
                {tl.service.serviceMonths ?? tl.service.requiredMonths} months of service ({tl.service.requiredMonths}{" "}
                needed){tl.service.joinDate ? `, joined ${formatDate(tl.service.joinDate)}` : ""}.
              </span>
            </p>
          ) : (
            <p className="flex items-start gap-1.5 text-amber-900" data-testid="new-request-service">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden />
              <span>
                <b>Less than {tl.service.requiredMonths} months of service.</b>{" "}
                {tl.service.reason ??
                  (tl.service.eligibleFrom
                    ? `A Term Loan is possible from ${formatDate(tl.service.eligibleFrom)}.`
                    : "")}
              </span>
            </p>
          )}
          <p className="flex items-start gap-1.5 text-slate-600">
            <CalendarClock size={13} className="mt-0.5 shrink-0" aria-hidden />
            From {formatMoney(tl.minAmount)}, repaid in {tl.minMonths} to {tl.maxMonths} monthly EMIs from the{" "}
            {tl.firstDeductionLabel} salary. Open on any day.
          </p>
        </div>
      )}

      {e.rules.length > 0 && (
        <details className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
          <summary className="flex cursor-pointer items-center gap-1.5 font-semibold text-slate-700">
            <ListChecks size={13} aria-hidden /> The rules (as the employee app shows them)
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-5" data-testid="new-request-rules">
            {e.rules.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/**
 * New request (owner 2026-11-27): HR raises a Salary Advance or Term Loan request on an employee's behalf under exactly
 * the employee apps' rules. Choosing the employee reads their eligibility (the employee app's own): what can be sent now
 * and why not, the 1st-20th earned figures and the Salary Advance limit, the Term Loan's 6 months of service. A type the
 * employee cannot apply for now cannot be sent; an amount above the limit is blocked here; the server's own refusal is
 * shown beside its field. Created, it waits for approval (Normal Method) or joins its type's open batch (Automation).
 */
export default function NewRequestDialog({ open, onClose, fixedType, onCreated }: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<RequestForm>(() => emptyRequestForm(fixedType ?? "general"));
  const [submitted, setSubmitted] = useState(false);
  const [refusal, setRefusal] = useState<RequestRefusal | null>(null);
  const create = useCreateAdvance();
  const busy = create.isPending;
  const { data: method } = useSettlementMethod();

  const { data: employees } = useListEmployeesLite({ status: "active" }, { enabled: open });
  const employeeId = Number(form.employeeId) || null;
  const eligibility = useAdvanceEligibility(open ? employeeId : null);
  const e = employeeId ? eligibility.data : undefined;
  const type = fixedType ?? form.advanceType;
  const current = useMemo(() => ({ ...form, advanceType: type }), [form, type]);
  const allowed = e ? typeEligibility(e, type) : null;

  // every opening starts on a blank form of the page's type
  useEffect(() => {
    if (open) {
      setForm(emptyRequestForm(fixedType ?? "general"));
      setSubmitted(false);
      setRefusal(null);
    }
  }, [open, fixedType]);

  const errors: RequestErrors = useMemo(() => validateRequest(current, e), [current, e]);
  // the limit is shown as it is typed (an amount above it is never sent); the rest once Raise is pressed
  const shown: RequestErrors = submitted
    ? errors
    : aboveLimit(current, e) && errors.amount
      ? { amount: errors.amount }
      : {};
  const fieldError = (field: keyof RequestErrors) =>
    shown[field] ?? (refusal?.field === field ? refusal.text : undefined);
  const schedule = useMemo(() => requestSchedule(current, e), [current, e]);
  const patch = (p: Partial<RequestForm>) => {
    setForm((f) => ({ ...f, ...p }));
    setRefusal(null);
  };

  const close = () => {
    if (busy) return;
    onClose();
  };

  const canSend = !!e && !!allowed?.canApply && !busy;
  const submit = async () => {
    setSubmitted(true);
    setRefusal(null);
    if (!e || !allowed?.canApply || Object.keys(errors).length > 0) return;
    try {
      const created = await create.mutateAsync(requestPayload(current));
      void queryClient.invalidateQueries({ queryKey: ["/api/advances"] });
      void queryClient.invalidateQueries({ queryKey: getAdvanceEligibilityQueryKey(e.employee.id) });
      refreshSettlementWorkflow(queryClient);
      const month = MONTH_FULL[Number(e.today.slice(5, 7)) - 1] ?? "this month";
      toast({
        title: `${TYPE_LABEL[type]} request raised`,
        description: `${e.employee.name}: ${formatMoney(current.amount === "" ? 0 : Number(current.amount))}. ${
          method?.method === "automation"
            ? `It joins ${month}'s open ${TYPE_LABEL[type]} batch.`
            : "It is waiting for approval."
        }`,
      });
      onCreated?.(created);
      onClose();
    } catch (err) {
      const said = requestRefusal(err);
      setRefusal(said);
      // the day, or another request, changed what the employee may apply for: read it again
      if (said.code && STALE_ELIGIBILITY_CODES.has(said.code)) void eligibility.refetch();
    }
  };

  const title = fixedType ? `New ${TYPE_LABEL[fixedType]} request` : "New request";
  const disabled = !e || !allowed?.canApply;
  const term = type === "term";

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-h-[92vh] max-w-lg overflow-y-auto" data-testid="new-request-dialog">
        <DialogHeader>
          <DialogTitle data-testid="new-request-title">{title}</DialogTitle>
          <DialogDescription>
            Raised on the employee&apos;s behalf under the same rules as the employee app, then decided in the same
            approval workflow.
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
              dataTestId="new-request-employee-select"
            />
            <FieldError id="new-request-employee-error" text={fieldError("employee")} />
          </div>

          {employeeId &&
            (eligibility.isLoading ? (
              <p
                className="rounded-xl border bg-slate-50 p-3 text-xs text-slate-500"
                data-testid="new-request-eligibility-loading"
              >
                Checking what this employee can apply for…
              </p>
            ) : eligibility.isError || !e ? (
              <div
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800"
                role="alert"
                data-testid="new-request-eligibility-error"
              >
                <span>What this employee can apply for could not be loaded, so nothing can be sent yet.</span>
                <Button size="sm" variant="outline" className="h-7" onClick={() => void eligibility.refetch()}>
                  Retry
                </Button>
              </div>
            ) : (
              <>
                <EmployeeLine e={e.employee} />
                {!fixedType && <TypeChoice e={e} value={type} onChange={(next) => patch({ advanceType: next })} />}
                <EligibilityPanel e={e} type={type} />
              </>
            ))}

          <div className={cn("space-y-4", disabled && "opacity-60")}>
            <div className={cn("grid gap-3", term ? "grid-cols-2" : "grid-cols-1")}>
              <div className="space-y-1.5">
                <Label htmlFor="new-request-amount">
                  Amount (₹) <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="new-request-amount"
                  type="number"
                  inputMode="numeric"
                  min={term ? (e?.termLoan.minAmount ?? 1) : 1}
                  max={term ? e?.termLoan.maxAmount : (e?.salaryAdvance.limit ?? undefined)}
                  step={1}
                  value={form.amount}
                  onChange={(ev) => patch({ amount: ev.target.value })}
                  placeholder={
                    term
                      ? e?.termLoan.limit != null
                        ? `${formatMoney(e.termLoan.minAmount)} to ${formatMoney(e.termLoan.limit)}`
                        : e
                          ? `From ${formatMoney(e.termLoan.minAmount)}`
                          : "0"
                      : e?.salaryAdvance.limit != null
                        ? `Up to ${formatMoney(e.salaryAdvance.limit)}`
                        : "0"
                  }
                  disabled={disabled}
                  aria-invalid={!!fieldError("amount")}
                  aria-describedby={fieldError("amount") ? "new-request-amount-error" : undefined}
                  data-testid="new-request-amount"
                />
                <FieldError id="new-request-amount-error" text={fieldError("amount")} />
                {!term && e && e.salaryAdvance.limit != null && !fieldError("amount") && (
                  <p className="text-[11px] text-slate-500" data-testid="new-request-limit-hint">
                    {limitText(e)}
                  </p>
                )}
              </div>
              {term && (
                <div className="space-y-1.5">
                  <Label htmlFor="new-request-months">
                    Months to repay <span className="text-red-500">*</span>
                  </Label>
                  <Input
                    id="new-request-months"
                    type="number"
                    inputMode="numeric"
                    min={e?.termLoan.minMonths ?? 1}
                    max={e?.termLoan.maxMonths ?? ABSOLUTE_MAX_MONTHS}
                    step={1}
                    value={form.months}
                    onChange={(ev) => patch({ months: ev.target.value })}
                    placeholder={`${e?.termLoan.minMonths ?? 1} to ${e?.termLoan.maxMonths ?? ABSOLUTE_MAX_MONTHS}`}
                    disabled={disabled}
                    aria-invalid={!!fieldError("months")}
                    aria-describedby={fieldError("months") ? "new-request-months-error" : undefined}
                    data-testid="new-request-months"
                  />
                  <FieldError id="new-request-months-error" text={fieldError("months")} />
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="new-request-purpose">
                Purpose <span className="text-red-500">*</span>
              </Label>
              <Textarea
                id="new-request-purpose"
                rows={2}
                maxLength={PURPOSE_MAX}
                value={form.purpose}
                onChange={(ev) => patch({ purpose: ev.target.value })}
                placeholder="What the money is for, e.g. Medical expenses"
                disabled={disabled}
                aria-invalid={!!fieldError("purpose")}
                aria-describedby={fieldError("purpose") ? "new-request-purpose-error" : undefined}
                data-testid="new-request-purpose"
              />
              <FieldError id="new-request-purpose-error" text={fieldError("purpose")} />
            </div>

            {schedule && !disabled && (
              <p
                className="flex items-start gap-2 rounded-xl border border-blue-100 bg-blue-50 p-3 text-xs text-blue-800"
                data-testid="new-request-schedule"
              >
                <CalendarClock size={14} className="mt-0.5 shrink-0" aria-hidden />
                <span>
                  <b>Once approved as asked:</b> {schedule}
                </span>
              </p>
            )}
          </div>

          {refusal && (!refusal.field || refusal.field === "type") && (
            <div
              className="space-y-0.5 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700"
              role="alert"
              data-testid="new-request-server-error"
              data-code={refusal.code ?? undefined}
            >
              {refusal.title && <p className="font-semibold">{refusal.title}</p>}
              <p>{refusal.text}</p>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!canSend} data-testid="new-request-submit">
            {busy ? "Raising…" : `Raise ${TYPE_LABEL[type]} request`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
