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
          <div className="md-panel p-3 sm:p-4">
            <Heatmap {...heatmapShape(h)} rowHeaderWidth={44} cellHeight={26} testId="md-activity-heatmap-grid" />
          </div>
          <p
            className="md-panel-wine md-people-callout text-xs leading-relaxed text-md-ink"
            data-testid="md-activity-heatmap-summary"
          >
            <Clock size={15} className="mt-0.5 shrink-0 text-md-wine" aria-hidden="true" />
            <span>
              {peak && (
                <>
                  <b>Busiest: {peak}.</b>{" "}
                </>
              )}
              {afterHoursText(
                h.afterHours.events,
                h.total,
                h.afterHours.sharePct,
                h.afterHours.weekend,
                h.afterHours.night,
              )}
            </span>
          </p>
          {after.isError ? (
            <ErrorBanner message={describeMdError(after.error)} onRetry={() => after.refetch()} />
          ) : a && a.events > 0 ? (
            <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-2" data-testid="md-activity-after-hours">
              <div className="md-panel p-4">
                <ListHeading>Who works outside normal hours</ListHeading>
                <ul>
                  {a.byUser.map((p) => (
                    <li key={p.userName} className="md-people-row">
                      <PersonCell name={p.userName} role={p.role} />
                      <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                        <Chip tone="info">
                          {num(p.afterHours)} {plural(p.afterHours, "action")}
                        </Chip>
                        {p.weekend > 0 && <Chip>{num(p.weekend)} Sunday</Chip>}
                        {p.sensitive > 0 && <Chip tone="warning">{num(p.sensitive)} sensitive</Chip>}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="md-panel p-4">
                <ListHeading>Latest cases</ListHeading>
                <ul className="space-y-3">
                  {a.recent.map((c, i) => (
                    <li key={`${c.at}-${i}`} className="text-xs text-md-ink">
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <b className="text-[13px]">{c.userName}</b>
                        <span className="text-md-ink-soft">{whenText(c.at)}</span>
                        <Chip tone="info">{afterKindText(c.kind)}</Chip>
                        {c.severity && <SeverityChip severity={c.severity} />}
                      </p>
                      <p className="mt-0.5 leading-snug text-md-ink-soft">
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
