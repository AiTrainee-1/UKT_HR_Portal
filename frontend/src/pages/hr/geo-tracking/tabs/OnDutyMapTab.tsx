// Geo Attendance -> On-Duty Map: every employee that was On-Duty on the chosen days (the HR portal's date filter: This Month by
// default, Today, Yesterday, an earlier month or Custom days), each employee's journeys of those days in their own colour on
// one map, drawn like the Journey History map (route line, numbered stops, a flag at the start, a person at the end).
// "All On-Duty" is the overview; "Single Employee" is the directional route lookup for one tracking-enabled employee.
//   * the list beside the map is the legend: click a row to focus that employee (the map zooms to them, the others fade), the eye
//     hides or shows one;
//   * the journeys come from the new tracking (GET /api/tracking/journeys/day-map?from=&to=), joined by employee with the
//     On-Duty feed (on-duty-map?from=&to=: their latest request of the days and its punches); an employee without a journey
//     keeps the old position pings (kept 72 hours) as a plain line. Over several days an employee is still one entry: every
//     journey of theirs in the days, stops numbered on through them.
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Eye, MapPinned, Route as RouteIcon, ScanSearch, Users } from "lucide-react";
import { DateRangeBar, useDateRange } from "@/components/date-range";
import { Chip } from "@/components/payroll/kit/parts";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { isRouteViewOnly, useAuth } from "@/contexts/AuthContext";
import { trackingErrorMessage, useJourneyDayMap, useOnDutyMap } from "@/lib/api-client/custom-hooks";
import type { DateRangeValue } from "@/lib/date-range";
import { moduleForPath } from "@/lib/permission-modules";
import { ViewOnlyTabNote, pickVisible, useLevel, useViewOnlyLock } from "@/lib/tab-access";
import { assignDutyColors, dutyColor } from "../dutyColors";
import { buildDutyEntries, hasRoute, summarize } from "../dutyMap";
import { ListSkeleton, LoadError, Note, ToolbarCard } from "../kit";
import { fmtDistance } from "../logic";
import { MapCardHeader, MapOverlayNote, MapViewButtons, useMapView } from "../mapKit";
import OnDutyLegend from "../OnDutyLegend";
import OnDutyMapView from "../OnDutyMapView";
import PinGuide from "../PinGuide";
import { TIRUPPUR_CAPTION, type LatLng } from "../tiruppur";
import SingleEmployeeView from "./SingleEmployeeView";

type Mode = "all" | "single";

/** Each view's own permission key (Account Management -> Roles & Permissions); one without a setting follows the map. */
const MODE_KEY: Record<Mode, string> = {
  all: "geo_attendance.on_duty_map.all",
  single: "geo_attendance.on_duty_map.single",
};

