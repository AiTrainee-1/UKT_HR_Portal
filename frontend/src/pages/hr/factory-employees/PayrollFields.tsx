import { CalendarCheck } from "lucide-react";
import SalarySplitFields from "@/components/SalarySplitFields";
import { Input } from "@/components/ui/input";
import type { FactoryPayCycle, FactoryPayrollCategory } from "@/lib/api-client/custom-hooks";
import { EMPTY_SPLIT, defaultSplit, type SplitKey } from "@/lib/salary-split";
import { cn } from "@/lib/utils";
import { CATEGORY_LABEL, PAY_CYCLE_LABEL, PAY_CYCLE_LIST, type PayrollField, type PayrollForm } from "./logic";
import { ChoiceCards, Field } from "./parts";

const CYCLE_SUB: Record<FactoryPayCycle, string> = {
  weekly: "Paid every week",
  biweekly: "Paid every two weeks",
  monthly: "Paid every four weeks",
};

/**
 * The payroll of a factory employee: Staff Payroll (always Monthly, a monthly salary with its 50% + 50% split) or
 * Production Payroll (a salary per shift, paid on the frequency chosen here: Weekly, BiWeekly or Monthly, which is
 * required). The same block in the create dialog, the edit sheet and Set payroll.
 */
export function PayrollFields({
  form,
  onChange,
  problems,
  testId,
  withSplit = true,
  notRecorded = false,
  amountOptional = false,
  autoFocusAmount = false,
}: {
  form: PayrollForm;
  onChange: (patch: Partial<PayrollForm>) => void;
  problems: Partial<Record<PayrollField, string>>;
  testId: string;
  withSplit?: boolean;
  /** Edit: no split on record yet (the one shown is a suggestion). */
  notRecorded?: boolean;
  /** Set payroll for many: the amount may be left blank to keep each person's own. */
  amountOptional?: boolean;
  autoFocusAmount?: boolean;
}) {
  const production = form.category === "production";
  const setSalary = (amount: string) => onChange({ salaryAmount: amount, split: defaultSplit(amount) ?? EMPTY_SPLIT });
  const setSplit = (key: SplitKey, value: string) => onChange({ split: { ...form.split, [key]: value } });

  return (
    <div className="space-y-4" data-testid={testId}>
      <Field label="Payroll category" required>
        <ChoiceCards<FactoryPayrollCategory>
          value={form.category}
          onChange={(category) => category !== form.category && onChange({ category, payCycle: "" })}
          testId={`${testId}-category`}
          options={[
            { value: "staff", label: CATEGORY_LABEL.staff, sub: "A monthly salary, paid in Staff Payroll" },
            {
              value: "production",
              label: CATEGORY_LABEL.production,
              sub: "Paid per shift, on a Weekly, BiWeekly or Monthly cycle",
            },
          ]}
        />
      </Field>

      <Field label="Frequency" required={production} error={problems.payCycle}>
        {production ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Frequency">
            {PAY_CYCLE_LIST.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={form.payCycle === c}
                onClick={() => onChange({ payCycle: c })}
                data-testid={`${testId}-cycle-${c}`}
                className={cn(
                  "rounded-xl border p-3 text-left transition-all",
                  form.payCycle === c
                    ? "border-amber-500 bg-amber-50 ring-1 ring-amber-300"
                    : problems.payCycle
                      ? "border-red-300 bg-white hover:border-red-400"
                      : "border-gray-200 bg-white hover:border-gray-300",
                )}
              >
                <span className="block text-sm font-semibold text-gray-900">{PAY_CYCLE_LABEL[c]}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{CYCLE_SUB[c]}</span>
              </button>
            ))}
          </div>
        ) : (
          <p
            className="flex items-center gap-2 rounded-xl border border-blue-100 bg-blue-50 px-3 py-2.5 text-sm text-blue-900"
            data-testid={`${testId}-cycle-fixed`}
          >
            <CalendarCheck size={15} className="shrink-0" />
            <span>
              <b>Monthly</b> · Staff Payroll is always paid monthly.
            </span>
          </p>
        )}
        {production && (
          <p className="text-xs text-muted-foreground">
            They are paid on that frequency&apos;s Production Payroll page. Until one is chosen they are in no payroll.
          </p>
        )}
      </Field>

      {production ? (
        <Field
          label="Salary per shift (₹)"
          htmlFor={`${testId}-rate`}
          required={!amountOptional}
          error={problems.salaryPerShift}
          hint={
            amountOptional ? "Leave blank to keep each person's own rate." : "Pay = shifts worked × salary per shift."
          }
        >
          <Input
            id={`${testId}-rate`}
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            value={form.salaryPerShift}
            onChange={(e) => onChange({ salaryPerShift: e.target.value })}
            autoFocus={autoFocusAmount}
            className="max-w-xs"
            data-testid={`${testId}-rate`}
          />
        </Field>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label="Monthly salary (₹)"
            htmlFor={`${testId}-salary`}
            required={!amountOptional}
            error={problems.salaryAmount}
            hint={
              amountOptional
                ? "Leave blank to keep each person's own salary. A new one is split 50% + 50% automatically."
                : undefined
            }
            className="sm:col-span-2"
          >
            <Input
              id={`${testId}-salary`}
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              value={form.salaryAmount}
              onChange={(e) => setSalary(e.target.value)}
              autoFocus={autoFocusAmount}
              className="max-w-xs"
              data-testid={`${testId}-salary`}
            />
          </Field>
          {withSplit && (
            <SalarySplitFields
              total={form.salaryAmount}
              values={form.split}
              onChange={setSplit}
              onReset={() => setSalary(form.salaryAmount)}
              notRecorded={notRecorded}
            />
          )}
          {withSplit && problems.split && (
            <p className="text-xs font-medium text-red-600 sm:col-span-2" role="alert">
              {problems.split}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
