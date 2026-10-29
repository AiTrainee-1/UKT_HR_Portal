// Geo Attendance -> Live Map: where the On-Duty employees are right now. The map opens on Tiruppur (about 60 km across), not on the
// whole of India: the company works in and around the town. It is never locked: pan and zoom as you like, "Back to Tiruppur" and
// "Fit all" bring the view back, and whatever lies outside the Tiruppur area (a branch or an employee in another town) is counted
// in a chip that fits everything with one click, so nothing is lost off the edge.
import { useMemo, useState } from "react";
import { Circle, MapContainer, Marker, Polyline, Popup } from "react-leaflet";
import { Building2, MapPinned, Radar, ScanSearch } from "lucide-react";
import { BaseMapLayers } from "@/components/geo/BaseMapLayers";
import { Avatar, Chip } from "@/components/payroll/kit/parts";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useListBranches } from "@/lib/api-client";
import {
  useLiveLocationTeam,
  useLiveLocationTrail,
  useLiveTracks,
  type LiveLocationTeamMember,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { LiveFocus, LiveLegend, LiveTrackList, LiveTrackMarkers, supersededTeamIds } from "../LiveTracks";
import { MapBridge, MapCardHeader, MapViewButtons, useMapView } from "../mapKit";
import { COLOR_COMPANY, COLOR_MOCKED, COLOR_NORMAL, COLOR_ON_DUTY, pinIcon } from "../pins";
import { timeAgo } from "../logic";
import {
  TIRUPPUR_CAPTION,
  TIRUPPUR_CENTER,
  TIRUPPUR_ZOOM,
  farFromTiruppurText,
  outsideTiruppur,
  type LatLng,
} from "../tiruppur";

type Member = LiveLocationTeamMember & { isOnDutyToday?: boolean };
type BranchWithFence = {
  id: number;
  name: string;
  geofenceLat: number;
  geofenceLng: number;
  geofenceRadiusM?: number | null;
};

const memberColor = (m: Member): string => (m.isMocked ? COLOR_MOCKED : m.isOnDutyToday ? COLOR_ON_DUTY : COLOR_NORMAL);

/** The pin legend of the old feed (company locations, employees HR switched live tracking on for). */
function PinLegend() {
  const items = [
    { color: COLOR_COMPANY, label: "Company location" },
    { color: COLOR_NORMAL, label: "Employee" },
    { color: COLOR_ON_DUTY, label: "On-Duty today" },
    { color: COLOR_MOCKED, label: "Simulated location" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="pin-legend">
      {items.map((it) => (
        <span key={it.label} className="flex items-center gap-1.5 text-[11px] font-semibold text-gray-600">
          <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

export default function LiveMapTab({ onOpenJourney }: { onOpenJourney: (id: number) => void }) {
  const { data: team, isLoading } = useLiveLocationTeam();
  const { data: tracks, isLoading: tracksLoading, error: tracksError } = useLiveTracks();
  const { data: branches } = useListBranches();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedTrackId, setSelectedTrackId] = useState<number | null>(null);
  const { data: trail } = useLiveLocationTrail(selectedId);
  const view = useMapView();

  const members = (team ?? []) as Member[];
  const withFix = members.filter((m) => m.latitude != null && m.longitude != null);
  // the new feed (On-Duty tracks) wins over the old one for a person it has a newer position for
  const liveTracks = useMemo(() => tracks ?? [], [tracks]);
  const superseded = supersededTeamIds(team ?? [], liveTracks);
  const oldPins = withFix.filter((m) => !superseded.has(m.employeeId));
  const branchesWithFence = (branches ?? []).filter(
    (b) =>
      (b as unknown as BranchWithFence).geofenceLat != null && (b as unknown as BranchWithFence).geofenceLng != null,
  ) as unknown as BranchWithFence[];

  // everything that is on the map, as places: what "Fit all" shows and what is counted when it lies outside Tiruppur
  const places: { key: string; pos: LatLng; label: string }[] = [
    ...liveTracks.flatMap((t) =>
      t.latitude !== null && t.longitude !== null
        ? [{ key: `track-${t.trackId}`, pos: [t.latitude, t.longitude] as LatLng, label: t.employeeName }]
        : [],
    ),
    ...oldPins.map((m) => ({
      key: `emp-${m.employeeId}`,
      pos: [m.latitude as number, m.longitude as number] as LatLng,
      label: m.employeeName,
    })),
    ...branchesWithFence.map((b) => ({
      key: `branch-${b.id}`,
      pos: [b.geofenceLat, b.geofenceLng] as LatLng,
      label: b.name,
    })),
  ];
  const outside = outsideTiruppur(places);
  const fitAll = () => view.fit(places.map((p) => p.pos));

  return (
    <div
      className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]"
      data-testid="tab-live-map"
    >
      <Card className="order-2 space-y-4 rounded-2xl p-4 lg:order-1 lg:max-h-[760px] lg:overflow-y-auto">
        <LiveTrackList
          tracks={liveTracks}
          loading={tracksLoading}
          error={tracksError}
          selectedId={selectedTrackId}
          onSelect={setSelectedTrackId}
          onOpenJourney={onOpenJourney}
        />

        <section className="space-y-2 border-t pt-4">
          <p className="flex items-center gap-1.5 text-sm font-bold text-gray-900">
            <Radar size={14} className="text-teal-700" /> Tracking-Enabled Employees ({team?.length ?? 0})
          </p>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-12 rounded-xl" />
              ))}
            </div>
          ) : members.length === 0 ? (
            <p className="rounded-xl border border-dashed px-3 py-6 text-center text-xs text-gray-500">
              No employees have live tracking enabled. Turn it on from the Tracking Settings tab.
            </p>
          ) : (
            <div className="max-h-[300px] space-y-1 overflow-y-auto">
              {members.map((m) => (
                <button
                  key={m.employeeId}
                  type="button"
                  onClick={() => setSelectedId(m.employeeId)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left transition-colors",
                    selectedId === m.employeeId
                      ? "border-sky-300 bg-sky-50/60"
                      : "border-transparent hover:bg-slate-50",
                  )}
                >
                  <span
                    className={cn("h-2 w-2 shrink-0 rounded-full", !m.latitude && "bg-slate-300")}
                    style={m.latitude ? { background: memberColor(m) } : undefined}
                    aria-hidden
                  />
                  <Avatar name={m.employeeName} size={28} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-semibold text-gray-900">{m.employeeName}</span>
                    <span className="block truncate text-[11px] text-gray-500">
                      {m.department ?? "—"} · {m.latitude ? timeAgo(m.lastSeenAt) : "no signal yet"}
                    </span>
                  </span>
                  {m.isOnDutyToday && (
                    <Chip tone="warning" className="shrink-0 !px-1.5 !py-0 !text-[9px] uppercase">
                      On-Duty
                    </Chip>
                  )}
                </button>
              ))}
            </div>
          )}
        </section>

        <div className="space-y-2 border-t pt-4">
          <PinLegend />
          <LiveLegend />
        </div>
      </Card>

      <Card className="order-1 overflow-hidden rounded-2xl p-0 lg:order-2">
        <MapCardHeader
          icon={<MapPinned size={15} className="text-[#006496]" />}
          title="Live positions"
          actions={<MapViewButtons onTiruppur={view.backToTiruppur} onFit={fitAll} fitDisabled={places.length === 0} />}
        >
          <Chip tone="info" icon={ScanSearch}>
            {TIRUPPUR_CAPTION}
          </Chip>
          <Chip tone="neutral">{places.length} on the map</Chip>
          {outside.length > 0 && (
            <button
              type="button"
              onClick={fitAll}
              title={outside.map((o) => `${o.label} (${farFromTiruppurText(o.pos)})`).join(", ")}
              data-testid="outside-chip"
              className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
            >
              <Chip tone="warning" className="cursor-pointer hover:bg-amber-200">
                {outside.length} outside the Tiruppur area · show all
              </Chip>
            </button>
          )}
        </MapCardHeader>
        <div className="h-[420px] sm:h-[520px] lg:h-[640px]" data-testid="live-map-canvas">
          <MapContainer
            center={TIRUPPUR_CENTER}
            zoom={TIRUPPUR_ZOOM}
            style={{ height: "100%", width: "100%" }}
            scrollWheelZoom
          >
            <BaseMapLayers />
            <MapBridge onMap={view.onMap} />
            {branchesWithFence.map((b) => (
              <div key={b.id}>
                <Marker position={[b.geofenceLat, b.geofenceLng]} icon={pinIcon(COLOR_COMPANY, "building", 32)}>
                  <Popup>
                    <p className="font-semibold">{b.name}</p>
                    <p className="text-xs text-gray-500">Company location · {b.geofenceRadiusM ?? 200}m radius</p>
                  </Popup>
                </Marker>
                <Circle
                  center={[b.geofenceLat, b.geofenceLng]}
                  radius={b.geofenceRadiusM ?? 200}
                  pathOptions={{ color: COLOR_COMPANY, weight: 1.5, fillOpacity: 0.06 }}
                />
              </div>
            ))}
            {oldPins.map((m) => (
              <Marker
                key={m.employeeId}
                position={[m.latitude as number, m.longitude as number]}
                icon={pinIcon(memberColor(m), "person")}
                eventHandlers={{ click: () => setSelectedId(m.employeeId) }}
              >
                <Popup>
                  <p className="font-semibold">{m.employeeName}</p>
                  <p className="text-xs text-gray-500">{m.department ?? "—"}</p>
                  <p className="mt-1 text-xs text-gray-400">Last seen {timeAgo(m.lastSeenAt)}</p>
                  {m.isOnDutyToday && <p className="mt-1 text-xs font-semibold text-amber-600">On-Duty today</p>}
                  {m.isMocked && <p className="mt-1 text-xs font-semibold text-red-500">⚠ Simulated location</p>}
                </Popup>
              </Marker>
            ))}
            <LiveFocus tracks={liveTracks} selectedId={selectedTrackId} />
            <LiveTrackMarkers tracks={liveTracks} onSelect={setSelectedTrackId} onOpenJourney={onOpenJourney} />
            {trail && trail.length > 1 && (
              <Polyline
                positions={trail.map((p) => [p.latitude, p.longitude] as [number, number])}
                pathOptions={{ color: COLOR_NORMAL, weight: 3, opacity: 0.6 }}
              />
            )}
          </MapContainer>
        </div>
        <p className="flex items-center gap-1.5 border-t px-4 py-2 text-[11px] text-gray-500">
          <Building2 size={12} /> Drag and zoom freely. The map opens on Tiruppur; use &ldquo;Fit all&rdquo; to see
          every pin, wherever it is.
        </p>
      </Card>
    </div>
  );
}
