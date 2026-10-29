import { useMemo, type ComponentType, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  CheckCircle2,
  Clock,
  FileWarning,
  IndianRupee,
  TrendingUp,
  UserX,
  Users,
  Wallet,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  IssueCode,
  IssueSeverity,
  PayrollIssuesSummary,
  PayrollKind,
  PayrollRunItem,
} from "@/lib/api-client/custom-hooks";
import { inr, plural } from "@/components/payroll/kit/format";
import { SEVERITY_META, issueIcon } from "@/components/payroll/kit/issue-meta";
import { KpiTile, SectionCard } from "@/components/payroll/kit/parts";
import { sumTds } from "@/components/payroll/kit/statutory";
import { cn } from "@/lib/utils";
import {
  byDepartment,
  issueBars,
  issueSplitText,
  paymentSplit,
  percentText,
  summarizeRuns,
  worstSeverity,
} from "./dashboard-logic";

type IconType = ComponentType<{ size?: number; className?: string }>;

export type PayrollDashboardProps = {
  kind: PayrollKind;
  /** Staff Payroll is indigo, Production Payroll amber. */
  accent: "indigo" | "amber";
  /** "October 2026" / "2 Feb - 8 Feb 2026": what the figures are for. */
  periodLabel: string;
  /** The payroll rows of the whole period (not the filtered list). */
  runs?: PayrollRunItem[];
  /** The first load of `runs`. Pass `isLoading`, not `isFetching`, so a refresh keeps the figures on screen. */
  loading?: boolean;
  /** Who is expected to be paid: all active staff, or the cycle's roster. `label` finishes "120 of 126 ...". */
  expected?: { count: number; label: string };
  issues?: PayrollIssuesSummary;
  issuesLoading?: boolean;
  skipped?: { count: number; total: number };
  skippedLoading?: boolean;
  /** Opens the issues view; a click on one issue type passes its code so the page can open it filtered. */
  onOpenIssues?: (code?: IssueCode) => void;
  onOpenSkipped?: () => void;
  /** Shows the pending or the paid payroll in the records list. */
  onFilterStatus?: (status: "pending" | "paid") => void;
  /** Test ids are `<prefix>-kpi-employees`, `<prefix>-card-payment` and so on (default "dash"). */
  testIdPrefix?: string;
};

const ACCENT = {
  indigo: { tile: "bg-indigo-50 text-indigo-800", pending: "bg-amber-50 text-amber-900", bar: "bg-indigo-500" },
  amber: { tile: "bg-amber-50 text-amber-800", pending: "bg-orange-50 text-orange-900", bar: "bg-amber-500" },
} as const;

const ISSUE_TILE: Record<IssueSeverity | "none", string> = {
  critical: "bg-red-50 text-red-800",
  warning: "bg-amber-50 text-amber-900",
  info: "bg-sky-50 text-sky-800",
  none: "bg-emerald-50 text-emerald-800",
};

// The tiles' titles in one place, so the wording is easy to change.
const LABELS = {
  employees: "Employees in payroll",
  gross: "Total gross",
  deductions: "Deductions",
  net: "Net payable",
  pending: "Pending release",
  issues: "Issues detected",
  skipped: "Skipped employees",
} as const;

/**
 * The payroll dashboard: one row of figures (who is in the payroll, what it costs, what is still to be released, what
 * payroll flagged, who it skipped) and three small charts (paid against pending, net payable by department, issues by
 * type). Every figure has its own skeleton while it loads, and a tile or a bar with a handler is a real button.
 */
