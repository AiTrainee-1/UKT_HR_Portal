import { CalendarDays, ExternalLink, Eye, PenLine, Wand2 } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { MissedCategory, MissedKind, MissedRow } from "@/lib/api-client/custom-hooks/missed-payroll";
import { cn } from "@/lib/utils";
import { useMediaQuery } from "../production-employees/hooks";
import { listSelection, type Selection } from "../salary-slip-center/logic";
import { payrollLink, profileEditPath } from "./logic";
import { BankCell, CategoryChip, EntryCell, PayDaysCell, RowBadges, SalaryCell } from "./parts";

type Props = {
  kind: MissedKind;
  /** The rows of the current page. */
  rows: MissedRow[];
  /** The whole filtered list (every page): what the header checkbox ticks. */
  allRows: MissedRow[];
  /** Ticks are shown (not in Not cleared, a list only to check). */
  selectable: boolean;
  selection: Selection;
  onToggle: (row: MissedRow) => void;
  onToggleAll: () => void;
  onFigures: (row: MissedRow) => void;
  onAttendance: (row: MissedRow) => void;
  /** Generate one employee (edit rights only; undefined hides the button). */
  onGenerate?: (row: MissedRow) => void;
  categoryLabels: Record<MissedCategory, string>;
  /** Show the unit under the department (more than one unit listed). */
  showUnit: boolean;
  busy: boolean;
};

const INDETERMINATE_CLASS =
  "data-[state=indeterminate]:bg-primary/60 data-[state=indeterminate]:text-primary-foreground";

const LINK_CLASS =
  "inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-50 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** The employees as a table, or as cards on a narrow screen (one or the other, never both: a row has one test id). */
export function RowList(props: Props) {
  const wide = useMediaQuery("(min-width: 1024px)");
  return wide ? <RowTable {...props} /> : <RowCards {...props} />;
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
          ? `Untick all ${allRows.length} employees in this list`
          : `Tick all ${allRows.length} employees in this list`
      }
      className={INDETERMINATE_CLASS}
      data-testid="mp-select-all"
    />
  );
}

function RowCheckbox({ row, selection, onToggle }: { row: MissedRow } & Pick<Props, "selection" | "onToggle">) {
  return (
    <Checkbox
      checked={selection.has(row.id)}
      onCheckedChange={() => onToggle(row)}
      aria-label={`Tick ${row.name}`}
      data-testid={`mp-select-${row.code}`}
    />
  );
}

/** Why the payroll missed them: the reason pill, the sentence and the detail. */
function ReasonCell({ row, labels }: { row: MissedRow; labels: Record<MissedCategory, string> }) {
  return (
    <div className="min-w-0 space-y-1 leading-snug">
      <CategoryChip category={row.category} label={labels[row.category] ?? row.categoryLabel} />
      <p className="text-xs text-gray-700">{row.reason}</p>
      {row.detail && <p className="text-[11px] text-gray-500">{row.detail}</p>}
    </div>
  );
}

