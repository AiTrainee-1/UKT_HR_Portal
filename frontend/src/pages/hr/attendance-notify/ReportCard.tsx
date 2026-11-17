import { useState } from "react";
import { ClipboardList } from "lucide-react";
import type { NotifyChatReport, NotifyRow } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { PersonAvatar } from "../device-control/parts";
import { CategoryChip } from "./parts";
import { countTotal, dateLabel, whenText } from "./logic";

/** How many lines a card shows before "Show all". */
export const REPORT_CARD_ROWS = 8;

/** One employee of a report: photo, name, code, department, the category and what it was. */
export function ReportRow({ row, showDate }: { row: NotifyRow; showDate?: boolean }) {
  return (
    <li className="flex items-start gap-2.5 px-3 py-2" data-testid="report-row">
      <PersonAvatar name={row.name || row.code} photoUrl={row.photoUrl} size={32} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <span className="truncate text-sm font-semibold text-slate-900">{row.name || "—"}</span>
          {row.code && <span className="font-mono text-[11px] text-slate-500">{row.code}</span>}
        </div>
        <p className="truncate text-[11px] text-slate-500">
          {[row.department, row.designation].filter(Boolean).join(" · ") || "—"}
          {showDate && row.date ? ` · ${dateLabel(row.date)}` : ""}
        </p>
        {row.detail && <p className="mt-0.5 text-xs leading-snug text-slate-700">{row.detail}</p>}
      </div>
      <CategoryChip category={row.category} className="mt-0.5 shrink-0" />
    </li>
  );
}

/**
 * An attendance report as the Internal Chat shows it (and as its preview shows it): the title and the day, the counts of
 * the report's categories at the top, then one line per employee (none for a summary-only report). Long reports show the
 * first lines and "Show all".
 */
export default function ReportCard({ report, className }: { report: NotifyChatReport; className?: string }) {
  const [all, setAll] = useState(false);
  const total = countTotal(report.counts, report.categories);
  const dates = new Set(report.rows.map((r) => r.date).filter(Boolean));
  const shown = all ? report.rows : report.rows.slice(0, REPORT_CARD_ROWS);
  const people = report.employees ?? total;

  return (
    <div
      className={cn("overflow-hidden rounded-xl border border-slate-200 bg-white text-left text-slate-900", className)}
      data-testid="report-card"
    >
      <div className="flex items-start gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2.5">
        <ClipboardList size={16} className="mt-0.5 shrink-0 text-indigo-600" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold leading-tight text-slate-900">{report.title}</p>
          <p className="text-[11px] text-slate-500">
            {report.dateLabel}
            {report.asOf ? `${report.dateLabel ? " · " : ""}as of ${whenText(report.asOf)}` : ""}
          </p>
        </div>
        <span
          className="shrink-0 rounded-full bg-white px-2 py-0.5 text-[11px] font-bold tabular-nums text-slate-700 ring-1 ring-slate-200"
          data-testid="report-card-people"
        >
          {people.toLocaleString("en-IN")} {people === 1 ? "employee" : "employees"}
          {report.total !== null ? ` of ${report.total.toLocaleString("en-IN")}` : ""}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5 px-3 py-2.5" data-testid="report-card-counts">
        {report.categories.map((c) => (
          <CategoryChip key={c} category={c} count={report.counts[c] ?? 0} />
        ))}
      </div>
      {total === 0 && <p className="px-3 pb-2.5 text-xs text-slate-500">Nobody in these categories.</p>}
      {report.rows.length > 0 && (
        <ul className="divide-y divide-slate-100 border-t border-slate-100">
          {shown.map((r, i) => (
            <ReportRow
              key={`${r.employeeId ?? r.code}-${r.date}-${r.category}-${i}`}
              row={r}
              showDate={dates.size > 1}
            />
          ))}
        </ul>
      )}
      {report.rows.length > REPORT_CARD_ROWS && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="w-full border-t border-slate-100 px-3 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-50"
          data-view-safe
          data-testid="report-card-more"
        >
          {all ? "Show fewer" : `Show all ${report.rows.length.toLocaleString("en-IN")}`}
        </button>
      )}
      {report.truncated && (
        <p
          className="border-t border-slate-100 px-3 py-2 text-[11px] text-slate-500"
          data-testid="report-card-truncated"
        >
          Only the first {report.rows.length.toLocaleString("en-IN")} people are listed here; the counts above are
          complete.
        </p>
      )}
    </div>
  );
}
