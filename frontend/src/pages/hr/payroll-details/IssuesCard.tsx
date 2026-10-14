import { useMemo } from "react";
import { Link } from "wouter";
import {
  AlertTriangle,
  ArrowUpRight,
  CalendarDays,
  CalendarRange,
  CheckCircle2,
  Layers,
  RotateCcw,
  Search,
  SearchX,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ExportMenu } from "@/components/payroll/kit/ExportMenu";
import { dateLong, dateTime, plural } from "@/components/payroll/kit/format";
import { SEVERITY_META, issueLabel } from "@/components/payroll/kit/issue-meta";
import { EmptyNote, IssueChip, SectionCard, SeverityChip } from "@/components/payroll/kit/parts";
import type { IssueSeverity, PayrollDetails, PayrollIssue } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import type { Accent } from "./accent";
import { issueExportItems } from "./exports";
import { FilterSelect, SegmentedToggle, ToggleChip } from "./parts";
import {
  activeFilterCount,
  factValue,
  filterIssues,
  groupIssuesByDate,
  groupIssuesByType,
  humanizeKey,
  impactParts,
  impactTotalsText,
  sectionDomId,
  severityCounts,
  typeOptions,
} from "./logic";
import type { IssueFilterState } from "./use-issue-filters";

const SEVERITIES: IssueSeverity[] = ["critical", "warning", "info"];

const EDGE: Record<IssueSeverity, string> = {
  critical: "border-l-red-500",
  warning: "border-l-amber-500",
  info: "border-l-sky-500",
};

/**
 * Everything payroll detected on this payroll, with the date each issue was detected: filter by severity, kind, date
 * range or words, group by date (in weeks) or by kind, and export what is shown. Each row says what happened, when,
 * what it cost, which rule fired it and the raw facts behind it.
 */
