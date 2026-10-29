// Geo Attendance -> On-Duty Map: every employee that was On-Duty on the chosen day (today unless a date is picked), each journey in
// its own colour on one map, drawn like the Journey History map (route line, numbered stops, a flag at the start, a person at the
// end). "All On-Duty" is the overview; "Single Employee" is the directional route lookup for one tracking-enabled employee.
//   * the list beside the map is the legend: click a row to focus that employee (the map zooms to them, the others fade), the eye
//     hides or shows one;
//   * the journeys come from the new tracking (GET /api/tracking/journeys/day-map), joined by employee with the On-Duty feed
//     (their request and punches); an employee without a journey keeps the old position pings as a plain line.
import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, Eye, MapPinned, Route as RouteIcon, ScanSearch, Users } from "lucide-react";
import { Chip } from "@/components/payroll/kit/parts";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { trackingErrorMessage, useJourneyDayMap, useOnDutyMap } from "@/lib/api-client/custom-hooks";
import { assignDutyColors, dutyColor } from "../dutyColors";
import { buildDutyEntries, hasRoute, summarize, todayIst } from "../dutyMap";
import { ListSkeleton, Note, ToolbarCard } from "../kit";
import { fmtDistance } from "../logic";
import { MapCardHeader, MapOverlayNote, MapViewButtons, useMapView } from "../mapKit";
import OnDutyLegend from "../OnDutyLegend";
import OnDutyMapView from "../OnDutyMapView";
import PinGuide from "../PinGuide";
import { TIRUPPUR_CAPTION, type LatLng } from "../tiruppur";
import SingleEmployeeView from "./SingleEmployeeView";

type Mode = "all" | "single";

export default function OnDutyMapTab() {
  const [mode, setMode] = useState<Mode>("all");
  const [date, setDate] = useState(todayIst());
  const [focusId, setFocusId] = useState<number | null>(null);
  // changes only when a row of the list is picked: that moves the map to the employee (picking a pin on the map must not)
  const [focusFit, setFocusFit] = useState("");
  const nonce = useRef(0);
  const [hoverId, setHoverId] = useState<number | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<number>>(() => new Set());
  const view = useMapView();
  const mapCard = useRef<HTMLDivElement>(null);
  const slots = useRef(new Map<number, number>());

  const today = todayIst();
  const { data: mapData, isLoading: mapLoading } = useOnDutyMap(date);
  const { data: dayMap, isLoading: dayLoading, error: dayError } = useJourneyDayMap(date);
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

  // the map fits everybody when the day's data first arrives and when another day is picked, not on every refresh
  const fitSignal = !loading && drawn > 0 ? date : "";

  // an employee that is no longer on the list cannot stay in focus
  useEffect(() => {
    if (focusId !== null && !entries.some((e) => e.employeeId === focusId)) {
      setFocusId(null);
      setFocusFit("");
    }
  }, [entries, focusId]);

  const changeDate = (next: string) => {
    if (!next) return;
    slots.current = new Map();
    setDate(next);
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

  return (
    <div className="space-y-4" data-testid="tab-onduty-map">
      <ToolbarCard>
        <div className="flex items-center gap-2">
          <CalendarDays size={15} className="text-gray-400" aria-hidden />
          <Input
            type="date"
            className="h-9 w-[10.5rem] text-sm"
            aria-label="Day"
            value={date}
            max={today}
            onChange={(e) => changeDate(e.target.value)}
          />
          {date !== today && (
            <Button type="button" size="sm" variant="outline" className="h-9 text-xs" onClick={() => changeDate(today)}>
              Today
            </Button>
          )}
        </div>
        <PillTabs
          items={[
            // the count goes in `count`: the pills measure themselves again when it changes
            { value: "all", label: "All On-Duty", count: entries.length || undefined, icon: <Users size={12} /> },
            { value: "single", label: "Single Employee", icon: <RouteIcon size={12} /> },
          ]}
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

      {mode === "single" ? (
        <SingleEmployeeView date={date} />
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
            ) : entries.length === 0 ? (
              <p
                className="rounded-xl border border-dashed px-3 py-8 text-center text-xs text-gray-500"
                data-testid="duty-empty"
              >
                No employees were On-Duty on {date}.
              </p>
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
                  No live positions to show for On-Duty staff on {date}.
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
