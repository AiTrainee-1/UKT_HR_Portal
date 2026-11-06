// Journey History -> Journey Simulation: one recorded journey replayed on the map, from its first recorded position to its last
// (or, while it is still being recorded, to the latest one). A marker travels the RECORDED positions in time order (on foot / on
// a two-wheeler / on a break / no location, from the recorded speed), the route is drawn behind it as it goes, and the page
// says the clock time, what the employee is doing, how far they have come and where they stopped. Play, Pause, Resume, Stop,
// Replay, a speed (1x to 60x real time, or the whole journey in 30 s / 1 min / 2 min) and a scrubber to jump anywhere. For a
// person whose device asks for less motion the replay starts in step-through mode (from one stop or gap to the next).
// The figures are the journey page's own (summary, stops, journeyStats), so they match it and the PDF.
import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Coffee,
  Crosshair,
  Flag,
  Footprints,
  Gauge,
  LocateFixed,
  LocateOff,
  MapPin,
  Pause,
  Play,
  RotateCcw,
  Route as RouteIcon,
  Square,
  Timer,
} from "lucide-react";
import { Avatar, Chip, EmptyNote, SectionCard } from "@/components/payroll/kit/parts";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { isTrackingNotFound, trackingErrorMessage, useJourney, useJourneyTrail } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { buildActivities, journeyStats } from "../activity";
import { buildTimeline, causeLabel, fmtDate, fmtDistance, fmtDuration, fmtSpeed, fmtTime } from "../logic";
import { LiveBadge } from "../ui";
import {
  FIT_SECONDS,
  SPEEDS,
  buildSimTrack,
  distanceSoFar,
  playSeconds,
  positionAt,
  progressOf,
  speedLabel,
  type SimState,
  type SimStop,
  type SimTrack,
  type SpeedChoice,
} from "./playback";
import Scrubber from "./Scrubber";
import SimulationMap from "./SimulationMap";
import { PUCK_COLOR, PUCK_LABEL } from "./simIcons";
import { usePlayback, usePrefersReducedMotion, type Playback } from "./usePlayback";

const iso = (t: number) => new Date(t).toISOString();

const SPEED_OPTIONS: { value: string; choice: SpeedChoice }[] = [
  ...FIT_SECONDS.map((seconds) => ({ value: `fit-${seconds}`, choice: { kind: "fit", seconds } as SpeedChoice })),
  ...SPEEDS.map((x) => ({ value: `x-${x}`, choice: { kind: "x", x } as SpeedChoice })),
];
const speedValue = (c: SpeedChoice) => (c.kind === "fit" ? `fit-${c.seconds}` : `x-${c.x}`);
const fitText = (s: number) => (s >= 60 ? `${s / 60} min` : `${s} s`);
const optionText = (c: SpeedChoice) =>
  c.kind === "fit" ? `Whole journey in ${fitText(c.seconds)}` : c.x === 1 ? "1× (real time)" : `${c.x}× real time`;

/** What the employee is doing at the replay's moment, in words. */
function statusText(state: SimState | null, track: SimTrack, active: boolean): { title: string; note: string } {
  if (!state) return { title: "No position", note: "" };
  if (state.gap) {
    const cause = state.gap.cause ? causeLabel(state.gap.cause) : "No location received";
    return {
      title: "No location",
      note: `${cause} for ${fmtDuration(state.gap.durationS)} (${fmtTime(iso(state.gap.startT))} - ${fmtTime(iso(state.gap.endT))}): the replay jumps to where it came back.`,
    };
  }
  if (state.stop) {
    const since = fmtTime(iso(state.stop.startT));
    const sofar = Math.max(0, Math.round((state.t - state.stop.startT) / 1000));
    return {
      title: `At stop ${state.stop.number}`,
      note: `Since ${since} · ${fmtDuration(sofar)} so far${state.stop.durationS ? ` of ${fmtDuration(state.stop.durationS)}` : ""}`,
    };
  }
  if (state.atEnd) {
    return active
      ? {
          title: "Latest position",
          note: "The journey is still being recorded: this is where the employee was last seen.",
        }
      : { title: "Journey end", note: "The last recorded position of the journey." };
  }
  if (state.atStart && track.points.length > 1) return { title: "Start", note: "The first recorded position." };
  return {
    title: state.mode === "vehicle" ? "On the move" : state.mode === "walking" ? "On foot" : "Moving slowly",
    note: state.speedKmh !== null ? fmtSpeed(state.speedKmh) : "",
  };
}