export function IssuesCard({
  details,
  accent,
  state,
  company,
  degraded,
}: {
  details: PayrollDetails;
  accent: Accent;
  state: IssueFilterState;
  company: string;
  /** No breakdown behind this payroll: its issues cannot be detected, which is not the same as there being none. */
  degraded: boolean;
}) {
  const { filters, groupBy, setGroupBy, patch, toggleSeverity, reset } = state;
  const all = details.issues;
  const shown = useMemo(() => filterIssues(all, filters), [all, filters]);
  const counts = useMemo(() => severityCounts(all), [all]);
  const options = useMemo(() => typeOptions(details.issueCounts?.byCode, all), [details.issueCounts, all]);
  const bands = useMemo(() => (groupBy === "date" ? groupIssuesByDate(shown) : []), [groupBy, shown]);
  const groups = useMemo(() => (groupBy === "type" ? groupIssuesByType(shown) : []), [groupBy, shown]);
  const active = activeFilterCount(filters);
  const { start, end } = details.period;

  const exportItems = useMemo(
    () =>
      issueExportItems({
        details,
        issues: shown,
        company,
        hint: `The ${shown.length} ${shown.length === 1 ? "issue" : "issues"} shown below, with the date of each`,
        keyPrefix: "",
      }),
    [details, shown, company],
  );

  return (
    <SectionCard
      id={sectionDomId("issues")}
      testId="pd-section-issues"
      className="scroll-mt-16"
      icon={AlertTriangle}
      title="Issues detected"
      description={`Everything payroll flagged on this record${
        details.generatedAt ? ` when it computed it on ${dateTime(details.generatedAt)}` : ""
      }, each with the day it happened on and the rule behind it.`}
      actions={
        all.length > 0 && (
          <span className="print:hidden">
            <ExportMenu items={exportItems} testId="pd-issues-export" />
          </span>
        )
      }
    >
      {all.length === 0 && degraded ? (
        <EmptyNote
          icon={AlertTriangle}
          title="Issues cannot be detected for this payroll"
          hint="Payroll detects issues from the day-by-day breakdown it stores, and this payroll has none."
          testId="pd-issues-unavailable"
        />
      ) : all.length === 0 ? (
        <div
          className="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-emerald-200 bg-emerald-50/50 px-6 py-12 text-center"
          data-testid="pd-issues-clean"
        >
          <CheckCircle2 size={34} className="text-emerald-500" />
          <p className="text-sm font-bold text-emerald-800">No issues detected - this payroll is clean</p>
          <p className="max-w-md text-xs text-emerald-900/70">
            Payroll found nothing to flag for {details.employee.name} in {details.period.label}: no late, early, absent
            or missing-punch days, and the profile is complete.
          </p>
        </div>
      ) : (
        <>
          <div className="space-y-3 print:hidden" data-testid="pd-issue-filters">
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by severity">
              {SEVERITIES.map((severity) => (
                <ToggleChip
                  key={severity}
                  pressed={filters.severities.includes(severity)}
                  onClick={() => toggleSeverity(severity)}
                  tone={SEVERITY_META[severity].tone}
                  disabled={counts[severity] === 0 && !filters.severities.includes(severity)}
                  testId={`pd-issue-sev-${severity}`}
                >
                  <span className={cn("h-1.5 w-1.5 rounded-full", SEVERITY_META[severity].dot)} />
                  {SEVERITY_META[severity].label}
                  <span className="tabular-nums opacity-70">{counts[severity]}</span>
                </ToggleChip>
              ))}
            </div>

            <div className="flex flex-wrap items-end gap-2">
              <FilterSelect
                value={filters.code}
                onChange={(code) => patch({ code })}
                label="Filter by kind of issue"
                testId="pd-issue-type"
                className="w-full sm:w-56"
              >
                <option value="all">All kinds ({all.length})</option>
                {options.map((o) => (
                  <option key={o.code} value={o.code}>
                    {o.label} ({o.count})
                  </option>
                ))}
              </FilterSelect>
              <DateInput
                label="From"
                value={filters.from}
                min={start}
                max={filters.to || end}
                onChange={(from) => patch({ from })}
                testId="pd-issue-from"
              />
              <DateInput
                label="To"
                value={filters.to}
                min={filters.from || start}
                max={end}
                onChange={(to) => patch({ to })}
                testId="pd-issue-to"
              />
              <div className="relative min-w-[11rem] flex-1 sm:max-w-xs">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={filters.query}
                  onChange={(e) => patch({ query: e.target.value })}
                  placeholder="Search the issues…"
                  aria-label="Search the issues"
                  className="h-9 rounded-xl pl-8 text-sm"
                  data-testid="pd-issue-search"
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-9 gap-1.5"
                disabled={active === 0}
                onClick={reset}
                data-testid="pd-issue-reset"
              >
                <RotateCcw size={13} /> Reset{active > 0 ? ` (${active})` : ""}
              </Button>
              <div className="sm:ml-auto">
                <SegmentedToggle
                  label="Group the issues"
                  value={groupBy}
                  onChange={setGroupBy}
                  activeClass={accent.solid}
                  testId="pd-issue-groupby"
                  items={[
                    {
                      value: "date",
                      label: (
                        <>
                          <CalendarDays size={13} /> By date
                        </>
                      ),
                      testId: "pd-issue-group-date",
                    },
                    {
                      value: "type",
                      label: (
                        <>
                          <Layers size={13} /> By type
                        </>
                      ),
                      testId: "pd-issue-group-type",
                    },
                  ]}
                />
              </div>
            </div>
          </div>

          <p className="mb-3 mt-4 text-xs text-muted-foreground" data-testid="pd-issue-count" aria-live="polite">
            Showing <strong className="text-slate-700">{shown.length}</strong> of {all.length}{" "}
            {all.length === 1 ? "issue" : "issues"}
            {active > 0 && ` · ${plural(active, "filter")} on`}
          </p>

          {shown.length === 0 ? (
            <EmptyNote
              icon={SearchX}
              title="No issue matches these filters"
              hint="Widen the date range, pick another kind or severity, or search for something else."
              testId="pd-issues-empty"
              action={
                <Button variant="outline" size="sm" className="mt-1 h-8 gap-1.5" onClick={reset}>
                  <RotateCcw size={13} /> Reset the filters
                </Button>
              }
            />
          ) : groupBy === "date" ? (
            <div className="space-y-5" data-testid="pd-issues-by-date">
              {bands.map((band) => (
                <div key={band.key} data-testid={`pd-issue-band-${band.key}`}>
                  <div className="flex items-center justify-between gap-2 rounded-lg bg-slate-100 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-600">
                    <span className="flex items-center gap-1.5">
                      {band.start ? <CalendarRange size={12} /> : <AlertTriangle size={12} />} {band.label}
                      {!band.start && (
                        <span className="font-semibold normal-case tracking-normal text-slate-500">
                          · not tied to a single day
                        </span>
                      )}
                    </span>
                    <span className="tabular-nums">{plural(band.count, "issue")}</span>
                  </div>
                  {band.days.map((day) => (
                    <div key={day.key} className="mt-3" data-testid={`pd-issue-day-${day.key}`}>
                      {day.date && (
                        <h4 className="mb-1.5 flex flex-wrap items-center gap-x-2 text-sm font-bold text-slate-800">
                          <CalendarDays size={14} className={accent.text} />
                          {day.label}
                          <span className="text-xs font-semibold text-muted-foreground">
                            {plural(day.issues.length, "issue")}
                          </span>
                        </h4>
                      )}
                      <ul className="space-y-2">
                        {day.issues.map((issue) => (
                          <IssueRow key={issue.id} issue={issue} accent={accent} />
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-5" data-testid="pd-issues-by-type">
              {groups.map((group) => (
                <div key={group.code} data-testid={`pd-issue-type-${group.code}`}>
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-100 px-3 py-1.5">
                    <span className="flex items-center gap-2 text-sm font-bold text-slate-800">
                      <IssueChip code={group.code} severity={group.severity} />
                      <span className="text-xs font-semibold text-muted-foreground">
                        {plural(group.issues.length, "issue")}
                      </span>
                    </span>
                    {impactTotalsText(group.totals) && (
                      <span className="text-xs font-semibold tabular-nums text-slate-600">
                        Cost: {impactTotalsText(group.totals)}
                      </span>
                    )}
                  </div>
                  <ul className="space-y-2">
                    {group.issues.map((issue) => (
                      <IssueRow key={issue.id} issue={issue} accent={accent} />
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </SectionCard>
  );
}

function DateInput({
  label,
  value,
  min,
  max,
  onChange,
  testId,
}: {
  label: string;
  value: string;
  min: string;
  max: string;
  onChange: (value: string) => void;
  testId: string;
}) {
  return (
    <label className="flex flex-col gap-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
      {label}
      <input
        type="date"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(e.target.value)}
        aria-label={`Issues ${label.toLowerCase()} date`}
        data-testid={testId}
        className="h-9 rounded-xl border border-slate-200 bg-white px-2 text-xs font-medium normal-case tracking-normal text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-slate-300"
      />
    </label>
  );
}

/** One issue: what it is, what happened, the day it was detected on, what it cost, the rule behind it and the facts. */
function IssueRow({ issue, accent }: { issue: PayrollIssue; accent: Accent }) {
  const meta = SEVERITY_META[issue.severity];
  const impact = impactParts(issue.impact);
  const facts = Object.entries(issue.facts ?? {});
  // The type chip already says "Late arrival": repeat the server's title only when it adds something.
  const showTitle = issue.title.trim().toLowerCase() !== issueLabel(issue.code).toLowerCase();
  return (
    <li
      className={cn(
        "break-inside-avoid rounded-xl border border-l-4 border-slate-100 bg-white px-4 py-3",
        EDGE[issue.severity],
      )}
      data-testid={`pd-issue-${issue.id}`}
      data-severity={issue.severity}
      data-code={issue.code}
      data-date={issue.date ?? ""}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", meta.dot)} aria-hidden="true" />
          <IssueChip code={issue.code} severity={issue.severity} />
          {showTitle && <span className="text-sm font-bold text-slate-900">{issue.title}</span>}
        </div>
        <SeverityChip severity={issue.severity} />
      </div>

      <p className="mt-1.5 text-sm leading-snug text-slate-700" data-testid="pd-issue-detail">
        {issue.detail}
      </p>

      <div className="mt-2.5 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs">
        {issue.date ? (
          <span className="inline-flex items-center gap-1.5 font-bold text-slate-900" data-testid="pd-issue-date">
            <CalendarDays size={13} className={accent.text} /> Detected on {dateLong(issue.date)}
          </span>
        ) : (
          <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5" data-testid="pd-issue-date">
            <span className="inline-flex items-center gap-1.5 font-bold text-slate-900">
              <CalendarRange size={13} className={accent.text} /> Whole period
            </span>
            {issue.detectedAt && (
              <span className="font-normal text-muted-foreground">
                Flagged by payroll on {dateTime(issue.detectedAt)}
              </span>
            )}
          </span>
        )}
        {impact.length > 0 && (
          <span className="inline-flex flex-wrap items-center gap-1.5" data-testid="pd-issue-impact">
            <span className="text-muted-foreground">Impact</span>
            {impact.map((part) => (
              <span
                key={part}
                className="rounded-md bg-slate-100 px-1.5 py-0.5 font-semibold tabular-nums text-slate-700"
              >
                {part}
              </span>
            ))}
          </span>
        )}
        {issue.rule && (
          <span className="inline-flex flex-wrap items-center gap-x-1.5" data-testid="pd-issue-rule">
            <span className="text-muted-foreground">Rule</span>
            <strong className="font-semibold text-slate-700">{issue.rule.label}</strong>
            {issue.rule.settingsPath && (
              <Link
                href={issue.rule.settingsPath}
                className={cn(
                  "inline-flex items-center gap-0.5 font-semibold underline-offset-2 hover:underline print:hidden",
                  accent.text,
                )}
              >
                Open in Settings <ArrowUpRight size={11} />
              </Link>
            )}
          </span>
        )}
      </div>

      {facts.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5" data-testid="pd-issue-facts">
          {facts.map(([key, value]) => (
            <span
              key={key}
              className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600"
              title={humanizeKey(key)}
            >
              {humanizeKey(key)}: {factValue(value)}
            </span>
          ))}
        </div>
      )}
    </li>
  );
}
