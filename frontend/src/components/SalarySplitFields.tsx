import { AlertTriangle, CheckCircle2, Info, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  FIRST_PORTION,
  SECOND_PORTION,
  checkSplit,
  rupees,
  toPaise,
  type PortionStatus,
  type SplitField,
  type SplitKey,
  type SplitValues,
} from "@/lib/salary-split";

type Props = {
  /** The salary amount as typed (monthly or weekly: the split works on whatever it is). */
  total: string;
  values: SplitValues;
  onChange: (key: SplitKey, value: string) => void;
  /** Recalculate all eight amounts from the salary. */
  onReset: () => void;
  /** Edit form: no split is on record for this employee yet, so the one shown is a suggestion. */
  notRecorded?: boolean;
};

function Portion({
  testId,
  title,
  fields,
  status,
  values,
  errors,
  onChange,
}: {
  testId: string;
  title: string;
  fields: SplitField[];
  status: PortionStatus | null;
  values: SplitValues;
  errors: Partial<Record<SplitKey, string>>;
  onChange: (key: SplitKey, value: string) => void;
}) {
  const sum = fields.reduce((n, f) => n + (toPaise(values[f.key]) ?? 0), 0);
  const over = status && !status.ok ? status.difference < 0 : false;
  return (
    <div
      className={cn(
        "rounded-xl border p-3.5 space-y-3",
        status && !status.ok ? "border-red-300 bg-red-50/40" : "border-border bg-muted/20",
      )}
      data-testid={testId}
    >
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">{title} · 50%</p>
        {status && (
          <p className="text-[11px] text-muted-foreground">
            Must be <b className="text-foreground">{rupees(status.required[1])}</b>
          </p>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {fields.map(({ key, label }) => (
          <div key={key} className="space-y-1">
            <Label className="text-xs" htmlFor={`split-${key}`}>
              {label} (₹)
            </Label>
            <Input
              id={`split-${key}`}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={values[key]}
              onChange={(e) => onChange(key, e.target.value)}
              aria-invalid={errors[key] ? true : undefined}
              data-testid={`split-input-${key}`}
            />
            {errors[key] && (
              <p className="text-[11px] text-red-600" role="alert">
                {errors[key]}
              </p>
            )}
          </div>
        ))}
      </div>
      <div
        className={cn(
          "flex items-center justify-between rounded-lg px-3 py-2 text-xs font-semibold",
          !status
            ? "bg-muted text-muted-foreground"
            : status.ok
              ? "bg-green-50 text-green-800"
              : "bg-red-100 text-red-800",
        )}
        data-testid={`${testId}-total`}
      >
        <span>Total</span>
        <span className="tabular-nums flex items-center gap-1.5">
          {rupees(sum)}
          {status &&
            (status.ok ? (
              <CheckCircle2 size={13} />
            ) : (
              <span className="font-medium">
                — {rupees(Math.abs(status.difference))} {over ? "over" : "short"}
              </span>
            ))}
        </span>
      </div>
    </div>
  );
}

/** The salary split: the salary divided 50% + 50% into two portions of editable amounts, kept honest live. */
export default function SalarySplitFields({ total, values, onChange, onReset, notRecorded = false }: Props) {
  const check = checkSplit(total, values);
  const haveTotal = check.totalPaise !== null && check.totalPaise > 0;
  // Until there is a usable salary there is nothing to judge: no red boxes, just the prompt.
  const fieldErrors = haveTotal ? check.fieldErrors : {};

  return (
    <div className="sm:col-span-2 space-y-3" data-testid="salary-split">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <p className="text-sm font-semibold">Salary Split · 50% + 50%</p>
          <p className="text-xs text-muted-foreground max-w-2xl">
            The salary is divided into two equal portions. The amounts are filled in for you as soon as the salary is
            entered; change any of them if you need to, but each portion must stay at exactly 50% of the salary.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={onReset}
          disabled={!haveTotal}
          data-testid="split-reset"
        >
          <RotateCcw size={13} /> Reset to automatic split
        </Button>
      </div>

      {notRecorded && (
        <div
          className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-800"
          data-testid="split-not-recorded"
        >
          <Info size={14} className="mt-0.5 shrink-0" />
          <span>
            No salary split has been recorded for this employee yet. A 50% + 50% split has been filled in from the
            current salary; review it and save to record it.
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Portion
          testId="split-first"
          title="First portion"
          fields={FIRST_PORTION}
          status={check.first}
          values={values}
          errors={fieldErrors}
          onChange={onChange}
        />
        <Portion
          testId="split-second"
          title="Second portion"
          fields={SECOND_PORTION}
          status={check.second}
          values={values}
          errors={fieldErrors}
          onChange={onChange}
        />
      </div>

      <div
        className={cn(
          "flex items-start gap-2 rounded-lg px-3 py-2 text-xs font-medium",
          !haveTotal
            ? "bg-muted text-muted-foreground"
            : check.ok
              ? "bg-green-50 text-green-800"
              : "bg-red-50 text-red-800",
        )}
        role="status"
        data-testid="split-status"
      >
        {!haveTotal ? (
          <Info size={14} className="mt-0.5 shrink-0" />
        ) : check.ok ? (
          <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
        ) : (
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        )}
        <span>
          {!haveTotal
            ? "Enter the salary amount and the split is worked out for you."
            : check.ok
              ? `The split is valid: 50% + 50% of ${rupees(check.totalPaise as number)}.`
              : check.message}
        </span>
      </div>
    </div>
  );
}