export function PayrollDashboard({
  kind,
  accent,
  periodLabel,
  runs,
  loading = false,
  expected,
  issues,
  issuesLoading = false,
  skipped,
  skippedLoading = false,
  onOpenIssues,
  onOpenSkipped,
  onFilterStatus,
  testIdPrefix = "dash",
}: PayrollDashboardProps) {
  const p = testIdPrefix;
  const colors = ACCENT[accent];
  const summary = useMemo(() => summarizeRuns(runs), [runs]);
  const tdsTotal = useMemo(() => sumTds(runs), [runs]);
  const split = useMemo(() => paymentSplit(runs), [runs]);
  const departments = useMemo(() => byDepartment(runs), [runs]);
  const worst = worstSeverity(issues?.bySeverity);
  const canFilterPending = !!onFilterStatus && summary.pending.records > 0;

  return (
    <section
      className="min-w-0 space-y-4"
      aria-label={`Payroll dashboard, ${periodLabel}`}
      data-testid={`${p}-root`}
      data-kind={kind}
    >
      <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 xl:grid-cols-12" data-testid={`${p}-kpis`}>
        <KpiTile
          testId={`${p}-kpi-employees`}
          label={LABELS.employees}
          icon={Users}
          tone={colors.tile}
          className="xl:col-span-3"
          loading={loading}
          value={expected ? `${summary.employees} of ${expected.count}` : summary.employees}
          sub={expected ? expected.label : plural(summary.records, "payslip")}
        />
        <KpiTile
          testId={`${p}-kpi-gross`}
          label={LABELS.gross}
          icon={TrendingUp}
          tone="bg-blue-50 text-blue-800"
          className="xl:col-span-3"
          loading={loading}
          value={inr(summary.gross)}
          sub={plural(summary.records, "payslip")}
        />
        <KpiTile
          testId={`${p}-kpi-deductions`}
          label={LABELS.deductions}
          icon={IndianRupee}
          tone="bg-red-50 text-red-800"
          className="xl:col-span-3"
          loading={loading}
          value={inr(summary.deductions)}
          sub={
            [
              summary.gross > 0 ? `${Math.round((summary.deductions / summary.gross) * 100)}% of gross` : null,
              // TDS is part of the figure above; it is named only when some employee on the TDS list has any
              tdsTotal > 0 ? `incl. ${inr(tdsTotal)} TDS` : null,
            ]
              .filter(Boolean)
              .join(" · ") || undefined
          }
        />
        <KpiTile
          testId={`${p}-kpi-net`}
          label={LABELS.net}
          icon={Wallet}
          tone="bg-green-50 text-green-800"
          className="xl:col-span-3"
          loading={loading}
          value={inr(summary.net)}
          sub={
            summary.employees > 0
              ? `${inr(Math.round(summary.net / summary.employees))} per employee on average`
              : undefined
          }
        />
        <KpiTile
          testId={`${p}-kpi-pending`}
          label={LABELS.pending}
          icon={Clock}
          tone={colors.pending}
          className="xl:col-span-4"
          loading={loading}
          value={inr(summary.pending.net)}
          sub={
            summary.records === 0
              ? "No payroll generated yet"
              : summary.pending.records === 0
                ? "Everything is released"
                : `${plural(summary.pending.employees, "employee")} waiting`
          }
          onClick={canFilterPending ? () => onFilterStatus?.("pending") : undefined}
        />
        <KpiTile
          testId={`${p}-kpi-issues`}
          label={LABELS.issues}
          icon={AlertTriangle}
          tone={ISSUE_TILE[worst ?? "none"]}
          className="xl:col-span-4"
          loading={issuesLoading}
          value={issues ? issues.total : "—"}
          sub={issues ? issueSplitText(issues.bySeverity) : "Not available for this period"}
          onClick={onOpenIssues && issues ? () => onOpenIssues() : undefined}
        />
        <KpiTile
          testId={`${p}-kpi-skipped`}
          label={LABELS.skipped}
          icon={UserX}
          tone={skipped && skipped.count > 0 ? "bg-orange-50 text-orange-900" : "bg-slate-100 text-slate-700"}
          className="min-[480px]:max-xl:col-span-2 xl:col-span-4"
          loading={skippedLoading}
          value={skipped ? skipped.count : "—"}
          sub={
            skipped
              ? skipped.count > 0
                ? `of ${skipped.total} checked`
                : `Nobody skipped · ${skipped.total} checked`
              : "Not available for this period"
          }
          onClick={onOpenSkipped}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <PaymentCard
          testId={`${p}-card-payment`}
          loading={loading}
          periodLabel={periodLabel}
          split={split}
          onFilterStatus={onFilterStatus}
        />
        <DepartmentCard
          testId={`${p}-card-departments`}
          loading={loading}
          periodLabel={periodLabel}
          rows={departments}
          barClass={colors.bar}
        />
        <IssuesCard
          testId={`${p}-card-issues`}
          className="lg:col-span-2 xl:col-span-1"
          loading={issuesLoading}
          issues={issues}
          onOpenIssues={onOpenIssues}
        />
      </div>
    </section>
  );
}

