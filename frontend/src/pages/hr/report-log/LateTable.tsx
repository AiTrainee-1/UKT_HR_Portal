import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Info } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { Chip } from "../leave/parts";
import SelectAllBox from "./SelectAllBox";
import { selectState } from "./selection";
import {
  LATE_COLUMNS,
  SEVERITY_BANDS,
  cellText,
  clock,
  explain,
  formatMinutes,
  severityOf,
  UNIT_BAND_COLORS,
  type LateEntry,
  type LateGroup,
  type LateSort,
  type LateSortKey,
  type Severity,
} from "./late";

/** The three steps of the colour scale (the same colours as the Excel file and the PDF). */
const SEVERITY_CLASS: Record<Severity, string> = {
  low: "border-amber-200 bg-amber-100 text-amber-800",
  mid: "border-orange-300 bg-orange-200 text-orange-800",
  high: "border-red-300 bg-red-200 text-red-800",
};

/** What "Late by (after grace)" means: the help line under the table's title and the header's hover text. */
export const LATE_BY_HELP =
  "Late by (after grace) = punch-in time minus (shift start + grace). After shift start counts from the shift start itself.";

/** The legend of the colour steps. */
export function SeverityLegend() {
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="severity-legend" aria-label="Colour steps">
      <span className="text-xs text-gray-500">Late by</span>
      {SEVERITY_BANDS.map((band) => (
        <Chip key={band.key} className={SEVERITY_CLASS[band.key]}>
          {band.label}
        </Chip>
      ))}
    </div>
  );
}

function SortHead({
  column,
  sort,
  onSort,
  className,
  children,
  title,
}: {
  column: LateSortKey;
  sort: LateSort;
  onSort: (column: LateSortKey) => void;
  className?: string;
  children: ReactNode;
  title?: string;
}) {
  const active = sort.key === column;
  const Icon = !active ? ArrowUpDown : sort.dir === "asc" ? ArrowUp : ArrowDown;
  const align = LATE_COLUMNS.find((c) => c.key === column)?.align;
  return (
    <TableHead
      className={cn(align === "center" && "text-center", className)}
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        title={title ?? `Sort by ${LATE_COLUMNS.find((c) => c.key === column)?.header ?? "unit"}`}
        className={cn(
          "inline-flex items-center gap-1 rounded text-left font-medium leading-tight hover:text-gray-900",
          active ? "text-gray-900" : "text-muted-foreground",
        )}
        data-testid={`sort-${column}`}
      >
        {children}
        <Icon size={13} className={active ? "text-indigo-600" : "text-gray-400"} aria-hidden />
      </button>
    </TableHead>
  );
}

/** How late: the main figure (after grace) in its colour step, and under it the minutes after the shift start. */
function LateBy({ entry }: { entry: LateEntry }) {
  const level = severityOf(entry.minutesLate);
  return (
    <div className="flex flex-col items-center gap-0.5" title={explain(entry)}>
      <span
        className={cn(
          "inline-flex min-w-[4.5rem] items-center justify-center rounded-full border px-2.5 py-0.5 text-xs font-bold tabular-nums",
          level ? SEVERITY_CLASS[level] : "border-gray-200 bg-gray-50 text-gray-500",
        )}
        data-testid={`late-by-${entry.employeeId}`}
        data-severity={level ?? "none"}
      >
        {formatMinutes(entry.minutesLate)}
      </span>
      <span className="text-[11px] tabular-nums text-gray-500" data-testid={`after-start-${entry.employeeId}`}>
        {entry.minutesAfterStart == null ? "—" : `${entry.minutesAfterStart} min`} after shift start
      </span>
    </div>
  );
}

/** The late staff, one row each. With `groups` the rows come unit by unit, each unit under a slim section row (its label, how
 *  many were late, and a box that ticks the whole unit); without it the list is flat, in the order of `entries`, and the Unit
 *  column says which unit each row belongs to. `entries` is always the rows in the order shown (it is what the header box ticks). */