function Fact({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof Clock3;
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 rounded-lg bg-slate-50 p-1.5 text-slate-600 ring-1 ring-slate-100">
        <Icon size={13} />
      </span>
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
        <p className="text-sm font-bold text-gray-900">{value}</p>
        {hint && <p className="truncate text-[11px] text-slate-500">{hint}</p>}
      </div>
    </div>
  );
}

function Controls({ track, playback, reducedMotion }: { track: SimTrack; playback: Playback; reducedMotion: boolean }) {
  const playable = track.points.length > 1 && track.durationMs > 0;
  const playing = playback.status === "playing";
  const resumable = playback.status === "paused";
  const seconds = playable ? Math.round(playSeconds(track, playback.rate)) : 0;
  const stepButtons = (
    <div className="flex items-center gap-1.5">
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-9 gap-1 text-xs"
        onClick={playback.stepBack}
        disabled={!playable}
        aria-label="Previous stop or gap"
        data-testid="sim-step-back"
      >
        <ChevronLeft size={14} /> Previous
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-9 gap-1 text-xs"
        onClick={playback.stepForward}
        disabled={!playable}
        aria-label="Next stop or gap"
        data-testid="sim-step-forward"
      >
        Next <ChevronRight size={14} />
      </Button>
    </div>
  );
  return (
    <div className="space-y-3 border-t border-slate-100 px-4 py-3" data-testid="sim-controls">
      <div className="flex flex-wrap items-center gap-2">
        {playing ? (
          <Button
            type="button"
            size="sm"
            className="h-9 min-w-[7.5rem] gap-1.5"
            onClick={playback.pause}
            data-testid="sim-pause"
          >
            <Pause size={14} /> Pause
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            className="h-9 min-w-[7.5rem] gap-1.5"
            onClick={playback.play}
            disabled={!playable}
            data-testid="sim-play"
          >
            <Play size={14} />{" "}
            {resumable ? "Resume" : playback.status === "ended" ? "Play again" : reducedMotion ? "Play anyway" : "Play"}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-9 gap-1.5 text-xs"
          onClick={playback.stop}
          disabled={!playable || playback.status === "idle"}
          data-testid="sim-stop"
        >
          <Square size={12} /> Stop
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-9 gap-1.5 text-xs"
          onClick={playback.replay}
          disabled={!playable}
          data-testid="sim-replay"
        >
          <RotateCcw size={13} /> Replay
        </Button>
        {stepButtons}
        <label className="ml-auto flex items-center gap-2 text-xs font-semibold text-gray-600">
          <Gauge size={14} className="text-slate-400" aria-hidden />
          Speed
          <select
            className="h-9 rounded-md border bg-background px-2 text-sm font-medium"
            value={speedValue(playback.speed)}
            onChange={(e) => {
              const picked = SPEED_OPTIONS.find((o) => o.value === e.target.value);
              if (picked) playback.setSpeed(picked.choice);
            }}
            data-testid="sim-speed"
          >
            {SPEED_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {optionText(o.choice)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Scrubber track={track} t={playback.t} onSeek={playback.seek} disabled={!playable} />
      <p className="text-[11px] text-gray-500" data-testid="sim-speed-note">
        {playable
          ? `${speedLabel(playback.speed)}: the replay takes about ${fmtDuration(seconds)}. Gaps with no location are jumped over.`
          : track.points.length === 1
            ? "Only one position was recorded: there is no route to play."
            : "No position was recorded: there is nothing to replay."}
        {reducedMotion &&
          playable &&
          " Your device asks for less motion, so the replay steps from stop to stop; Play animates it anyway."}
      </p>
    </div>
  );
}

function StopList({
  stops,
  current,
  onPick,
}: {
  stops: SimStop[];
  current: string | null;
  onPick: (s: SimStop) => void;
}) {
  if (stops.length === 0) {
    return (
      <p className="rounded-xl border border-dashed px-3 py-5 text-center text-xs text-gray-500">
        No stop of 3 minutes or more was recorded.
      </p>
    );
  }
  return (
    <ol className="space-y-1.5" data-testid="sim-stops">
      {stops.map((s) => {
        const on = s.key === current;
        return (
          <li key={s.key}>
            <button
              type="button"
              onClick={() => onPick(s)}
              data-testid="sim-stop-row"
              data-current={on || undefined}
              className={cn(
                "flex w-full items-start gap-3 rounded-xl border px-3 py-2 text-left transition-colors",
                on ? "border-amber-300 bg-amber-50" : "border-transparent hover:bg-slate-50",
              )}
            >
              <span
                className={cn(
                  "mt-0.5 flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full px-1 text-[11px] font-bold text-white",
                  s.long ? "bg-violet-600" : "bg-amber-500",
                )}
              >
                {s.number}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-semibold text-gray-900">{s.place || "Unknown place"}</span>
                <span className="block text-[11px] tabular-nums text-gray-600">
                  Arrived {fmtTime(iso(s.startT))} · {s.endT === null ? "still there" : `left ${fmtTime(iso(s.endT))}`}
                </span>
              </span>
              <span className="shrink-0 text-xs font-bold tabular-nums text-gray-900">
                {s.durationS === null ? "ongoing" : fmtDuration(s.durationS)}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function Loading({ back }: { back: ReactNode }) {
  return (
    <div className="space-y-4" data-testid="sim-loading">
      {back}
      <Skeleton className="h-24 rounded-2xl" />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-0 overflow-hidden rounded-2xl border border-slate-100">
          <Skeleton className="h-[460px] rounded-none" />
          <div className="space-y-2 p-4">
            <Skeleton className="h-9 w-2/3" />
            <Skeleton className="h-3 w-full rounded-full" />
          </div>
        </div>
        <div className="space-y-4">
          <Skeleton className="h-40 rounded-2xl" />
          <Skeleton className="h-56 rounded-2xl" />
        </div>
      </div>
    </div>
  );
}

export default function JourneySimulation({
  id,
  onBack,
  onOpenJourney,
}: {
  id: number;
  onBack: () => void;
  onOpenJourney: (id: number) => void;
}) {
  const query = useJourney(id);
  const detail = query.data;
  const active = detail?.track.status === "active";
  const trailQuery = useJourneyTrail(id, detail !== undefined, active);
  const reducedMotion = usePrefersReducedMotion();
  const [follow, setFollow] = useState(true);
  const [fits, setFits] = useState(0);

  const rows = useMemo(() => (detail ? buildTimeline(detail.segments, detail.events, active) : []), [detail, active]);
  const track = useMemo(
    () => buildSimTrack(trailQuery.data, { rows, segments: detail?.segments, path: detail?.path }),
    [trailQuery.data, rows, detail],
  );
  // the journey page's own story and figures: the start and end places, the duration
  const ends = useMemo(() => (detail ? buildActivities(detail, rows, active) : []), [detail, rows, active]);
  const stats = useMemo(() => (detail ? journeyStats(detail, ends) : null), [detail, ends]);
  const playback = usePlayback(track);
  const state = positionAt(track, playback.t);
  const status = statusText(state, track, active);
  const pickStop = useCallback((s: SimStop) => playback.seek(s.startT), [playback]);

  const back = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Button variant="ghost" size="sm" className="-ml-2 h-8 gap-1.5 text-xs" onClick={onBack} data-testid="sim-back">
        <ArrowLeft size={13} /> Back to journeys
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="h-8 gap-1.5 text-xs"
        onClick={() => onOpenJourney(id)}
        data-testid="sim-open-journey"
      >
        <RouteIcon size={13} /> Journey details
      </Button>
    </div>
  );

  if (query.isPending || (detail && trailQuery.isPending)) return <Loading back={back} />;

  if (!detail || !stats) {
    return (
      <div className="space-y-4" data-testid="sim-error">
        {back}
        <EmptyNote
          icon={AlertTriangle}
          title={isTrackingNotFound(query.error) ? "This journey was not found." : "The journey could not be loaded."}
          hint={trackingErrorMessage(query.error, "Check the connection and try again.")}
          action={
            <Button variant="outline" size="sm" className="mt-1" onClick={() => void query.refetch()}>
              Try again
            </Button>
          }
        />
      </div>
    );
  }

  const { track: head, summary } = detail;
  const start = ends.find((a) => a.kind === "start");
  const end = ends[ends.length - 1];
  const look = state?.gap ? "gap" : (state?.mode ?? "still");
  const covered = distanceSoFar(track, state, summary.distanceM);
  const progress = progressOf(track, playback.t);
  const playable = track.points.length > 1 && track.durationMs > 0;

  return (
    <div className="space-y-4" data-testid="journey-simulation" data-journey-id={id} data-points={track.points.length}>
      {back}

      <section className="clay-card rounded-2xl border border-slate-100 p-4 sm:p-5" data-testid="sim-hero">
        <div className="flex flex-wrap items-center gap-4">
          <Avatar name={head.employeeName} size={52} className="rounded-2xl text-base" />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-[11px] font-bold uppercase tracking-wider text-sky-700">Journey simulation</p>
            <h3 className="flex flex-wrap items-center gap-x-2 text-xl font-black leading-tight text-gray-900">
              {head.employeeName}
              <span className="font-mono text-sm font-semibold text-gray-500">({head.employeeCode})</span>
            </h3>
            <p className="text-sm text-gray-700">
              On-Duty to <b>&ldquo;{head.destination || "no destination"}&rdquo;</b>
              <span className="text-gray-500"> · {head.department ?? "No department"}</span>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {active ? <LiveBadge>Still recording</LiveBadge> : <Chip tone="neutral">Ended</Chip>}
            <span className="inline-flex items-center gap-1.5 rounded-xl bg-slate-50 px-3 py-1.5 text-sm font-semibold text-slate-700 ring-1 ring-slate-100">
              <CalendarDays size={14} className="text-[#006496]" /> {fmtDate(head.startedAt)}
            </span>
          </div>
        </div>
      </section>

      {active && (
        <p className="rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-900" data-testid="sim-live-note">
          This journey is still being recorded: the replay ends at the latest position
          {track.points.length ? ` (${fmtTime(iso(track.endT))})` : ""} and grows as new positions arrive (every 30
          seconds).
        </p>
      )}
      {trailQuery.isError && (
        <p
          role="alert"
          className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900"
          data-testid="sim-trail-error"
        >
          The recorded positions could not be loaded ({trackingErrorMessage(trailQuery.error, "connection problem")}).
          {track.source === "path" ? " Replaying the simplified route instead." : ""}{" "}
          <button type="button" className="font-semibold underline" onClick={() => void trailQuery.refetch()}>
            Try again
          </button>
        </p>
      )}
      {track.source === "trail" && trailQuery.data?.truncated && (
        <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-700" data-testid="sim-thinned-note">
          A very long journey: the server sent {trailQuery.data.count} of its {trailQuery.data.total} positions, evenly
          spread (every stop and gap boundary kept).
        </p>
      )}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <section className="clay-card overflow-hidden rounded-2xl border border-slate-100" data-testid="sim-map-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
            <div className="min-w-0">
              <h3 className="flex items-center gap-2 text-sm font-bold text-gray-900">
                <RouteIcon size={15} className="text-[#006496]" /> Replay
              </h3>
              <p className="text-xs text-muted-foreground">
                {track.points.length} recorded position{track.points.length === 1 ? "" : "s"}, in time order; nothing is
                drawn that was not recorded.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className={cn("h-8 gap-1.5 text-xs", follow && "border-sky-300 bg-sky-50 text-sky-800")}
                aria-pressed={follow}
                onClick={() => setFollow((f) => !f)}
                data-testid="sim-follow"
              >
                <LocateFixed size={13} /> Follow
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 text-xs"
                onClick={() => setFits((n) => n + 1)}
                data-testid="sim-fit"
              >
                <Crosshair size={13} /> Fit route
              </Button>
            </div>
          </div>
          <div className="relative h-[380px] sm:h-[480px] xl:h-[540px]" data-testid="sim-map">
            <SimulationMap
              track={track}
              subscribe={playback.subscribe}
              follow={follow}
              reducedMotion={reducedMotion}
              fitSignal={fits}
              onPickStop={pickStop}
            />
            {track.points.length > 0 && (
              <div
                className="pointer-events-none absolute bottom-3 left-3 z-[500] max-w-[calc(100%-1.5rem)] rounded-xl border border-slate-200 bg-white px-3 py-2 animate-in fade-in slide-in-from-bottom-2 duration-300 motion-reduce:animate-none"
                data-testid="sim-clock"
                aria-live="off"
              >
                <p className="flex items-center gap-2 text-lg font-black tabular-nums leading-none text-gray-900">
                  <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: PUCK_COLOR[look] }} />
                  {fmtTime(iso(playback.t), true)}
                </p>
                <p className="mt-1 text-[11px] font-semibold text-gray-600">
                  {status.title}
                  {state && !state.gap && !state.stop && state.speedKmh !== null && !state.atEnd
                    ? ` · ${fmtSpeed(state.speedKmh)}`
                    : ""}
                </p>
              </div>
            )}
            {track.points.length === 0 && (
              <div
                className="pointer-events-none absolute inset-0 z-[500] flex items-center justify-center bg-white/70 p-6 text-center"
                data-testid="sim-empty"
              >
                <p className="max-w-xs rounded-xl bg-white px-4 py-3 text-sm text-gray-600 ring-1 ring-gray-200">
                  No position was recorded for this journey, so there is nothing to replay. Open the journey details to
                  see its events.
                </p>
              </div>
            )}
          </div>
          <Controls track={track} playback={playback} reducedMotion={reducedMotion} />
        </section>

        <div className="space-y-4">
          <SectionCard title="Now" icon={Clock3} testId="sim-now">
            <div className="space-y-3">
              <div className="flex items-start gap-3">
                <span
                  aria-hidden
                  className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white"
                  style={{ background: PUCK_COLOR[look] }}
                >
                  {look === "gap" ? (
                    <LocateOff size={16} />
                  ) : look === "still" ? (
                    <Coffee size={16} />
                  ) : (
                    <Footprints size={16} />
                  )}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-bold text-gray-900" data-testid="sim-status">
                    {status.title}
                  </p>
                  <p className="text-xs leading-snug text-gray-600">{status.note || PUCK_LABEL[look]}</p>
                </div>
              </div>
              <div>
                <div className="flex items-baseline justify-between text-xs">
                  <span className="font-semibold text-gray-600">Distance so far</span>
                  <span className="font-bold tabular-nums text-gray-900" data-testid="sim-distance">
                    {fmtDistance(covered)}{" "}
                    <span className="font-medium text-gray-500">of {fmtDistance(summary.distanceM)}</span>
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full bg-sky-600"
                    style={{
                      width: `${summary.distanceM > 0 ? Math.min(100, (covered / summary.distanceM) * 100) : progress * 100}%`,
                    }}
                  />
                </div>
                <p className="mt-1.5 text-[11px] text-gray-500">
                  {playable
                    ? `${fmtDuration(Math.round((playback.t - track.startT) / 1000))} into the recorded ${fmtDuration(Math.round(track.durationMs / 1000))}`
                    : "-"}
                </p>
              </div>
            </div>
          </SectionCard>

          <SectionCard title="Journey" icon={RouteIcon} testId="sim-summary">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-1">
              <Fact
                icon={Flag}
                label="Start"
                value={fmtTime(head.startedAt)}
                hint={start?.place || "No position yet"}
              />
              <Fact
                icon={MapPin}
                label={active ? "Latest position" : "End"}
                value={fmtTime(active ? head.lastPointAt : (head.endedAt ?? head.lastPointAt))}
                hint={end?.place || "-"}
              />
              <Fact
                icon={RouteIcon}
                label="Total distance"
                value={fmtDistance(summary.distanceM)}
                hint={summary.maxSpeedKmh > 0 ? `Top speed ${Math.round(summary.maxSpeedKmh)} km/h` : undefined}
              />
              <Fact
                icon={Timer}
                label="Duration"
                value={fmtDuration(stats.journeyS)}
                hint={active ? "so far" : "start to end"}
              />
              <Fact
                icon={Coffee}
                label="Stops"
                value={`${summary.stopCount} · ${fmtDuration(summary.stopS)}`}
                hint={summary.stopCount > 0 ? `Longest ${fmtDuration(summary.longestStopS)}` : "none of 3 min or more"}
              />
              <Fact
                icon={LocateOff}
                label="No location"
                value={fmtDuration(summary.gapS)}
                hint={
                  track.gaps.length
                    ? `${track.gaps.length} gap${track.gaps.length === 1 ? "" : "s"} in the positions`
                    : "no gap"
                }
              />
            </div>
          </SectionCard>

          <SectionCard
            title="Stops"
            description="Click a stop to jump to its arrival."
            icon={Coffee}
            testId="sim-stops-card"
          >
            <StopList stops={track.stops} current={state?.stop?.key ?? null} onPick={pickStop} />
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
