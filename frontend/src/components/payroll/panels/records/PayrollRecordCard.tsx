import { memo } from "react";
import { ArrowRight, CalendarRange, CheckCircle2, Repeat } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { EmployeeRules, PayrollKind, PayrollRunItem } from "@/lib/api-client/custom-hooks";
import { inr } from "@/components/payroll/kit/format";
import { SEVERITY_META } from "@/components/payroll/kit/issue-meta";
import { Avatar, BusyIcon, Chip, IssueChip, PayStatusChip } from "@/components/payroll/kit/parts";
import { hasTds, tdsAmount, tdsLabel } from "@/components/payroll/kit/statutory";
import { cn } from "@/lib/utils";
import type { PayrollIssueSummary } from "../filters/filter-logic";
import {
  cycleLabelOf,
  displayName,
  issueBadges,
  markPaidTitle,
  metricLabel,
  metricText,
  periodText,
} from "./records-logic";

export type PayrollRecordCardProps = {
  run: PayrollRunItem;
  kind: PayrollKind;
  accent: "indigo" | "amber";
  /** The payroll's issues (`buildIssueSummaries(issues).get(run.id)`); `total: 0` reads "No issues". */
  issueSummary?: PayrollIssueSummary;
  /** The issues are on their way: a placeholder shows where the badges will be. */
  issuesLoading?: boolean;
  /** The employee's rules as short chips (`EmployeeRules["chips"]`). */
  chips?: EmployeeRules["chips"];
  chipsLoading?: boolean;
  /** The employee's designation (the payroll row has none; the rules and issues data do). */
  designation?: string | null;
  onOpenDetails: (run: PayrollRunItem) => void;
  /** Opens the details page at its issues section. Without it the issue badges are plain text. */
  onOpenIssues?: (run: PayrollRunItem) => void;
  /** Without it a pending row has no "Mark as Cleared". */
  onMarkPaid?: (run: PayrollRunItem) => void;
  /** This row's "Mark as Cleared" is running: the button spins and waits. */
  marking?: boolean;
  testId?: string;
};

const ACCENT_BUTTON = {
  indigo: "hover:border-indigo-300 hover:text-indigo-700",
  amber: "hover:border-amber-300 hover:text-amber-700",
} as const;

/** The severity counts and the two most frequent issue types of a payroll, as one block (a button when it can open them). */
function IssueBadgesBlock({
  run,
  summary,
  onOpenIssues,
}: {
  run: PayrollRunItem;
  summary: PayrollIssueSummary;
  onOpenIssues?: (run: PayrollRunItem) => void;
}) {
  const { severities, types, more } = issueBadges(summary);
  const body = (
    <>
      {severities.map(({ severity, count }) => {
        const meta = SEVERITY_META[severity];
        return (
          <Chip key={severity} tone={meta.tone} className="shrink-0">
            <span className={cn("h-1.5 w-1.5 rounded-full", meta.dot)} aria-hidden="true" />
            {count} {meta.label}
          </Chip>
        );
      })}
      {types.map((t) => (
        <IssueChip key={t.code} code={t.code} severity={t.severity} label={`${t.label} ×${t.count}`} />
      ))}
      {more > 0 && <span className="text-[11px] text-muted-foreground">+{more} more</span>}
    </>
  );
  if (!onOpenIssues) return <div className="flex flex-wrap items-center gap-1.5">{body}</div>;
  return (
    <button
      type="button"
      onClick={() => onOpenIssues(run)}
      aria-label={`Open the issues of ${displayName(run)}`}
      title="Open the issues of this payroll"
      className="flex w-full flex-wrap items-center gap-1.5 rounded-xl border border-dashed border-gray-200 px-2 py-1.5 text-left transition-colors hover:border-gray-300 hover:bg-slate-50"
      data-testid={`payroll-record-issues-${run.id}`}
    >
      {body}
      <span className="ml-auto inline-flex items-center gap-0.5 text-[11px] font-semibold text-blue-600">
        Issues <ArrowRight size={11} />
      </span>
    </button>
  );
}

