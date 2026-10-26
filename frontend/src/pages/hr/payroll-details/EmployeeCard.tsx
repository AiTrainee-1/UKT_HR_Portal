import type { ReactNode } from "react";
import { Link } from "wouter";
import { ArrowUpRight, CheckCircle2, MinusCircle, UserRound, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip, SectionCard } from "@/components/payroll/kit/parts";
import { dateShort, inr, inr2 } from "@/components/payroll/kit/format";
import { PAY_CYCLE_INFO, type PayrollDetails, type PayrollKind } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import type { Accent } from "./accent";
import { readiness, sectionDomId, statusLabel, tenureLabel } from "./logic";

/** Who is being paid and whether they can be: the payment checklist, how the salary is set, the split and the profile. */
export function EmployeeCard({
  details,
  kind,
  accent,
  statutoryCategory,
}: {
  details: PayrollDetails;
  kind: PayrollKind;
  accent: Accent;
  /** What this payroll's own record says the employee is for PF / ESI: Co Emp, on the TDS list, or neither (unknown: absent). */
  statutoryCategory?: "co_emp" | "tds" | "none" | null;
}) {
  const { employee, money } = details;
  const checks = readiness(employee, statutoryCategory);
  const tenure = tenureLabel(employee.joinDate);
  const cycle = employee.payCycle ? PAY_CYCLE_INFO[employee.payCycle]?.label : null;
  const split = employee.split;
  const splitTotal = split ? split.first + split.second : 0;
  const basis =
    kind === "production" || (employee.salaryPerShift && !employee.salaryAmount)
      ? employee.salaryPerShift
        ? `${inr(employee.salaryPerShift)} per shift`
        : "No rate per shift is set"
      : employee.salaryAmount
        ? `${inr(employee.salaryAmount)} a month`
        : money.monthlySalary
          ? `${inr(money.monthlySalary)} a month`
          : "No salary is set";

  return (
    <SectionCard
      id={sectionDomId("employee")}
      testId="pd-section-employee"
      className="scroll-mt-16"
      icon={UserRound}
      title="Employee"
      description="Whether this person can be paid, how their salary is set and the profile behind the payroll."
      actions={
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <Button asChild variant="outline" size="sm" className="h-8 gap-1.5">
            <Link href={`/hr/employees/${employee.id}`} data-testid="pd-profile-link">
              Open the employee profile <ArrowUpRight size={13} />
            </Link>
          </Button>
          {kind === "production" && (
            <Button asChild variant="outline" size="sm" className="h-8 gap-1.5">
              <Link href="/hr/employees/productionEmployee">Production Employees</Link>
            </Button>
          )}
        </div>
      }
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <div data-testid="pd-readiness">
          <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Payment readiness</h4>
          <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-100">
            {checks.map((c) => {
              const required = c.key === "bank" || c.key === "ifsc";
              const Icon = c.ok ? CheckCircle2 : required ? XCircle : MinusCircle;
              return (
                <li
                  key={c.key}
                  className="flex items-start gap-3 px-3 py-2.5"
                  data-testid={`pd-ready-${c.key}`}
                  data-ok={c.ok ? "true" : "false"}
                >
                  <Icon
                    size={18}
                    className={cn(
                      "mt-0.5 shrink-0",
                      c.ok ? "text-emerald-500" : required ? "text-red-500" : "text-amber-500",
                    )}
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm font-semibold text-slate-800">
                      <span>
                        {c.label}
                        <span className="sr-only">: {c.ok ? "present" : "missing"}</span>
                      </span>
                      <span className="text-xs tabular-nums">
                        <span
                          className={cn(
                            c.value.startsWith("••••") && "font-mono",
                            c.ok ? "font-semibold text-slate-700" : "text-slate-400",
                          )}
                        >
                          {c.value}
                        </span>
                        {c.detail && <span className="text-slate-500"> · {c.detail}</span>}
                      </span>
                    </p>
                    <p className="text-xs text-muted-foreground">{c.hint}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        <div data-testid="pd-profile">
          <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Salary and profile</h4>
          <dl className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-100 text-sm">
            <Row label="Salary basis" value={basis} testId="pd-basis" />
            {kind === "staff" && money.dailyRate ? <Row label="Daily rate" value={inr2(money.dailyRate)} /> : null}
            <Row
              label="Joined"
              value={
                employee.joinDate ? `${dateShort(employee.joinDate)}${tenure ? ` · ${tenure}` : ""}` : "Not recorded"
              }
            />
            <Row
              label="Pay cycle"
              value={kind === "production" ? (cycle ?? "Not assigned to a cycle") : "Monthly (staff payroll)"}
            />
            <Row
              label="Status now"
              value={
                <Chip tone={employee.status === "active" ? "success" : "danger"}>{statusLabel(employee.status)}</Chip>
              }
            />
          </dl>
        </div>
      </div>

      {split && (
        <div className="mt-4" data-testid="pd-split">
          <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Salary split</h4>
          <div className="grid gap-3 sm:grid-cols-2">
            <SplitPortion
              title="First portion"
              hint="Basic, DA and Retaining allowance"
              amount={split.first}
              share={splitTotal > 0 ? (split.first / splitTotal) * 100 : 0}
              accent={accent}
            />
            <SplitPortion
              title="Second portion"
              hint="Other allowance, Petrol, HRA, Special and CA"
              amount={split.second}
              share={splitTotal > 0 ? (split.second / splitTotal) * 100 : 0}
              accent={accent}
            />
          </div>
          {split.components.length > 0 && (
            <ul className="mt-3 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
              {split.components.map((c) => (
                <li key={c.key} className="flex justify-between gap-3 border-b border-dashed border-slate-100 py-1">
                  <span className="text-muted-foreground">{c.label}</span>
                  <span className="font-semibold tabular-nums text-slate-800">{inr2(c.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </SectionCard>
  );
}

function Row({ label, value, testId }: { label: string; value: ReactNode; testId?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5" data-testid={testId}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-semibold text-slate-800">{value}</dd>
    </div>
  );
}

function SplitPortion({
  title,
  hint,
  amount,
  share,
  accent,
}: {
  title: string;
  hint: string;
  amount: number;
  share: number;
  accent: Accent;
}) {
  return (
    <div className={cn("rounded-xl border px-4 py-3", accent.soft, accent.border)}>
      <p className={cn("text-xs font-bold uppercase tracking-wide", accent.text)}>{title}</p>
      <p className="mt-0.5 text-lg font-black tabular-nums text-slate-900">{inr2(amount)}</p>
      <p className="text-xs text-slate-600">
        {hint} · {Math.round(share)}%
      </p>
    </div>
  );
}
