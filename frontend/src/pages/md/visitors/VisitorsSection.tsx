import { useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Users } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import BarList from "@/components/md/kit/BarList";
import DataTable, { type Column } from "@/components/md/kit/DataTable";
import DonutChart from "@/components/md/kit/DonutChart";
import Heatmap from "@/components/md/kit/Heatmap";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock, ErrorBanner } from "@/components/md/kit/states";
import { describeMdError } from "@/lib/api-client/custom-hooks/md";
import { num, pct } from "@/lib/md/format";
import { heatmapWindow, hostDepartmentItems, periodPhrase, plural, purposeSlices, stampText } from "./logic";
import { CardNote, Chip, NO_CHECKOUT_TEXT, PersonCell, SectionHeading } from "./parts";
import type { RepeatVisitor, TopHost, VisitorsResponse } from "./types";

const hostColumns: Column<TopHost>[] = [
  {
    key: "name",
    header: "Person",
    cell: (h) => (
      <PersonCell
        name={h.name}
        sub={h.linked ? [h.department, h.code].filter(Boolean).join(" · ") : "Name typed at the gate, not matched"}
      />
    ),
  },
  { key: "visits", header: "Visits", align: "right", cell: (h) => num(h.visits) },
  { key: "unique", header: "Visitors", align: "right", cell: (h) => num(h.uniqueVisitors) },
];

function repeatColumns(frequentFrom: number): Column<RepeatVisitor>[] {
  return [
    {
      key: "name",
      header: "Visitor",
      cell: (r) => (
        <div className="flex items-center gap-2">
          <PersonCell name={r.visitorName} />
          {r.visits >= frequentFrom && <Chip tone="amber">Frequent</Chip>}
        </div>
      ),
    },
    { key: "visits", header: "Visits", align: "right", cell: (r) => num(r.visits) },
    { key: "hosts", header: "People met", align: "right", cell: (r) => num(r.hostsMet) },
    { key: "last", header: "Last visit", cell: (r) => stampText(r.lastVisitAt) },
    {
      key: "purpose",
      header: "Last purpose",
      cell: (r) => <span className="block max-w-[16rem] truncate">{r.lastPurpose ?? "—"}</span>,
    },
  ];
}