export default function LateTable({
  entries,
  groups,
  sort,
  onSort,
  selected,
  onToggle,
  onToggleAll,
  onToggleGroup,
}: {
  entries: LateEntry[];
  groups: LateGroup[] | null;
  sort: LateSort;
  onSort: (column: LateSortKey) => void;
  /** The ticked rows (by employee id), the box of one row, the box of the header (every row in view) and a unit's box. */
  selected: ReadonlySet<number>;
  onToggle: (employeeId: number) => void;
  onToggleAll: () => void;
  onToggleGroup: (group: LateGroup) => void;
}) {
  const rows = entries.map((e) => ({ employeeId: e.employeeId }));

  const rowOf = (entry: LateEntry) => (
    <TableRow
      key={entry.employeeId}
      data-testid={`late-row-${entry.employeeId}`}
      data-state={selected.has(entry.employeeId) ? "selected" : undefined}
    >
      <TableCell className="w-10 pl-4">
        <Checkbox
          checked={selected.has(entry.employeeId)}
          onCheckedChange={() => onToggle(entry.employeeId)}
          aria-label={`Select ${entry.name}`}
          data-testid={`late-select-${entry.employeeId}`}
        />
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-sm font-semibold text-gray-900" data-testid="late-name">
            {cellText(entry, "name")}
          </span>
          {/* the unit has a column of its own from a medium screen up; on a phone it stays beside the name */}
          <UnitBadge unit={entry.unit} className="md:hidden" />
        </div>
        <p className="font-mono text-xs text-gray-500 sm:hidden">{cellText(entry, "code")}</p>
      </TableCell>
      <TableCell className="hidden whitespace-nowrap font-mono text-xs text-gray-600 sm:table-cell">
        {cellText(entry, "code")}
      </TableCell>
      <TableCell className="hidden text-sm text-gray-600 md:table-cell">{cellText(entry, "department")}</TableCell>
      <TableCell className="hidden md:table-cell" data-testid={`late-unit-${entry.employeeId}`}>
        <UnitBadge unit={entry.unit} />
      </TableCell>
      <TableCell className="hidden whitespace-nowrap text-center text-sm tabular-nums text-gray-700 md:table-cell">
        {cellText(entry, "shiftStart")}
      </TableCell>
      <TableCell className="hidden text-center text-sm tabular-nums text-gray-700 lg:table-cell">
        {cellText(entry, "grace")}
      </TableCell>
      <TableCell className="text-center text-sm font-semibold tabular-nums text-gray-900 sm:whitespace-nowrap">
        {clock(entry.punchIn)}
      </TableCell>
      <TableCell className="pr-4">
        <LateBy entry={entry} />
      </TableCell>
    </TableRow>
  );

  return (
    <Table data-testid="late-table">
      <TableHeader>
        <TableRow>
          <TableHead className="w-10 pl-4">
            <SelectAllBox state={selectState(rows, selected)} count={entries.length} onToggle={onToggleAll} />
          </TableHead>
          <SortHead column="name" sort={sort} onSort={onSort}>
            Employee Name
          </SortHead>
          <SortHead column="code" sort={sort} onSort={onSort} className="hidden sm:table-cell">
            Employee Code
          </SortHead>
          <SortHead column="department" sort={sort} onSort={onSort} className="hidden md:table-cell">
            Department
          </SortHead>
          <SortHead column="unit" sort={sort} onSort={onSort} className="hidden md:table-cell">
            Unit
          </SortHead>
          <SortHead column="shiftStart" sort={sort} onSort={onSort} className="hidden md:table-cell">
            Shift Start Time
          </SortHead>
          <SortHead column="grace" sort={sort} onSort={onSort} className="hidden lg:table-cell">
            Grace Period (minutes)
          </SortHead>
          <SortHead column="punchIn" sort={sort} onSort={onSort}>
            Actual Punch-In Time
          </SortHead>
          <SortHead column="minutesLate" sort={sort} onSort={onSort} className="pr-4" title={LATE_BY_HELP}>
            <span className="flex flex-col items-center leading-tight">
              <span className="inline-flex items-center gap-1">
                Total Minutes Late
                <Info size={12} className="text-gray-400" aria-hidden />
              </span>
              <span className="text-[10px] font-normal text-gray-500">late by (after grace)</span>
            </span>
          </SortHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {groups
          ? groups.map((group) => [
              <TableRow
                key={`group-${group.key}`}
                data-testid={`late-group-${group.key}`}
                className="border-y border-indigo-100 hover:bg-transparent"
                style={{ background: UNIT_BAND_COLORS.bg }}
              >
                <TableCell className="w-10 py-1.5 pl-4">
                  <SelectAllBox
                    state={selectState(group.entries, selected)}
                    count={group.entries.length}
                    onToggle={() => onToggleGroup(group)}
                    label={`all ${group.entries.length} in ${group.label}`}
                    testId={`late-group-select-${group.key}`}
                  />
                </TableCell>
                <TableCell colSpan={8} className="py-1.5" style={{ color: UNIT_BAND_COLORS.text }}>
                  <span className="text-sm font-bold" data-testid={`late-group-label-${group.key}`}>
                    {group.label}
                  </span>
                  <span className="ml-3 text-xs font-semibold opacity-80" data-testid={`late-group-count-${group.key}`}>
                    {group.entries.length} late
                  </span>
                  {group.branchName && group.branchName !== group.label && (
                    <span className="ml-3 hidden text-xs font-normal opacity-70 sm:inline">{group.branchName}</span>
                  )}
                </TableCell>
              </TableRow>,
              ...group.entries.map(rowOf),
            ])
          : entries.map(rowOf)}
      </TableBody>
    </Table>
  );
}

/** The unit as a small badge. */
function UnitBadge({ unit, className }: { unit: string; className?: string }) {
  return <Chip className={cn("border-teal-200 bg-teal-50 font-mono text-teal-700", className)}>{unit}</Chip>;
}
