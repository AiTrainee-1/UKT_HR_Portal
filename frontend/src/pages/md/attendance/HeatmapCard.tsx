import type { UseQueryResult } from "@tanstack/react-query";
import AskAiButton from "@/components/md/kit/AskAiButton";
import Heatmap from "@/components/md/kit/Heatmap";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock } from "@/components/md/kit/states";
import { pct } from "@/lib/md/format";
import CardBody from "./CardBody";
import { ask, dayGridInput, gridRange, type AskContext } from "./logic";
import type { AttendanceHeatmap } from "./types";

/** Each department's attendance on each working day: the dark cells are the bad days, a dash is a day nobody was recorded. */
export default function HeatmapCard({
  query,
  context,
  className,
}: {
  query: UseQueryResult<AttendanceHeatmap>;
  context: AskContext;
  className?: string;
}) {
  const data = query.data;
  return (
    <SectionCard
      testId="md-attendance-heatmap"
      className={className}
      title="Department by day"
      subtitle={
        data && data.days.length > 0
          ? `Attendance %, ${gridRange(data)}: darker is worse`
          : "Attendance % by department and working day"
      }
      loading={query.isPending}
      provenance={data?.provenance}
      actions={<AskAiButton question={ask.heatmap(context)} />}
    >
      <CardBody query={query}>
        {(d) => {
          if (d.departments.length === 0) {
            return (
              <EmptyBlock title="No days to show" testId="md-attendance-heatmap-empty">
                There are no attendance records for these departments in the period.
              </EmptyBlock>
            );
          }
          const grid = dayGridInput(d);
          return (
            <div className="space-y-2">
              <Heatmap
                rows={grid.rows}
                cols={grid.cols}
                values={grid.values}
                domain={[70, 100]}
                invert
                format={(n) => pct(n, 0)}
                rowHeaderWidth={110}
                cellHeight={26}
                testId="md-attendance-day-grid"
              />
              {d.capped && (
                <p className="text-xs text-muted-foreground">
                  Showing {d.shownDepartments} of {d.totalDepartments} departments (the lowest attendance first).
                </p>
              )}
            </div>
          );
        }}
      </CardBody>
    </SectionCard>
  );
}
