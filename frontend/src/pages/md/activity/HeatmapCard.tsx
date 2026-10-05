import { Clock } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import Heatmap from "@/components/md/kit/Heatmap";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock, ErrorBanner } from "@/components/md/kit/states";
import { describeMdError, useMdQuery, type MdQueryParams } from "@/lib/api-client/custom-hooks/md";
import { num } from "@/lib/md/format";
import { afterHoursText, afterKindText, ask, heatmapShape, peakText, plural, whenText } from "./logic";
import { Chip, ListHeading, PersonCell, SeverityChip } from "./parts";
import type { ActivityAfterHours, ActivityHeatmap } from "./types";

/** When people act: weekday by hour in factory time, and who works outside normal hours. */
export default function HeatmapCard({ params, label }: { params: MdQueryParams; label: string }) {
  const q = useMdQuery<ActivityHeatmap>("activity/heatmap", params);
  const after = useMdQuery<ActivityAfterHours>("activity/after-hours", { ...params, limit: 5 });
  const h = q.data;
  const a = after.data;
  const peak = h ? peakText(h) : null;
  return (
    <SectionCard
      title="When people act"
      subtitle={
        h
          ? `Actions by day and hour, factory time. Normal hours: ${h.workingHours.label}`
          : "Actions by day and hour, factory time"
      }
      provenance={h?.provenance}
      loading={q.isPending}
      actions={<AskAiButton question={ask.heatmap(label)} />}
      testId="md-activity-heatmap"
    >
      {q.isError ? (
        <ErrorBanner message={describeMdError(q.error)} onRetry={() => q.refetch()} />
      ) : h && h.total === 0 ? (
        <EmptyBlock icon={Clock} title="No activity to chart" testId="md-activity-heatmap-empty">
          No actions were recorded in this period.
        </EmptyBlock>
      ) : h ? (
        <div className="space-y-4">
          <Heatmap {...heatmapShape(h)} rowHeaderWidth={44} cellHeight={26} testId="md-activity-heatmap-grid" />
          <p className="text-xs text-[#006496]/70" data-testid="md-activity-heatmap-summary">
            {peak && (
              <>
                <b className="text-[#1a3a4a]">Busiest: {peak}.</b>{" "}
              </>
            )}
            {afterHoursText(
              h.afterHours.events,
              h.total,
              h.afterHours.sharePct,
              h.afterHours.weekend,
              h.afterHours.night,
            )}
          </p>
          {after.isError ? (
            <ErrorBanner message={describeMdError(after.error)} onRetry={() => after.refetch()} />
          ) : a && a.events > 0 ? (
            <div
              className="grid grid-cols-1 gap-5 border-t pt-4 @3xl:grid-cols-2"
              data-testid="md-activity-after-hours"
            >
              <div>
                <ListHeading>Who works outside normal hours</ListHeading>
                <ul className="space-y-2.5">
                  {a.byUser.map((p) => (
                    <li key={p.userName} className="flex items-center justify-between gap-3">
                      <PersonCell name={p.userName} role={p.role} />
                      <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                        <Chip className="border-indigo-200 bg-indigo-50 text-indigo-800">
                          {num(p.afterHours)} {plural(p.afterHours, "action")}
                        </Chip>
                        {p.weekend > 0 && (
                          <Chip className="border-slate-200 bg-slate-50 text-slate-700">{num(p.weekend)} Sunday</Chip>
                        )}
                        {p.sensitive > 0 && (
                          <Chip className="border-amber-200 bg-amber-100 text-amber-800">
                            {num(p.sensitive)} sensitive
                          </Chip>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <ListHeading>Latest cases</ListHeading>
                <ul className="space-y-2.5">
                  {a.recent.map((c, i) => (
                    <li key={`${c.at}-${i}`} className="text-xs text-[#1a3a4a]">
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <b className="text-[13px]">{c.userName}</b>
                        <span className="text-[#006496]/65">{whenText(c.at)}</span>
                        <Chip className="border-indigo-200 bg-indigo-50 text-indigo-800">{afterKindText(c.kind)}</Chip>
                        {c.severity && <SeverityChip severity={c.severity} />}
                      </p>
                      <p className="text-[#006496]/65">
                        {c.what ?? "Routine change"} · {c.area}
                        {c.count > 1 ? ` · ${num(c.count)} actions` : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </SectionCard>
  );
}
