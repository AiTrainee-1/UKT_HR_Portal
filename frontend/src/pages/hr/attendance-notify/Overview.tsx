import { useState } from "react";
import {
  Activity,
  AlertTriangle,
  Briefcase,
  CalendarClock,
  ChevronRight,
  Clock,
  Users,
  Workflow,
  XCircle,
} from "lucide-react";
import { KpiTile, SectionCard, SkeletonKpis } from "@/components/payroll/kit/parts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  NOTIFY_CATEGORIES,
  NOTIFY_CHANNELS,
  useAttendanceNotifySnapshot,
  type NotifyChannel,
  type NotifyEmployeeType,
  type NotifyOverview,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import {
  CATEGORY_META,
  CHANNEL_LABEL,
  EMPLOYEE_TYPE_LABEL,
  dateLabel,
  istToday,
  phoneLabel,
  relativeText,
  whenText,
} from "./logic";
import { CHANNEL_META, ChannelIcon, EMPLOYEE_TYPE_OPTIONS, Segmented } from "./parts";

const CATEGORY_ICON = {
  absent: XCircle,
  cl: CalendarClock,
  on_leave: Users,
  on_duty: Briefcase,
  permission: Clock,
  compensation: Activity,
} as const;

/** The three channels: can each deliver right now, and how many automations use it. A card opens its tab. */
function ChannelCards({
  overview,
  canOpen,
  onOpen,
}: {
  overview: NotifyOverview;
  canOpen: (c: NotifyChannel) => boolean;
  onOpen: (c: NotifyChannel) => void;
}) {
  return (
    <div className="grid gap-3 md:grid-cols-3" data-testid="an-channels">
      {NOTIFY_CHANNELS.map((c) => {
        const state = overview.channels[c];
        const count = overview.counts.byChannel[c];
        const body = (
          <>
            <div className="flex items-start gap-3">
              <ChannelIcon channel={c} size={18} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-slate-900">{CHANNEL_LABEL[c]}</p>
                <p
                  className={cn(
                    "mt-0.5 flex items-center gap-1 text-[11px] font-semibold",
                    state.available ? "text-emerald-700" : "text-amber-700",
                  )}
                  data-testid={`an-channel-${c}-state`}
                >
                  <span
                    className={cn("h-2 w-2 rounded-full", state.available ? "bg-emerald-500" : "bg-amber-500")}
                    aria-hidden
                  />
                  {state.available ? "Ready to send" : "Not ready"}
                </p>
              </div>
              {canOpen(c) && <ChevronRight size={16} className="mt-1 shrink-0 text-slate-300" aria-hidden />}
            </div>
            <p className="mt-2 line-clamp-2 min-h-8 text-xs leading-snug text-slate-500">
              {state.note ||
                (c === "whatsapp"
                  ? overview.settings.connectedNumber
                    ? `Connected number ${phoneLabel(overview.settings.connectedNumber)}.`
                    : "No connected number set yet."
                  : state.available
                    ? "Set up and working."
                    : "Not set up on this server.")}
            </p>
            <p className="mt-2 text-xs text-slate-600">
              <b className="text-lg font-black tabular-nums text-slate-900" data-testid={`an-channel-${c}-count`}>
                {count}
              </b>{" "}
              automation{count === 1 ? "" : "s"}
            </p>
          </>
        );
        const classes = cn(
          "rounded-2xl border bg-white p-4 text-left shadow-sm",
          state.available ? "border-slate-200" : "border-amber-200",
        );
        return canOpen(c) ? (
          <button
            key={c}
            type="button"
            onClick={() => onOpen(c)}
            className={cn(
              classes,
              "transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
            )}
            data-view-safe
            data-testid={`an-channel-${c}`}
          >
            {body}
          </button>
        ) : (
          <div key={c} className={classes} data-testid={`an-channel-${c}`}>
            {body}
          </div>
        );
      })}
    </div>
  );
}

