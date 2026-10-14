import { useMemo } from "react";
import type { SalaryStatement, StatementColumn, StatementRow } from "@/lib/api-client/custom-hooks";
import { PAPER_CSS } from "./paper-css";
import { PAPER, layoutPaperColumns, paperPages, wrapsOnPaper, type PaperLayout } from "./paper-layout";
import {
  DEFAULT_ROWS_PER_PAGE,
  GRAND_TOTAL_LABEL,
  cellValue,
  columnBands,
  formatCell,
  formatStamp,
  leadingIdentityCount,
  statementHeadline,
  statementTitle,
  type StatementLine,
  type StatementPage,
} from "./statement-model";

// The printed statement: A4 landscape sheets, each with the company and title block, the grouped header repeated, a page's
// worth of department bands / rows / subtotals, and "Page x of y" at the bottom right. The last sheet carries the grand
// total and the notes. One component draws a sheet for both the "Pages" preview and the browser's print dialog.

const alignClass = (col: StatementColumn): string =>
  col.align === "right" ? "stmt-r" : col.align === "center" ? "stmt-ctr" : "stmt-l";

function Cells({
  columns,
  row,
  from,
  summary,
}: {
  columns: StatementColumn[];
  row: StatementRow;
  from: number;
  summary: boolean;
}) {
  return (
    <>
      {columns.slice(from).map((col) => {
        const cell = formatCell(col, cellValue(row, col), summary ? { blankNull: true } : {});
        const cls = [alignClass(col), cell.zero && !summary ? "stmt-zero" : ""].filter(Boolean).join(" ");
        return (
          <td key={col.key} className={cls}>
            {wrapsOnPaper(col) ? <div className="stmt-clip2">{cell.text}</div> : cell.text}
          </td>
        );
      })}
    </>
  );
}

function Line({ line, columns, identity }: { line: StatementLine; columns: StatementColumn[]; identity: number }) {
  switch (line.kind) {
    case "band":
      return (
        <tr className="stmt-bandline" data-testid="statement-sheet-band">
          <td colSpan={columns.length}>
            {line.label}
            {line.continued ? " (contd.)" : " "}
            {!line.continued && (
              <span className="stmt-count">
                {line.count} {line.count === 1 ? "employee" : "employees"}
              </span>
            )}
          </td>
        </tr>
      );
    case "row":
      return (
        <tr className="stmt-row" data-testid="statement-sheet-row">
          <Cells columns={columns} row={line.row} from={0} summary={false} />
        </tr>
      );
    case "subtotal":
      return (
        <tr className="stmt-sub" data-testid="statement-sheet-subtotal">
          <td colSpan={identity} className="stmt-label">
            {line.label}
          </td>
          <Cells columns={columns} row={line.row} from={identity} summary />
        </tr>
      );
    case "total":
      return (
        <tr className="stmt-total" data-testid="statement-sheet-total">
          <td colSpan={identity} className="stmt-label">
            {GRAND_TOTAL_LABEL}
          </td>
          <Cells columns={columns} row={line.row} from={identity} summary />
        </tr>
      );
  }
}

export type StatementSheetProps = {
  statement: SalaryStatement;
  page: StatementPage;
  pageCount: number;
  layout: PaperLayout;
  /** On screen in the "Pages" preview: the sheet gets a paper shadow. */
  preview?: boolean;
};

/** One printed page. */
export function StatementSheet({ statement, page, pageCount, layout, preview }: StatementSheetProps) {
  const columns = statement.columns;
  const identity = Math.max(1, leadingIdentityCount(columns));
  return (
    <section
      className={`stmt-sheet stmt-kind-${statement.kind}${preview ? " stmt-sheet-preview" : ""}`}
      data-testid="statement-sheet"
      data-page={page.number}
      aria-label={`Page ${page.number} of ${pageCount} of the salary statement`}
    >
      <header className="stmt-head">
        <div className="stmt-company">{statementHeadline(statement)}</div>
        <div className="stmt-title">{statementTitle(statement)}</div>
      </header>
      <table className="stmt-table" style={{ width: `${layout.totalMm}mm`, fontSize: `${layout.fontPt}pt` }}>
        <colgroup>
          {columns.map((col, i) => (
            <col key={col.key} style={{ width: `${layout.widthsMm[i]}mm` }} />
          ))}
        </colgroup>
        <thead>
          <tr className="stmt-bands">
            {columnBands(columns).map((band) => (
              <th key={band.start} colSpan={band.span} className={`stmt-band-${band.group}`} scope="colgroup">
                {band.label.toUpperCase()}
              </th>
            ))}
          </tr>
          <tr className="stmt-labels">
            {columns.map((col) => (
              <th key={col.key} scope="col">
                {col.label}
                {col.sub ? (
                  <>
                    {" "}
                    <br />
                    {col.sub}
                  </>
                ) : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {page.lines.map((line, i) => (
            <Line key={i} line={line} columns={columns} identity={identity} />
          ))}
        </tbody>
      </table>
      {page.last && statement.notes.length > 0 && (
        <div className="stmt-notes" data-testid="statement-sheet-notes">
          <b>Notes</b>
          {statement.notes.map((note, i) => (
            <div key={i}>{note}</div>
          ))}
        </div>
      )}
      <footer className="stmt-foot">
        <span>Generated {formatStamp(statement.generatedAt)}</span>
        <span>
          Page {page.number} of {pageCount}
        </span>
      </footer>
    </section>
  );
}

/** The stylesheet of the sheets: render it once next to them. */
export function PaperStyle() {
  return <style data-statement-paper="">{PAPER_CSS}</style>;
}

/** The pages and the column layout of a statement, worked out once per statement. */
export function usePaper(statement: SalaryStatement, rowsPerPage: number = DEFAULT_ROWS_PER_PAGE) {
  return useMemo(
    () => ({
      pages: paperPages(statement, rowsPerPage),
      layout: layoutPaperColumns(statement, { widthMm: PAPER.contentWidthMm - PAPER.tableBorderMm }),
    }),
    [statement, rowsPerPage],
  );
}

/** Every page of the statement, one sheet each: what the print dialog gets. */
export function StatementSheets({
  statement,
  rowsPerPage = DEFAULT_ROWS_PER_PAGE,
}: {
  statement: SalaryStatement;
  rowsPerPage?: number;
}) {
  const { pages, layout } = usePaper(statement, rowsPerPage);
  return (
    <>
      <PaperStyle />
      {pages.map((page) => (
        <StatementSheet key={page.number} statement={statement} page={page} pageCount={pages.length} layout={layout} />
      ))}
    </>
  );
}
