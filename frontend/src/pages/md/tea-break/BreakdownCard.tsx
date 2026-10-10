import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import AskAiButton from "@/components/md/kit/AskAiButton";
import DataTable, { type Column } from "@/components/md/kit/DataTable";
import SectionCard from "@/components/md/kit/SectionCard";
import { DeltaChip } from "@/components/md/kit/StatCard";
import { minutesText, num, pct } from "@/lib/md/format";
import { deltaChip, participationText } from "./logic";
import { QueryError, SmallSample, refreshingClass } from "./parts";
import type { TeaBreakdown, TeaGroupRow } from "./types";

function LabelCell({ row }: { row: TeaGroupRow }) {
  const detail = row.sub ?? participationText(row);
  return (
    <div className="min-w-[8rem]">
      <p className="font-semibold text-md-ink">
        {row.label}
        {row.lowSample && row.breaks > 0 && <SmallSample />}
      </p>
      {detail && <p className="text-[11px] text-md-ink-soft">{detail}</p>}
    </div>
  );
}

function RateCell({ row }: { row: TeaGroupRow }) {
  if (row.overrunPct == null) return <span className="text-md-ink-soft">—</span>;
  const chip = deltaChip(row.change.overrunPct, "pts", "down");
  return (
    <div className="flex flex-col items-end gap-0.5">
      <span className="font-bold tabular-nums text-md-ink">{pct(row.overrunPct, 1)}</span>
      {chip && <DeltaChip {...chip} />}
    </div>
  );
}

function LostCell({ row }: { row: TeaGroupRow }) {
  if (row.minutesLost == null) return <span className="text-md-ink-soft">—</span>;
  return (
    <div className="flex flex-col items-end">
      <span className="font-bold tabular-nums text-md-ink">{minutesText(row.minutesLost)}</span>
      {row.shareOfLostPct != null && (
        <span className="text-[11px] text-md-ink-soft">{pct(row.shareOfLostPct, 0)} of the total</span>
      )}
    </div>
  );
}

function columns(nameHeader: string): Column<TeaGroupRow>[] {
  return [
    { key: "label", header: nameHeader, sortValue: (r) => r.label.toLowerCase(), cell: (r) => <LabelCell row={r} /> },
    { key: "breaks", header: "Breaks", align: "right", sortValue: (r) => r.breaks, cell: (r) => num(r.breaks) },
    {
      key: "avg",
      header: "Average",
      align: "right",
      sortValue: (r) => r.avgMinutes,
      cell: (r) => (r.avgMinutes == null ? "—" : `${num(r.avgMinutes, 1)} min`),
    },
    {
      key: "rate",
      header: "Overrun rate",
      align: "right",
      sortValue: (r) => r.overrunPct,
      cell: (r) => <RateCell row={r} />,
    },
    {
      key: "lost",
      header: "Minutes lost",
      align: "right",
      sortValue: (r) => r.minutesLost,
      cell: (r) => <LostCell row={r} />,
    },
  ];
}

/** A ranking by minutes lost (departments, units, staff vs production, or shifts): the rate with its change against
 *  the previous period, the share of all lost time, and the overall figure to compare with. A click on a row
 *  narrows the page to it (`onFocus`), where that makes sense. */
export default function BreakdownCard({
  title,
  subtitle,
  query,
  ask,
  testId,
  nameHeader,
  tabs,
  onFocus,
  emptyText,
}: {
  title: string;
  subtitle: string;
  query: UseQueryResult<TeaBreakdown>;
  ask: string;
  testId: string;
  nameHeader: string;
  tabs?: ReactNode;
  onFocus?: (row: TeaGroupRow) => void;
  emptyText: string;
}) {
  const data = query.data;
  return (
    <SectionCard
      title={title}
      subtitle={subtitle}
      loading={query.isPending}
      provenance={data?.provenance}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId={testId}
    >
      {tabs && <div className="mb-4">{tabs}</div>}
      {query.isError ? (
        <QueryError query={query} />
      ) : data ? (
        <>
          {data.average.overrunPct != null && (
            <p className="mb-3 text-xs text-md-ink-soft">
              Overall: {pct(data.average.overrunPct, 1)} of breaks ran over, average {num(data.average.avgMinutes, 1)}{" "}
              min.
            </p>
          )}
          <DataTable
            columns={columns(nameHeader)}
            rows={data.rows}
            rowKey={(r) => r.key}
            initialSort={{ key: "lost", dir: "desc" }}
            pageSize={6}
            empty={emptyText}
            onRowClick={onFocus}
            testId={`${testId}-table`}
          />
          {onFocus && data.rows.length > 0 && (
            <p className="md-analytics-note">Click a row to focus the whole page on it.</p>
          )}
          {data.truncated && (
            <p className="md-analytics-note">
              Showing the {num(data.rows.length)} biggest of {num(data.total)}.
            </p>
          )}
        </>
      ) : null}
    </SectionCard>
  );
}
