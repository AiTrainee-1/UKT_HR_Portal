// Journey History: the journey as a vertical story. One node per thing that happened (started, break, resumed, no location, notice,
// completed), joined by a line that carries the travel between them. Picking an item points it out on the map and opens its
// details; picking a pin on the map opens its item. The detailed table (every segment and event, with the category filters)
// stays below this in <Timeline>.
import { useEffect, useRef, useState, type ComponentType } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Coffee,
  Flag,
  MapPin,
  Navigation,
  PlayCircle,
  Radio,
  Route as RouteIcon,
  LocateOff,
} from "lucide-react";
import { SectionCard, Chip } from "@/components/payroll/kit/parts";
import { cn } from "@/lib/utils";
import { legText, type Activity, type ActivityKind, type JourneyStats } from "./activity";
import { fmtDuration, fmtTime, timeRange } from "./logic";
import { PlaceLinks } from "./PlaceLinks";

type IconType = ComponentType<{ size?: number; className?: string }>;

type Look = { icon: IconType; node: string; label: string };

/** How each kind of item is drawn: its icon, the colour of its node (start and end share one green; breaks are amber or purple). */
const LOOK: Record<ActivityKind, Look> = {
  start: { icon: Flag, node: "bg-emerald-600 text-white", label: "Start" },
  break: { icon: Coffee, node: "bg-amber-500 text-white", label: "Break" },
  resume: { icon: PlayCircle, node: "bg-sky-600 text-white", label: "Resumed" },
  gap: { icon: LocateOff, node: "bg-slate-400 text-white", label: "No location" },
  notice: { icon: AlertTriangle, node: "bg-rose-500 text-white", label: "Notice" },
  end: { icon: CheckCircle2, node: "bg-emerald-600 text-white", label: "Completed" },
  live: { icon: Radio, node: "bg-emerald-600 text-white", label: "Live" },
};

const lookOf = (a: Activity): Look =>
  a.kind === "break" && a.longBreak ? { ...LOOK.break, node: "bg-violet-600 text-white" } : LOOK[a.kind];

function when(a: Activity): string {
  if (a.kind === "break" || a.kind === "gap") return timeRange(a.startedAt, a.endedAt, a.open);
  return fmtTime(a.startedAt);
}

function Stat({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="rounded-xl bg-slate-50 px-3 py-2 ring-1 ring-slate-100" data-testid={testId}>
      <p className="text-[11px] font-medium text-slate-500">{label}</p>
      <p className="text-sm font-black tabular-nums text-gray-900">{value}</p>
    </div>
  );
}

function Leg({
  leg,
  selected,
  onPick,
}: {
  leg: NonNullable<Activity["legBefore"]>;
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      data-testid="activity-leg"
      data-key={leg.key}
      data-selected={selected ? "true" : "false"}
      title="Show this stretch of the route on the map"
      className={cn(
        "mb-2 inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold",
        selected ? "border-sky-400 bg-sky-50 text-sky-800" : "border-sky-100 bg-sky-50/70 text-sky-800 hover:bg-sky-50",
      )}
    >
      <Navigation size={11} className="shrink-0" />
      <span className="truncate">Travelled {legText(leg)}</span>
      {leg.estimated && <span className="rounded bg-white/70 px-1 text-[10px] font-bold text-sky-600">estimated</span>}
    </button>
  );
}

