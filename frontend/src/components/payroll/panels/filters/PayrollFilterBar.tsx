import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { RotateCcw, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { IssueCodeCount, IssueSeverity } from "@/lib/api-client/custom-hooks";
import { SEVERITY_META } from "@/components/payroll/kit/issue-meta";
import { TONE } from "@/lib/statusTones";
import { VIEW_SAFE_ATTR } from "@/lib/view-only-lock";
import { cn } from "@/lib/utils";
import {
  ALL,
  DEFAULT_FILTERS,
  SEVERITY_ORDER,
  SORT_OPTIONS,
  STATUS_OPTIONS,
  activeFilterCount,
  departmentLabel,
  filterChips,
  hasChanges,
  issueFilterOptions,
  issueTypeLabel,
  parseSeverities,
  toggleSeverity,
  type DepartmentOption,
  type PayStatusFilter,
  type PayrollFilterState,
  type PayrollSort,
} from "./filter-logic";

export type PayrollFilterBarProps = {
  /** The filters now (kept by the page, usually in the address through `useUrlParams`). */
  value: PayrollFilterState;
  /** Called with the whole next state. The search box calls it once per pause (250 ms), the rest at once. */
  onChange: (next: PayrollFilterState) => void;
  /** The departments to choose from (`useListDepartments()` data, or `departmentOptionsFromRuns(runs)`). */
  departments?: DepartmentOption[];
  /**
   * The issue types that exist for this period (`issues.summary.byCode`): the issue select lists them with their
   * counts. Leave it out when the page has no issue data and the issue controls are hidden.
   */
  issueOptions?: IssueCodeCount[];
  /** The issues are on their way: the issue controls show but wait. */
  issuesLoading?: boolean;
  /** How many rows pass the filters out of how many there are ("Showing 12 of 120"). */
  shown?: number;
  total?: number;
  /** The page's own buttons (Generate, Export ...), at the right end of the first row. Not covered by view-safe. */
  rightSlot?: ReactNode;
  /** Everything waits (the rows are loading). */
  disabled?: boolean;
  /** The page picks the department itself (a strip of department tabs): the department select is left out. */
  hideDepartment?: boolean;
  /** How long the search box waits after the last keystroke. */
  searchDelayMs?: number;
  /** Test ids are `<prefix>-search`, `<prefix>-dept` and so on (default "pf"). */
  testIdPrefix?: string;
  className?: string;
};

const CLEAR_LABEL: Record<string, string> = {
  q: "Clear the search",
  dept: "Clear the department filter",
  status: "Clear the payment filter",
  issue: "Clear the issue type filter",
  onlyIssues: "Clear the only-with-issues filter",
};

// What a button says to assistive technology must not carry free text (a department called "New Products" would trip
// the view-only lock's word list), so a chip's clear button gets a fixed sentence, not its chip's label.
const clearLabel = (key: string): string =>
  key.startsWith("severity-")
    ? `Clear the ${SEVERITY_META[key.slice("severity-".length) as IssueSeverity]?.label ?? "severity"} severity filter`
    : (CLEAR_LABEL[key] ?? "Clear this filter");

function FilterSelect({
  value,
  onChange,
  label,
  testId,
  items,
  disabled,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  testId: string;
  items: { value: string; label: string; disabled?: boolean }[];
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className={cn("h-10", className)} aria-label={label} data-testid={testId}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value} disabled={item.disabled}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * The toolbar above a payroll list: search, department, payment status, issue type, severity, "only with issues" and
 * sort, with a count of the filters on, a removable chip for each, and a Reset. It owns no filter state besides the text
 * being typed (so the search can wait for a pause); everything else is `value` in, `onChange` out. The filter controls
 * are view-safe (filtering only reads), `rightSlot` is not.
 */
export function PayrollFilterBar({
  value,
  onChange,
  departments = [],
  issueOptions,
  issuesLoading = false,
  shown,
  total,
  rightSlot,
  disabled = false,
  hideDepartment = false,
  searchDelayMs = 250,
  testIdPrefix = "pf",
  className,
}: PayrollFilterBarProps) {
  const p = testIdPrefix;

  // The search text is typed here and handed up after a pause; every other filter goes up at once.
  const [draft, setDraft] = useState(value.q);
  const committed = useRef(value.q);
  const latest = useRef({ value, onChange });
  useEffect(() => {
    latest.current = { value, onChange };
  });
  useEffect(() => {
    // The page changed the search (Reset, a chip, the address): the box follows.
    if (value.q !== committed.current) {
      committed.current = value.q;
      setDraft(value.q);
    }
  }, [value.q]);
  useEffect(() => {
    if (draft === committed.current) return;
    const timer = setTimeout(() => {
      committed.current = draft;
      latest.current.onChange({ ...latest.current.value, q: draft });
    }, searchDelayMs);
    return () => clearTimeout(timer);
  }, [draft, searchDelayMs]);

  const change = (patch: Partial<PayrollFilterState>) => {
    if (patch.q !== undefined) {
      committed.current = patch.q;
      setDraft(patch.q);
    }
    onChange({ ...value, ...patch });
  };
  const reset = () => {
    committed.current = DEFAULT_FILTERS.q;
    setDraft(DEFAULT_FILTERS.q);
    onChange({ ...DEFAULT_FILTERS });
  };

  const issuesShown = issueOptions !== undefined || issuesLoading;
  const issuesWait = issuesLoading || disabled;
  const options = useMemo(() => issueFilterOptions(issueOptions), [issueOptions]);
  const departmentItems = useMemo(() => {
    const items = [
      { value: ALL, label: "All departments" },
      ...departments.map((d) => ({ value: String(d.id), label: d.name })),
    ];
    // An address can name a department the list does not have: keep it visible rather than a blank box.
    if (value.dept !== ALL && !items.some((i) => i.value === value.dept))
      items.push({ value: value.dept, label: departmentLabel(value.dept, departments) });
    return items;
  }, [departments, value.dept]);
  const issueItems = useMemo(() => {
    const items = [
      { value: ALL, label: "All issue types" },
      ...options.map((o) => ({ value: o.code as string, label: `${o.label} (${o.count})` })),
    ];
    if (value.issue !== ALL && !items.some((i) => i.value === value.issue))
      items.push({ value: value.issue, label: issueTypeLabel(value.issue, issueOptions) });
    return items;
  }, [options, value.issue, issueOptions]);
  const sortItems = SORT_OPTIONS.map((o) => ({ ...o, disabled: o.value === "issues" && !issuesShown }));

  const count = activeFilterCount(value);
  const chips = filterChips(value, { departments, issues: issueOptions });
  const chosen = parseSeverities(value.severity);
  const countText =
    shown === undefined || total === undefined
      ? null
      : shown === total
        ? `${total} payroll ${total === 1 ? "record" : "records"}`
        : `Showing ${shown} of ${total}`;

  return (
    <div
      className={cn("min-w-0 space-y-3 rounded-2xl border bg-white p-3", className)}
      role="search"
      aria-label="Filter the payroll"
      data-testid={`${p}-bar`}
    >
      {/* One row that wraps: the search takes what is left of its line, the selects keep their width, and the page's own
          buttons go to the right. `contents` lets the view-safe wrapper join the same row without a box of its own. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="contents" {...{ [VIEW_SAFE_ATTR]: "" }}>
          <div className="relative min-w-[14rem] flex-1">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") change({ q: draft });
              }}
              placeholder="Search by name or employee code"
              aria-label="Search by employee name or code"
              className="h-10 pl-9 pr-9"
              disabled={disabled}
              data-testid={`${p}-search`}
            />
            {draft && (
              <button
                type="button"
                onClick={() => change({ q: "" })}
                aria-label="Clear the search text"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:text-gray-700"
                data-testid={`${p}-search-clear`}
              >
                <X size={14} />
              </button>
            )}
          </div>
          {!hideDepartment && (
            <FilterSelect
              value={value.dept}
              onChange={(dept) => change({ dept })}
              label="Department"
              testId={`${p}-dept`}
              items={departmentItems}
              disabled={disabled}
              className="w-[calc(50%-0.25rem)] sm:w-44"
            />
          )}
          <FilterSelect
            value={value.status}
            onChange={(status) => change({ status: status as PayStatusFilter })}
            label="Payment status"
            testId={`${p}-status`}
            items={[...STATUS_OPTIONS]}
            disabled={disabled}
            className="w-[calc(50%-0.25rem)] sm:w-36"
          />
          {issuesShown && (
            <FilterSelect
              value={value.issue}
              onChange={(issue) => change({ issue })}
              label="Issue type"
              testId={`${p}-issue`}
              items={issueItems}
              disabled={issuesWait}
              className="w-[calc(50%-0.25rem)] sm:w-48"
            />
          )}
          <FilterSelect
            value={value.sort}
            onChange={(sort) => change({ sort: sort as PayrollSort })}
            label="Sort by"
            testId={`${p}-sort`}
            items={sortItems}
            disabled={disabled}
            className="w-[calc(50%-0.25rem)] sm:w-48"
          />
        </div>
        {rightSlot && (
          <div className="flex flex-wrap items-center gap-2 lg:ml-auto" data-testid={`${p}-right`}>
            {rightSlot}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2" {...{ [VIEW_SAFE_ATTR]: "" }}>
        {issuesShown && (
          <>
            <div
              className="flex flex-wrap items-center gap-1.5"
              role="group"
              aria-label="Issue severity"
              data-testid={`${p}-severity`}
            >
              <span className="mr-0.5 text-xs font-medium text-muted-foreground">Severity</span>
              {SEVERITY_ORDER.map((severity) => {
                const meta = SEVERITY_META[severity];
                const on = chosen.includes(severity);
                return (
                  <button
                    key={severity}
                    type="button"
                    aria-pressed={on}
                    disabled={issuesWait}
                    onClick={() => change({ severity: toggleSeverity(value.severity, severity) })}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors disabled:opacity-50",
                      on
                        ? cn(TONE[meta.tone], "ring-1 ring-current/30")
                        : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50",
                    )}
                    data-testid={`${p}-sev-${severity}`}
                  >
                    <span className={cn("h-2 w-2 rounded-full", meta.dot)} aria-hidden="true" />
                    {meta.label}
                  </button>
                );
              })}
            </div>
            <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-semibold text-gray-700">
              <Switch
                checked={value.onlyIssues}
                onCheckedChange={(onlyIssues) => change({ onlyIssues })}
                disabled={issuesWait}
                data-testid={`${p}-only-issues`}
              />
              Only with issues
            </label>
          </>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">
          {countText && (
            <p className="text-xs text-gray-500" aria-live="polite" data-testid={`${p}-count`}>
              {countText}
            </p>
          )}
          {count > 0 && (
            <p className="text-xs font-semibold text-indigo-700" data-testid={`${p}-active`}>
              {count} {count === 1 ? "filter" : "filters"} on
            </p>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            disabled={disabled || !hasChanges(value)}
            onClick={reset}
            data-testid={`${p}-reset`}
          >
            <RotateCcw size={13} /> Reset
          </Button>
        </div>
      </div>

      {chips.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-1.5 border-t border-gray-100 pt-2.5"
          data-testid={`${p}-chips`}
          {...{ [VIEW_SAFE_ATTR]: "" }}
        >
          {chips.map((chip) => (
            <span
              key={chip.key}
              className="inline-flex items-center gap-1 rounded-full border border-indigo-100 bg-indigo-50 py-0.5 pl-2.5 pr-1 text-[11px] font-semibold text-indigo-800"
              data-testid={`${p}-chip-${chip.key}`}
            >
              {chip.label}
              <button
                type="button"
                onClick={() => change(chip.clear)}
                disabled={disabled}
                aria-label={clearLabel(chip.key)}
                className="rounded-full p-0.5 hover:bg-indigo-100 disabled:opacity-50"
                data-testid={`${p}-chip-${chip.key}-clear`}
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
