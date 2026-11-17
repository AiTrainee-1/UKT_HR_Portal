import type { ReactNode } from "react";
import { Link } from "wouter";
import {
  ArrowRight,
  BarChart3,
  BellOff,
  BellRing,
  CalendarDays,
  CheckCheck,
  ListChecks,
  Power,
  Send,
  Smartphone,
  SmartphoneNfc,
  XCircle,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useMobileMessagesConfig, useMobileMessagesOverview, type PushCounts } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import {
  HEALTH_LABEL,
  dayBars,
  deliveredOf,
  formatNumber,
  formatWhen,
  healthNeedsBanner,
  healthTone,
  overviewTiles,
  type TileId,
} from "./logic";
import { pnPath, type PnTabKey } from "./routes";
import { LoadError, Notice, Panel, StatusCard } from "./ui";

const TILE_ICON: Record<TileId, typeof BellRing> = {
  master: Power,
  phones: SmartphoneNfc,
  today: Send,
  week: CalendarDays,
  delivered: CheckCheck,
  failed: XCircle,
  off: BellOff,
  nophone: Smartphone,
};

/** Where a tile leads (a pre-filtered tab), when that tab is open to the role. */
const TILE_LINK: Partial<Record<TileId, { tab: PnTabKey; query: string; label: string }>> = {
  master: { tab: "controls", query: "", label: "Open the switches" },
  phones: { tab: "employees", query: "show=with", label: "See who has a phone" },
  today: { tab: "messages", query: "", label: "See the messages" },
  delivered: { tab: "messages", query: "status=delivered", label: "See the delivered ones" },
  failed: { tab: "messages", query: "status=failed", label: "See the failures" },
  off: { tab: "messages", query: "status=off", label: "See the switched-off ones" },
  nophone: { tab: "employees", query: "show=without", label: "See who has no phone" },
};

function TileLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      href={to}
      className="mt-1.5 inline-flex items-center gap-1 text-xs font-semibold text-sky-700 underline-offset-2 hover:underline"
    >
      {children} <ArrowRight size={11} />
    </Link>
  );
}

function CountsLine({ label, c }: { label: string; c: PushCounts }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b py-2.5 last:border-b-0">
      <span className="w-24 text-sm font-semibold">{label}</span>
      <span className="text-sm font-black tabular-nums">{formatNumber(c.total)}</span>
      <span className="text-xs text-sky-700">{formatNumber(c.sent)} pushed</span>
      {c.delivered !== undefined && (
        <span className="text-xs text-emerald-700">{formatNumber(deliveredOf(c))} delivered</span>
      )}
      <span className="text-xs text-amber-700">{formatNumber(c.noDevice)} no phone</span>
      <span className="text-xs text-muted-foreground">{formatNumber(c.off)} switched off</span>
      <span className={cn("text-xs", c.failed ? "font-semibold text-red-700" : "text-muted-foreground")}>
        {formatNumber(c.failed)} failed
      </span>
    </div>
  );
}

function DayChart({ days }: { days: { date: string; total: number; sent: number }[] }) {
  const { bars } = dayBars(days);
  const total = bars.reduce((n, b) => n + b.total, 0);
  const sent = bars.reduce((n, b) => n + b.sent, 0);
  return (
    <Panel
      title="The last 14 days"
      description="Notifications saved each day: the dark part was pushed to a phone, the light part stayed in the app only."
      icon={BarChart3}
      testId="pn-chart"
    >
      {total === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground" data-testid="pn-chart-empty">
          No notification in the last 14 days.
        </p>
      ) : (
        <div role="img" aria-label={`Last 14 days: ${total} notifications, ${sent} pushed to phones`}>
          <div className="flex h-32 items-end gap-1">
            {bars.map((b) => (
              <div
                key={b.date}
                className="flex h-full min-w-0 flex-1 flex-col justify-end"
                title={`${b.label}: ${b.total} saved, ${b.sent} pushed`}
                data-testid={`pn-bar-${b.date}`}
              >
                <div className="rounded-t-sm bg-sky-100" style={{ height: `${b.notPushedPct}%` }} />
                <div
                  className={cn("bg-sky-600", b.notPushed === 0 && "rounded-t-sm")}
                  style={{ height: `${b.sentPct}%`, minHeight: b.sent ? 2 : 0 }}
                />
              </div>
            ))}
          </div>
          <div className="mt-1.5 flex gap-1">
            {bars.map((b, i) => (
              <span key={b.date} className="min-w-0 flex-1 truncate text-center text-[10px] text-muted-foreground">
                {i % 2 === 0 ? b.label : ""}
              </span>
            ))}
          </div>
        </div>
      )}
      {/* the same numbers as a table, for a screen reader */}
      <table className="sr-only">
        <caption>Notifications per day, last 14 days</caption>
        <thead>
          <tr>
            <th>Day</th>
            <th>Saved</th>
            <th>Pushed</th>
          </tr>
        </thead>
        <tbody>
          {bars.map((b) => (
            <tr key={b.date}>
              <td>{b.label}</td>
              <td>{b.total}</td>
              <td>{b.sent}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <i className="inline-block h-2 w-2 rounded-sm bg-sky-600" /> Pushed to a phone
        </span>
        <span className="flex items-center gap-1">
          <i className="inline-block h-2 w-2 rounded-sm bg-sky-100" /> In the app only
        </span>
      </div>
    </Panel>
  );
}

function Loading() {
  return (
    <div className="space-y-4" data-testid="pn-overview-loading">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-28 rounded-2xl" />
        ))}
      </div>
      <Skeleton className="h-40 w-full rounded-2xl" />
      <Skeleton className="h-56 w-full rounded-2xl" />
    </div>
  );
}

