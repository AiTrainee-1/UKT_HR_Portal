import { useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import AskAiButton from "@/components/md/kit/AskAiButton";
import BarList from "@/components/md/kit/BarList";
import SectionCard from "@/components/md/kit/SectionCard";
import TrendChart, { type TrendSeries } from "@/components/md/kit/TrendChart";
import { CHART } from "@/components/md/kit/chartTheme";
import { EmptyBlock } from "@/components/md/kit/states";
import { dayShort, num } from "@/lib/md/format";
import { hasExports, latestLine, reportBars, trendRows, userBars } from "./logic";
import { QueryError, refreshingClass } from "./parts";
import type { RlExports, RlTrend } from "./types";

const EXPORTS: TrendSeries = { key: "exports", label: "Attendance report exports", kind: "bar", color: CHART.brand };

/** Who produces the attendance reports, and how often: exports per day, who made them, which reports, and the latest few.
 *  Only what the audit trail records: exports from the Report Log page itself are made in the browser and are not in it. */
export default function ExportsCard({
  query,
  trend,
  ask,
}: {
  query: UseQueryResult<RlExports>;
  trend: UseQueryResult<RlTrend>;
  ask: string;
}) {
  const data = query.data;
  const rows = useMemo(() => (trend.data ? trendRows(trend.data) : []), [trend.data]);
  const t = data?.totals;
  return (
    <SectionCard
      title="Who produces the attendance reports"
      subtitle="Exports of attendance reports on record in the audit trail, for the whole company"
      loading={query.isPending}
      provenance={data?.provenance}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId="md-reportlog-exports"
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : data && t && t.attendance > 0 ? (
        <div className="space-y-5">
          <p className="text-sm text-gray-800" data-testid="md-reportlog-exports-line">
            {num(t.attendance)} {t.attendance === 1 ? "export" : "exports"} by {num(t.exporters)}{" "}
            {t.exporters === 1 ? "person" : "people"} on {num(t.days)} of {num(t.daysInPeriod)} days
            {t.change
              ? ` (${t.change.abs >= 0 ? "up" : "down"} ${num(Math.abs(t.change.abs))} on ${num(t.previousAttendance)} before)`
              : ""}
            .{t.otherReports > 0 ? ` ${num(t.otherReports)} more exports were of other reports.` : ""}
          </p>
          {trend.data && hasExports(trend.data) && (
            <TrendChart
              data={rows}
              xKey="date"
              series={[EXPORTS]}
              height={170}
              xFormat={dayShort}
              yFormat={(v) => num(v)}
              legend={false}
            />
          )}
          <div className="grid grid-cols-1 gap-6 @3xl:grid-cols-2">
            <div data-testid="md-reportlog-exports-users">
              <p className="mb-2 text-xs font-semibold text-[#006496]/70">By person</p>
              <BarList items={userBars(data.byUser)} />
              {data.usersTotal > data.byUser.length && (
                <p className="mt-1 text-[11px] text-[#006496]/55">
                  Showing {num(data.byUser.length)} of {num(data.usersTotal)} people.
                </p>
              )}
            </div>
            <div data-testid="md-reportlog-exports-reports">
              <p className="mb-2 text-xs font-semibold text-[#006496]/70">By report</p>
              <BarList items={reportBars(data.byReport)} />
              {data.reportsTotal > data.byReport.length && (
                <p className="mt-1 text-[11px] text-[#006496]/55">
                  Showing {num(data.byReport.length)} of {num(data.reportsTotal)} reports.
                </p>
              )}
            </div>
          </div>
          {data.latest.length > 0 && (
            <div data-testid="md-reportlog-exports-latest">
              <p className="mb-1.5 text-xs font-semibold text-[#006496]/70">Latest exports</p>
              <ul className="space-y-1 text-xs text-gray-700">
                {data.latest.map((item) => (
                  <li
                    key={`${item.at}-${item.userName}-${item.report}`}
                    className="rounded-lg bg-[#006496]/[0.04] px-2.5 py-1.5"
                  >
                    {latestLine(item)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : data ? (
        <EmptyBlock title="No attendance report exports on record" testId="md-reportlog-exports-empty">
          Nobody exported an attendance report from the Report Center or Attendance Search in this period. Exports from
          the Report Log page itself are not recorded, so people may be using that.
        </EmptyBlock>
      ) : null}
    </SectionCard>
  );
}
