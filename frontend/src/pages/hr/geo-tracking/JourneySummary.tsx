// Journey History: the figures of one journey in one band. Five big figures (how far, how long on the road, how long on breaks, how
// long without a location, the whole journey), a bar that shows how the time was spent, and the smaller counts under it.
import { Clock, Coffee, Navigation, Ruler, LocateOff, Timer } from "lucide-react";
import { KpiTile } from "@/components/payroll/kit/parts";
import type { JourneyDetail } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { timeSplit, type JourneyStats } from "./activity";
import { fmtDistance, fmtDuration } from "./logic";

const pct = (n: number): string => `${Math.round(n * 100)}%`;

function Count({
  label,
  value,
  hint,
  testId,
}: {
  label: string;
  value: string | number;
  hint?: string;
  testId: string;
}) {
  return (
    <div className="flex items-baseline gap-2" data-testid={testId} title={hint}>
      <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</span>
      <span className="text-sm font-black tabular-nums text-gray-900" data-testid={`${testId}-value`}>
        {value}
      </span>
      {hint && <span className="hidden text-[11px] text-slate-400 xl:inline">{hint}</span>}
    </div>
  );
}

export default function JourneySummary({ detail, stats }: { detail: JourneyDetail; stats: JourneyStats }) {
  const { summary, track } = detail;
  const split = timeSplit(stats);
  const parts = [
    { key: "travel", label: "On the road", share: split.travel, bar: "bg-sky-500", dot: "bg-sky-500" },
    { key: "breaks", label: "On breaks", share: split.breaks, bar: "bg-amber-400", dot: "bg-amber-400" },
    { key: "gap", label: "No location", share: split.gap, bar: "bg-slate-300", dot: "bg-slate-300" },
    { key: "other", label: "Not measured", share: split.other, bar: "bg-slate-100", dot: "bg-slate-200" },
  ].filter((p) => p.share > 0.004);

  return (
    <section className="clay-card rounded-2xl border border-slate-100 p-4 sm:p-5" data-testid="journey-summary">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <KpiTile
          testId="card-distance"
          label="Distance"
          icon={Ruler}
          tone="bg-sky-50 text-sky-900"
          value={fmtDistance(summary.distanceM)}
          sub={summary.maxSpeedKmh > 0 ? `Top speed ${Math.round(summary.maxSpeedKmh)} km/h` : undefined}
        />
        <KpiTile
          testId="card-travel"
          label="Travel time"
          icon={Navigation}
          tone="bg-blue-50 text-blue-900"
          value={fmtDuration(summary.travelS)}
          sub={
            stats.legCount > 0 ? `${stats.legCount} ${stats.legCount === 1 ? "leg" : "legs"} on the road` : undefined
          }
        />
        <KpiTile
          testId="card-stationary"
          label="Stationary time"
          icon={Coffee}
          tone="bg-amber-50 text-amber-900"
          value={fmtDuration(summary.stopS)}
          sub="Waiting, breaks, stops"
        />
        <KpiTile
          testId="card-gap"
          label="Gap time"
          icon={LocateOff}
          tone={summary.gapS > 0 ? "bg-orange-50 text-orange-900" : "bg-slate-50 text-slate-700"}
          value={fmtDuration(summary.gapS)}
          sub="No location recorded"
        />
        <KpiTile
          testId="card-total"
          label="Whole journey"
          icon={Timer}
          tone="bg-emerald-50 text-emerald-900"
          className="col-span-2 lg:col-span-1"
          value={fmtDuration(stats.journeyS)}
          sub={track.status === "active" ? "so far" : "start to end"}
        />
      </div>

      <div className="mt-4" data-testid="time-split">
        <div
          className="flex h-2.5 overflow-hidden rounded-full bg-slate-100"
          role="img"
          aria-label="How the time was spent"
        >
          {parts.map((p) => (
            <span key={p.key} className={cn("h-full", p.bar)} style={{ width: `${p.share * 100}%` }} />
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          {parts.map((p) => (
            <span key={p.key} className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-600">
              <span aria-hidden className={cn("h-2 w-2 rounded-full", p.dot)} />
              {p.label} {pct(p.share)}
            </span>
          ))}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-1.5 border-t border-slate-100 pt-3">
        <Count testId="card-stops" label="Stops" value={summary.stopCount} />
        <Count
          testId="card-longest"
          label="Longest stop"
          value={summary.stopCount > 0 ? fmtDuration(summary.longestStopS) : "-"}
        />
        <Count testId="card-points" label="Points" value={track.pointsCount} hint="GPS positions received" />
        <Count testId="card-events" label="Events" value={track.eventsCount} hint="Location off, network lost ..." />
        <span className="ml-auto hidden items-center gap-1 text-[11px] text-slate-400 lg:flex">
          <Clock size={11} /> Times are India time (IST)
        </span>
      </div>
    </section>
  );
}
