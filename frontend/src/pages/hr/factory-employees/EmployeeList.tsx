import { Link } from "wouter";
import { AlertTriangle, CheckCircle2, ChevronDown, Clock, Eye, MoreHorizontal, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { FactoryEmployee, FactoryLabel, FactoryPayCycle } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { Chip } from "../account-management/parts";
import { useMediaQuery } from "../production-employees/hooks";
import {
  NO_LABEL,
  PAY_CYCLE_LABEL,
  PAY_CYCLE_LIST,
  categoryOf,
  isPayCycleValue,
  listSelection,
  payText,
  payrollFix,
  shiftText,
  sortLabels,
  type Rights,
  type Selection,
} from "./logic";
import { AMBER_CHIP, CategoryChip, GREEN_CHIP, GREY_CHIP, LabelChip } from "./parts";

/** What a row (or the bulk bar) can ask the page to do. */
export type RowActions = {
  onProfile: (row: FactoryEmployee) => void;
  onEdit: (row: FactoryEmployee, focus?: "salary") => void;
  onShift: (rows: FactoryEmployee[]) => void;
  onShiftRemove: (rows: FactoryEmployee[]) => void;
  onPayroll: (rows: FactoryEmployee[]) => void;
  onLabel: (rows: FactoryEmployee[], labelId: number | null) => void;
  onRemove: (rows: FactoryEmployee[]) => void;
  onStatus: (rows: FactoryEmployee[], status: "active" | "inactive") => void;
  /** Production Payroll's frequency for someone who has none (the "No pay cycle" quick fix). */
  onCycle: (row: FactoryEmployee, cycle: FactoryPayCycle) => void;
};

type Props = {
  rows: FactoryEmployee[];
  /** The whole filtered list (every page): what the header checkbox selects. */
  allRows: FactoryEmployee[];
  selection: Selection;
  onToggle: (row: FactoryEmployee) => void;
  onToggleAll: () => void;
  labels: FactoryLabel[];
  rights: Rights;
  actions: RowActions;
  busy: boolean;
  stale: boolean;
};

const INDETERMINATE = "data-[state=indeterminate]:bg-primary/60 data-[state=indeterminate]:text-primary-foreground";

/** The employees as a table, or as cards on a narrow screen (one or the other: a row has one test id). */
export function EmployeeList(props: Props) {
  const wide = useMediaQuery("(min-width: 1024px)");
  return wide ? <EmployeeTable {...props} /> : <EmployeeCards {...props} />;
}

function HeaderCheckbox({ allRows, selection, onToggleAll }: Pick<Props, "allRows" | "selection" | "onToggleAll">) {
  const state = listSelection(selection, allRows);
  return (
    <Checkbox
      checked={state === "all" ? true : state === "some" ? "indeterminate" : false}
      onCheckedChange={onToggleAll}
      disabled={allRows.length === 0}
      aria-label={
        state === "all"
          ? `Deselect all ${allRows.length} employees in this list`
          : `Select all ${allRows.length} employees in this list`
      }
      className={INDETERMINATE}
      data-testid="fe-select-all"
    />
  );
}

function RowCheckbox({ row, selection, onToggle }: { row: FactoryEmployee } & Pick<Props, "selection" | "onToggle">) {
  return (
    <Checkbox
      checked={selection.has(row.id)}
      onCheckedChange={() => onToggle(row)}
      aria-label={`Select ${row.name}`}
      data-testid={`fe-select-${row.code}`}
    />
  );
}

function NameCell({ row, onProfile }: { row: FactoryEmployee; onProfile: (row: FactoryEmployee) => void }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <p className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => onProfile(row)}
          className="truncate text-left font-semibold text-gray-900 hover:text-teal-700 hover:underline"
          data-testid={`fe-name-${row.code}`}
        >
          {row.name}
        </button>
        {row.status !== "active" && <Chip className={GREY_CHIP}>Inactive</Chip>}
      </p>
      <p className="text-xs text-muted-foreground">
        <span className="font-mono">{row.code}</span>
        {row.phone && <> · {row.phone}</>}
      </p>
    </div>
  );
}

function ShiftCell({ row }: { row: FactoryEmployee }) {
  if (!row.shift) {
    return (
      <span
        className="inline-flex"
        title="Not on any shift: attendance has no hours to judge them by"
        data-testid={`fe-noshift-${row.code}`}
      >
        <Chip className={AMBER_CHIP}>
          <Clock size={10} /> No shift
        </Chip>
      </span>
    );
  }
  return (
    <div className="min-w-0 text-xs" data-testid={`fe-shift-${row.code}`}>
      <p className="truncate font-semibold text-gray-800">{row.shift.name}</p>
      <p className="text-gray-500">
        {row.shift.startTime && row.shift.endTime
          ? `${row.shift.startTime}-${row.shift.endTime}`
          : shiftText(row.shift)}
        {row.shift.saturdayOff && " · Sat off"}
      </p>
    </div>
  );
}

