import { CalendarSearch, Phone, ShieldCheck, UserX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { InvestigationRow, InvestigationSettings } from "@/lib/api-client/custom-hooks/employee-investigation";
import { cn } from "@/lib/utils";
import { useMediaQuery } from "../production-employees/hooks";
import { listSelection, type Selection } from "../salary-slip-center/logic";
import { AwayCell, DecisionCell, KindChip, LastAttendedCell, LeaveCell } from "./parts";

type Ticks = {
  allRows: InvestigationRow[];
  selection: Selection;
  onToggle: (row: InvestigationRow) => void;
  onToggleAll: () => void;
};

/** The ticks, when the list has them (all four given). */
const ticksOf = ({ allRows, selection, onToggle, onToggleAll }: Partial<Ticks>): Ticks | null =>
  allRows && selection && onToggle && onToggleAll ? { allRows, selection, onToggle, onToggleAll } : null;

type Props = {
  /** The rows of the current page. */
  rows: InvestigationRow[];
  /** The whole filtered list (every page): what the header checkbox ticks. Undefined = no ticks (the Tonight list). */
  allRows?: InvestigationRow[];
  selection?: Selection;
  onToggle?: (row: InvestigationRow) => void;
  onToggleAll?: () => void;
  settings: InvestigationSettings | undefined;
  /** The 30 Days list: why the Auto Trigger leaves a row alone, as a muted note. */
  showWhyNot: boolean;
  onDetails: (row: InvestigationRow) => void;
  onKeep: (row: InvestigationRow) => void;
  /** Undefined hides Mark inactive (the Tonight list only keeps people active). */
  onInactivate?: (row: InvestigationRow) => void;
  /** Edit rights: without them Keep active and Mark inactive are shown locked. */
  canEdit: boolean;
  busy: boolean;
  /** "inv" for the 15 / 30 Days lists, "inv-tonight" for the Auto Trigger's Tonight list. */
  testPrefix: string;
  caption: string;
};

const INDETERMINATE_CLASS =
  "data-[state=indeterminate]:bg-primary/60 data-[state=indeterminate]:text-primary-foreground";

const LOCKED = "Needs edit rights on this page";

/** The employees as a table, or as cards on a narrow screen (one or the other, never both: a row has one test id). */
export function RowList(props: Props) {
  const wide = useMediaQuery("(min-width: 1024px)");
  return wide ? <RowTable {...props} /> : <RowCards {...props} />;
}

function HeaderCheckbox({
  allRows,
  selection,
  onToggleAll,
  testPrefix,
}: Pick<Ticks, "allRows" | "selection" | "onToggleAll"> & { testPrefix: string }) {
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
      data-testid={`${testPrefix}-select-all`}
    />
  );
}

function RowCheckbox({
  row,
  selection,
  onToggle,
  testPrefix,
}: { row: InvestigationRow; testPrefix: string } & Pick<Ticks, "selection" | "onToggle">) {
  return (
    <Checkbox
      checked={selection.has(row.id)}
      onCheckedChange={() => onToggle(row)}
      aria-label={`Tick ${row.name}`}
      data-testid={`${testPrefix}-select-${row.code}`}
    />
  );
}

function NameCell({ row }: { row: InvestigationRow }) {
  return (
    <div className="min-w-0 leading-tight">
      <div className="flex flex-wrap items-center gap-1.5">
        <p className="truncate font-semibold text-gray-900" title={row.name}>
          {row.name}
        </p>
        <KindChip kind={row.kind} />
      </div>
      <p className="mt-0.5 font-mono text-xs text-gray-500">{row.code}</p>
      <p className="truncate text-xs text-gray-600">
        {row.department || "No department"}
        {row.designation && <> · {row.designation}</>}
      </p>
      {row.unit && <p className="truncate text-[11px] text-gray-400">{row.unit}</p>}
      {row.phone && (
        <a
          href={`tel:${row.phone}`}
          className="mt-0.5 inline-flex items-center gap-1 rounded text-[11px] text-gray-500 hover:text-indigo-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Call ${row.name} on ${row.phone}`}
        >
          <Phone size={10} aria-hidden /> {row.phone}
        </a>
      )}
    </div>
  );
}