/** Today's (or a chosen day's) numbers per category, for Staff, Production or everyone: what a report would send. */
function SnapshotCard() {
  const [employeeType, setEmployeeType] = useState<NotifyEmployeeType>("all");
  const today = istToday();
  const [date, setDate] = useState(today);
  const q = useAttendanceNotifySnapshot({ date, employeeType });
  const data = q.data;

  return (
    <SectionCard
      icon={Activity}
      title={date === today ? "Attendance today" : `Attendance on ${dateLabel(date)}`}
      description={`Live numbers for ${EMPLOYEE_TYPE_LABEL[employeeType].toLowerCase()}: the same ones a report would send now.`}
      testId="an-snapshot"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            options={EMPLOYEE_TYPE_OPTIONS}
            value={employeeType}
            onChange={setEmployeeType}
            ariaLabel="Employees"
            testId="an-snapshot-type"
            size="sm"
          />
          <Input
            type="date"
            value={date}
            max={today}
            onChange={(e) => setDate(e.target.value || today)}
            className="h-8 w-40 text-xs"
            aria-label="Day"
            data-testid="an-snapshot-date"
          />
          {date !== today && (
            <Button size="sm" variant="ghost" className="h-8" onClick={() => setDate(today)} data-view-safe>
              Today
            </Button>
          )}
        </div>
      }
    >
      {q.isError && !data ? (
        <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
          The numbers could not be loaded.{" "}
          <button type="button" className="font-semibold underline" onClick={() => void q.refetch()} data-view-safe>
            Try again
          </button>
        </p>
      ) : !data ? (
        <SkeletonKpis count={7} className="xl:grid-cols-3" />
      ) : (
        <div className={cn("space-y-2 transition-opacity", q.isFetching && q.isPlaceholderData && "opacity-60")}>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3" data-testid="an-snapshot-tiles">
            {NOTIFY_CATEGORIES.map((c) => (
              <KpiTile
                key={c}
                label={CATEGORY_META[c].label}
                value={data.counts[c].toLocaleString("en-IN")}
                icon={CATEGORY_ICON[c]}
                tone={CATEGORY_META[c].tile}
                testId={`an-snapshot-${c}`}
              />
            ))}
            <KpiTile
              label="Active employees"
              value={data.total.toLocaleString("en-IN")}
              sub={employeeType === "all" ? "Staff and Production" : EMPLOYEE_TYPE_LABEL[employeeType]}
              icon={Users}
              tone="bg-slate-50 text-slate-800"
              testId="an-snapshot-total"
              className="col-span-2 md:col-span-3"
            />
          </div>
          {data.generatedAt && (
            <p className="text-right text-[11px] text-slate-400">
              Counted {whenText(data.generatedAt)} · refreshes every minute
            </p>
          )}
        </div>
      )}
    </SectionCard>
  );
}

/** How many automations there are and are on, today's sends, and the next five sends. */
function ScheduleCard({ overview }: { overview: NotifyOverview }) {
  const c = overview.counts;
  const now = new Date();
  return (
    <SectionCard
      icon={Workflow}
      title="Automations"
      description="What is set up, what went out today and what goes out next (India time)."
      testId="an-schedule"
    >
      <div className="grid grid-cols-2 gap-2">
        {(
          [
            ["Automations", c.automations, "bg-slate-50 text-slate-800", "an-count-automations"],
            ["Switched on", c.active, "bg-emerald-50 text-emerald-800", "an-count-active"],
            ["Sends today", c.runsToday, "bg-blue-50 text-blue-800", "an-count-runs"],
            [
              "Failed today",
              c.failedToday,
              c.failedToday ? "bg-red-50 text-red-800" : "bg-slate-50 text-slate-800",
              "an-count-failed",
            ],
          ] as const
        ).map(([label, value, tone, id]) => (
          <div key={id} className={cn("rounded-xl px-3 py-2", tone)} data-testid={id}>
            <p className="text-[11px] font-medium opacity-70">{label}</p>
            <p className="text-xl font-black tabular-nums">{value.toLocaleString("en-IN")}</p>
          </div>
        ))}
      </div>
      <p className="mb-1.5 mt-4 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Upcoming sends</p>
      {overview.upcoming.length === 0 ? (
        <p className="rounded-xl bg-slate-50 px-3 py-3 text-xs text-slate-500" data-testid="an-upcoming-empty">
          Nothing is scheduled. Switch an automation on, or create one.
        </p>
      ) : (
        <ul className="space-y-1.5" data-testid="an-upcoming">
          {overview.upcoming.map((u) => {
            const Icon = CHANNEL_META[u.channel].icon;
            return (
              <li
                key={`${u.automationId}-${u.at}`}
                className="flex items-center gap-2.5 rounded-xl border border-slate-100 bg-white px-2.5 py-2"
              >
                <span className={cn("rounded-lg p-1.5", CHANNEL_META[u.channel].tile)} title={CHANNEL_LABEL[u.channel]}>
                  <Icon size={13} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-semibold text-slate-900">{u.name}</span>
                  <span className="block text-[11px] text-slate-500">{whenText(u.at, now)}</span>
                </span>
                <span className="shrink-0 text-[11px] font-semibold text-blue-700">{relativeText(u.at, now)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}

/** The dashboard above the tabs: the channels, today's numbers and the automations at a glance. */
export default function Overview({
  overview,
  loading,
  error,
  onRetry,
  canOpen,
  onOpen,
}: {
  overview: NotifyOverview | undefined;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  canOpen: (c: NotifyChannel) => boolean;
  onOpen: (c: NotifyChannel) => void;
}) {
  return (
    <section className="space-y-4" aria-label="Overview" data-testid="an-overview">
      {overview ? (
        <ChannelCards overview={overview} canOpen={canOpen} onOpen={onOpen} />
      ) : error ? (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
          data-testid="an-overview-error"
        >
          <span className="flex items-center gap-2">
            <AlertTriangle size={15} /> {error}
          </span>
          <Button size="sm" variant="outline" onClick={onRetry} data-view-safe>
            Try again
          </Button>
        </div>
      ) : (
        loading && <SkeletonKpis count={3} className="md:grid-cols-3 xl:grid-cols-3" />
      )}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <SnapshotCard />
        {overview ? (
          <ScheduleCard overview={overview} />
        ) : (
          <div className="rounded-2xl border border-slate-100 bg-white p-5" aria-busy={loading}>
            <SkeletonKpis count={4} className="grid-cols-2 md:grid-cols-2 xl:grid-cols-2" />
          </div>
        )}
      </div>
    </section>
  );
}
