import { memo } from "react";
import { AlertTriangle, ArrowRight, ArrowUpRight, CheckCircle2, Play, RefreshCcw } from "lucide-react";
import { Link } from "wouter";
import { inr, plural } from "@/components/payroll/kit/format";
import { SEVERITY_META } from "@/components/payroll/kit/issue-meta";
import { Avatar, Chip } from "@/components/payroll/kit/parts";
import type { PayrollIssueSummary } from "@/components/payroll/panels/filters";
import { classifySkipReason } from "@/components/payroll/panels/skipped";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import type { EmployeeRules, PeriodEmployee } from "@/lib/api-client/custom-hooks";
import type { Tone } from "@/lib/statusTones";
import { cn } from "@/lib/utils";
import { VIEW_SAFE_ATTR } from "@/lib/view-only-lock";
import { ROSTER_STATE_LABEL, rosterState, type RosterState } from "./logic";

const STATE_TONE: Record<RosterState, Tone> = {
  ready: "neutral",
  pending: "warning",
  paid: "success",
  blocked: "danger",
};

// The stripe at the left edge of a row: what state the employee is in, readable at a glance down the list.
const STATE_STRIPE: Record<RosterState, string> = {
  ready: "border-l-slate-200",
  pending: "border-l-amber-400",
  paid: "border-l-emerald-500",
  blocked: "border-l-red-400",
};

/** Whether an employee's issues are known: still loading, loaded (none listed means none), or the request failed. */
export type RosterDataState = "loading" | "ready" | "unavailable";

function IssueBadge({
  summary,
  state,
  onOpen,
  code,
}: {
  summary: PayrollIssueSummary | undefined;
  state: RosterDataState;
  onOpen: () => void;
  code: string;
}) {
  if (state === "loading")
    return <Skeleton className="h-5 w-24 rounded-full" data-testid={`pcp-roster-issues-loading-${code}`} />;
  if (state === "unavailable") return null;
  if (!summary || summary.total === 0)
    return (
      <span data-testid={`pcp-roster-issues-${code}`}>
        <Chip tone="success" icon={CheckCircle2}>
          No issues
        </Chip>
      </span>
    );
  const worst = summary.bySeverity.critical > 0 ? "critical" : summary.bySeverity.warning > 0 ? "warning" : "info";
  const meta = SEVERITY_META[worst];
  return (
    <button
      type="button"
      onClick={onOpen}
      title="Open the issues of this payroll"
      className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid={`pcp-roster-issues-${code}`}
      data-severity={worst}
    >
      <Chip tone={meta.tone} icon={AlertTriangle}>
        {plural(summary.total, "issue")} · {meta.label}
      </Chip>
    </button>
  );
}

export type RosterRowProps = {
  employee: PeriodEmployee;
  selected: boolean;
  /** The period has ended: only then can payroll be generated for it. */
  ended: boolean;
  /** A generation is running: nothing else may be started. */
  busy: boolean;
  /** This payslip's issues (`buildIssueSummaries(issues).get(payrollId)`). */
  issues: PayrollIssueSummary | undefined;
  issuesState: RosterDataState;
  /** The employee's rules as chips (`EmployeeRules["chips"]`), when the rules data has them. */
  rules: Pick<EmployeeRules, "chips"> | undefined;
  rulesState: RosterDataState;
  onToggle: (employeeId: number) => void;
  onGenerate: (employee: PeriodEmployee) => void;
  onGenerateAgain: (employee: PeriodEmployee) => void;
  onOpenDetails: (payrollId: number, section?: string) => void;
};

