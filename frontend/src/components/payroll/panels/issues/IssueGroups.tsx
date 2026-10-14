import { useId } from "react";
import { Link } from "wouter";
import { ArrowRight, CalendarDays, CalendarRange, ChevronRight } from "lucide-react";
import { plural } from "@/components/payroll/kit/format";
import { issueLabel, severityRank } from "@/components/payroll/kit/issue-meta";
import { Avatar, IssueChip } from "@/components/payroll/kit/parts";
import { Button, buttonVariants } from "@/components/ui/button";
import type { IssueSeverity, PayrollIssue } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { employeePath } from "../skipped/skipped-logic";
import { IssueRow, SeverityCounts } from "./IssueRow";
import { detailsTarget, issueImpactText, type PagedGroup } from "./issues-logic";
import { ACCENT, type PanelAccent } from "./panel-kit";

// The three ways the list can be arranged. Each draws one group of an IssuePage: a timeline day, an employee's
// accordion or an issue type. A group that began on an earlier page is marked "(continued)".

type Common = {
  /** The names the server gave the issue codes. */
  labels: Record<string, string>;
  accent: PanelAccent;
  onOpenDetails: (issue: PayrollIssue) => void;
};

const Continued = () => <span className="text-xs font-medium text-muted-foreground">(continued)</span>;

/** A day of the timeline ("Tue, 13 Oct 2026 · 4 issues"), or the final "Whole period" group. */
export function DateGroupView({ paged, labels, accent, onOpenDetails }: { paged: PagedGroup } & Common) {
  const { group, rows, continued } = paged;
  const Icon = group.date ? CalendarDays : CalendarRange;
  return (
    <section className="space-y-2" data-testid={`issues-group-${group.key}`} data-group="date">
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1">
        <h4 className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-bold text-gray-900">
          <Icon size={15} className={ACCENT[accent].text} />
          <span data-testid="issues-group-title">
            {group.label}{" "}
            <span className="text-xs font-semibold text-muted-foreground">
              · {plural(group.issues.length, "issue")}
            </span>
          </span>
          {continued && <Continued />}
        </h4>
        <SeverityCounts counts={group.severity} />
      </header>
      {!group.date && (
        <p className="px-1 text-xs text-muted-foreground">
          These are about the whole period, not one day, so they have no single date.
        </p>
      )}
      <ul className="space-y-2">
        {rows.map((issue) => (
          <IssueRow
            key={issue.id}
            issue={issue}
            typeLabel={labels[issue.code] ?? issueLabel(issue.code)}
            showEmployee
            accent={accent}
            onOpenDetails={onOpenDetails}
          />
        ))}
      </ul>
    </section>
  );
}

/** The worst severity among a group's issues (a type has one severity; this keeps a mixed group honest). */
const worstSeverity = (issues: PayrollIssue[]): IssueSeverity =>
  issues.reduce<IssueSeverity>(
    (worst, i) => (severityRank(i.severity) < severityRank(worst) ? i.severity : worst),
    "info",
  );

/** An issue type with its count and what it cost in all. */
export function TypeGroupView({ paged, labels, accent, onOpenDetails }: { paged: PagedGroup } & Common) {
  const { group, rows, continued } = paged;
  const code = group.code ?? rows[0].code;
  const impact = issueImpactText(group.impact);
  return (
    <section className="space-y-2" data-testid={`issues-group-${group.key}`} data-group="type">
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1">
        <h4 className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-bold text-gray-900">
          <IssueChip code={code} severity={worstSeverity(group.issues)} label={group.label} />{" "}
          <span className="text-xs font-semibold text-muted-foreground" data-testid="issues-group-title">
            · {plural(group.issues.length, "issue")}
            {impact && (
              <>
                {" "}
                · Total impact <span className="font-bold tabular-nums text-gray-800">{impact}</span>
              </>
            )}
          </span>
          {continued && <Continued />}
        </h4>
        <SeverityCounts counts={group.severity} />
      </header>
      <ul className="space-y-2">
        {rows.map((issue) => (
          <IssueRow
            key={issue.id}
            issue={issue}
            typeLabel={labels[issue.code] ?? issueLabel(issue.code)}
            showEmployee
            accent={accent}
            onOpenDetails={onOpenDetails}
          />
        ))}
      </ul>
    </section>
  );
}

/**
 * One employee as an accordion: who, how many issues of each severity, what they cost together and the way to the
 * employee's details page; opened, it lists every issue (without repeating the employee on each).
 */
export function EmployeeGroupView({
  paged,
  open,
  onToggle,
  labels,
  accent,
  onOpenDetails,
}: { paged: PagedGroup; open: boolean; onToggle: () => void } & Common) {
  const panelId = useId();
  const { group, rows } = paged;
  const sample = group.issues[0];
  const impact = issueImpactText(group.impact);
  const target = detailsTarget(group.issues);
  const meta = [sample.employeeCode, sample.department ?? "No department", sample.designation]
    .filter(Boolean)
    .join(" · ");
  const key = sample.employeeCode || String(sample.employeeId);

  return (
    <section
      className="clay-card rounded-2xl border border-slate-100"
      data-testid={`issues-employee-${key}`}
      data-group="employee"
      data-open={open ? "true" : "false"}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onToggle}
          className="flex min-w-0 flex-1 basis-56 items-center gap-3 rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid={`issues-employee-toggle-${key}`}
        >
          <ChevronRight
            size={16}
            className={cn("shrink-0 text-gray-400 transition-transform", open && "rotate-90")}
            aria-hidden="true"
          />
          <Avatar name={group.label} />
          <span className="min-w-0">
            <span className="block truncate text-sm font-bold text-gray-900">{group.label}</span>
            <span className="block truncate text-xs text-muted-foreground">{meta}</span>
          </span>
        </button>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <SeverityCounts counts={group.severity} />
          <span className="text-xs text-gray-600" data-testid="issues-employee-count">
            {plural(group.issues.length, "issue")}
          </span>
          {impact && (
            <span className="text-xs text-gray-600" data-testid="issues-employee-impact">
              Impact <span className="font-bold tabular-nums text-gray-900">{impact}</span>
            </span>
          )}
          {target ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-1.5"
              onClick={() => onOpenDetails(target)}
              aria-label={`Open details: ${group.label}`}
              data-testid="issues-employee-open"
            >
              Open details <ArrowRight size={13} />
            </Button>
          ) : (
            <Link
              href={employeePath(sample.employeeId)}
              className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-8 gap-1.5")}
              data-testid="issues-employee-open"
            >
              Open employee <ArrowRight size={13} />
            </Link>
          )}
        </div>
      </div>
      {open && (
        <ul
          id={panelId}
          className="space-y-2 border-t border-slate-100 bg-slate-50/60 p-3"
          data-testid="issues-employee-rows"
        >
          {rows.map((issue) => (
            <IssueRow
              key={issue.id}
              issue={issue}
              typeLabel={labels[issue.code] ?? issueLabel(issue.code)}
              showEmployee={false}
              accent={accent}
              onOpenDetails={onOpenDetails}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