export default function OnDutyMapTab() {
  const [askedMode, setMode] = useState<Mode>("all");
  // only the views this role may see are offered (a hidden one is never drawn), and one it may only view is locked
  const { user } = useAuth();
  const [location] = useLocation();
  const level = useLevel();
  const modes = (["all", "single"] as const).filter((m) => level(MODE_KEY[m]) !== "hidden");
  const mode = pickVisible(askedMode, modes);
  const modeViewOnly =
    modes.length > 0 && !isRouteViewOnly(user, location, moduleForPath(location)) && level(MODE_KEY[mode]) === "view";
  useViewOnlyLock(modeViewOnly, mode);
  const dates = useDateRange();
  const days = dates.days;
  const daysKey = `${days.from}_${days.to}`;
  const [focusId, setFocusId] = useState<number | null>(null);
  // changes only when a row of the list is picked: that moves the map to the employee (picking a pin on the map must not)
  const [focusFit, setFocusFit] = useState("");
  const nonce = useRef(0);
  const [hoverId, setHoverId] = useState<number | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<number>>(() => new Set());
  const view = useMapView();
  const mapCard = useRef<HTMLDivElement>(null);
  const slots = useRef(new Map<number, number>());

  const { data: mapData, isLoading: mapLoading, error: mapError, refetch: refetchMap } = useOnDutyMap(days.to, days);
  const {
    data: dayMap,
    isLoading: dayLoading,
    error: dayError,
  } = useJourneyDayMap(days.to, modes.includes("all"), days);
  const loading = mapLoading || dayLoading;

  const entries = useMemo(() => buildDutyEntries(mapData?.employees ?? [], dayMap?.journeys ?? []), [mapData, dayMap]);
  // an employee keeps one colour while the page is open: a refresh never repaints anybody's route
  const colors = useMemo(() => {
    const next = assignDutyColors(
      entries.map((e) => e.employeeId),
      slots.current,
    );
    slots.current = next;
    return new Map([...next].map(([id, slot]) => [id, dutyColor(slot)] as const));
  }, [entries]);

  const summary = useMemo(() => summarize(entries), [entries]);
  const visible = entries.filter((e) => !hidden.has(e.employeeId));
  const fitPoints = visible.flatMap((e) => e.all);
  const focusEntry = focusId === null ? null : entries.find((e) => e.employeeId === focusId);
  const focusPoints: LatLng[] = focusEntry ? focusEntry.all : [];
  const drawn = visible.filter(hasRoute).length;

  // the map fits everybody when the days' data first arrives and when other days are picked, not on every refresh
  const fitSignal = !loading && drawn > 0 ? daysKey : "";

  // an employee that is no longer on the list cannot stay in focus
  useEffect(() => {
    if (focusId !== null && !entries.some((e) => e.employeeId === focusId)) {
      setFocusId(null);
      setFocusFit("");
    }
  }, [entries, focusId]);

  const changeDates = (next: DateRangeValue) => {
    slots.current = new Map();
    dates.set(next);
    setFocusId(null);
    setFocusFit("");
    setHidden(new Set());
  };

  const focus = (id: number) => {
    if (focusId === id) {
      setFocusId(null);
      setFocusFit("");
    } else {
      nonce.current += 1;
      setFocusId(id);
      setFocusFit(`${id}:${nonce.current}`);
    }
    // on a phone the map is above the list: bring it into view
    if (typeof window !== "undefined" && window.innerWidth < 1024) {
      mapCard.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
    }
  };

  const toggle = (id: number) => {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (focusId === id) {
      setFocusId(null);
      setFocusFit("");
    }
  };

  const showAll = () => {
    setFocusId(null);
    setFocusFit("");
    setHidden(new Set());
    view.fit(entries.flatMap((e) => e.all));
  };

  if (modes.length === 0) {
    return (
      <p
        className="rounded-2xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground"
        data-testid="nothing-open"
      >
        Nothing on this page is open to your role.
      </p>
    );
  }

  return (
    <div className="space-y-4" data-testid="tab-onduty-map">
      <ToolbarCard>
        <DateRangeBar value={dates.value} onChange={changeDates} accent="#006496" testId="onduty-dates" />
        <PillTabs
          items={[
            // the count goes in `count`: the pills measure themselves again when it changes
            { value: "all", label: "All On-Duty", count: entries.length || undefined, icon: <Users size={12} /> },
            { value: "single", label: "Single Employee", icon: <RouteIcon size={12} /> },
          ].filter((item) => modes.includes(item.value as Mode))}
          value={mode}
          onChange={(v) => {
            setMode(v as Mode);
            setFocusId(null);
            setFocusFit("");
          }}
          size="sm"
        />
        {mode === "all" && !loading && entries.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 sm:ml-auto" data-testid="duty-summary-chips">
            <Chip tone="neutral">
              {summary.employees} employee{summary.employees === 1 ? "" : "s"}
            </Chip>
            {summary.live > 0 && <Chip tone="success">{summary.live} on the road now</Chip>}
            {summary.distanceM > 0 && <Chip tone="info">{fmtDistance(summary.distanceM)}</Chip>}
            {summary.stops > 0 && (
              <Chip tone="neutral">
                {summary.stops} stop{summary.stops === 1 ? "" : "s"}
              </Chip>
            )}
          </div>
        )}
      </ToolbarCard>

      <ViewOnlyTabNote show={modeViewOnly} />

      {mode === "all" && dayMap?.truncated && (
        <Note tone="warn" testId="duty-truncated">
          These days hold more journeys than one map can draw: only the latest ones are drawn. Pick fewer days to see
          the rest.
        </Note>
      )}

      {mode === "single" ? (
        <SingleEmployeeView days={days} rangeText={dates.label} />
      ) : (
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
          <Card className="order-2 space-y-3 rounded-2xl p-4 lg:order-1 lg:max-h-[780px] lg:overflow-y-auto">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="flex items-center gap-1.5 text-sm font-bold text-gray-900">
                <Users size={14} className="text-[#006496]" /> Employees on duty
              </p>
              {(focusId !== null || hidden.size > 0) && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1 px-2 text-xs"
                  onClick={showAll}
                  data-testid="duty-show-all"
                >
                  <Eye size={12} /> Show everyone
                </Button>
              )}
            </div>
            {dayError && (
              <Note tone="warn" testId="duty-journeys-error">
                The recorded journeys could not be loaded ({trackingErrorMessage(dayError, "try again")}). Only the
                basic positions are shown.
              </Note>
            )}
            {loading ? (
              <ListSkeleton rows={3} height="h-28" />
            ) : mapError && dayError ? (
              <LoadError
                title="The day's On-Duty work could not be loaded."
                error={mapError}
                onRetry={() => void refetchMap()}
                testId="duty-error"
              />
            ) : entries.length === 0 ? (
              <div
                className="rounded-xl border border-dashed px-3 py-8 text-center text-xs leading-relaxed text-gray-500"
                data-testid="duty-empty"
              >
                <p className="font-semibold text-gray-700">No employees were On-Duty for {dates.label}.</p>
                <p className="mt-1">
                  Pick other dates above. A day appears here once an employee submits an On-Duty request for it.
                </p>
              </div>
            ) : (
              <OnDutyLegend
                entries={entries}
                colors={colors}
                hidden={hidden}
                focusId={focusId}
                onFocus={focus}
                onToggle={toggle}
                onHover={setHoverId}
              />
            )}
          </Card>

          <Card className="order-1 overflow-hidden rounded-2xl p-0 lg:order-2" ref={mapCard}>
            <MapCardHeader
              icon={<MapPinned size={15} className="text-[#006496]" />}
              title="Journeys"
              actions={
                <MapViewButtons
                  onTiruppur={view.backToTiruppur}
                  onFit={() => view.fit(fitPoints)}
                  fitDisabled={fitPoints.length === 0}
                />
              }
            >
              <Chip tone="info" icon={ScanSearch}>
                {TIRUPPUR_CAPTION}
              </Chip>
              <Chip tone="neutral">
                {drawn} route{drawn === 1 ? "" : "s"} drawn
              </Chip>
              {hidden.size > 0 && <Chip tone="warning">{hidden.size} hidden</Chip>}
            </MapCardHeader>
            <div className="relative h-[420px] sm:h-[520px] lg:h-[640px]" data-testid="onduty-map-canvas">
              {loading ? (
                <Skeleton className="h-full w-full rounded-none" />
              ) : (
                <OnDutyMapView
                  entries={entries}
                  colors={colors}
                  hidden={hidden}
                  focusId={focusId}
                  hoverId={hoverId}
                  fitPoints={fitPoints}
                  fitSignal={fitSignal}
                  focusPoints={focusPoints}
                  focusSignal={focusFit}
                  onPick={setFocusId}
                  onMap={view.onMap}
                />
              )}
              {!loading && drawn === 0 && (
                <MapOverlayNote testId="duty-map-empty">
                  No live positions to show for On-Duty staff for {dates.label}.
                </MapOverlayNote>
              )}
            </div>
            <div className="border-t px-4 py-2.5">
              <PinGuide />
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
