import { Link } from "wouter";
import { ArrowRight, ArrowUpRight, CalendarDays, CalendarRange, ScrollText } from "lucide-react";
import { dateLong, dateTime } from "@/components/payroll/kit/format";
import { SEVERITY_META } from "@/components/payroll/kit/issue-meta";
import { Avatar, IssueChip } from "@/components/payroll/kit/parts";
import { Button, buttonVariants } from "@/components/ui/button";
import type { IssueSeverity, PayrollIssue } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { classifySkipReason, employeePath } from "../skipped/skipped-logic";
import { issueImpactText } from "./issues-logic";
import { appPath } from "./lists";
import { ACCENT, type PanelAccent } from "./panel-kit";

/** A coloured dot for a severity, with the word for it for anyone who cannot see the colour. */
export function SeverityDot({ severity }: { severity: IssueSeverity }) {
  const meta = SEVERITY_META[severity];
  return (
    <span className="inline-flex shrink-0 items-center" title={meta?.label}>
      <span className={cn("h-2.5 w-2.5 rounded-full", meta?.dot ?? "bg-slate-400")} aria-hidden="true" />
      <span className="sr-only">{meta?.label ?? severity}</span>
    </span>
  );
}

/** "● 2  ● 1": how many issues of each severity, each with its word for a screen reader. Nothing when there are none. */
export function SeverityCounts({ counts, className }: { counts: Record<IssueSeverity, number>; className?: string }) {
  const shown = (["critical", "warning", "info"] as const).filter((s) => counts[s] > 0);
  if (shown.length === 0) return null;
  return (
    <span
      className={cn(
        "inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-semibold text-gray-700",
        className,
      )}
      data-testid="severity-counts"
    >
      {shown.map((s) => (
        <span
          key={s}
          className="inline-flex items-center gap-1"
          title={`${counts[s]} ${SEVERITY_META[s].label}`}
          data-severity={s}
        >
          <span className={cn("h-2 w-2 rounded-full", SEVERITY_META[s].dot)} aria-hidden="true" />
          <span className="tabular-nums">{counts[s]}</span>
          <span className="sr-only">{SEVERITY_META[s].label}</span>
        </span>
      ))}
    </span>
  );
}

/**
 * When the issue was detected. A day issue says the day, prominently ("Detected on Tue, 13 Oct 2026"; hover for the time
 * payroll flagged it). An issue about the whole period has no day, so it says that and when payroll flagged it.
 */
function DetectedOn({ issue }: { issue: PayrollIssue }) {
  const flagged = issue.detectedAt ? `Flagged by payroll ${dateTime(issue.detectedAt)}` : null;
  if (issue.date) {
    return (
      <div
        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-gray-600"
        title={flagged ?? undefined}
        data-testid="issue-detected"
        data-kind="day"
      >
        <CalendarDays size={13} className="text-gray-400" />
        <span>
          Detected on <strong className="font-bold text-gray-900">{dateLong(issue.date)}</strong>
        </span>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-0.5 sm:items-end" data-testid="issue-detected" data-kind="period">
      <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs">
        <CalendarRange size={13} className="text-gray-400" />
        <strong className="font-bold text-gray-900">Whole period</strong>
      </span>
      {(flagged || issue.code === "skipped") && (
        <span className="text-[11px] text-muted-foreground">{flagged ?? "Found when payroll was checked"}</span>
      )}
    </div>
  );
}

export type IssueRowProps = {
  issue: PayrollIssue;
  /** The name of the issue's type ("Late arrival"), from the server's own names when it sent them. */
  typeLabel: string;
  /** False inside the by-employee grouping, whose header already says whose the issues are. */
  showEmployee: boolean;
  accent: PanelAccent;
  onOpenDetails: (issue: PayrollIssue) => void;
};

/**
 * One detected issue: its severity and type, the title, the detail (the specifics), when it was detected, whose it is,
 * what it cost, the rule that fired it (with the link to change that rule) and the way to its details page. An employee
 * payroll skipped has no payroll, so it opens the employee instead and says how to fix it.
 */
export function IssueRow({ issue, typeLabel, showEmployee, accent, onOpenDetails }: IssueRowProps) {
  const impact = issueImpactText(issue.impact);
  const sameAsType = issue.title.trim().toLowerCase() === typeLabel.trim().toLowerCase();
  const skipFix = issue.code === "skipped" ? classifySkipReason(issue.detail, issue.employeeId) : null;
  const where = [issue.employeeCode, issue.department ?? "No department"].filter(Boolean).join(" · ");
  const ruleHref = appPath(issue.rule?.settingsPath);

  return (
    <li
      className="rounded-xl border border-slate-100 bg-white p-3.5 shadow-sm"
      data-testid={`issue-row-${issue.id}`}
      data-severity={issue.severity}
      data-code={issue.code}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <SeverityDot severity={issue.severity} />
          <IssueChip code={issue.code} severity={issue.severity} label={typeLabel} />
          {!sameAsType && (
            <span className="min-w-0 break-words text-sm font-semibold text-gray-900" data-testid="issue-title">
              {issue.title}
            </span>
          )}
        </div>
        <DetectedOn issue={issue} />
      </div>

      <p className="mt-2 break-words text-sm text-gray-700" data-testid="issue-detail">
        {issue.detail}
      </p>
      {skipFix && (
        <p className="mt-1 break-words text-xs text-gray-600" data-testid="issue-fix">
          <span className="font-semibold text-gray-800">How to fix:</span> {skipFix.fix}
          {skipFix.href && skipFix.hrefLabel && skipFix.href !== employeePath(issue.employeeId) && (
            <>
              {" "}
              <Link href={skipFix.href} className={cn("font-semibold hover:underline", ACCENT[accent].link)}>
                {skipFix.hrefLabel}
              </Link>
            </>
          )}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-gray-600">
        {showEmployee && (
          <div className="flex min-w-0 items-center gap-2" data-testid="issue-employee">
            <Avatar name={issue.employeeName} size={26} className="rounded-lg text-[10px]" />
            <div className="min-w-0 leading-tight">
              <p className="truncate text-xs font-semibold text-gray-900">{issue.employeeName}</p>
              <p className="truncate text-[11px] text-muted-foreground">{where}</p>
            </div>
          </div>
        )}
        {impact && (
          <p data-testid="issue-impact">
            Impact <span className="font-bold tabular-nums text-gray-900">{impact}</span>
          </p>
        )}
        {issue.rule && (
          <p className="inline-flex flex-wrap items-center gap-x-1.5" data-testid="issue-rule">
            <ScrollText size={12} className="text-gray-400" />
            <span>
              Rule <span className="font-semibold text-gray-800">{issue.rule.label}</span>
            </span>
            {ruleHref && (
              <Link
                href={ruleHref}
                className={cn("inline-flex items-center gap-0.5 font-semibold hover:underline", ACCENT[accent].link)}
                aria-label={`Open ${issue.rule.label} in Settings`}
                data-testid="issue-rule-link"
              >
                Settings <ArrowUpRight size={11} />
              </Link>
            )}
          </p>
        )}
        <div className="ml-auto">
          {issue.payrollId === null ? (
            <Link
              href={employeePath(issue.employeeId)}
              className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-8 gap-1.5")}
              data-testid="issue-open-employee"
            >
              Open employee <ArrowRight size={13} />
            </Link>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-1.5"
              onClick={() => onOpenDetails(issue)}
              aria-label={`Open details: ${issue.employeeName}, ${issue.title}`}
              data-testid="issue-open-details"
            >
              Open details <ArrowRight size={13} />
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}