// ── Small pieces ──────────────────────────────────────────────────────────────

/** A card with nothing to chart: says why, and what to do. */
function CardEmpty({
  icon: Icon,
  title,
  hint,
  tone = "neutral",
  testId,
}: {
  icon: IconType;
  title: string;
  hint?: ReactNode;
  tone?: "neutral" | "good";
  testId?: string;
}) {
  return (
    <div
      className="flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-gray-200 px-4 py-8 text-center"
      data-testid={testId}
    >
      <Icon size={22} className={tone === "good" ? "text-emerald-400" : "text-gray-300"} />
      <p className="text-sm font-semibold text-gray-700">{title}</p>
      {hint && <p className="max-w-xs text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Placeholder rows shaped like the bars that are about to appear. */
function BarsSkeleton({ rows = 4, testId }: { rows?: number; testId?: string }) {
  return (
    <div className="space-y-3" data-testid={testId} aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="space-y-1.5">
          <div className="flex justify-between gap-6">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-14" />
          </div>
          <Skeleton className="h-2 rounded-r-[4px]" style={{ width: `${90 - i * 18}%` }} />
        </div>
      ))}
    </div>
  );
}

/**
 * One horizontal bar: label and value above, the bar below. The bar grows from the left edge and rounds only its end.
 * Made of spans, so it is valid inside a button (the issue rows are buttons).
 */
function BarRow({
  label,
  value,
  share,
  barClass,
  title,
}: {
  label: ReactNode;
  value: ReactNode;
  /** The bar's length against the longest bar (0 to 1). */
  share: number;
  barClass: string;
  title?: string;
}) {
  return (
    <span className="block" title={title}>
      <span className="flex items-baseline justify-between gap-3 text-xs">
        <span className="flex min-w-0 items-center gap-1.5 font-medium text-gray-700">{label}</span>
        <span className="shrink-0 text-gray-900">{value}</span>
      </span>
      <span className="mt-1 block h-2 w-full rounded-r-[4px] bg-slate-100">
        <span
          className={cn("block h-2 rounded-r-[4px]", barClass)}
          style={{ width: `${Math.max(0, Math.min(1, share)) * 100}%`, minWidth: share > 0 ? 4 : 0 }}
        />
      </span>
    </span>
  );
}

// ── Payment status ────────────────────────────────────────────────────────────

