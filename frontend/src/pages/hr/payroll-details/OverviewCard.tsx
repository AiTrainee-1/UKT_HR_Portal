import { Calculator } from "lucide-react";
import { PayStatusChip, SectionCard } from "@/components/payroll/kit/parts";
import { dateTime, inr, inr2 } from "@/components/payroll/kit/format";
import type { MoneyLine, PayrollDetails, PayrollKind } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import type { Accent } from "./accent";
import { sectionDomId, summaryNumber, trimNumber } from "./logic";

type Step = { label: string; value: string } | { op: string };

/** The arithmetic behind the gross, in the order it is done: salary / working days x paid days, or shifts x rate. */
function formulaSteps(details: PayrollDetails, kind: PayrollKind): Step[] {
  const { money, summary } = details;
  if (kind === "production") {
    const shifts = summaryNumber(summary, "totalShifts");
    const rate = details.employee.salaryPerShift;
    if (shifts === null || !rate) return [];
    return [
      { label: "Shifts earned", value: trimNumber(shifts) },
      { op: "×" },
      { label: "Rate per shift", value: inr(rate) },
      { op: "=" },
      { label: "Gross", value: inr2(money.gross) },
    ];
  }
  const working = summaryNumber(summary, "totalWorkingDays");
  const paid = summaryNumber(summary, "effectivePaidDays");
  if (!money.monthlySalary || !money.dailyRate || working === null || paid === null) return [];
  return [
    { label: "Monthly salary", value: inr(money.monthlySalary) },
    { op: "÷" },
    { label: "Working days", value: trimNumber(working) },
    { op: "=" },
    { label: "Daily rate", value: inr2(money.dailyRate) },
    { op: "×" },
    { label: "Paid days", value: trimNumber(paid) },
    { op: "=" },
    { label: "Salary earned", value: inr2(money.gross) },
  ];
}

/** "How this salary was worked out": the stored earnings and deductions line by line, ending in the net payable. */
export function OverviewCard({
  details,
  kind,
  accent,
  ruleKeys,
  onShowRule,
}: {
  details: PayrollDetails;
  kind: PayrollKind;
  accent: Accent;
  /** The keys of the rules on this payroll, so a line can point at its rule only when there is one to show. */
  ruleKeys: ReadonlySet<string>;
  onShowRule: (ruleKey: string) => void;
}) {
  const steps = formulaSteps(details, kind);
  const { money } = details;
  return (
    <SectionCard
      id={sectionDomId("overview")}
      testId="pd-section-overview"
      className="scroll-mt-16"
      icon={Calculator}
      title="How this salary was worked out"
      description={`Every figure is what payroll stored when it computed this record${
        details.generatedAt ? ` on ${dateTime(details.generatedAt)}` : ""
      }. Nothing on this page recalculates it.`}
    >
      {steps.length > 0 && (
        <div
          className="mb-4 flex flex-wrap items-stretch gap-2 rounded-xl bg-slate-50 p-3"
          aria-label="How the gross was worked out"
          data-testid="pd-formula"
        >
          {steps.map((step, i) =>
            "op" in step ? (
              <span key={i} className="flex items-center px-0.5 text-xl font-medium text-slate-400" aria-hidden="true">
                {step.op}
              </span>
            ) : (
              <span key={i} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5">
                <span className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {step.label}
                </span>
                <span className="block text-sm font-black tabular-nums text-slate-800">{step.value}</span>
              </span>
            ),
          )}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <MoneyColumn
          title="Earnings"
          lines={details.earnings}
          empty="No earnings lines were stored for this payroll."
          testId="pd-earnings"
          ruleKeys={ruleKeys}
          onShowRule={onShowRule}
          accent={accent}
        />
        <MoneyColumn
          title="Deductions"
          lines={details.deductions}
          empty="No deductions on this payroll."
          testId="pd-deductions"
          ruleKeys={ruleKeys}
          onShowRule={onShowRule}
          accent={accent}
        />
      </div>

      <div
        className={cn(
          "mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border px-4 py-3",
          accent.soft,
          accent.border,
        )}
        data-testid="pd-net-callout"
      >
        <div>
          <p className={cn("text-xs font-bold uppercase tracking-wide", accent.text)}>Net payable</p>
          <p className="mt-0.5 text-xs text-slate-600">
            Gross {inr2(money.gross)} - deductions {inr2(money.deductions)}
            {money.bonus ? ` + bonus ${inr2(money.bonus)}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <PayStatusChip status={details.status} />
          <p className="text-2xl font-black tabular-nums text-gray-900" data-testid="pd-net-amount">
            {inr2(money.net)}
          </p>
        </div>
      </div>
    </SectionCard>
  );
}

function MoneyColumn({
  title,
  lines,
  empty,
  testId,
  ruleKeys,
  onShowRule,
  accent,
}: {
  title: string;
  lines: MoneyLine[];
  empty: string;
  testId: string;
  ruleKeys: ReadonlySet<string>;
  onShowRule: (ruleKey: string) => void;
  accent: Accent;
}) {
  return (
    <div data-testid={testId}>
      <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">{title}</h4>
      <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-100">
        {lines.length === 0 ? (
          <li className="px-3 py-3 text-xs text-muted-foreground">{empty}</li>
        ) : (
          lines.map((line) => (
            <MoneyRow key={line.key} line={line} ruleKeys={ruleKeys} onShowRule={onShowRule} accent={accent} />
          ))
        )}
      </ul>
    </div>
  );
}

function MoneyRow({
  line,
  ruleKeys,
  onShowRule,
  accent,
}: {
  line: MoneyLine;
  ruleKeys: ReadonlySet<string>;
  onShowRule: (ruleKey: string) => void;
  accent: Accent;
}) {
  const info = line.kind === "info";
  const subtotal = line.kind === "subtotal";
  const deduction = line.kind === "deduction";
  const amount = deduction ? `− ${inr2(Math.abs(line.amount))}` : inr2(line.amount);
  return (
    <li
      className={cn("flex items-start justify-between gap-3 px-3 py-2.5", subtotal && "bg-slate-50")}
      data-testid={`pd-line-${line.key}`}
      data-kind={line.kind}
    >
      <div className="min-w-0">
        <p
          className={cn("text-sm", subtotal ? "font-bold text-slate-900" : info ? "text-slate-500" : "text-slate-800")}
        >
          {line.label}
          {info && (
            <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">not added</span>
          )}
        </p>
        {line.note && <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{line.note}</p>}
        {line.ruleKey && ruleKeys.has(line.ruleKey) && (
          <button
            type="button"
            onClick={() => onShowRule(line.ruleKey as string)}
            className={cn("mt-1 text-[11px] font-semibold underline-offset-2 hover:underline", accent.text)}
            data-testid={`pd-line-rule-${line.key}`}
          >
            See the rule
          </button>
        )}
      </div>
      <p
        className={cn(
          "shrink-0 text-sm font-semibold tabular-nums",
          info && "text-slate-400",
          deduction && "text-red-700",
          subtotal && "font-black text-slate-900",
        )}
      >
        {amount}
      </p>
    </li>
  );
}
