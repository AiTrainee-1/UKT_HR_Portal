// Geo Attendance -> Live Map: where the On-Duty employees are right now. The map opens on Tiruppur (about 60 km across), not on the
// whole of India: the company works in and around the town. It is never locked: pan and zoom as you like, "Back to Tiruppur" and
// "Fit all" bring the view back, and whatever lies outside the Tiruppur area (a branch or an employee in another town) is counted
// in a chip that fits everything with one click, so nothing is lost off the edge.
//
// What keeps it smooth (measured with the e2e performance spec, see frontend.md): the map is its own memoised component, so
// typing in the search box or picking a row never re-renders it; each pin is memoised per person, so a 20-second refresh only
// moves the people who moved; lines and circles are drawn on one canvas; the tiles are not reloaded while a zoom is still
// animating, nor do they fade in; markers do not animate their zoom (each animated marker cost a style recalculation on every
// frame); a selected employee's trail is thinned for drawing; and nothing on the page pulses forever.
import { memo, useCallback, useMemo, useState } from "react";
import type { Map as LeafletMap } from "leaflet";
import { Circle, MapContainer, Marker, Polyline, Popup } from "react-leaflet";
import { Building2, MapPinned, Radar, ScanSearch } from "lucide-react";
import { BaseMapLayers } from "@/components/geo/BaseMapLayers";
import { Avatar, Chip } from "@/components/payroll/kit/parts";
import { Card } from "@/components/ui/card";
import { useListBranches } from "@/lib/api-client";
import {
  useLiveLocationTeam,
  useLiveLocationTrail,
  useLiveTracks,
  type LiveLocationTeamMember,
  type LiveTrack,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { ListSkeleton } from "../kit";
import {
  LiveFocus,
  LiveLegend,
  LiveTrackList,
  LiveTrackMarkers,
  supersededTeamIds,
  type BoardFilter,
} from "../LiveTracks";
import { MapBridge, MapCardHeader, MapViewButtons, useMapView } from "../mapKit";
import { COLOR_COMPANY, COLOR_MOCKED, COLOR_NORMAL, COLOR_ON_DUTY, pinIcon } from "../pins";
import { timeAgo } from "../logic";
import { thinPath } from "../thin";
import {
  TIRUPPUR_CAPTION,
  TIRUPPUR_CENTER,
  TIRUPPUR_ZOOM,
  farFromTiruppurText,
  outsideTiruppur,
  type LatLng,
} from "../tiruppur";

type Member = LiveLocationTeamMember & { isOnDutyToday?: boolean };
type Fence = { id: number; name: string; pos: LatLng; radiusM: number };
type BranchWithFence = {
  id: number;
  name: string;
  geofenceLat: number | null;
  geofenceLng: number | null;
  geofenceRadiusM?: number | null;
};

const NO_TRACKS: LiveTrack[] = [];
const NO_MEMBERS: Member[] = [];
const TRAIL_STYLE = { color: COLOR_NORMAL, weight: 3, opacity: 0.6 };

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

/** A company location: a building pin and its radius. */
const FencePins = memo(function FencePins({ fences }: { fences: Fence[] }) {
  return (
    <>
      {fences.map((b) => (
        <FencePin key={b.id} fence={b} />
      ))}
    </>
  );
});

const FENCE_STYLE = { color: COLOR_COMPANY, weight: 1.5, fillOpacity: 0.06 };

const FencePin = memo(function FencePin({ fence }: { fence: Fence }) {
  return (
    <>
      <Marker position={fence.pos} icon={pinIcon(COLOR_COMPANY, "building", 32)}>
        <Popup>
          <p className="font-semibold">{fence.name}</p>
          <p className="text-xs text-gray-500">Company location · {fence.radiusM}m radius</p>
        </Popup>
      </Marker>
      <Circle center={fence.pos} radius={fence.radiusM} pathOptions={FENCE_STYLE} interactive={false} />
    </>
  );
});

/** A person of the old feed. */
const MemberPin = memo(function MemberPin({ m, onSelect }: { m: Member; onSelect: (id: number) => void }) {
  const lat = m.latitude as number;
  const lng = m.longitude as number;
  const position = useMemo<LatLng>(() => [lat, lng], [lat, lng]);
  const handlers = useMemo(() => ({ click: () => onSelect(m.employeeId) }), [onSelect, m.employeeId]);
  return (
    <Marker position={position} icon={pinIcon(memberColor(m), "person")} eventHandlers={handlers}>
      <Popup>
        <p className="font-semibold">{m.employeeName}</p>
        <p className="text-xs text-gray-500">{m.department ?? "—"}</p>
        <p className="mt-1 text-xs text-gray-400">Last seen {timeAgo(m.lastSeenAt)}</p>
        {m.isOnDutyToday && <p className="mt-1 text-xs font-semibold text-amber-600">On-Duty today</p>}
        {m.isMocked && <p className="mt-1 text-xs font-semibold text-red-500">⚠ Simulated location</p>}
      </Popup>
    </Marker>
  );
});

/**
 * The map. Memoised and given only stable props, so it re-renders when the data on it changes, never because of the list
 * beside it (a search keystroke, a filter).
 */
const LiveMapCanvas = memo(function LiveMapCanvas({
  tracks,
  members,
  fences,
  trail,
  selectedTrackId,
  onSelectTrack,
  onSelectMember,
  onOpenJourney,
  onMap,
}: {
  tracks: LiveTrack[];
  members: Member[];
  fences: Fence[];
  trail: LatLng[];
  selectedTrackId: number | null;
  onSelectTrack: (id: number) => void;
  onSelectMember: (id: number) => void;
  onOpenJourney: (id: number) => void;
  onMap: (map: LeafletMap | null) => void;
}) {
  return (
    <MapContainer
      center={TIRUPPUR_CENTER}
      zoom={TIRUPPUR_ZOOM}
      style={{ height: "100%", width: "100%" }}
      scrollWheelZoom
      preferCanvas
      fadeAnimation={false}
      markerZoomAnimation={false}
      wheelPxPerZoomLevel={90}
    >
      <BaseMapLayers />
      <MapBridge onMap={onMap} />
      <FencePins fences={fences} />
      {members.map((m) => (
        <MemberPin key={m.employeeId} m={m} onSelect={onSelectMember} />
      ))}
      <LiveFocus tracks={tracks} selectedId={selectedTrackId} />
      <LiveTrackMarkers tracks={tracks} onSelect={onSelectTrack} onOpenJourney={onOpenJourney} />
      {trail.length > 1 && <Polyline positions={trail} pathOptions={TRAIL_STYLE} interactive={false} />}
    </MapContainer>
  );
});

export default function LiveMapTab({ onOpenJourney }: { onOpenJourney: (id: number) => void }) {
  const team = useLiveLocationTeam();
  const live = useLiveTracks();
  const { data: branches } = useListBranches();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedTrackId, setSelectedTrackId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<BoardFilter>("all");
  const { data: trailPoints } = useLiveLocationTrail(selectedId);
  const view = useMapView();

  const members = (team.data as Member[] | undefined) ?? NO_MEMBERS;
  const tracks = live.data ?? NO_TRACKS;
  // the new feed (On-Duty tracks) wins over the old one for a person it has a newer position for
  const oldPins = useMemo(() => {
    const superseded = supersededTeamIds(members, tracks);
    return members.filter((m) => m.latitude != null && m.longitude != null && !superseded.has(m.employeeId));
  }, [members, tracks]);
  const fences = useMemo<Fence[]>(
    () =>
      ((branches ?? []) as unknown as BranchWithFence[]).flatMap((b) =>
        b.geofenceLat != null && b.geofenceLng != null
          ? [
              {
                id: b.id,
                name: b.name,
                pos: [b.geofenceLat, b.geofenceLng] as LatLng,
                radiusM: b.geofenceRadiusM ?? 200,
              },
            ]
          : [],
      ),
    [branches],
  );
  // a long trail is thinned for drawing only (the pings themselves are untouched)
  const trail = useMemo(
    () =>
      thinPath(
        (trailPoints ?? []).map((p) => [p.latitude, p.longitude] as LatLng),
        { maxPoints: 1500 },
      ),
    [trailPoints],
  );

  // everything that is on the map, as places: what "Fit all" shows and what is counted when it lies outside Tiruppur
  const places = useMemo(
    () => [
      ...tracks.flatMap((t) =>
        t.latitude !== null && t.longitude !== null
          ? [{ key: `track-${t.trackId}`, pos: [t.latitude, t.longitude] as LatLng, label: t.employeeName }]
          : [],
      ),
      ...oldPins.map((m) => ({
        key: `emp-${m.employeeId}`,
        pos: [m.latitude as number, m.longitude as number] as LatLng,
        label: m.employeeName,
      })),
      ...fences.map((b) => ({ key: `branch-${b.id}`, pos: b.pos, label: b.name })),
    ],
    [tracks, oldPins, fences],
  );
  const outside = useMemo(() => outsideTiruppur(places), [places]);
  const { fit, backToTiruppur, onMap } = view;
  const fitAll = useCallback(() => fit(places.map((p) => p.pos)), [fit, places]);
  const selectTrack = useCallback((id: number) => setSelectedTrackId(id), []);
  const selectMember = useCallback((id: number) => setSelectedId(id), []);

  return (
    <div
      className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]"
      data-testid="tab-live-map"
    >
      <Card className="order-2 space-y-4 rounded-2xl p-4 lg:order-1 lg:max-h-[780px] lg:overflow-y-auto">
        <LiveTrackList
          tracks={tracks}
          loading={live.isLoading}
          error={live.error}
          selectedId={selectedTrackId}
          onSelect={selectTrack}
          onOpenJourney={onOpenJourney}
          onRetry={() => void live.refetch()}
          search={search}
          onSearch={setSearch}
          filter={filter}
          onFilter={setFilter}
        />

        <section className="space-y-2 border-t pt-4">
          <p className="flex items-center gap-1.5 text-sm font-bold text-gray-900">
            <Radar size={14} className="text-teal-700" /> Tracking-Enabled Employees ({members.length})
          </p>
          {team.isLoading ? (
            <ListSkeleton rows={3} height="h-12" />
          ) : members.length === 0 ? (
            <p className="rounded-xl border border-dashed px-3 py-6 text-center text-xs text-gray-500">
              No employees have live tracking enabled. Turn it on from Tracking Settings.
            </p>
          ) : (
            <div className="max-h-[300px] space-y-1 overflow-y-auto">
              {members.map((m) => (
                <button
                  key={m.employeeId}
                  type="button"
                  onClick={() => setSelectedId(m.employeeId)}
                  aria-pressed={selectedId === m.employeeId}
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
      </Card>

      <Card className="order-1 overflow-hidden rounded-2xl p-0 lg:order-2">
        <MapCardHeader
          icon={<MapPinned size={15} className="text-[#006496]" />}
          title="Live positions"
          actions={<MapViewButtons onTiruppur={backToTiruppur} onFit={fitAll} fitDisabled={places.length === 0} />}
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
        <div className="h-[420px] sm:h-[520px] lg:h-[660px]" data-testid="live-map-canvas">
          <LiveMapCanvas
            tracks={tracks}
            members={oldPins}
            fences={fences}
            trail={trail}
            selectedTrackId={selectedTrackId}
            onSelectTrack={selectTrack}
            onSelectMember={selectMember}
            onOpenJourney={onOpenJourney}
            onMap={onMap}
          />
        </div>
        <div className="space-y-2 border-t px-4 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <LiveLegend />
            <PinLegend />
          </div>
          <p className="flex items-center gap-1.5 text-[11px] text-gray-500">
            <Building2 size={12} /> Drag and zoom freely. The map opens on Tiruppur; use &ldquo;Fit all&rdquo; to see
            every pin, wherever it is. The positions refresh every 20 seconds.
          </p>
        </div>
      </Card>
    </div>
  );
}
