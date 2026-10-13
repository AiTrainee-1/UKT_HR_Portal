import { Checkbox } from "@/components/ui/checkbox";
import type { PayCycle, ProductionEmployeeRow } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { Chip } from "../account-management/parts";
import { useMediaQuery } from "./hooks";
import { listSelection, type Selection } from "./logic";
import { AssignMenu, CycleChip, LastPayrollCell, RateCell } from "./parts";

type Props = {
  /** The rows of the current page. */
  rows: ProductionEmployeeRow[];
  /** The whole filtered list (every page): what the header checkbox selects. */
  allRows: ProductionEmployeeRow[];
  selection: Selection;
  onToggle: (row: ProductionEmployeeRow) => void;
  onToggleAll: () => void;
  onAssign: (row: ProductionEmployeeRow, cycle: PayCycle | null) => void;
  /** An assignment is in flight: the menus wait for it. */
  busy: boolean;
  /** The list shown is the previous one while a new filter loads. */
  stale: boolean;
};

const INDETERMINATE_CLASS =
  "data-[state=indeterminate]:bg-primary/60 data-[state=indeterminate]:text-primary-foreground";

/** The employees as a table, or as cards on a narrow screen (one or the other, never both: a row has one test id). */
export function EmployeeList(props: Props) {
  const wide = useMediaQuery("(min-width: 768px)");
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
      className={INDETERMINATE_CLASS}
      data-testid="pe-select-all"
    />
  );
}

function RowCheckbox({
  row,
  selection,
  onToggle,
}: { row: ProductionEmployeeRow } & Pick<Props, "selection" | "onToggle">) {
  return (
    <Checkbox
      checked={selection.has(row.id)}
      onCheckedChange={() => onToggle(row)}
      aria-label={`Select ${row.name}`}
      data-testid={`pe-select-${row.employeeCode}`}
    />
  );
}

function NameCell({ row }: { row: ProductionEmployeeRow }) {
  return (
    <div className="min-w-0">
      <p className="flex flex-wrap items-center gap-1.5 font-semibold text-gray-900">
        <span className="truncate">{row.name}</span>
        {row.status !== "active" && <Chip className="border-gray-200 bg-gray-50 text-gray-500">Inactive</Chip>}
      </p>
      <p className="font-mono text-xs text-muted-foreground">{row.employeeCode}</p>
    </div>
  );
}

const dash = <span className="text-gray-400">—</span>;

function EmployeeTable({ rows, allRows, selection, onToggle, onToggleAll, onAssign, busy, stale }: Props) {
  return (
    <div
      className={cn("overflow-x-auto rounded-2xl border bg-white transition-opacity", stale && "opacity-60")}
      data-testid="pe-table"
    >
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
          <tr>
            <th className="w-10 px-3 py-2.5">
              <HeaderCheckbox allRows={allRows} selection={selection} onToggleAll={onToggleAll} />
            </th>
            <th className="px-3 py-2.5">Employee</th>
            <th className="px-3 py-2.5">Department</th>
            <th className="px-3 py-2.5">Designation</th>
            <th className="px-3 py-2.5">Salary per shift</th>
            <th className="px-3 py-2.5">Pay cycle</th>
            <th className="px-3 py-2.5">Last payroll</th>
            <th className="px-3 py-2.5 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row) => (
            <tr
              key={row.id}
              className={cn("hover:bg-gray-50/60", selection.has(row.id) && "bg-amber-50/40")}
              data-testid={`pe-row-${row.employeeCode}`}
              data-cycle={row.payCycle ?? "none"}
            >
              <td className="px-3 py-2.5 align-middle">
                <RowCheckbox row={row} selection={selection} onToggle={onToggle} />
              </td>
              <td className="px-3 py-2.5 align-middle">
                <NameCell row={row} />
              </td>
              <td className="px-3 py-2.5 align-middle text-gray-700">{row.departmentName ?? dash}</td>
              <td className="px-3 py-2.5 align-middle text-gray-700">{row.designationTitle ?? dash}</td>
              <td className="px-3 py-2.5 align-middle">
                <RateCell value={row.salaryPerShift} />
              </td>
              <td className="px-3 py-2.5 align-middle">
                <CycleChip cycle={row.payCycle} />
              </td>
              <td className="px-3 py-2.5 align-middle">
                <LastPayrollCell payroll={row.lastPayroll} currentCycle={row.payCycle} />
              </td>
              <td className="px-3 py-2.5 text-right align-middle">
                <AssignMenu row={row} disabled={busy} onAssign={onAssign} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmployeeCards({ rows, allRows, selection, onToggle, onToggleAll, onAssign, busy, stale }: Props) {
  return (
    <div className={cn("space-y-2 transition-opacity", stale && "opacity-60")} data-testid="pe-cards">
      <div className="flex items-center gap-2 px-1 text-xs font-semibold text-gray-500">
        <HeaderCheckbox allRows={allRows} selection={selection} onToggleAll={onToggleAll} />
        Select all in this list
      </div>
      {rows.map((row) => (
        <div
          key={row.id}
          className={cn("rounded-2xl border bg-white p-3", selection.has(row.id) && "border-amber-300 bg-amber-50/40")}
          data-testid={`pe-row-${row.employeeCode}`}
          data-cycle={row.payCycle ?? "none"}
        >
          <div className="flex items-start gap-3">
            <div className="pt-1">
              <RowCheckbox row={row} selection={selection} onToggle={onToggle} />
            </div>
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <NameCell row={row} />
                <AssignMenu row={row} disabled={busy} onAssign={onAssign} />
              </div>
              <p className="text-xs text-gray-600">
                {row.departmentName ?? "No department"}
                {row.designationTitle && <> · {row.designationTitle}</>}
              </p>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <CycleChip cycle={row.payCycle} />
                <span className="text-gray-500">Per shift:</span>
                <RateCell value={row.salaryPerShift} />
              </div>
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="text-gray-500">Last payroll:</span>
                <LastPayrollCell payroll={row.lastPayroll} currentCycle={row.payCycle} />
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
