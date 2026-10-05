import { useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import AskAiButton from "@/components/md/kit/AskAiButton";
import BarList from "@/components/md/kit/BarList";
import Heatmap from "@/components/md/kit/Heatmap";
import SectionCard from "@/components/md/kit/SectionCard";
import { pct } from "@/lib/md/format";
import CardBody from "./CardBody";
import TabStrip from "./TabStrip";
import { ask, mondayText, weekdayBars, weekGridInput, type AskContext } from "./logic";
import type { AttendanceWeekday } from "./types";

const VIEWS = [
  { value: "days", label: "By weekday" },
  { value: "weeks", label: "Week by week" },
];

/** Is one day of the week worse than the others? Absence by weekday, and a weekday x week grid of attendance. */
export default function WeekdayCard({
  query,
  context,
  className,
}: {
  query: UseQueryResult<AttendanceWeekday>;
  context: AskContext;
  className?: string;
}) {
  const [view, setView] = useState("days");
  return (
    <SectionCard
      testId="md-attendance-weekday"
      className={className}
      title="Weekday pattern"
      subtitle={
        view === "days"
          ? "Absent % on each day of the week: the red bar is the worst day"
          : "Attendance % each day, by week"
      }
      loading={query.isPending}
      provenance={query.data?.provenance}
      actions={<AskAiButton question={ask.weekday(context)} />}
    >
      <TabStrip items={VIEWS} value={view} onChange={setView} />
      <CardBody query={query}>
        {(d) => {
          if (d.weekdays.length === 0) {
            return (
              <p className="py-6 text-center text-sm text-muted-foreground">No scheduled days with a record yet.</p>
            );
          }
          if (view === "weeks") {
            const grid = weekGridInput(d.heatmap);
            return (
              <Heatmap
                rows={grid.rows}
                cols={grid.cols}
                values={grid.values}
                domain={[70, 100]}
                invert
                format={(n) => pct(n, 0)}
                rowHeaderWidth={44}
                cellHeight={30}
                testId="md-attendance-week-grid"
              />
            );
          }
          const note = mondayText(d.mondayEffect);
          return (
            <div className="space-y-3">
              <BarList items={weekdayBars(d.weekdays)} format={(n) => pct(n)} testId="md-attendance-weekday-bars" />
              {note && <p className="text-xs text-[#006496]/70">{note}</p>}
            </div>
          );
        }}
      </CardBody>
    </SectionCard>
  );
}