/** The quick fix of a payroll problem: choose the Production Payroll frequency, or set the salary. */
function FixButton({
  row,
  rights,
  actions,
  busy,
}: {
  row: FactoryEmployee;
  rights: Rights;
  actions: RowActions;
  busy: boolean;
}) {
  const fix = payrollFix(row);
  if (!rights.manage) return null;
  if (fix === "cycle") {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 border-amber-300 px-2 text-xs text-amber-900"
            disabled={busy}
            aria-label={`Set the Production Payroll frequency of ${row.name}`}
            data-testid={`fe-fix-${row.code}`}
          >
            Set frequency <ChevronDown size={12} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48">
          <DropdownMenuLabel className="text-xs text-gray-500">Production Payroll</DropdownMenuLabel>
          <DropdownMenuRadioGroup value="" onValueChange={(v) => isPayCycleValue(v) && actions.onCycle(row, v)}>
            {PAY_CYCLE_LIST.map((c) => (
              <DropdownMenuRadioItem key={c} value={c} data-testid={`fe-fix-${row.code}-${c}`}>
                {PAY_CYCLE_LABEL[c]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  if (fix === "salary") {
    return (
      <Button
        size="sm"
        variant="outline"
        className="h-7 border-amber-300 px-2 text-xs text-amber-900"
        onClick={() => actions.onEdit(row, "salary")}
        aria-label={`Edit the salary of ${row.name}`}
        data-testid={`fe-fix-${row.code}`}
      >
        Edit salary
      </Button>
    );
  }
  return null;
}

function PayrollCell({
  row,
  rights,
  actions,
  busy,
}: {
  row: FactoryEmployee;
  rights: Rights;
  actions: RowActions;
  busy: boolean;
}) {
  return (
    <div className="min-w-0 space-y-1" data-testid={`fe-payroll-${row.code}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <CategoryChip category={categoryOf(row)} />
        {row.payrollIssue ? (
          <span
            className="inline-flex"
            title="Payroll skips this employee until this is fixed"
            data-testid={`fe-issue-${row.code}`}
          >
            <Chip className={AMBER_CHIP}>
              <AlertTriangle size={10} /> {row.payrollIssue}
            </Chip>
          </span>
        ) : (
          <span className="inline-flex" data-testid={`fe-ready-${row.code}`}>
            <Chip className={GREEN_CHIP}>
              <CheckCircle2 size={10} /> Ready
            </Chip>
          </span>
        )}
      </div>
      <p className="text-xs text-gray-600">{payText(row)}</p>
      {row.payrollIssue && <FixButton row={row} rights={rights} actions={actions} busy={busy} />}
    </div>
  );
}

/** A row's menu: payroll, shift, label, status, the full profile, and taking them out of the page. */
function RowMenu({
  row,
  labels,
  rights,
  actions,
  busy,
}: {
  row: FactoryEmployee;
  labels: FactoryLabel[];
  rights: Rights;
  actions: RowActions;
  busy: boolean;
}) {
  const code = row.code;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          disabled={busy}
          aria-label={`More for ${row.name}`}
          data-testid={`fe-menu-${code}`}
        >
          <MoreHorizontal size={16} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        {rights.manage && (
          <>
            <DropdownMenuItem onSelect={() => actions.onPayroll([row])} data-testid={`fe-menu-${code}-payroll`}>
              Set payroll
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => actions.onShift([row])} data-testid={`fe-menu-${code}-shift`}>
              {row.shift ? "Change shift" : "Assign shift"}
            </DropdownMenuItem>
            {row.shift && (
              <DropdownMenuItem
                onSelect={() => actions.onShiftRemove([row])}
                data-testid={`fe-menu-${code}-shift-remove`}
              >
                Take off the shift
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-gray-500">Label</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={row.labelId == null ? NO_LABEL : String(row.labelId)}
              onValueChange={(v) => actions.onLabel([row], v === NO_LABEL ? null : Number(v))}
            >
              {sortLabels(labels).map((l) => (
                <DropdownMenuRadioItem key={l.id} value={String(l.id)} data-testid={`fe-menu-${code}-label-${l.id}`}>
                  <span className="mr-2 inline-block h-2.5 w-2.5 rounded-full" style={{ background: l.color }} />
                  {l.name}
                </DropdownMenuRadioItem>
              ))}
              <DropdownMenuRadioItem value={NO_LABEL} data-testid={`fe-menu-${code}-label-none`}>
                No label
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
          </>
        )}
        {rights.setStatus && (
          <DropdownMenuItem
            onSelect={() => actions.onStatus([row], row.status === "active" ? "inactive" : "active")}
            data-testid={`fe-menu-${code}-status`}
          >
            {row.status === "active" ? "Mark inactive" : "Mark active"}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild>
          <Link href={`/hr/employees/${row.id}`} data-testid={`fe-menu-${code}-full`}>
            Open full profile
          </Link>
        </DropdownMenuItem>
        {rights.manage && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-red-700 focus:text-red-800"
              onSelect={() => actions.onRemove([row])}
              data-testid={`fe-menu-${code}-remove`}
            >
              Remove from Factory Employees
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RowButtons({
  row,
  labels,
  rights,
  actions,
  busy,
}: {
  row: FactoryEmployee;
  labels: FactoryLabel[];
  rights: Rights;
  actions: RowActions;
  busy: boolean;
}) {
  return (
    <div className="inline-flex items-center gap-1">
      <Button
        variant="ghost"
        size="sm"
        className="h-8 w-8 p-0"
        onClick={() => actions.onProfile(row)}
        aria-label={`Profile and history of ${row.name}`}
        title="Profile and history"
        data-testid={`fe-profile-${row.code}`}
      >
        <Eye size={15} />
      </Button>
      {(rights.editEmployee || rights.manage) && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          onClick={() => actions.onEdit(row)}
          aria-label={`Edit ${row.name}`}
          title="Edit details and payroll"
          data-testid={`fe-edit-${row.code}`}
        >
          <Pencil size={14} />
        </Button>
      )}
      <RowMenu row={row} labels={labels} rights={rights} actions={actions} busy={busy} />
    </div>
  );
}

function EmployeeTable({
  rows,
  allRows,
  selection,
  onToggle,
  onToggleAll,
  labels,
  rights,
  actions,
  busy,
  stale,
}: Props) {
  return (
    <div
      className={cn("overflow-x-auto rounded-2xl border bg-white transition-opacity", stale && "opacity-60")}
      data-testid="fe-table"
    >
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
          <tr>
            <th className="w-10 px-3 py-2.5">
              <HeaderCheckbox allRows={allRows} selection={selection} onToggleAll={onToggleAll} />
            </th>
            <th className="px-3 py-2.5">Employee</th>
            <th className="px-3 py-2.5">Label</th>
            <th className="px-3 py-2.5">Shift</th>
            <th className="px-3 py-2.5">Payroll</th>
            <th className="px-3 py-2.5 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row) => (
            <tr
              key={row.id}
              className={cn("align-top hover:bg-gray-50/60", selection.has(row.id) && "bg-teal-50/40")}
              data-testid={`fe-row-${row.code}`}
            >
              <td className="px-3 py-3">
                <RowCheckbox row={row} selection={selection} onToggle={onToggle} />
              </td>
              <td className="px-3 py-3">
                <NameCell row={row} onProfile={actions.onProfile} />
              </td>
              <td className="px-3 py-3">
                <LabelChip name={row.label} color={row.labelColor} testId={`fe-label-${row.code}`} />
              </td>
              <td className="px-3 py-3">
                <ShiftCell row={row} />
              </td>
              <td className="px-3 py-3">
                <PayrollCell row={row} rights={rights} actions={actions} busy={busy} />
              </td>
              <td className="px-3 py-3 text-right">
                <RowButtons row={row} labels={labels} rights={rights} actions={actions} busy={busy} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmployeeCards({
  rows,
  allRows,
  selection,
  onToggle,
  onToggleAll,
  labels,
  rights,
  actions,
  busy,
  stale,
}: Props) {
  return (
    <div className={cn("space-y-2 transition-opacity", stale && "opacity-60")} data-testid="fe-cards">
      <div className="flex items-center gap-2 px-1 text-xs font-semibold text-gray-500">
        <HeaderCheckbox allRows={allRows} selection={selection} onToggleAll={onToggleAll} />
        Select all in this list
      </div>
      {rows.map((row) => (
        <div
          key={row.id}
          className={cn("rounded-2xl border bg-white p-3", selection.has(row.id) && "border-teal-300 bg-teal-50/40")}
          data-testid={`fe-row-${row.code}`}
        >
          <div className="flex items-start gap-3">
            <div className="pt-1">
              <RowCheckbox row={row} selection={selection} onToggle={onToggle} />
            </div>
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <NameCell row={row} onProfile={actions.onProfile} />
                <RowButtons row={row} labels={labels} rights={rights} actions={actions} busy={busy} />
              </div>
              <LabelChip name={row.label} color={row.labelColor} testId={`fe-label-${row.code}`} />
              <ShiftCell row={row} />
              <PayrollCell row={row} rights={rights} actions={actions} busy={busy} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