export default function ActivityTimeline({
  activities,
  stats,
  selectedKey,
  onSelect,
  active,
}: {
  activities: Activity[];
  stats: JourneyStats;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  active: boolean;
}) {
  // the items the reader opened by hand (an item that holds the picked pin is open as well)
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const isSelected = (a: Activity) => selectedKey !== null && a.rowKeys.includes(selectedKey);
  const selectedRef = useRef<HTMLLIElement | null>(null);

  // a pin picked on the map brings its item into view (and a pick made here is already in view: nothing moves)
  useEffect(() => {
    selectedRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [selectedKey]);

  const toggle = (a: Activity) => {
    const open = opened.has(a.key) || isSelected(a);
    const next = new Set(opened);
    if (open) {
      next.delete(a.key);
      if (isSelected(a)) onSelect(null);
    } else {
      next.add(a.key);
      if (a.selectKey) onSelect(a.selectKey);
    }
    setOpened(next);
  };

  const onlyEnds = activities.every((a) => a.kind === "start" || a.kind === "end" || a.kind === "live");

  return (
    <SectionCard
      title="Journey timeline"
      description="In the order it happened. Pick an item to see it on the map."
      icon={RouteIcon}
      testId="activity-timeline"
      actions={
        <button
          type="button"
          className="text-xs font-semibold text-[#006496] hover:underline"
          data-testid="activity-toggle-all"
          onClick={() => {
            const everyOpen = activities.every((a) => opened.has(a.key));
            setOpened(everyOpen ? new Set() : new Set(activities.map((a) => a.key)));
            if (everyOpen) onSelect(null);
          }}
        >
          {activities.every((a) => opened.has(a.key)) ? "Collapse all" : "Expand all"}
        </button>
      }
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="activity-summary">
        <Stat
          testId="stat-breaks"
          label="Breaks taken"
          value={
            stats.breakCount === 0
              ? "None"
              : `${stats.breakCount}${stats.longBreakCount > 0 ? ` (${stats.longBreakCount} long)` : ""}`
          }
        />
        <Stat testId="stat-break-time" label="Time on breaks" value={fmtDuration(stats.breakS)} />
        <Stat testId="stat-travel-time" label="Time travelling" value={fmtDuration(stats.travelS)} />
        <Stat testId="stat-started" label="Started travelling" value={stats.started === 1 ? "1 time" : "-"} />
        <Stat
          testId="stat-resumed"
          label="Resumed after a break"
          value={stats.resumed === 1 ? "1 time" : `${stats.resumed} times`}
        />
        <Stat testId="stat-total" label="Whole journey" value={fmtDuration(stats.journeyS)} />
      </div>

      <ol className="mt-5" data-testid="activity-list">
        {activities.map((a, index) => {
          const look = lookOf(a);
          const Icon = look.icon;
          const selected = isSelected(a);
          const open = selected || opened.has(a.key);
          const first = index === 0;
          const last = index === activities.length - 1;
          return (
            <li
              key={a.key}
              ref={selected ? selectedRef : undefined}
              className="relative pb-5 pl-14 last:pb-0"
              data-testid="activity-item"
              data-kind={a.kind}
              data-key={a.key}
              data-selected={selected ? "true" : "false"}
            >
              {/* the line: blue where the journey was on the road, dashed where no location was recorded, grey otherwise */}
              {a.legBefore && (
                <span aria-hidden className="absolute left-[19px] top-0 h-10 w-0 border-l-2 border-sky-300" />
              )}
              {!last && (
                <span
                  aria-hidden
                  className={cn(
                    "absolute bottom-0 left-[19px] w-0 border-l-2",
                    a.legBefore ? "top-[56px]" : "top-5",
                    activities[index + 1].legBefore
                      ? "border-sky-300"
                      : activities[index + 1].kind === "gap" || a.kind === "gap"
                        ? "border-dashed border-slate-300"
                        : "border-slate-200",
                  )}
                />
              )}
              <span
                aria-hidden
                className={cn(
                  "absolute left-0 flex h-10 w-10 items-center justify-center rounded-full shadow-sm ring-4 ring-white",
                  look.node,
                  a.kind === "live" && "animate-pulse",
                  a.legBefore ? "top-9" : "top-0",
                )}
              >
                <Icon size={17} />
              </span>

              {a.legBefore && (
                <Leg
                  leg={a.legBefore}
                  selected={selectedKey === a.legBefore.key}
                  onPick={() => onSelect(selectedKey === a.legBefore?.key ? null : (a.legBefore?.key ?? null))}
                />
              )}

              <div
                className={cn(
                  "rounded-xl border bg-white transition-colors",
                  selected ? "border-sky-400 bg-sky-50/50 shadow-sm" : "border-slate-100 hover:border-slate-200",
                  first && "min-h-10",
                )}
              >
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => toggle(a)}
                  className="flex w-full items-start gap-3 rounded-xl px-3.5 py-2.5 text-left"
                  data-testid="activity-head"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-sm font-bold text-gray-900">{a.title}</span>
                      {a.breakNumber !== null && (
                        <Chip tone={a.longBreak ? "accent" : "warning"}>
                          Break {a.breakNumber}
                          {a.longBreak ? " · long" : ""}
                        </Chip>
                      )}
                      {a.mock && <Chip tone="danger">simulated</Chip>}
                      {a.estimated && <Chip tone="info">estimated</Chip>}
                      {a.kind === "live" && <Chip tone="success">live</Chip>}
                    </span>
                    {a.place && (
                      <span className="mt-0.5 flex items-center gap-1 text-xs text-gray-600">
                        <MapPin size={11} className="shrink-0 text-slate-400" />
                        <span className="truncate">{a.place}</span>
                      </span>
                    )}
                    {a.note && <span className="mt-0.5 block text-xs text-slate-500">{a.note}</span>}
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1 text-right">
                    <span className="font-mono text-xs font-semibold tabular-nums text-gray-800">{when(a)}</span>
                    {a.durationS !== null && a.durationS > 0 && (
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-[11px] font-bold",
                          a.kind === "break"
                            ? a.longBreak
                              ? "bg-violet-50 text-violet-700"
                              : "bg-amber-50 text-amber-800"
                            : "bg-slate-100 text-slate-600",
                        )}
                      >
                        {fmtDuration(a.durationS)}
                      </span>
                    )}
                    {a.open && a.durationS === null && (
                      <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-bold text-emerald-700">
                        ongoing
                      </span>
                    )}
                    <ChevronDown
                      size={14}
                      className={cn("text-slate-400 transition-transform", open && "rotate-180")}
                      aria-hidden
                    />
                  </span>
                </button>

                {open && (
                  <div
                    className="space-y-2.5 border-t border-slate-100 px-3.5 pb-3 pt-2.5"
                    data-testid="activity-details"
                  >
                    {a.facts.length > 0 && (
                      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                        {a.facts.map(([label, value]) => (
                          <div key={label} className="flex justify-between gap-3 border-b border-slate-50 py-0.5">
                            <dt className="text-slate-500">{label}</dt>
                            <dd className="text-right font-semibold text-gray-900">{value}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                    {a.pos && <PlaceLinks lat={a.pos[0]} lng={a.pos[1]} />}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {onlyEnds && (
        <p
          className="mt-4 rounded-xl bg-slate-50 px-3 py-2 text-center text-xs text-slate-500"
          data-testid="activity-none"
        >
          {active
            ? "No stops or travel have been recorded yet. They appear here as the phone reports."
            : "No stops or travel were recorded for this journey."}
        </p>
      )}
    </SectionCard>
  );
}