function RowActions({
  row,
  onDetails,
  onKeep,
  onInactivate,
  canEdit,
  busy,
  compact,
  testPrefix,
}: { row: InvestigationRow; compact?: boolean } & Pick<
  Props,
  "onDetails" | "onKeep" | "onInactivate" | "canEdit" | "busy" | "testPrefix"
>) {
  return (
    <div className={cn("flex flex-wrap items-center gap-1", !compact && "justify-end")}>
      <Button
        variant="outline"
        size="sm"
        className="h-8 gap-1 px-2.5"
        onClick={() => onDetails(row)}
        aria-label={`Leave details of ${row.name}`}
        data-testid={`${testPrefix}-details-${row.code}`}
      >
        <CalendarSearch size={14} /> Leave details
      </Button>
      <span title={canEdit ? undefined : LOCKED} className="inline-flex">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1 px-2 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800"
          onClick={() => onKeep(row)}
          disabled={!canEdit || busy}
          aria-label={canEdit ? `Keep ${row.name} active` : `Keep active: ${LOCKED}`}
          data-testid={`${testPrefix}-keep-${row.code}`}
        >
          <ShieldCheck size={14} /> Keep active
        </Button>
      </span>
      {onInactivate && (
        <span title={canEdit ? undefined : LOCKED} className="inline-flex">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1 px-2 text-red-700 hover:bg-red-50 hover:text-red-800"
            onClick={() => onInactivate(row)}
            disabled={!canEdit || busy}
            aria-label={canEdit ? `Mark ${row.name} inactive` : `Mark inactive: ${LOCKED}`}
            data-testid={`${testPrefix}-inactivate-${row.code}`}
          >
            <UserX size={14} /> Mark inactive
          </Button>
        </span>
      )}
    </div>
  );
}

function RowTable({
  rows,
  allRows,
  selection,
  onToggle,
  onToggleAll,
  settings,
  showWhyNot,
  caption,
  ...actions
}: Props) {
  const ticks = ticksOf({ allRows, selection, onToggle, onToggleAll });
  return (
    <div className="overflow-x-auto rounded-2xl border bg-white" data-testid={`${actions.testPrefix}-table`}>
      <table className="w-full min-w-[1000px] text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
          <tr>
            {ticks && (
              <th scope="col" className="w-10 px-3 py-2.5">
                <HeaderCheckbox
                  allRows={ticks.allRows}
                  selection={ticks.selection}
                  onToggleAll={ticks.onToggleAll}
                  testPrefix={actions.testPrefix}
                />
              </th>
            )}
            <th scope="col" className="px-3 py-2.5">
              Employee
            </th>
            <th scope="col" className="px-3 py-2.5">
              Last attended
            </th>
            <th scope="col" className="px-3 py-2.5">
              Away
            </th>
            <th scope="col" className="px-3 py-2.5">
              Approved leave
            </th>
            <th scope="col" className="px-3 py-2.5">
              Decision
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
              className={cn("align-top hover:bg-gray-50/60", selection?.has(row.id) && "bg-indigo-50/40")}
              data-testid={`${actions.testPrefix}-row-${row.code}`}
            >
              {ticks && (
                <td className="px-3 py-3">
                  <RowCheckbox
                    row={row}
                    selection={ticks.selection}
                    onToggle={ticks.onToggle}
                    testPrefix={actions.testPrefix}
                  />
                </td>
              )}
              <td className="max-w-[260px] px-3 py-3">
                <NameCell row={row} />
              </td>
              <td className="max-w-[180px] px-3 py-3">
                <LastAttendedCell row={row} />
              </td>
              <td className="px-3 py-3">
                <AwayCell row={row} />
              </td>
              <td className="max-w-[170px] px-3 py-3">
                <LeaveCell row={row} />
              </td>
              <td className="max-w-[280px] px-3 py-3">
                <DecisionCell row={row} settings={settings} showWhyNot={showWhyNot} />
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
  settings,
  showWhyNot,
  caption,
  ...actions
}: Props) {
  const ticks = ticksOf({ allRows, selection, onToggle, onToggleAll });
  return (
    <div className="space-y-2" data-testid={`${actions.testPrefix}-cards`} role="list" aria-label={caption}>
      {ticks && (
        <label className="flex items-center gap-2 px-1 text-xs font-semibold text-gray-500">
          <HeaderCheckbox
            allRows={ticks.allRows}
            selection={ticks.selection}
            onToggleAll={ticks.onToggleAll}
            testPrefix={actions.testPrefix}
          />
          Tick all {ticks.allRows.length} in this list
        </label>
      )}
      {rows.map((row) => (
        <div
          key={row.id}
          role="listitem"
          className={cn(
            "rounded-2xl border bg-white p-3",
            selection?.has(row.id) && "border-indigo-300 bg-indigo-50/40",
          )}
          data-testid={`${actions.testPrefix}-row-${row.code}`}
        >
          <div className="flex items-start gap-3">
            {ticks && (
              <div className="pt-0.5">
                <RowCheckbox
                  row={row}
                  selection={ticks.selection}
                  onToggle={ticks.onToggle}
                  testPrefix={actions.testPrefix}
                />
              </div>
            )}
            <div className="min-w-0 flex-1 space-y-2.5">
              <div className="flex items-start justify-between gap-3">
                <NameCell row={row} />
                <div className="shrink-0 text-right">
                  <AwayCell row={row} />
                </div>
              </div>
              <div className="grid grid-cols-1 gap-2 text-xs min-[420px]:grid-cols-2">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Last attended</p>
                  <LastAttendedCell row={row} />
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Approved leave</p>
                  <LeaveCell row={row} />
                </div>
              </div>
              <DecisionCell row={row} settings={settings} showWhyNot={showWhyNot} />
              <RowActions row={row} compact {...actions} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