function RosterRowImpl({
  employee: e,
  selected,
  ended,
  busy,
  issues,
  issuesState,
  rules,
  rulesState,
  onToggle,
  onGenerate,
  onGenerateAgain,
  onOpenDetails,
}: RosterRowProps) {
  const state = rosterState(e);
  const p = e.payroll;
  const code = e.employeeCode;
  const hasRate = e.salaryPerShift != null && e.salaryPerShift > 0;
  const fix = state === "blocked" ? classifySkipReason(e.blockedReason ?? "", e.employeeId) : null;

  return (
    <li
      className={cn(
        "flex flex-col gap-3 border-l-4 px-4 py-3.5 transition-colors hover:bg-slate-50/70 lg:flex-row lg:items-center",
        STATE_STRIPE[state],
      )}
      data-testid={`pcp-roster-row-${code}`}
      data-state={state}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <div className="mt-2.5 flex h-4 w-4 shrink-0 items-center justify-center">
          {state === "ready" && (
            <Checkbox
              aria-label={`Select ${e.name}`}
              checked={selected}
              disabled={!ended}
              onCheckedChange={() => onToggle(e.employeeId)}
              data-testid={`pcp-roster-select-${code}`}
            />
          )}
        </div>
        <Avatar name={e.name} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="truncate text-sm font-bold text-gray-900">{e.name}</p>
            <span data-testid={`pcp-roster-state-${code}`}>
              <Chip tone={STATE_TONE[state]}>{ROSTER_STATE_LABEL[state]}</Chip>
            </span>
            {p && (
              <IssueBadge
                summary={issues}
                state={issuesState}
                onOpen={() => onOpenDetails(p.id, "issues")}
                code={code}
              />
            )}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            <span className="font-mono">{code}</span>
            {e.departmentName && <> · {e.departmentName}</>}
            {" · "}Rate{" "}
            {hasRate ? (
              <span className="font-semibold text-gray-700">{inr(e.salaryPerShift)} / shift</span>
            ) : (
              <span className="font-semibold text-amber-700">Not set</span>
            )}
          </p>
          {state === "blocked" && (
            <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-red-700">
              <span>{e.blockedReason}</span>
              {fix?.href && fix.hrefLabel && (
                <Link
                  href={fix.href}
                  className="inline-flex items-center gap-0.5 font-semibold text-red-800 underline-offset-2 hover:underline"
                  data-testid={`pcp-roster-fix-${code}`}
                >
                  {fix.hrefLabel} <ArrowUpRight size={11} />
                </Link>
              )}
            </p>
          )}
          {rules && rules.chips.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Rules assigned to this employee">
              {rules.chips.map((chip) => (
                <li key={chip.key}>
                  <Chip tone={chip.tone}>{chip.label}</Chip>
                </li>
              ))}
            </ul>
          ) : (
            !rules &&
            rulesState === "loading" && (
              <div className="mt-2 flex flex-wrap gap-1.5" data-testid={`pcp-roster-rules-loading-${code}`}>
                <Skeleton className="h-5 w-28 rounded-full" />
                <Skeleton className="h-5 w-20 rounded-full" />
              </div>
            )
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 lg:justify-end">
        {p && (
          <dl className="grid grid-cols-3 gap-x-5 text-right" data-testid={`pcp-roster-figures-${code}`}>
            <div>
              <dt className="text-[11px] text-muted-foreground">Shifts</dt>
              <dd className="text-xs font-bold tabular-nums text-gray-800">{plural(p.presentDays, "shift")}</dd>
            </div>
            <div>
              <dt className="text-[11px] text-muted-foreground">Gross</dt>
              <dd className="text-xs font-bold tabular-nums text-gray-800">{inr(p.grossSalary)}</dd>
            </div>
            <div>
              <dt className="text-[11px] text-muted-foreground">Net</dt>
              <dd className="text-xs font-black tabular-nums text-green-700">{inr(p.finalSalary)}</dd>
            </div>
          </dl>
        )}
        <div className="flex items-center gap-1.5">
          {state === "ready" && (
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1 text-xs"
              disabled={busy || !ended}
              onClick={() => onGenerate(e)}
              data-testid={`pcp-generate-${code}`}
            >
              <Play size={11} /> Generate
            </Button>
          )}
          {state === "pending" && (
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 text-amber-700"
              title={`Generate again for ${e.name}: recompute this payslip`}
              aria-label={`Generate again for ${e.name}`}
              disabled={busy}
              onClick={() => onGenerateAgain(e)}
              data-testid={`pcp-regenerate-${code}`}
            >
              <RefreshCcw size={14} />
            </Button>
          )}
          {p && (
            // Opening a payroll's details only reads: a View Only role keeps it, whatever the employee is called.
            <span {...{ [VIEW_SAFE_ATTR]: "" }}>
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 text-xs hover:border-amber-300 hover:text-amber-700"
                title="Open the full details of this payroll"
                onClick={() => onOpenDetails(p.id)}
                data-testid={`pcp-roster-details-${code}`}
              >
                Details <ArrowRight size={13} />
              </Button>
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

/** One employee of the cycle's roster: who, their state for the period, what payroll found, the rules, and what can be done. */
export const RosterRow = memo(RosterRowImpl);