function PayrollRecordCardImpl({
  run,
  kind,
  accent,
  issueSummary,
  issuesLoading = false,
  chips,
  chipsLoading = false,
  designation,
  onOpenDetails,
  onOpenIssues,
  onMarkPaid,
  marking = false,
  testId,
}: PayrollRecordCardProps) {
  const name = displayName(run);
  const cycle = cycleLabelOf(run);
  const pending = run.status !== "paid";
  // The TDS cell exists only on the card of an employee on the TDS list.
  const tds = hasTds(run);
  const extras = [
    run.otAmount > 0 ? `OT ${inr(run.otAmount)}` : "",
    run.bonus > 0 ? `Bonus ${inr(run.bonus)}` : "",
  ].filter(Boolean);

  return (
    <article
      className={cn(
        "rounded-2xl border border-l-4 border-slate-100 bg-white p-4 shadow-sm transition-shadow hover:shadow-md",
        pending ? "border-l-amber-400" : "border-l-emerald-500",
      )}
      aria-label={`Payroll of ${name}`}
      data-testid={testId ?? `payroll-record-${run.id}`}
      data-status={run.status}
      data-kind={kind}
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0 space-y-2.5">
          <div className="flex items-start gap-3">
            <Avatar name={name} size={40} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <p className="truncate text-sm font-bold text-gray-900">{name}</p>
                <PayStatusChip status={run.status} />
                {cycle && (
                  <Chip tone="caution" icon={Repeat}>
                    {cycle}
                  </Chip>
                )}
                <Chip tone="neutral" icon={CalendarRange}>
                  {periodText(run)}
                </Chip>
              </div>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                <span className="font-mono">{run.employeeCode ?? `#${run.employeeId}`}</span>
                {run.departmentName && <> · {run.departmentName}</>}
                {designation && <> · {designation}</>}
              </p>
            </div>
          </div>

          {issueSummary ? (
            issueSummary.total > 0 ? (
              <IssueBadgesBlock run={run} summary={issueSummary} onOpenIssues={onOpenIssues} />
            ) : (
              <Chip tone="success" icon={CheckCircle2}>
                No issues
              </Chip>
            )
          ) : (
            issuesLoading && (
              <Skeleton className="h-7 w-64 max-w-full rounded-full" data-testid="payroll-record-issues-loading" />
            )
          )}

          {chips && chips.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5" aria-label="Rules assigned to this employee">
              {chips.map((chip) => (
                <li key={chip.key}>
                  <Chip tone={chip.tone}>{chip.label}</Chip>
                </li>
              ))}
            </ul>
          ) : (
            !chips &&
            chipsLoading && (
              <div className="flex flex-wrap gap-1.5" data-testid="payroll-record-rules-loading">
                <Skeleton className="h-5 w-28 rounded-full" />
                <Skeleton className="h-5 w-20 rounded-full" />
                <Skeleton className="h-5 w-24 rounded-full" />
              </div>
            )
          )}
        </div>

        <div className="space-y-3 rounded-xl bg-slate-50/80 p-3">
          <div className="text-right">
            <p className="text-[11px] font-medium text-muted-foreground">Net payable</p>
            <p
              className="text-2xl font-black leading-tight text-green-700"
              data-testid={`payroll-record-net-${run.id}`}
            >
              {inr(run.finalSalary)}
            </p>
            {extras.length > 0 && <p className="text-[11px] text-muted-foreground">{extras.join(" · ")}</p>}
          </div>
          <dl className={cn("grid grid-cols-3 gap-2 text-center", tds && "grid-cols-4")}>
            <div className="min-w-0">
              <dt className="text-[11px] text-muted-foreground">{metricLabel(run)}</dt>
              <dd className="text-xs font-bold text-gray-800">{metricText(run)}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-[11px] text-muted-foreground">Gross</dt>
              <dd className="text-xs font-bold text-gray-800">{inr(run.grossSalary)}</dd>
            </div>
            {tds && (
              <div className="min-w-0" data-testid={`payroll-record-tds-${run.id}`}>
                <dt className="text-[11px] text-muted-foreground" title="Tax deducted at source (part of Deductions)">
                  {tdsLabel(run)}
                </dt>
                <dd className="text-xs font-bold text-red-600">{inr(tdsAmount(run))}</dd>
              </div>
            )}
            <div className="min-w-0">
              <dt className="text-[11px] text-muted-foreground">Deductions</dt>
              <dd className={cn("text-xs font-bold", run.deductions > 0 ? "text-red-600" : "text-gray-800")}>
                {inr(run.deductions)}
              </dd>
            </div>
          </dl>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className={cn("h-8 gap-1.5 text-xs", ACCENT_BUTTON[accent])}
              onClick={() => onOpenDetails(run)}
              title="Open the full details of this payroll"
              data-testid={`payroll-record-details-${run.id}`}
            >
              Details <ArrowRight size={13} />
            </Button>
            {pending && onMarkPaid && (
              <Button
                type="button"
                size="sm"
                className="h-8 gap-1.5 border-0 bg-none bg-emerald-600 text-xs text-white hover:bg-emerald-700"
                disabled={marking}
                onClick={() => onMarkPaid(run)}
                title={markPaidTitle(run)}
                data-testid={`payroll-record-markpaid-${run.id}`}
              >
                <BusyIcon busy={marking} icon={CheckCircle2} size={13} /> Mark as Cleared
              </Button>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

/** One payroll row as a card: who and for which period, the pay figures, what payroll flagged, the rules in force, and the two actions. */
export const PayrollRecordCard = memo(PayrollRecordCardImpl);
