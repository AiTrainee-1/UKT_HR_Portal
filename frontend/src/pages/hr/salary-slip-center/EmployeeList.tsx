import { Download, Eye, Hand, PlayCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { SlipCenterEmployee } from "@/lib/api-client/custom-hooks/salary-slip-center";
import { cn } from "@/lib/utils";
import { useMediaQuery } from "../production-employees/hooks";
import { listSelection, type Selection } from "./logic";
import { BankCell, CategoryChip, RowBadges, SalaryCell, SlipCell } from "./parts";

type Props = {
  /** The rows of the current page. */
  rows: SlipCenterEmployee[];
  /** The whole filtered list (every page): what the header checkbox ticks. */
  allRows: SlipCenterEmployee[];
  selection: Selection;
  onToggle: (row: SlipCenterEmployee) => void;
  onToggleAll: () => void;
  onPreview: (row: SlipCenterEmployee) => void;
  onDownload: (row: SlipCenterEmployee) => void;
  /** Hold or Release one employee (edit rights only; undefined hides the button). */
  onHold?: (row: SlipCenterEmployee) => void;
  /** May generate: a row with no saved slip can still be downloaded (it is generated first). */
  canEdit: boolean;
  /** Show the unit under the department (the company has more than one unit). */
  showUnit: boolean;
  /** A job is running: the row buttons wait. */
  busy: boolean;
};

const INDETERMINATE_CLASS =
  "data-[state=indeterminate]:bg-primary/60 data-[state=indeterminate]:text-primary-foreground";

/** The employees as a table, or as cards on a narrow screen (one or the other, never both: a row has one test id). */
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
          ? `Untick all ${allRows.length} employees in this list`
          : `Tick all ${allRows.length} employees in this list`
      }
      className={INDETERMINATE_CLASS}
      data-testid="ssc-select-all"
    />
  );
}

function RowCheckbox({
  row,
  selection,
  onToggle,
}: { row: SlipCenterEmployee } & Pick<Props, "selection" | "onToggle">) {
  return (
    <Checkbox
      checked={selection.has(row.id)}
      onCheckedChange={() => onToggle(row)}
      aria-label={`Tick ${row.name}`}
      data-testid={`ssc-select-${row.code}`}
    />
  );
}

function DeptCell({ row, showUnit }: { row: SlipCenterEmployee; showUnit: boolean }) {
  return (
    <div className="min-w-0 leading-tight">
      <p className="truncate text-gray-800">{row.department || <span className="text-gray-400">No department</span>}</p>
      <p className="truncate text-xs text-gray-500">{row.designation || "—"}</p>
      {showUnit && row.unit && <p className="truncate text-[11px] text-gray-400">{row.unit}</p>}
    </div>
  );
}

function RowActions({
  row,
  onPreview,
  onDownload,
  onHold,
  busy,
  canEdit,
  compact,
}: { row: SlipCenterEmployee; compact?: boolean } & Pick<
  Props,
  "onPreview" | "onDownload" | "onHold" | "busy" | "canEdit"
>) {
  const canDownload = row.slip !== null || canEdit;
  return (
    <div className={cn("flex flex-wrap items-center gap-1", !compact && "justify-end")}>
      <Button
        variant="outline"
        size="sm"
        className="h-8 gap-1 px-2.5"
        onClick={() => onPreview(row)}
        aria-label={`Preview the slip of ${row.name}`}
        data-testid={`ssc-preview-${row.code}`}
      >
        <Eye size={14} /> Preview
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-8 gap-1 px-2"
        onClick={() => onDownload(row)}
        disabled={busy || !canDownload}
        aria-label={`Download the slip of ${row.name}`}
        title={
          row.slip
            ? "Download the saved slip (PDF)"
            : canEdit
              ? "Not generated yet: it is generated first, then downloaded"
              : "Not generated yet: someone with edit rights has to generate it"
        }
        data-testid={`ssc-download-${row.code}`}
      >
        <Download size={14} />
        {compact && "Download slip"}
      </Button>
      {onHold && (
        <Button
          variant="ghost"
          size="sm"
          className={cn("h-8 gap-1 px-2 text-xs", row.onHold ? "text-emerald-700" : "text-orange-700")}
          onClick={() => onHold(row)}
          disabled={busy}
          aria-label={row.onHold ? `Release ${row.name}` : `Hold ${row.name} for the month`}
          title={row.onHold ? "Release: back in the bank file" : "Hold: left out of the bank file this month"}
          data-testid={`ssc-hold-${row.code}`}
        >
          {row.onHold ? <PlayCircle size={14} /> : <Hand size={14} />}
          {row.onHold ? "Release" : "Hold"}
        </Button>
      )}
    </div>
  );
}