/** Who is coming in: why, to meet whom, when, and the visitors who keep coming back. */
export default function VisitorsSection({ query }: { query: UseQueryResult<VisitorsResponse> }) {
  const d = query.isError ? undefined : query.data;
  const when = periodPhrase(d?.period);
  const grid = useMemo(() => (d?.heatmap ? heatmapWindow(d.heatmap) : null), [d?.heatmap]);
  const departments = useMemo(() => (d ? hostDepartmentItems(d.hostDepartments, d.hostsNotLinked) : []), [d]);
  const empty = !!d && d.visits === 0;

  return (
    <section className="space-y-4" data-testid="md-visitors-section">
      <SectionHeading icon={Users} title="Visitors" subtitle={NO_CHECKOUT_TEXT} testId="md-visitors-section-heading" />
      {query.isError && <ErrorBanner message={describeMdError(query.error)} onRetry={() => query.refetch()} />}

      {query.isError ? null : empty ? (
        <SectionCard title="No visitors in this period" testId="md-visitors-none">
          <EmptyBlock icon={Users} title="Nobody checked in at the gate">
            No visit was recorded {when} for this unit, department and staff or production choice. Try a longer period,
            or all units.
          </EmptyBlock>
        </SectionCard>
      ) : (
        <div className="grid grid-cols-1 items-start gap-5 @2xl:grid-cols-2 @5xl:grid-cols-12">
          <SectionCard
            className="@5xl:col-span-5"
            title="Why visitors came"
            subtitle="Grouped by the words typed at the gate"
            loading={query.isPending}
            provenance={d?.provenance}
            provenanceIds={["purposes"]}
            actions={
              <AskAiButton
                question={`Why do visitors come to the factory ${when}? What are the most common purposes?`}
              />
            }
            testId="md-visitors-purposes"
          >
            {d && (
              <>
                <DonutChart
                  data={purposeSlices(d.purposes.categories)}
                  center={
                    <>
                      <span className="text-2xl font-black tabular-nums text-md-ink">{num(d.visits)}</span>
                      <span className="text-[11px] font-semibold text-md-ink-soft">{plural(d.visits, "visit")}</span>
                    </>
                  }
                  testId="md-visitors-purpose-donut"
                />
                {d.purposes.otherSharePct != null && d.purposes.otherSharePct >= 20 && (
                  <CardNote tone="warn">
                    {pct(d.purposes.otherSharePct, 0)} of visits did not match a category
                    {d.purposes.otherSamples.length > 0 &&
                      `, for example ${d.purposes.otherSamples
                        .slice(0, 3)
                        .map((s) => `“${s.text}”`)
                        .join(", ")}`}
                    .
                  </CardNote>
                )}
              </>
            )}
          </SectionCard>

          <SectionCard
            className="@5xl:col-span-7"
            title="Whom they came to meet"
            subtitle="Visits by the department of the person visited"
            loading={query.isPending}
            provenance={d?.provenance}
            provenanceIds={["hosts"]}
            actions={
              <AskAiButton
                question={`Which departments get the most visitors ${when}, and who are the most visited people?`}
              />
            }
            testId="md-visitors-hosts"
          >
            <BarList items={departments} emptyText="No visits in this period." testId="md-visitors-host-bars" />
            <CardNote>The gate form does not ask for a company, so visits are shown by the person visited.</CardNote>
          </SectionCard>

          <SectionCard
            className="@2xl:col-span-2 @5xl:col-span-8"
            title="Busiest times"
            subtitle={
              d
                ? `Visits by weekday and hour · ${num(d.afterHours.total)} ${plural(d.afterHours.total, "visit")} ${d.afterHours.label}`
                : undefined
            }
            loading={query.isPending}
            provenance={d?.provenance}
            provenanceIds={["heatmap", "after-hours"]}
            actions={
              <AskAiButton question={`When are the gate's busiest times ${when}, and were there visits after hours?`} />
            }
            testId="md-visitors-times"
          >
            {grid && (
              <Heatmap
                rows={grid.rows}
                cols={grid.cols}
                values={grid.values}
                rowHeaderWidth={48}
                cellHeight={26}
                testId="md-visitors-heatmap"
              />
            )}
          </SectionCard>

          <SectionCard
            className="@2xl:col-span-2 @5xl:col-span-4"
            title="Most visited people"
            subtitle="Employees (or names typed) that visitors asked for"
            loading={query.isPending}
            provenance={d?.provenance}
            provenanceIds={["hosts"]}
            actions={
              <AskAiButton question={`Who received the most visitors ${when}, and what did the visitors come for?`} />
            }
            testId="md-visitors-top-hosts"
          >
            <DataTable
              columns={hostColumns}
              rows={d?.topHosts ?? []}
              rowKey={(h) => `${h.employeeId ?? "typed"}-${h.name}`}
              pageSize={6}
              dense
              empty="No visits in this period."
            />
          </SectionCard>

          <SectionCard
            className="@2xl:col-span-2 @5xl:col-span-12"
            title="Repeat visitors"
            subtitle={
              d
                ? `${num(d.repeatVisitors.total)} ${plural(d.repeatVisitors.total, "visitor")} came more than once (${pct(d.repeatVisitors.sharePct, 0)} of visits). “Frequent” means ${d.repeatVisitors.frequentFrom} or more visits.`
                : undefined
            }
            loading={query.isPending}
            provenance={d?.provenance}
            provenanceIds={["repeat-visitors", "visits"]}
            actions={<AskAiButton question={`Which visitors came back most often ${when}, and why?`} />}
            testId="md-visitors-repeat"
          >
            <DataTable
              columns={repeatColumns(d?.repeatVisitors.frequentFrom ?? 4)}
              rows={d?.repeatVisitors.rows ?? []}
              rowKey={(r) => r.visitorId}
              pageSize={10}
              empty="Nobody came more than once in this period."
            />
          </SectionCard>
        </div>
      )}
    </section>
  );
}
