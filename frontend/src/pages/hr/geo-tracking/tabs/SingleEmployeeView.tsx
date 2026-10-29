// On-Duty Map -> Single Employee: a detailed, directional route lookup for ONE tracking-enabled employee on the chosen day, from
// the position pings the phone sent (the old live-location feed). The route is one line with direction arrows; the start (a flag)
// and the latest position (a person) are one colour, as on the Journey History map.
import { useEffect, useMemo, useState } from "react";
import { MapContainer, Marker, Polyline, Popup } from "react-leaflet";
import { Route as RouteIcon, Search } from "lucide-react";
import { BaseMapLayers } from "@/components/geo/BaseMapLayers";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useListEmployees, type Employee } from "@/lib/api-client";
import { useLiveLocationRoute } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { MapBridge, MapCardHeader, MapViewButtons, MapOverlayNote, useMapView, viewPlaces } from "../mapKit";
import { PersonCell } from "../kit";
import { COLOR_END, COLOR_NORMAL, COLOR_START, arrowIcon, arrowSamples, pinIcon } from "../pins";
import { TIRUPPUR_CENTER, TIRUPPUR_ZOOM } from "../tiruppur";

type Tracked = Employee & { locationTrackingEnabled?: boolean };

const time = (iso?: string): string => (iso ? new Date(iso).toLocaleTimeString() : "");

export default function SingleEmployeeView({ date }: { date: string }) {
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const view = useMapView();

  const { data: trackedList, isLoading: employeesLoading } = useListEmployees({ status: "active" });
  const tracked = (trackedList ?? []).filter((e) => (e as Tracked).locationTrackingEnabled);
  const q = search.trim().toLowerCase();
  const filtered = tracked.filter(
    (e) => !q || e.employeeCode.toLowerCase().includes(q) || `${e.firstName} ${e.lastName}`.toLowerCase().includes(q),
  );

  const { data: route, isLoading: routeLoading } = useLiveLocationRoute(selectedId, date);
  const points = useMemo(
    () => (route?.points ?? []).map((p) => [p.latitude, p.longitude] as [number, number]),
    [route],
  );
  const arrows = useMemo(() => arrowSamples(points), [points]);

  // the map fits the route when it arrives (and again for another employee or day), not on every refresh
  const { map } = view;
  const routeKey = points.length > 0 ? `${selectedId}|${date}` : "";
  useEffect(() => {
    if (map && routeKey) viewPlaces(map, points);
    // only when a different route arrives
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, routeKey]);

  const who = filtered.find((e) => e.id === selectedId);

  return (
    <div
      className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]"
      data-testid="onduty-single"
    >
      <Card className="order-2 space-y-3 rounded-2xl p-4 lg:order-1">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <Input
            className="h-9 pl-9 text-sm"
            placeholder="Search tracked staff…"
            aria-label="Search tracked staff"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {employeesLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-12 rounded-xl" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <p className="rounded-xl border border-dashed px-3 py-8 text-center text-xs text-gray-500">
            No tracking-enabled employees match. This view only shows staff with Live Tracking turned on (mainly On-Duty
            employees).
          </p>
        ) : (
          <div className="max-h-[480px] space-y-1 overflow-y-auto">
            {filtered.map((e) => (
              <button
                key={e.id}
                type="button"
                onClick={() => setSelectedId(e.id)}
                className={cn(
                  "w-full rounded-xl border px-2.5 py-2 text-left transition-colors",
                  selectedId === e.id ? "border-sky-300 bg-sky-50/60" : "border-transparent hover:bg-slate-50",
                )}
              >
                <PersonCell
                  name={`${e.firstName} ${e.lastName}`}
                  code={e.employeeCode}
                  sub={e.departmentName ?? "—"}
                  size={32}
                />
              </button>
            ))}
          </div>
        )}
        <p className="flex items-center gap-1.5 border-t pt-3 text-[11px] font-semibold text-gray-600">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: COLOR_START }} /> Route start and
          latest position
        </p>
      </Card>

      <Card className="order-1 overflow-hidden rounded-2xl p-0 lg:order-2">
        <MapCardHeader
          icon={<RouteIcon size={15} className="text-[#006496]" />}
          title={who ? `${who.firstName} ${who.lastName}` : "Travel route"}
          actions={
            <MapViewButtons
              onTiruppur={view.backToTiruppur}
              onFit={() => view.fit(points)}
              fitLabel="Fit route"
              fitDisabled={points.length === 0}
            />
          }
        />
        <div className="relative h-[420px] sm:h-[520px] lg:h-[620px]" data-testid="single-map-canvas">
          {selectedId && routeLoading ? (
            <Skeleton className="h-full w-full" />
          ) : (
            <MapContainer
              center={TIRUPPUR_CENTER}
              zoom={TIRUPPUR_ZOOM}
              style={{ height: "100%", width: "100%" }}
              scrollWheelZoom
            >
              <BaseMapLayers />
              <MapBridge onMap={view.onMap} />
              {points.length > 0 && (
                <>
                  <Polyline
                    positions={points}
                    interactive={false}
                    pathOptions={{ color: "#ffffff", weight: 8, opacity: 0.85 }}
                  />
                  <Polyline positions={points} pathOptions={{ color: COLOR_NORMAL, weight: 4, opacity: 0.85 }} />
                  {arrows.map((a, i) => (
                    <Marker key={i} position={a.pos} icon={arrowIcon(COLOR_NORMAL, a.rot)} />
                  ))}
                  <Marker position={points[0]} icon={pinIcon(COLOR_START, "flag")}>
                    <Popup>Route start · {time(route?.points[0]?.recordedAt)}</Popup>
                  </Marker>
                  <Marker position={points[points.length - 1]} icon={pinIcon(COLOR_END, "person")}>
                    <Popup>Latest position · {time(route?.points[route.points.length - 1]?.recordedAt)}</Popup>
                  </Marker>
                </>
              )}
            </MapContainer>
          )}
          {!selectedId ? (
            <MapOverlayNote testId="single-empty">Select an employee to view their travel route.</MapOverlayNote>
          ) : !routeLoading && points.length === 0 ? (
            <MapOverlayNote testId="single-no-route">
              No location pings recorded for {route?.employeeName ?? "this employee"} on {date}.
            </MapOverlayNote>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