function EmployeeTable({ rows, allRows, selection, onToggle, onToggleAll, showUnit, ...actions }: Props) {
  return (
    <div className="overflow-x-auto rounded-2xl border bg-white" data-testid="ssc-table">
      <table className="w-full min-w-[1080px] text-sm">
        <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
          <tr>
            <th className="w-10 px-3 py-2.5">
              <HeaderCheckbox allRows={allRows} selection={selection} onToggleAll={onToggleAll} />
            </th>
            <th className="px-3 py-2.5">Code</th>
            <th className="px-3 py-2.5">Name</th>
            <th className="px-3 py-2.5">Department / Designation</th>
            <th className="px-3 py-2.5">Category</th>
            <th className="px-3 py-2.5">Salary</th>
            <th className="px-3 py-2.5">Bank</th>
            <th className="px-3 py-2.5">Slip</th>
            <th className="px-3 py-2.5 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row) => (
            <tr
              key={row.id}
              className={cn("align-middle hover:bg-gray-50/60", selection.has(row.id) && "bg-indigo-50/40")}
              data-testid={`ssc-row-${row.code}`}
            >
              <td className="px-3 py-2.5">
                <RowCheckbox row={row} selection={selection} onToggle={onToggle} />
              </td>
              <td className="whitespace-nowrap px-3 py-2.5 font-mono text-xs text-gray-600">{row.code}</td>
              <td className="max-w-[220px] px-3 py-2.5">
                <p className="truncate font-semibold text-gray-900" title={row.name}>
                  {row.name}
                </p>
                <div className="mt-0.5 flex flex-wrap gap-1">
                  <RowBadges row={row} />
                </div>
              </td>
              <td className="max-w-[220px] px-3 py-2.5">
                <DeptCell row={row} showUnit={showUnit} />
              </td>
              <td className="px-3 py-2.5">
                <CategoryChip category={row.category} />
              </td>
              <td className="px-3 py-2.5">
                <SalaryCell row={row} />
              </td>
              <td className="px-3 py-2.5">
                <BankCell row={row} />
              </td>
              <td className="px-3 py-2.5">
                <SlipCell row={row} />
              </td>
              <td className="px-3 py-2.5">
                <RowActions row={row} {...actions} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmployeeCards({ rows, allRows, selection, onToggle, onToggleAll, showUnit, ...actions }: Props) {
  return (
    <div className="space-y-2" data-testid="ssc-cards">
      <label className="flex items-center gap-2 px-1 text-xs font-semibold text-gray-500">
        <HeaderCheckbox allRows={allRows} selection={selection} onToggleAll={onToggleAll} />
        Tick all {allRows.length} in this list
      </label>
      {rows.map((row) => (
        <div
          key={row.id}
          className={cn(
            "rounded-2xl border bg-white p-3",
            selection.has(row.id) && "border-indigo-300 bg-indigo-50/40",
          )}
          data-testid={`ssc-row-${row.code}`}
        >
          <div className="flex items-start gap-3">
            <div className="pt-0.5">
              <RowCheckbox row={row} selection={selection} onToggle={onToggle} />
            </div>
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <p className="min-w-0 truncate font-semibold text-gray-900">{row.name}</p>
                <span className="font-mono text-xs text-gray-500">{row.code}</span>
                <RowBadges row={row} />
              </div>
              <p className="text-xs text-gray-600">
                {row.department || "No department"}
                {row.designation && <> · {row.designation}</>}
                {showUnit && row.unit && <> · {row.unit}</>}
              </p>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
                <CategoryChip category={row.category} />
                <SalaryCell row={row} />
                <BankCell row={row} />
              </div>
              <SlipCell row={row} />
              <RowActions row={row} compact {...actions} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
