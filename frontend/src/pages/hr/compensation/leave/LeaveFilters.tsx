import { useMemo } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useListDepartments } from "@/lib/api-client";
import { getListBranchesQueryKey, useListBranches } from "@/lib/api-client/custom-hooks";
import { departmentOptions } from "@/lib/departments";
import { VIEW_SAFE_ATTR } from "@/lib/view-only-lock";
import { CONTROL_H, SelectFilter, type FilterOption } from "@/pages/hr/outpass-visitors/kit";
import { cn } from "@/lib/utils";
import { MONTH_NAMES, yearChoices } from "../logic";
import { WHOLE_YEAR } from "./leave-logic";
import { stepMonth } from "./claims-logic";
import type { MonthChoice } from "./leave-url";

// The filter pieces the Compensation Leave lists share: the month (with Previous / Next and, where it makes sense, "All
// months"), the staff departments and the branches (no branch filter for a login that sees one branch), and the chip of an
// employee a cross-link opened the list on.

const MONTH_OPTIONS: FilterOption[] = MONTH_NAMES.map((name, i) => ({ value: String(i + 1), label: name }));

const STEP =
  "inline-flex shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-700 " +
  "hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 size-11 sm:size-9";

/**
 * Month + year as two selects with Previous / Next around them. `onChange` gets the month as a string ("1".."12", or "all"
 * with `allowAll`) and the year as a string, ready for the address.
 */
export function MonthFilter({
  value,
  today,
  onChange,
  allowAll = false,
  label = "Month",
  testId,
}: {
  value: MonthChoice;
  today: string;
  onChange: (month: string, year: string) => void;
  allowAll?: boolean;
  label?: string;
  testId: string;
}) {
  const years = useMemo(() => yearChoices(today).map((y) => ({ value: String(y), label: String(y) })), [today]);
  const step = (delta: number) => {
    if (value.all) return;
    const next = stepMonth(value.month, value.year, delta);
    onChange(String(next.month), String(next.year));
  };
  const monthOptions = allowAll ? [{ value: WHOLE_YEAR, label: "All months" }, ...MONTH_OPTIONS] : MONTH_OPTIONS;
  return (
    <div className="flex w-full min-w-0 items-center gap-1.5 sm:w-auto" {...{ [VIEW_SAFE_ATTR]: "" }}>
      <button
        type="button"
        className={STEP}
        onClick={() => step(-1)}
        disabled={value.all}
        aria-label="Previous month"
        title="Previous month"
        data-testid={`${testId}-prev`}
      >
        <ChevronLeft size={15} />
      </button>
      <SelectFilter
        label={label}
        value={value.all ? WHOLE_YEAR : String(value.month)}
        onChange={(m) => onChange(m, value.all ? "" : String(value.year))}
        options={monthOptions}
        testId={`${testId}-month`}
        className="w-auto flex-1 sm:flex-none"
      />
      <SelectFilter
        label={`${label}: year`}
        value={value.all ? String(yearChoices(today)[1]) : String(value.year)}
        onChange={(y) => onChange(value.all ? "" : String(value.month), y)}
        options={years}
        disabled={value.all}
        testId={`${testId}-year`}
        className="w-auto flex-1 sm:flex-none"
      />
      <button
        type="button"
        className={STEP}
        onClick={() => step(1)}
        disabled={value.all}
        aria-label="Next month"
        title="Next month"
        data-testid={`${testId}-next`}
      >
        <ChevronRight size={15} />
      </button>
    </div>
  );
}

/** The staff departments and the branches as filter options (no branches for a login that sees one branch only). */
export function useOrgFilterOptions() {
  const { user } = useAuth();
  const branchScoped = !!user?.branchId;
  const { data: departments } = useListDepartments();
  const { data: branches } = useListBranches({ enabled: !branchScoped, queryKey: getListBranchesQueryKey() });
  // compensation is for staff only, so only Staff departments are offered
  const deptOptions = useMemo<FilterOption[]>(
    () => departmentOptions(departments, { category: "staff" }).map((o) => ({ value: o.value, label: o.label })),
    [departments],
  );
  const branchOptions = useMemo<FilterOption[]>(
    () => (branches ?? []).map((b) => ({ value: String(b.id), label: b.name })),
    [branches],
  );
  return { deptOptions, branchOptions, branchScoped };
}

/** Department and (when the login sees every branch) branch. */
export function OrgFilters({
  dept,
  branch,
  onDept,
  onBranch,
  testId,
}: {
  dept: string;
  branch: string;
  onDept: (value: string) => void;
  onBranch: (value: string) => void;
  testId: string;
}) {
  const { deptOptions, branchOptions, branchScoped } = useOrgFilterOptions();
  return (
    <>
      <SelectFilter
        label="Department"
        value={dept}
        onChange={onDept}
        options={deptOptions}
        allLabel="All departments"
        testId={`${testId}-dept`}
      />
      {!branchScoped && (
        <SelectFilter
          label="Branch"
          value={branch}
          onChange={onBranch}
          options={branchOptions}
          allLabel="All branches"
          testId={`${testId}-branch`}
        />
      )}
    </>
  );
}

/** "Employee: Fara Khan ×": the list was opened on one employee (a link from a claim or a balance); × shows everyone. */
export function EmployeeChip({ name, onClear, testId }: { name: string | null; onClear: () => void; testId: string }) {
  return (
    <span
      className={cn(
        CONTROL_H,
        "inline-flex max-w-full items-center gap-1 rounded-lg border border-indigo-200 bg-indigo-50 pl-2.5 text-sm text-indigo-800",
      )}
      data-testid={testId}
    >
      <span className="truncate">Employee: {name ?? "one employee"}</span>
      <button
        type="button"
        onClick={onClear}
        aria-label="Show every employee"
        title="Show every employee"
        className="flex size-11 items-center justify-center text-indigo-700 hover:text-indigo-900 sm:size-9"
        {...{ [VIEW_SAFE_ATTR]: "" }}
        data-testid={`${testId}-clear`}
      >
        <X size={14} />
      </button>
    </span>
  );
}
