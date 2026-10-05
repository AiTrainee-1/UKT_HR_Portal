import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePayrollSettings } from "@/lib/api-client/custom-hooks";
import type { ReportColumn, ReportMeta, ReportRunResult } from "@/lib/report-center";
import { formatCell, formatDateTime, isNumericType } from "@/lib/report-format";
import { cn } from "@/lib/utils";

/** The page rule for the printout: A4, in the orientation the report's PDF uses. */
export const pageRule = (landscape: boolean) =>
  `@page { size: A4 ${landscape ? "landscape" : "portrait"}; margin: 12mm; }`;

function alignOf(c: ReportColumn): string {
  const align =
    c.align ??
    (isNumericType(c.type) ? "right" : ["date", "time", "datetime", "badge"].includes(c.type) ? "center" : "left");
  return align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";
}

/** Smaller type for wide registers so every column still fits the page. */
const sizeFor = (columns: number) => (columns > 14 ? "text-[7.5px]" : columns > 9 ? "text-[8.5px]" : "text-[10px]");

/**
 * What the browser prints for an open report: letterhead, title, the filters it ran with, the headline figures, EVERY
 * row (the screen pages them) and the notes. Hidden on screen, shown only to the printer. No background colours: browsers
 * drop them unless asked, so structure comes from borders and weight.
 */
export function PrintSheet({
  spec,
  data,
  categoryLabel,
}: {
  spec: ReportMeta;
  data: ReportRunResult;
  categoryLabel: string;
}) {
  const { data: settings } = usePayrollSettings();
  const company = settings?.companyName || "UKTextiles";
  const logo = settings?.companyLogo;
  const columns = data.columns;

  return (
    <div className="hidden text-slate-900 print:block" data-testid="report-print-sheet">
      <style>{pageRule(spec.landscape)}</style>

      <header className="mb-3 flex items-center justify-between gap-4 border-b-2 border-slate-800 pb-2">
        <div className="flex items-center gap-3">
          {logo && <img src={logo} alt="" className="h-9 w-9 object-contain" />}
          <div>
            <p className="text-base font-black leading-tight">{company}</p>
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{categoryLabel}</p>
          </div>
        </div>
        <p className="text-right text-[10px] leading-snug text-slate-600">
          Generated {formatDateTime(data.generatedAt)}
          <br />
          by {data.generatedBy}
        </p>
      </header>

      <h1 className="text-xl font-black leading-tight">{data.title}</h1>
      {spec.description && <p className="mt-0.5 text-[11px] text-slate-600">{spec.description}</p>}
      {data.filters.length > 0 && (
        <p className="mt-1.5 text-[10px] text-slate-700" data-testid="report-print-filters">
          {data.filters.map((f, i) => (
            <span key={`${f.label}:${i}`}>
              {i > 0 && "  ·  "}
              <span className="text-slate-500">{f.label}: </span>
              <span className="font-semibold">{f.value}</span>
            </span>
          ))}
        </p>
      )}

      {data.summary.length > 0 && (
        <div className="mb-3 mt-3 grid grid-cols-4 gap-2">
          {data.summary.map((card) => (
            <div key={card.label} className="break-inside-avoid rounded border border-slate-400 px-2 py-1.5">
              <p className="text-[8px] font-bold uppercase tracking-wider text-slate-500">{card.label}</p>
              <p className="text-sm font-black tabular-nums">{formatCell(card.value, card.format)}</p>
            </div>
          ))}
        </div>
      )}

      <table className={cn("mt-3 w-full border-collapse", sizeFor(columns.length))}>
        <thead className="table-header-group">
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={cn("border border-slate-500 px-1.5 py-1 font-bold uppercase tracking-wide", alignOf(c))}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, i) => {
            const structural = row._kind === "subtotal" || row._kind === "total";
            return (
              <tr key={i} className={cn("break-inside-avoid", structural && "font-bold")}>
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={cn(
                      "border border-slate-300 px-1.5 py-0.5",
                      alignOf(c),
                      isNumericType(c.type) && "whitespace-nowrap tabular-nums",
                    )}
                  >
                    {structural && row[c.key] === null ? "" : formatCell(row[c.key], c.type)}
                  </td>
                ))}
              </tr>
            );
          })}
          {/* In the body, not a <tfoot>: browsers repeat a footer group at the bottom of EVERY printed page, and this is
              the grand total. */}
          {data.totals && (
            <tr className="break-inside-avoid font-bold">
              {columns.map((c, i) => {
                const v = data.totals?.[c.key];
                return (
                  <td key={c.key} className={cn("border-2 border-slate-500 px-1.5 py-1 tabular-nums", alignOf(c))}>
                    {v !== null && v !== undefined ? formatCell(v, c.type) : i === 0 ? "Total" : ""}
                  </td>
                );
              })}
            </tr>
          )}
        </tbody>
      </table>

      {data.truncated && (
        <p className="mt-2 text-[10px] font-semibold text-slate-700">
          Only the first {data.rowCount.toLocaleString("en-IN")} rows are shown: narrow the filters to print the rest.
        </p>
      )}
      {data.notes.length > 0 && (
        <div className="mt-3 break-inside-avoid border border-slate-300 px-3 py-2">
          <p className="mb-1 text-[8px] font-bold uppercase tracking-wider text-slate-500">Notes</p>
          <ul className="list-disc space-y-0.5 pl-4 text-[9px] text-slate-700">
            {data.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** "Print" beside the PDF and Excel downloads: prints the report as the sheet above. */
export function PrintButton({ onPrint, disabled }: { onPrint: () => void; disabled: boolean }) {
  return (
    <Button
      type="button"
      variant="outline"
      onClick={onPrint}
      disabled={disabled}
      title="Print this report: every row, with the filters it ran with"
      className="border-sky-200 bg-sky-50 text-sky-800 hover:bg-sky-100"
      data-testid="report-print"
    >
      <Printer /> Print
    </Button>
  );
}
