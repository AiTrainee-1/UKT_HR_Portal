import { useMemo, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import AskAiButton from "@/components/md/kit/AskAiButton";
import Heatmap from "@/components/md/kit/Heatmap";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock } from "@/components/md/kit/states";
import { num, pct } from "@/lib/md/format";
import SegTabs from "../embedded/shared/SegTabs";
import { heatmapCaption, heatmapMatrix, visibleSlots, type HeatMetric } from "./logic";
import { QueryError, refreshingClass } from "./parts";
import type { TeaHeatmap } from "./types";

const METRICS = [
  { value: "breaks", label: "Breaks" },
  { value: "rate", label: "Overrun rate" },
];

/** When breaks cluster and when they overrun: the half hour a break started in, by weekday. Stray scans at the very
 *  edges of the day are not drawn, and the card says how many breaks that leaves out. */
export default function HeatmapCard({ query, ask }: { query: UseQueryResult<TeaHeatmap>; ask: string }) {
  const [metric, setMetric] = useState<HeatMetric>("breaks");
  const data = query.data;
  const shown = useMemo(() => (data ? visibleSlots(data) : null), [data]);
  const matrix = useMemo(
    () => (data && shown ? heatmapMatrix(data, metric, shown.slots) : null),
    [data, shown, metric],
  );
  const caption = data ? heatmapCaption(data) : [];

  return (
    <SectionCard
      title="When breaks happen"
      subtitle="The half hour each break started in (Indian time), by weekday"
      loading={query.isPending}
      provenance={data?.provenance}
      actions={
        <>
          <SegTabs label="What to show" items={METRICS} value={metric} onChange={(v) => setMetric(v as HeatMetric)} />
          <AskAiButton question={ask} />
        </>
      }
      bodyClassName={refreshingClass(query)}
      testId="md-tea-break-heatmap"
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : data && matrix && shown ? (
        data.cells.length === 0 ? (
          <EmptyBlock title="No breaks to place in the day" testId="md-tea-break-heatmap-empty">
            No tea break started in this period for this selection.
          </EmptyBlock>
        ) : (
          <>
            <Heatmap
              rows={matrix.rows}
              cols={matrix.cols}
              values={matrix.values}
              format={metric === "breaks" ? (n) => num(n) : (n) => pct(n, 0)}
              rowHeaderWidth={44}
              testId="md-tea-break-heatmap-grid"
            />
            <ul className="md-analytics-note space-y-0.5" data-testid="md-tea-break-heatmap-notes">
              {caption.map((line) => (
                <li key={line}>{line}</li>
              ))}
              {metric === "rate" && (
                <li>
                  A rate needs at least {data.minCellBreaks} measured breaks in the cell; smaller cells show a dot.
                </li>
              )}
              {shown.hidden > 0 && (
                <li>
                  {num(shown.hidden)} {shown.hidden === 1 ? "break" : "breaks"} started outside {shown.slots[0].label}{" "}
                  to {shown.slots[shown.slots.length - 1].label} and are not drawn.
                </li>
              )}
            </ul>
          </>
        )
      ) : null}
    </SectionCard>
  );
}
