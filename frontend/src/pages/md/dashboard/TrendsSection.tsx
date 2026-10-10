import type { UseQueryResult } from "@tanstack/react-query";
import { GroupHeading } from "./parts";
import { AttendanceTrendCard, MovementTrendCard, PayrollTrendCard } from "./TrendCards";
import type { DashboardTrends } from "./types";

/** The three charts, loaded by their own request so the cards above can paint first. */
export default function TrendsSection({ query }: { query: UseQueryResult<DashboardTrends> }) {
  return (
    <section aria-labelledby="md-trends-heading" className="@container" data-testid="md-dashboard-trends">
      <GroupHeading id="md-trends-heading" title="Trends">
        The last month and the last year, from the pages' own charts
      </GroupHeading>
      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-3">
        <AttendanceTrendCard query={query} />
        <PayrollTrendCard query={query} />
        <MovementTrendCard query={query} />
      </div>
    </section>
  );
}