function PaymentCard({
  testId,
  loading,
  periodLabel,
  split,
  onFilterStatus,
}: {
  testId: string;
  loading: boolean;
  periodLabel: string;
  split: ReturnType<typeof paymentSplit>;
  onFilterStatus?: (status: "pending" | "paid") => void;
}) {
  const both = split.paid.share > 0 && split.pending.share > 0;
  const rows = [
    { status: "paid" as const, label: "Cleared", dot: "bg-emerald-500", bucket: split.paid },
    { status: "pending" as const, label: "Pending", dot: "bg-amber-500", bucket: split.pending },
  ];
  return (
    <SectionCard
      title="Payment status"
      description="How much of the net payable has been cleared"
      icon={Wallet}
      testId={testId}
    >
      {loading ? (
        <div className="space-y-3" data-testid={`${testId}-loading`} aria-busy="true">
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-3 w-full rounded-[4px]" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
        </div>
      ) : split.records === 0 ? (
        <CardEmpty
          testId={`${testId}-empty`}
          icon={Wallet}
          title="No payroll yet"
          hint={`Generate payroll for ${periodLabel} to see what is cleared and what is pending.`}
        />
      ) : (
        <div className="space-y-3">
          <div>
            <p className="text-3xl font-black leading-none text-gray-900" data-testid={`${testId}-percent`}>
              {split.paidPercent}% <span className="text-sm font-semibold text-muted-foreground">cleared</span>
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {inr(split.paid.net)} of {inr(split.net)} net payable
            </p>
          </div>
          <div
            role="img"
            aria-label={`${split.paidPercent}% of the net payable is cleared: ${inr(split.paid.net)} cleared, ${inr(split.pending.net)} pending`}
            className="flex h-3 w-full gap-0.5"
            data-testid={`${testId}-bar`}
          >
            {split.paid.share > 0 && (
              <div
                className={cn("bg-emerald-500", both ? "rounded-l-[4px]" : "rounded-[4px]")}
                style={{ flex: `${split.paid.share} 1 0%`, minWidth: 6 }}
                title={`Cleared: ${plural(split.paid.employees, "employee")}, ${inr(split.paid.net)}`}
                data-segment="paid"
              />
            )}
            {split.pending.share > 0 && (
              <div
                className={cn("bg-amber-500", both ? "rounded-r-[4px]" : "rounded-[4px]")}
                style={{ flex: `${split.pending.share} 1 0%`, minWidth: 6 }}
                title={`Pending: ${plural(split.pending.employees, "employee")}, ${inr(split.pending.net)}`}
                data-segment="pending"
              />
            )}
          </div>
          <ul className="space-y-0.5" data-testid={`${testId}-legend`}>
            {rows.map(({ status, label, dot, bucket }) => {
              const body = (
                <>
                  <span className={cn("h-2.5 w-2.5 shrink-0 rounded-sm", dot)} aria-hidden="true" />
                  <span className="font-semibold text-gray-800">{label}</span>{" "}
                  <span className="text-muted-foreground">{plural(bucket.employees, "employee")}</span>{" "}
                  <span className="ml-auto font-bold tabular-nums text-gray-900">{inr(bucket.net)}</span>{" "}
                  <span className="w-10 text-right tabular-nums text-muted-foreground">
                    {percentText(bucket.share)}
                  </span>
                </>
              );
              const classes = "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs";
              return (
                <li key={status}>
                  {onFilterStatus && bucket.records > 0 ? (
                    <button
                      type="button"
                      className={cn(classes, "hover:bg-slate-50")}
                      onClick={() => onFilterStatus(status)}
                      aria-label={`Show the ${status} payroll: ${plural(bucket.employees, "employee")}, ${inr(bucket.net)}`}
                      data-testid={`${testId}-${status}`}
                    >
                      {body}
                    </button>
                  ) : (
                    <div className={classes} data-testid={`${testId}-${status}`}>
                      {body}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </SectionCard>
  );
}

// ── Net payable by department ─────────────────────────────────────────────────

function DepartmentCard({
  testId,
  loading,
  periodLabel,
  rows,
  barClass,
}: {
  testId: string;
  loading: boolean;
  periodLabel: string;
  rows: ReturnType<typeof byDepartment>;
  barClass: string;
}) {
  const longest = Math.max(0, ...rows.map((r) => r.net));
  return (
    <SectionCard
      title="Net payable by department"
      description="The six biggest departments; the rest are grouped as Others"
      icon={Building2}
      testId={testId}
    >
      {loading ? (
        <BarsSkeleton testId={`${testId}-loading`} />
      ) : rows.length === 0 ? (
        <CardEmpty
          testId={`${testId}-empty`}
          icon={Building2}
          title="No payroll yet"
          hint={`Generate payroll for ${periodLabel} to see how it is spread over the departments.`}
        />
      ) : (
        <ul className="space-y-3" data-testid={`${testId}-list`}>
          {rows.map((row) => (
            <li key={row.key} data-testid={`${testId}-row-${row.key}`}>
              <BarRow
                title={`${row.label}: ${inr(row.net)} (${percentText(row.share)}) for ${plural(row.employees, "employee")}`}
                label={
                  <>
                    <span className="truncate">{row.label}</span>{" "}
                    <span className="shrink-0 font-normal text-muted-foreground">
                      {row.others ? `${row.departments} departments` : row.employees}
                    </span>
                  </>
                }
                value={
                  <>
                    <span className="font-semibold tabular-nums">{inr(row.net)}</span>{" "}
                    <span className="ml-1 tabular-nums text-muted-foreground">{percentText(row.share)}</span>
                  </>
                }
                share={longest > 0 ? row.net / longest : 0}
                barClass={row.others ? "bg-slate-300" : barClass}
              />
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

// ── Issues by type ────────────────────────────────────────────────────────────

function IssuesCard({
  testId,
  className,
  loading,
  issues,
  onOpenIssues,
}: {
  testId: string;
  className?: string;
  loading: boolean;
  issues: PayrollIssuesSummary | undefined;
  onOpenIssues?: (code?: IssueCode) => void;
}) {
  const { bars, hidden } = useMemo(() => issueBars(issues), [issues]);
  const present = useMemo(() => [...new Set(bars.map((b) => b.severity))], [bars]);
  return (
    <SectionCard
      title="Issues by type"
      description="What payroll flagged this period, by kind"
      icon={FileWarning}
      className={className}
      testId={testId}
      actions={
        !loading && issues && issues.total > 0 && onOpenIssues ? (
          <button
            type="button"
            onClick={() => onOpenIssues()}
            className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 hover:underline"
            data-testid={`${testId}-open`}
          >
            View all issues <ArrowRight size={12} />
          </button>
        ) : undefined
      }
    >
      {loading ? (
        <BarsSkeleton testId={`${testId}-loading`} />
      ) : !issues ? (
        <CardEmpty
          testId={`${testId}-empty`}
          icon={FileWarning}
          title="Issues are not available"
          hint="They appear once payroll has been generated for this period."
        />
      ) : issues.total === 0 || bars.length === 0 ? (
        <CardEmpty
          testId={`${testId}-none`}
          tone="good"
          icon={CheckCircle2}
          title="No issues detected"
          hint="Payroll found nothing to flag for this period."
        />
      ) : (
        <div className="space-y-3">
          <ul className="space-y-1.5" data-testid={`${testId}-list`}>
            {bars.map((bar) => {
              const meta = SEVERITY_META[bar.severity];
              const Icon = issueIcon(bar.code);
              const row = (
                <BarRow
                  title={`${bar.label}: ${bar.count} (${meta.label})`}
                  label={
                    <>
                      <Icon size={13} className="shrink-0 text-gray-500" />
                      <span className="truncate">{bar.label}</span>
                    </>
                  }
                  value={<span className="font-bold tabular-nums">{bar.count}</span>}
                  share={bar.share}
                  barClass={meta.dot}
                />
              );
              return (
                <li key={bar.code}>
                  {onOpenIssues ? (
                    <button
                      type="button"
                      onClick={() => onOpenIssues(bar.code)}
                      aria-label={`Open ${bar.label}: ${bar.count} (${meta.label})`}
                      className="block w-full rounded-lg px-1.5 py-1 text-left hover:bg-slate-50"
                      data-testid={`${testId}-row-${bar.code}`}
                      data-severity={bar.severity}
                    >
                      {row}
                    </button>
                  ) : (
                    <div className="px-1.5 py-1" data-testid={`${testId}-row-${bar.code}`} data-severity={bar.severity}>
                      {row}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <div
            className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-gray-100 pt-2.5"
            data-testid={`${testId}-legend`}
          >
            {present.map((severity) => (
              <span key={severity} className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className={cn("h-2.5 w-2.5 rounded-sm", SEVERITY_META[severity].dot)} aria-hidden="true" />
                {SEVERITY_META[severity].label}
              </span>
            ))}
            {hidden > 0 &&
              (onOpenIssues ? (
                <button
                  type="button"
                  onClick={() => onOpenIssues()}
                  className="ml-auto text-[11px] font-semibold text-blue-600 hover:underline"
                  data-testid={`${testId}-more`}
                >
                  +{hidden} more {hidden === 1 ? "type" : "types"}
                </button>
              ) : (
                <span className="ml-auto text-[11px] text-muted-foreground" data-testid={`${testId}-more`}>
                  +{hidden} more {hidden === 1 ? "type" : "types"}
                </span>
              ))}
          </div>
        </div>
      )}
    </SectionCard>
  );
}
