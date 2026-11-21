import { useMemo, type ComponentType } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { AlarmClock, BellRing, Navigation, Route, ShieldAlert, Unplug } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import BarList from "@/components/md/kit/BarList";
import SectionCard from "@/components/md/kit/SectionCard";
import StatCard, { type StatTone } from "@/components/md/kit/StatCard";
import TrendChart, { type TrendSeries } from "@/components/md/kit/TrendChart";
import { CHART } from "@/components/md/kit/chartTheme";
import { EmptyBlock } from "@/components/md/kit/states";
import { dayShort, num } from "@/lib/md/format";
import { DetailList, DetailRow } from "../shared/DetailSheet";
import { drillClick } from "../shared/drill";
import { QueryError, refreshingClass } from "./parts";
import { alertKindBars, trackingDays, trackingEmpty, trackingTiles, type TrackingTile } from "./tracking-logic";
import type { AlertKind, AlertStatus, GeoTracking } from "./types";

const ICONS: Record<TrackingTile["id"], ComponentType<{ size?: number }>> = {
  journeys: Route,
  km: Navigation,
  gaps: Unplug,
  alerts: BellRing,
  escalated: ShieldAlert,
  fix: AlarmClock,
};
const TONES: Record<TrackingTile["id"], StatTone> = {
  journeys: "blue",
  km: "indigo",
  gaps: "slate",
  alerts: "amber",
  escalated: "red",
  fix: "green",
};

const JOURNEYS: TrendSeries = { key: "journeys", label: "Journeys", kind: "bar", color: CHART.brand };
const ALERTS: TrendSeries = {
  key: "alerts",
  label: "Automatic alerts",
  kind: "line",
  color: CHART.warn,
  rightAxis: true,
};

/**
 * On-Duty tracking and the automatic alerts (2026-11-21): the journeys the app recorded (how many, how far, the gaps in
 * the record) and the alerts the server sent (location off, permission, tracking failure, missing punch, reminder), with
 * the kinds as clickable bars and the people alerted most. Each figure that is a list opens it.
 */
export default function TrackingCard({
  query,
  ask,
  onAlerts,
  onPerson,
}: {
  query: UseQueryResult<GeoTracking>;
  ask: string;
  onAlerts: (filter: { kind?: AlertKind; status?: AlertStatus; title: string }) => void;
  onPerson: (employeeId: number) => void;
}) {
  const data = query.data;
  const days = useMemo(() => (data ? trackingDays(data) : []), [data]);
  const kinds = data ? alertKindBars(data) : [];

  return (
    <SectionCard
      title="On-Duty tracking and automatic alerts"
      subtitle="The journeys the app recorded and the alerts sent when location, permission or punches went wrong"
      loading={query.isPending}
      provenance={data?.provenance}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId="md-geo-tracking"
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : data && trackingEmpty(data) ? (
        <EmptyBlock title="Nothing tracked in this period" testId="md-geo-tracking-empty">
          No on-duty journey was recorded by the app and no automatic alert went out for this selection.
        </EmptyBlock>
      ) : data ? (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-3 @5xl:grid-cols-6" data-testid="md-geo-tracking-tiles">
            {trackingTiles(data).map((tile) => (
              <StatCard
                key={tile.id}
                testId={`md-geo-tracking-${tile.id}`}
                label={tile.label}
                value={tile.value}
                sub={tile.sub}
                icon={ICONS[tile.id]}
                tone={TONES[tile.id]}
                delta={tile.delta}
                provenance={data.provenance}
                onClick={
                  tile.opens === "alerts"
                    ? drillClick(() => onAlerts({ title: "Automatic alerts" }))
                    : tile.opens === "escalated"
                      ? drillClick(() =>
                          onAlerts({ status: "escalated", title: "Alerts escalated to the Department Head" }),
                        )
                      : undefined
                }
              />
            ))}
          </div>

          <div className="grid grid-cols-1 items-start gap-5 @4xl:grid-cols-12">
            <div className="@4xl:col-span-7">
              <h4 className="md-analytics-subhead">Journeys and alerts by day</h4>
              <TrendChart
                data={days}
                xKey="date"
                series={[JOURNEYS, ALERTS]}
                height={220}
                xFormat={dayShort}
                yFormat={(v) => num(v)}
                rightFormat={(v) => num(v)}
              />
            </div>
            <div className="@4xl:col-span-5">
              <h4 className="md-analytics-subhead">Alerts by kind</h4>
              <BarList
                items={kinds}
                color={CHART.warn}
                format={(v) => num(v)}
                onSelect={(item) => {
                  const kind = kinds.find((k) => k.key === item.key);
                  if (kind) onAlerts({ kind: kind.kind, title: String(kind.label) });
                }}
                emptyText="No automatic alert in this period."
                testId="md-geo-tracking-kinds"
              />
              {data.alerts.openNow > 0 && (
                <button
                  type="button"
                  className="md-btn mt-3 inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold"
                  onClick={() => onAlerts({ status: "open", title: "Alerts open right now" })}
                  data-testid="md-geo-tracking-open"
                >
                  <BellRing size={13} aria-hidden /> {num(data.alerts.openNow)} open right now
                </button>
              )}
            </div>
          </div>

          {data.topAlerted.length > 0 && (
            <div>
              <h4 className="md-analytics-subhead">Alerted most often</h4>
              <DetailList testId="md-geo-tracking-people">
                {data.topAlerted.map((p) => (
                  <DetailRow
                    key={p.employeeId}
                    testId={`md-geo-tracking-person-${p.employeeCode}`}
                    primary={p.employeeName}
                    secondary={[p.employeeCode, p.department].filter(Boolean).join(" · ")}
                    value={`${num(p.alerts)} ${p.alerts === 1 ? "alert" : "alerts"}${p.open ? ` · ${num(p.open)} open` : ""}`}
                    tone={p.alerts >= data.repeatAlertsMin ? "md-analytics-tone-bad" : undefined}
                    onClick={() => onPerson(p.employeeId)}
                  />
                ))}
              </DetailList>
            </div>
          )}
        </div>
      ) : null}
    </SectionCard>
  );
}