function RowActions({
  row,
  kind,
  onFigures,
  onAttendance,
  onGenerate,
  busy,
  compact,
}: { row: MissedRow; compact?: boolean } & Pick<Props, "kind" | "onFigures" | "onAttendance" | "onGenerate" | "busy">) {
  const link = row.category === "not_cleared" ? payrollLink(row, kind) : null;
  return (
    <div className={cn("flex flex-wrap items-center gap-1", !compact && "justify-end")}>
      {row.entry && (
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1 px-2.5"
          onClick={() => onFigures(row)}
          aria-label={`View the figures of ${row.name}`}
          data-testid={`mp-figures-${row.code}`}
        >
          <Eye size={14} /> Figures
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="h-8 gap-1 px-2"
        onClick={() => onAttendance(row)}
        aria-label={`Check or change the attendance of ${row.name}`}
        title="The month's attendance, and a change sent for approval"
        data-testid={`mp-attendance-${row.code}`}
      >
        <CalendarDays size={14} /> Attendance
      </Button>
      {onGenerate && row.canGenerate && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1 px-2 text-indigo-700"
          onClick={() => onGenerate(row)}
          disabled={busy}
          aria-label={`${row.entry ? "Generate again" : "Generate"} ${row.name}`}
          data-testid={`mp-generate-${row.code}`}
        >
          <Wand2 size={14} /> {row.entry ? "Generate again" : "Generate"}
        </Button>
      )}
      {row.category === "no_salary" && !row.salary && (
        <Link
          href={profileEditPath(row.id)}
          className={LINK_CLASS}
          aria-label={`Set the salary of ${row.name} on the profile`}
          data-testid={`mp-set-salary-${row.code}`}
        >
          <PenLine size={13} /> Set salary
        </Link>
      )}
      {link && (
        <Link
          href={link}
          className={LINK_CLASS}
          aria-label={`Open the payroll details of ${row.name}`}
          data-testid={`mp-open-payroll-${row.code}`}
        >
          <ExternalLink size={13} /> {row.payroll?.id ? "Open Payroll Details" : "Open Production Payroll"}
        </Link>
      )}
    </div>
  );
}

function NameCell({ row, showUnit }: { row: MissedRow; showUnit: boolean }) {
  return (
    <div className="min-w-0 leading-tight">
      <div className="flex flex-wrap items-center gap-1.5">
        <p className="truncate font-semibold text-gray-900" title={row.name}>
          {row.name}
        </p>
        <RowBadges row={row} />
      </div>
      <p className="mt-0.5 font-mono text-xs text-gray-500">{row.code}</p>
      <p className="truncate text-xs text-gray-600">
        {row.department || "No department"}
        {row.designation && <> · {row.designation}</>}
      </p>
      {showUnit && row.unit && <p className="truncate text-[11px] text-gray-400">{row.unit}</p>}
    </div>
  );
}

function RowTable({
  rows,
  allRows,
  selection,
  onToggle,
  onToggleAll,
  showUnit,
  selectable,
  categoryLabels,
  ...actions
}: Props) {
  const production = actions.kind === "production";
  return (
    <div className="overflow-x-auto rounded-2xl border bg-white" data-testid="mp-table">
      <table className="w-full min-w-[1100px] text-sm">
        <caption className="sr-only">Employees the payroll missed</caption>
        <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
          <tr>
            {selectable && (
              <th scope="col" className="w-10 px-3 py-2.5">
                <HeaderCheckbox allRows={allRows} selection={selection} onToggleAll={onToggleAll} />
              </th>
            )}
            <th scope="col" className="px-3 py-2.5">
              Employee
            </th>
            <th scope="col" className="px-3 py-2.5">
              Why missed
            </th>
            <th scope="col" className="px-3 py-2.5">
              Salary
            </th>
            {production && (
              <th scope="col" className="px-3 py-2.5">
                Days to pay
              </th>
            )}
            <th scope="col" className="px-3 py-2.5">
              Status
            </th>
            <th scope="col" className="px-3 py-2.5">
              Bank
            </th>
            <th scope="col" className="px-3 py-2.5 text-right">
              Actions
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row) => (
            <tr
              key={row.id}
              className={cn("align-top hover:bg-gray-50/60", selection.has(row.id) && "bg-indigo-50/40")}
              data-testid={`mp-row-${row.code}`}
            >
              {selectable && (
                <td className="px-3 py-3">
                  <RowCheckbox row={row} selection={selection} onToggle={onToggle} />
                </td>
              )}
              <td className="max-w-[240px] px-3 py-3">
                <NameCell row={row} showUnit={showUnit} />
              </td>
              <td className="max-w-[300px] px-3 py-3">
                <ReasonCell row={row} labels={categoryLabels} />
              </td>
              <td className="px-3 py-3">
                <SalaryCell row={row} kind={actions.kind} />
              </td>
              {production && (
                <td className="max-w-[200px] px-3 py-3">
                  <PayDaysCell row={row} />
                </td>
              )}
              <td className="px-3 py-3">
                <EntryCell row={row} />
              </td>
              <td className="px-3 py-3">
                <BankCell row={row} />
              </td>
              <td className="px-3 py-3">
                <RowActions row={row} {...actions} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RowCards({
  rows,
  allRows,
  selection,
  onToggle,
  onToggleAll,
  showUnit,
  selectable,
  categoryLabels,
  ...actions
}: Props) {
  return (
    <div className="space-y-2" data-testid="mp-cards">
      {selectable && (
        <label className="flex items-center gap-2 px-1 text-xs font-semibold text-gray-500">
          <HeaderCheckbox allRows={allRows} selection={selection} onToggleAll={onToggleAll} />
          Tick all {allRows.length} in this list
        </label>
      )}
      {rows.map((row) => (
        <div
          key={row.id}
          className={cn(
            "rounded-2xl border bg-white p-3",
            selection.has(row.id) && "border-indigo-300 bg-indigo-50/40",
          )}
          data-testid={`mp-row-${row.code}`}
        >
          <div className="flex items-start gap-3">
            {selectable && (
              <div className="pt-0.5">
                <RowCheckbox row={row} selection={selection} onToggle={onToggle} />
              </div>
            )}
            <div className="min-w-0 flex-1 space-y-2">
              <NameCell row={row} showUnit={showUnit} />
              <ReasonCell row={row} labels={categoryLabels} />
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
                <SalaryCell row={row} kind={actions.kind} />
                <BankCell row={row} />
              </div>
              {actions.kind === "production" && <PayDaysCell row={row} />}
              <EntryCell row={row} />
              <RowActions row={row} compact {...actions} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