/**
 * Overview: the master switch, the phones registered, what was pushed today and in 7 days and what became of it (delivered,
 * failed, switched off, no phone), the last 14 days and the kinds of message. The health of the push service shows on top
 * when it is not fine. `canOpen` says which tabs the role may open, so a shortcut only leads where it may go.
 */
export default function OverviewTab({ canOpen }: { canOpen: (tab: PnTabKey) => boolean }) {
  const { data, isLoading, isError, refetch } = useMobileMessagesOverview();
  // the health lives on the Configuration tab's endpoint: read only when the role may open that tab
  const config = useMobileMessagesConfig(canOpen("configuration"));

  if (isLoading) return <Loading />;
  if (isError || !data) {
    return <LoadError what="The overview" onRetry={() => void refetch()} testId="pn-overview-error" />;
  }

  const o = data;
  const tiles = overviewTiles(o);
  const health = config.data?.health;
  const link = (id: TileId) => {
    const to = TILE_LINK[id];
    return to && canOpen(to.tab) ? <TileLink to={pnPath(to.tab, to.query)}>{to.label}</TileLink> : null;
  };

  return (
    <div className="space-y-4" data-testid="pn-overview">
      {health && healthNeedsBanner(health) && (
        <Notice tone={healthTone(health.state) === "bad" ? "bad" : "warn"} testId="pn-health-banner">
          <p className="font-semibold">Phone notifications: {HEALTH_LABEL[health.state]}</p>
          <p className="mt-0.5">{health.note}</p>
          {canOpen("configuration") && (
            <Link href={pnPath("configuration")} className="mt-1 inline-flex font-semibold underline">
              See why on the Configuration tab
            </Link>
          )}
        </Notice>
      )}
      {!o.pushEnabled && (
        <Notice tone="warn" testId="pn-master-off">
          Phone notifications are switched <b>OFF</b>: nothing is pushed to any phone. The employees&apos; Notifications
          list in the app still records everything.{" "}
          {canOpen("controls") && (
            <Link href={pnPath("controls")} className="font-semibold underline">
              Switch them on
            </Link>
          )}
        </Notice>
      )}
      {o.devices.employees > 0 && o.devices.withDevice === 0 && (
        <Notice tone="warn" testId="pn-no-phones">
          <b>No phone has registered for notifications yet</b>, so nothing can reach a notification bar. Notifications
          still appear inside the app. The usual cause is an app build made without Firebase (Google&apos;s push
          service): follow <b>docs/PUSH_NOTIFICATIONS.md</b> in the mobile app folder, install the new app and sign in.
        </Notice>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="pn-tiles">
        {tiles.map((t) => (
          <StatusCard
            key={t.id}
            testId={`pn-tile-${t.id}`}
            label={t.label}
            value={t.value}
            sub={t.sub}
            tone={t.tone}
            icon={TILE_ICON[t.id]}
          >
            {link(t.id)}
          </StatusCard>
        ))}
      </div>

      <Panel
        title="What was sent"
        description="Every notification is saved in the employee's app; these say what happened to its push."
        icon={ListChecks}
        testId="pn-counts"
        actions={
          <span className="text-xs text-muted-foreground" data-testid="pn-read-rate">
            Opened in the app (30 days):{" "}
            <b className="text-foreground">{o.readRate === null ? "-" : `${o.readRate}%`}</b>
          </span>
        }
      >
        <CountsLine label="Today" c={o.today} />
        <CountsLine label="Last 7 days" c={o.week} />
        <CountsLine label="Last 30 days" c={o.month} />
        <p className="mt-2 text-[11px] text-muted-foreground">
          Last phone registered: {formatWhen(o.devices.lastRegisteredAt)}
        </p>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <DayChart days={o.byDay} />
        <Panel title="By kind of message (30 days)" icon={BellRing} testId="pn-by-kind">
          {o.byKind.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing was sent yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="sr-only">
                <tr>
                  <th>Kind</th>
                  <th>Notifications</th>
                </tr>
              </thead>
              <tbody>
                {o.byKind.map((k) => (
                  <tr key={k.label} className="border-b last:border-b-0">
                    <td className="truncate py-1.5 pr-3">{k.label}</td>
                    <td className="py-1.5 text-right font-bold tabular-nums">{formatNumber(k.count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </div>
  );
}
