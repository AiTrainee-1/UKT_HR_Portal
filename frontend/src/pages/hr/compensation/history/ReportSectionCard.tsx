import { Link } from "wouter";
import { PauseCircle, Users } from "lucide-react";
import { EmptyNote, SectionCard } from "@/components/payroll/kit/parts";
import type { ReportRow, ReportSection } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { compensationSettingsHref } from "../logic";
import { CELL, PersonCell, Pager, StatusChip, TABLE_HEAD, usePaged } from "../ui";
import {
  REDEMPTION_COLUMNS,
  TYPE_COLUMNS,
  TYPE_META,
  overviewText,
  statusTone,
  summaryTiles,
  type ReportColumn,
} from "./history-logic";

const PAGE = 15;

/** One tile of a section's summary: a figure and what it counts. */
function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div
      className="rounded-xl bg-slate-50 px-3 py-2.5"
      data-testid={`stat-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
    >
      <p className="text-[11px] font-medium text-slate-500">{label}</p>
      <p className="text-lg font-black leading-tight tabular-nums text-slate-900">{value}</p>
      {sub && <p className="text-[11px] leading-snug text-slate-500">{sub}</p>}
    </div>
  );
}

function Cell({ column, row }: { column: ReportColumn; row: ReportRow }) {
  const text = column.display(row);
  if (column.key === "statusLabel" && row.status) {
    return <StatusChip tone={statusTone(row.status)}>{text}</StatusChip>;
  }
  return <>{text}</>;
}

function RowsTable({
  rows,
  columns,
  testId,
  rowTestId,
}: {
  rows: ReportRow[];
  columns: ReportColumn[];
  testId: string;
  rowTestId: string;
}) {
  const paged = usePaged(rows, `${testId}|${rows.length}`, PAGE);
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-sm" data-testid={testId}>
          <thead className={TABLE_HEAD}>
            <tr>
              <th className="px-3 py-2.5 pl-5">Employee</th>
              {columns.map((c) => (
                <th key={c.key} className={cn("px-3 py-2.5", c.align === "right" && "text-right")}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {paged.rows.map((row, i) => (
              <tr
                key={`${row.employeeId}-${row.date}-${row.usedOn}-${paged.from + i}`}
                data-testid={`${rowTestId}-${paged.from - 1 + i}`}
                data-employee={row.employeeCode}
                data-status={row.status ?? undefined}
              >
                <td className={`${CELL} pl-5`}>
                  <PersonCell name={row.employeeName} code={row.employeeCode} department={row.department} />
                </td>
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={cn(
                      CELL,
                      "text-gray-700",
                      c.key === "detail" ? "max-w-sm text-xs leading-snug text-gray-600" : "whitespace-nowrap",
                      c.key === "reason" && "max-w-xs whitespace-normal break-words",
                      c.align === "right" && "text-right tabular-nums",
                    )}
                  >
                    <Cell column={c} row={row} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager paged={paged} size={PAGE} />
    </>
  );
}

/**
 * One type of compensation in the report: who benefits from it (one sentence), the tiles of its summary, and the table of
 * the beneficiaries. A type that is switched off in Settings says so (what it already gave stays listed).
 */
export function ReportSectionCard({
  section,
  masterOn,
  withRedemptions = true,
}: {
  section: ReportSection;
  masterOn: boolean;
  /** Show the balance redeemed as days off under the work (Holiday / Sunday work). Off when it has a nested subtab of its own. */
  withRedemptions?: boolean;
}) {
  const meta = TYPE_META[section.type];
  const columns = TYPE_COLUMNS[section.type]();
  const tiles = summaryTiles(section.type, section.summary);
  const redemptions = section.redemptions ?? [];
  return (
    <SectionCard
      id={`report-${section.type}`}
      testId={`report-section-${section.type}`}
      icon={Users}
      title={meta.label}
      description={<span data-testid={`report-who-${section.type}`}>{meta.who}</span>}
      actions={
        <span className="text-xs font-semibold text-slate-600" data-testid={`report-count-${section.type}`}>
          {overviewText(section)}
        </span>
      }
      bodyClassName="space-y-4 px-0 pb-0"
    >
      {masterOn && !section.enabled && (
        <div
          className="mx-5 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"
          role="status"
          data-testid={`report-off-${section.type}`}
        >
          <PauseCircle size={15} className="mt-0.5 shrink-0 text-amber-600" />
          <p>
            <strong>This type is switched off in Settings.</strong> Nothing new is given; what it gave earlier stays
            listed.{" "}
            <Link href={compensationSettingsHref(meta.setting)} className="font-semibold underline">
              Settings → Compensation
            </Link>
          </p>
        </div>
      )}

      <div
        className="grid grid-cols-2 gap-2 px-5 sm:grid-cols-3 lg:grid-cols-6"
        data-testid={`report-tiles-${section.type}`}
      >
        {tiles.map((t) => (
          <Stat key={t.key} label={t.label} value={t.value} sub={t.sub} />
        ))}
      </div>

      {section.rows.length === 0 ? (
        <div className="px-5 pb-5">
          <EmptyNote
            icon={Users}
            title="Nobody benefited in this period"
            hint="Change the period, the filters or the type to see others."
            testId={`report-empty-${section.type}`}
          />
        </div>
      ) : (
        <RowsTable
          rows={section.rows}
          columns={columns}
          testId={`report-table-${section.type}`}
          rowTestId={`report-row-${section.type}`}
        />
      )}

      {withRedemptions && section.type === "holiday_work" && redemptions.length > 0 && (
        <div className="space-y-2 border-t border-slate-100 pt-4">
          <h4 className="px-5 text-sm font-bold text-gray-900">
            Balance redeemed as days off{" "}
            <span className="font-semibold text-muted-foreground">({redemptions.length})</span>
          </h4>
          <RowsTable
            rows={redemptions}
            columns={REDEMPTION_COLUMNS()}
            testId="report-table-redemptions"
            rowTestId="report-redemption"
          />
        </div>
      )}
    </SectionCard>
  );
}

/** The balance that was redeemed as days off in the period (Holiday / Sunday work, its own nested subtab). */
export function RedemptionsCard({ section }: { section: ReportSection }) {
  const redemptions = section.redemptions ?? [];
  return (
    <SectionCard
      testId="report-redemptions"
      icon={Users}
      title="Balance redeemed as days off"
      description="Compensation balance that HR turned into a day off in this period, and for whom."
      actions={
        <span className="text-xs font-semibold text-slate-600">
          {redemptions.length} {redemptions.length === 1 ? "redemption" : "redemptions"}
        </span>
      }
      bodyClassName="space-y-4 px-0 pb-0"
    >
      {redemptions.length === 0 ? (
        <div className="px-5 pb-5">
          <EmptyNote
            icon={Users}
            title="No balance was redeemed in this period"
            hint="Change the period or the filters to see others."
            testId="report-redemptions-empty"
          />
        </div>
      ) : (
        <RowsTable
          rows={redemptions}
          columns={REDEMPTION_COLUMNS()}
          testId="report-table-redemptions"
          rowTestId="report-redemption"
        />
      )}
    </SectionCard>
  );
}
