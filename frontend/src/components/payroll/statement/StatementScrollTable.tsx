import { useMemo, type CSSProperties, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { SalaryStatement, StatementColumn, StatementGroup, StatementRow } from "@/lib/api-client/custom-hooks";
import { Chip } from "@/components/payroll/kit/parts";
import { cn } from "@/lib/utils";
import { VIEW_SAFE_ATTR } from "@/lib/view-only-lock";
import { ACCENT, GROUP_BAND, GROUP_HEAD, STATUS_ACCENT, STATUS_TEXT, type AccentStyle } from "./accent";
import {
  GRAND_TOTAL_LABEL,
  cellValue,
  columnBands,
  columnWidthsPx,
  fitWidths,
  formatCell,
  remarkChips,
  rowName,
  stickyCount,
  stickyOffsets,
  subtotalLabel,
  type ColumnGroupKey,
  type StatementAccent,
} from "./statement-model";
import { useElementWidth } from "./use-element-width";

// The statement as one continuous table you scroll: a grouped header that stays at the top, SNO / ID NO / Name that stay at
// the left, department bands, zebra rows, a subtotal per department and the grand total pinned at the bottom.
//
// Sticky offsets: the first header row is 28px (h-7) tall and the second sticks at top-7 = 28px, so the two add up; a sticky
// column's `left` is the sum of the widths of the columns before it (the same widths the <col>s are given).

/** The Actions column the pages may add (Mark as Cleared, Adjust ...). */
const ACTIONS_PX = 132;
/** Below this width the table scrolls as a whole: three sticky columns would leave no room for the figures. */
export const STICKY_MIN_WIDTH = 720;

const alignClass = (col: StatementColumn): string =>
  col.align === "right" ? "text-right" : col.align === "center" ? "text-center" : "text-left";

const bandClass = (group: ColumnGroupKey, accent: AccentStyle): string =>
  group === "result" ? accent.resultBand : GROUP_BAND[group];
const headClass = (group: ColumnGroupKey, accent: AccentStyle): string =>
  group === "result" ? accent.resultHead : GROUP_HEAD[group];

export type StatementScrollTableProps = {
  statement: SalaryStatement;
  accent: StatementAccent;
  onOpenDetails?: (row: StatementRow) => void;
  renderRowActions?: (row: StatementRow) => ReactNode;
};

export function StatementScrollTable({
  statement,
  accent,
  onOpenDetails,
  renderRowActions,
}: StatementScrollTableProps) {
  const a = ACCENT[accent];
  const columns = statement.columns;
  const [setWrap, width] = useElementWidth<HTMLDivElement>();
  const natural = useMemo(() => columnWidthsPx(columns), [columns]);
  const hasActions = !!renderRowActions;
  // a table narrower than its container is stretched to fill it (all columns by the same factor); a wider one scrolls
  const room = width > 0 ? width - (hasActions ? ACTIONS_PX : 0) : 0;
  const widths = useMemo(() => fitWidths(natural, room), [natural, room]);
  const sticky = stickyCount(columns);
  const stickyOn = sticky > 0 && (width === 0 || width >= STICKY_MIN_WIDTH);
  const lefts = useMemo(() => stickyOffsets(widths, sticky), [widths, sticky]);
  const bands = useMemo(() => columnBands(columns, sticky), [columns, sticky]);
  const colCount = columns.length + (hasActions ? 1 : 0);
  const tableWidth = widths.reduce((sum, w) => sum + w, 0) + (hasActions ? ACTIONS_PX : 0);
  /** Columns before this are the label of a subtotal / total line (SNO .. Name, the sticky ones). */
  const labelSpan = Math.max(1, sticky);

  const isSticky = (i: number) => stickyOn && i < sticky;
  const edge = (i: number) => stickyOn && i === sticky - 1;
  const leftOf = (i: number): CSSProperties | undefined => (isSticky(i) ? { left: lefts[i] } : undefined);

  const figureCell = (col: StatementColumn, row: StatementRow, summary: boolean): ReactNode => {
    const cell = formatCell(col, cellValue(row, col), summary ? { blankNull: true } : {});
    if (cell.text === "") return null;
    if (col.format === "text") {
      return (
        <span className="block truncate" title={cell.text}>
          {cell.text}
        </span>
      );
    }
    return <span className={cn("tabular-nums", cell.zero && !summary && "text-slate-400")}>{cell.text}</span>;
  };

  const dataCell = (col: StatementColumn, i: number, row: StatementRow, zebra: boolean): ReactNode => {
    const isName = col.key === "name";
    const common = cn(
      "h-[34px] border-b border-slate-100 px-2 align-middle transition-colors",
      zebra ? "bg-slate-50" : "bg-white",
      a.hover,
      alignClass(col),
      isSticky(i) && "sticky z-10",
      edge(i) && "border-r border-r-slate-200",
      col.group === "result" && col.format !== "text" && "font-bold text-slate-900",
    );
    let content: ReactNode;
    if (col.key === "remarks") {
      const chips = remarkChips(cellValue(row, col));
      content =
        chips.length > 0 ? (
          <span className="flex flex-wrap gap-1">
            {chips.map((chip) => (
              <Chip key={chip.label} tone={chip.tone}>
                {chip.label}
              </Chip>
            ))}
          </span>
        ) : null;
    } else if (isName && onOpenDetails) {
      const name = rowName(row);
      content = (
        <span className="block min-w-0" {...{ [VIEW_SAFE_ATTR]: "" }}>
          <button
            type="button"
            onClick={() => onOpenDetails(row)}
            className={cn(
              "flex max-w-full items-center gap-1 rounded text-left font-semibold text-slate-900 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2",
              a.link,
              a.ring,
            )}
            title="Open the payroll details"
            aria-label={`Details of ${name}`}
            data-testid={`statement-details-${row.payrollId ?? name}`}
          >
            <span className="truncate">{name}</span>
            <ChevronRight size={12} className="shrink-0 opacity-0 group-hover:opacity-60" aria-hidden="true" />
          </button>
        </span>
      );
    } else {
      content = figureCell(col, row, false);
    }
    // the first column carries the status accent: green = cleared, amber = pending, with its words for everyone
    const accentOn = i === 0;
    const label = accentOn && row.status ? (STATUS_TEXT[row.status] ?? row.status) : "";
    return (
      <td
        key={col.key}
        className={cn(
          common,
          accentOn && "border-l-4",
          accentOn && ((row.status && STATUS_ACCENT[row.status]) || "border-l-transparent"),
        )}
        style={leftOf(i)}
        title={label ? `Payroll ${label.toLowerCase()}` : undefined}
        data-status={accentOn ? (row.status ?? "") : undefined}
      >
        {content}
        {label ? (
          <>
            {" "}
            <span className="sr-only">{label}</span>
          </>
        ) : null}
      </td>
    );
  };

  const summaryRow = (kind: "subtotal" | "total", row: StatementRow, label: string, testId: string, key: string) => {
    const total = kind === "total";
    const tone = total ? a.total : a.subtotal;
    const cell = (extra: string) =>
      cn("border-slate-300 px-2 align-middle font-bold", total ? "h-10 border-t-2" : "h-9 border-y", tone, extra);
    return (
      <tr key={key} data-testid={testId}>
        <td
          colSpan={labelSpan}
          className={cn(
            cell("text-left"),
            stickyOn && (total ? "sticky bottom-0 left-0 z-30" : "sticky left-0 z-10"),
            stickyOn && !total && "border-r border-r-slate-200",
            !stickyOn && total && "sticky bottom-0 z-20",
          )}
          style={stickyOn ? { left: 0 } : undefined}
        >
          <span className="px-1 text-xs uppercase tracking-wide">{label}</span>
        </td>
        {columns.slice(labelSpan).map((col) => (
          <td key={col.key} className={cn(cell(alignClass(col)), total && "sticky bottom-0 z-20")}>
            {figureCell(col, row, true)}
          </td>
        ))}
        {hasActions && <td className={cn(cell(""), total && "sticky bottom-0 z-20")} />}
      </tr>
    );
  };

  const groupBody = (group: StatementGroup) => {
    const count = group.rows.length;
    return [
      <tr key={`band-${group.key}`} data-testid={`statement-band-${group.key}`}>
        <td colSpan={colCount} className={cn("border-b border-slate-200 p-0", a.band)}>
          <div className="sticky left-0 flex w-max max-w-full items-center gap-2 px-3 py-1.5">
            <span className="text-xs font-extrabold uppercase tracking-wide">{group.label}</span>{" "}
            <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-bold", a.bandCount)}>
              {count} {count === 1 ? "employee" : "employees"}
            </span>
          </div>
        </td>
      </tr>,
      ...group.rows.map((row, ri) => (
        <tr
          key={row.payrollId ?? `${group.key}-${ri}`}
          className="group"
          data-testid={`statement-row-${row.payrollId ?? `${group.key}-${ri}`}`}
        >
          {columns.map((col, i) => dataCell(col, i, row, ri % 2 === 1))}
          {hasActions && (
            <td
              className={cn(
                "h-[34px] border-b border-l border-slate-100 border-l-slate-200 px-2 align-middle",
                stickyOn && "sticky right-0 z-10",
                ri % 2 === 1 ? "bg-slate-50" : "bg-white",
                a.hover,
              )}
            >
              <div className="flex items-center justify-end gap-1">{renderRowActions?.(row)}</div>
            </td>
          )}
        </tr>
      )),
      summaryRow(
        "subtotal",
        group.subtotal,
        subtotalLabel(group.label),
        `statement-subtotal-${group.key}`,
        `sub-${group.key}`,
      ),
    ];
  };

  return (
    <div
      ref={setWrap}
      className="relative min-w-0 overflow-auto rounded-xl border border-slate-200 bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
      style={{ maxHeight: "min(72vh, 760px)" }}
      role="region"
      aria-label="Salary statement table"
      tabIndex={0}
      data-testid="statement-scroll"
      data-sticky={stickyOn ? "on" : "off"}
    >
      <table
        className="border-separate border-spacing-0 text-xs"
        style={{ width: tableWidth, tableLayout: "fixed" }}
        data-testid="statement-table"
      >
        <colgroup>
          {widths.map((w, i) => (
            <col key={columns[i].key} style={{ width: w }} />
          ))}
          {hasActions && <col style={{ width: ACTIONS_PX }} />}
        </colgroup>
        <thead>
          <tr data-testid="statement-head-bands">
            {bands.map((band) => (
              <th
                key={band.start}
                colSpan={band.span}
                scope="colgroup"
                className={cn(
                  "sticky top-0 h-7 border-b border-slate-200 px-2 text-center text-[10px] font-extrabold uppercase tracking-wider",
                  bandClass(band.group, a),
                  isSticky(band.start) ? "z-30" : "z-20",
                  edge(band.start + band.span - 1) && "border-r border-r-slate-200",
                )}
                style={leftOf(band.start)}
              >
                {band.continued ? null : band.label}
              </th>
            ))}
            {hasActions && (
              <th
                className={cn(
                  "sticky top-0 h-7 border-b border-slate-200 bg-slate-100",
                  stickyOn ? "right-0 z-30" : "z-20",
                )}
              />
            )}
          </tr>
          <tr data-testid="statement-head-labels">
            {columns.map((col, i) => (
              <th
                key={col.key}
                scope="col"
                className={cn(
                  "sticky top-7 h-12 border-b-2 border-slate-300 px-2 text-[11px] font-bold leading-tight",
                  headClass(col.group, a),
                  alignClass(col),
                  isSticky(i) ? "z-30" : "z-20",
                  edge(i) && "border-r border-r-slate-200",
                )}
                style={leftOf(i)}
              >
                <span className="block">{col.label}</span>
                {col.sub ? (
                  <>
                    {" "}
                    <span className="block font-semibold opacity-60">{col.sub}</span>
                  </>
                ) : null}
              </th>
            ))}
            {hasActions && (
              <th
                className={cn(
                  "sticky top-7 h-12 border-b-2 border-l border-slate-300 border-l-slate-200 bg-slate-50 px-2 text-center text-[11px] font-bold text-slate-700",
                  stickyOn ? "right-0 z-30" : "z-20",
                )}
              >
                Actions
              </th>
            )}
          </tr>
        </thead>
        <tbody>{statement.groups.filter((g) => g.rows.length > 0).flatMap(groupBody)}</tbody>
        <tfoot>{summaryRow("total", statement.total, GRAND_TOTAL_LABEL, "statement-total", "total")}</tfoot>
      </table>
    </div>
  );
}
