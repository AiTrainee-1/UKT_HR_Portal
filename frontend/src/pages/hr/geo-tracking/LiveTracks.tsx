// Live Map: the new feed of On-Duty tracks (GET /api/tracking/live) next to the old feed of employees HR switched live tracking
// on for. A track is listed from the moment the employee submitted the On-Duty request, whether or not it is approved yet.
// Each row says what the phone is doing (moving, stationary, offline, location off), when it was last heard from, its battery
// and network, where the request stands, and links to the journey.
//
// The board refreshes every 20 s. The rows and the pins are memoised per track: the answer is shared structurally by the query
// cache (a track whose figures did not change keeps the same object), so a refresh redraws only the people who moved, and a
// pin's position, icon and handlers keep their identity (Leaflet is not asked to move a marker that stayed where it was).
import { Fragment, memo, useEffect, useMemo, useRef } from "react";
import { Marker, Popup, useMap } from "react-leaflet";
import { AlertTriangle, ArrowUpRight, BatteryMedium, Search, Signal, Wifi, X } from "lucide-react";
import { Avatar, Chip } from "@/components/payroll/kit/parts";
import { Input } from "@/components/ui/input";
import {
  isTrackingForbidden,
  trackingErrorMessage,
  type LiveLocationTeamMember,
  type LiveTrack,
  type TrackState,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { dutyEndIcon } from "./dutyIcons";
import { ApprovalPill, ListSkeleton, Note, StateChip } from "./kit";
import { fmtDateTime, fmtDistance, fmtTime, sortLive, STATE_COLOR, STATE_LABEL, timeAgo } from "./logic";
import { COLOR_MOCKED } from "./pins";
import type { LatLng } from "./tiruppur";

const hasFix = (t: LiveTrack): boolean => t.latitude !== null && t.longitude !== null;

/**
 * Employees the old feed and the new feed both know: the old marker is dropped when the new feed has a position that is newer
 * (or the old feed has none), so one person is never drawn twice. The old list itself is left as it was.
 */
export function supersededTeamIds(team: LiveLocationTeamMember[], tracks: LiveTrack[]): Set<number> {
  const out = new Set<number>();
  const byEmployee = new Map(team.map((m) => [m.employeeId, m] as const));
  for (const t of tracks) {
    if (!hasFix(t)) continue;
    const old = byEmployee.get(t.employeeId);
    if (!old) continue;
    const oldAt = old.lastSeenAt ? Date.parse(old.lastSeenAt) : NaN;
    const newAt = t.lastPointAt ? Date.parse(t.lastPointAt) : NaN;
    if (old.latitude === null || Number.isNaN(oldAt) || Number.isNaN(newAt) || newAt >= oldAt) out.add(t.employeeId);
  }
  return out;
}

/** What the board can be narrowed to. */
export type BoardFilter = "all" | "moving" | "stationary" | "offline" | "location_off";

const COUNT_DOT: Record<Exclude<BoardFilter, "all">, string> = {
  moving: "bg-green-500",
  stationary: "bg-amber-500",
  offline: "bg-slate-400",
  location_off: "bg-red-500",
};
const COUNT_WORD: Record<Exclude<BoardFilter, "all">, string> = {
  moving: "moving",
  stationary: "stationary",
  offline: "offline",
  location_off: "location off",
};

/** The counts above the list ("2 moving, 1 stationary ..."); each one narrows the list to that state (again: everyone). */
function Counts({
  tracks,
  filter,
  onFilter,
}: {
  tracks: LiveTrack[];
  filter: BoardFilter;
  onFilter: (f: BoardFilter) => void;
}) {
  const n = (s: TrackState) => tracks.filter((t) => t.state === s).length;
  const parts = (["moving", "stationary", "offline", "location_off"] as const).map((s) => [s, n(s)] as const);
  return (
    <p className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 lg:grid-cols-2" data-testid="live-counts">
      {parts.map(([state, count]) => {
        const on = filter === state;
        return (
          <Fragment key={state}>
            <button
              type="button"
              aria-pressed={on}
              disabled={count === 0 && !on}
              onClick={() => onFilter(on ? "all" : state)}
              title={on ? "Show everyone again" : `Show only the ${COUNT_WORD[state]} employees`}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-left text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300",
                on
                  ? "border-sky-300 bg-sky-50 text-sky-900"
                  : count > 0
                    ? "border-slate-200 bg-white text-gray-800 hover:bg-slate-50"
                    : "border-transparent bg-slate-50 text-gray-400",
              )}
            >
              <span
                aria-hidden
                className={cn("h-1.5 w-1.5 rounded-full", count > 0 ? COUNT_DOT[state] : "bg-slate-300")}
              />
              {count} {COUNT_WORD[state]}
            </button>{" "}
          </Fragment>
        );
      })}
    </p>
  );
}

const matches = (t: LiveTrack, q: string): boolean =>
  !q ||
  t.employeeName.toLowerCase().includes(q) ||
  t.employeeCode.toLowerCase().includes(q) ||
  t.destination.toLowerCase().includes(q) ||
  (t.department ?? "").toLowerCase().includes(q);

/** One track of the board. Memoised: a refresh that did not change this track does not redraw it. */
const TrackRow = memo(function TrackRow({
  t,
  selected,
  onSelect,
  onOpenJourney,
}: {
  t: LiveTrack;
  selected: boolean;
  onSelect: (id: number) => void;
  onOpenJourney: (id: number) => void;
}) {
  return (
    <div
      data-testid="live-track"
      data-track-id={t.trackId}
      data-state={t.state}
      data-selected={selected || undefined}
      className={cn(
        "rounded-xl border bg-white p-3 transition-colors",
        selected ? "border-sky-300 bg-sky-50/60 ring-1 ring-sky-200" : "hover:border-slate-300",
      )}
    >
      <button
        type="button"
        className="flex w-full items-start gap-3 text-left"
        onClick={() => onSelect(t.trackId)}
        aria-pressed={selected}
      >
        <span className="relative shrink-0">
          <Avatar name={t.employeeName} size={34} />
          <span
            aria-hidden
            className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white"
            style={{ background: t.isMocked ? COLOR_MOCKED : STATE_COLOR[t.state] }}
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-bold text-gray-900">{t.employeeName}</span>
            <StateChip state={t.state} testId="live-state" />
          </span>
          <span className="mt-0.5 block truncate text-xs text-gray-600">
            {t.department ?? "No department"} · {t.destination || "no destination"}
          </span>
        </span>
      </button>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-600">
        <span data-testid="live-last-seen">Last seen {t.lastPointAt ? timeAgo(t.lastPointAt) : "never"}</span>
        {t.batteryPct !== null && (
          <span className="inline-flex items-center gap-0.5" data-testid="live-battery">
            <BatteryMedium size={12} /> {Math.round(t.batteryPct)}%
          </span>
        )}
        {t.network && (
          <span className="inline-flex items-center gap-0.5" data-testid="live-network">
            <Wifi size={11} /> {t.network}
          </span>
        )}
        {t.isMocked && (
          <Chip tone="danger" icon={AlertTriangle}>
            Simulated
          </Chip>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-t pt-2">
        <span className="flex flex-wrap items-center gap-1.5">
          <ApprovalPill status={t.approvalStatus} testId="live-approval" />
          <span className="text-[11px] text-gray-500" data-testid="live-since">
            tracking since {fmtTime(t.startedAt)}
          </span>
        </span>
        <button
          type="button"
          className="inline-flex items-center gap-0.5 rounded text-[11px] font-semibold text-[#006496] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
          data-testid="open-journey"
          onClick={() => onOpenJourney(t.trackId)}
        >
          Open journey <ArrowUpRight size={12} />
        </button>
      </div>
    </div>
  );
});

export function LiveTrackList({
  tracks,
  loading,
  error,
  selectedId,
  onSelect,
  onOpenJourney,
  onRetry,
  search,
  onSearch,
  filter,
  onFilter,
}: {
  tracks: LiveTrack[];
  loading: boolean;
  error: unknown;
  selectedId: number | null;
  onSelect: (id: number) => void;
  onOpenJourney: (id: number) => void;
  onRetry?: () => void;
  search: string;
  onSearch: (text: string) => void;
  filter: BoardFilter;
  onFilter: (f: BoardFilter) => void;
}) {
  const rows = useMemo(() => sortLive(tracks), [tracks]);
  const q = search.trim().toLowerCase();
  const shown = useMemo(
    () => rows.filter((t) => (filter === "all" || t.state === filter) && matches(t, q)),
    [rows, filter, q],
  );
  return (
    <div className="space-y-3" data-testid="live-tracks">
      <p className="flex items-center gap-1.5 text-sm font-bold text-gray-900">
        <Signal size={14} className="text-[#006496]" /> On-Duty tracks ({tracks.length})
      </p>
      {loading ? (
        <ListSkeleton rows={2} height="h-28" />
      ) : error ? (
        <Note tone="warn" testId="live-tracks-error">
          <span role="alert">
            {isTrackingForbidden(error)
              ? "You are not allowed to see On-Duty tracks."
              : trackingErrorMessage(error, "The On-Duty tracks could not be loaded.")}
          </span>
          {onRetry && !isTrackingForbidden(error) && (
            <button type="button" className="ml-1 font-semibold underline" onClick={onRetry}>
              Try again
            </button>
          )}
        </Note>
      ) : rows.length === 0 ? (
        <div
          className="rounded-xl border border-dashed px-3 py-6 text-center text-xs leading-relaxed text-gray-500"
          data-testid="live-tracks-empty"
        >
          <p className="font-semibold text-gray-700">No On-Duty journey is being recorded now.</p>
          <p className="mt-1">
            A track starts when an employee submits an On-Duty request from the mobile app; it appears here within a
            minute.
          </p>
        </div>
      ) : (
        <>
          <Counts tracks={tracks} filter={filter} onFilter={onFilter} />
          {rows.length > 4 && (
            <div className="relative">
              <Search
                size={14}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
                aria-hidden
              />
              <Input
                value={search}
                onChange={(e) => onSearch(e.target.value)}
                placeholder="Search name, code or destination"
                aria-label="Search the On-Duty tracks"
                className="h-9 pl-9 pr-8 text-sm"
                data-testid="live-search"
              />
              {search && (
                <button
                  type="button"
                  aria-label="Clear the search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-gray-400 hover:bg-slate-100 hover:text-gray-700"
                  onClick={() => onSearch("")}
                >
                  <X size={14} />
                </button>
              )}
            </div>
          )}
          <div className="max-h-[460px] space-y-2 overflow-y-auto pr-0.5" data-testid="live-track-list">
            {shown.length === 0 ? (
              <p className="rounded-xl border border-dashed px-3 py-5 text-center text-xs text-gray-500">
                Nobody matches. {filter !== "all" ? "Show everyone again with the count above, or " : ""}clear the
                search.
              </p>
            ) : (
              shown.map((t) => (
                <TrackRow
                  key={t.trackId}
                  t={t}
                  selected={selectedId === t.trackId}
                  onSelect={onSelect}
                  onOpenJourney={onOpenJourney}
                />
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Pans the map to the track picked in the list (once per pick: the board refreshes every 20 s and must not drag the map back). Lives inside the MapContainer. */
export function LiveFocus({ tracks, selectedId }: { tracks: LiveTrack[]; selectedId: number | null }) {
  const map = useMap();
  const latest = useRef(tracks);
  latest.current = tracks;
  useEffect(() => {
    const picked = selectedId === null ? undefined : latest.current.find((t) => t.trackId === selectedId);
    if (picked && hasFix(picked))
      map.setView([picked.latitude as number, picked.longitude as number], Math.max(map.getZoom(), 14));
  }, [map, selectedId]);
  return null;
}

/** One person's pin. Memoised: its position array, icon and handlers keep their identity while the track does not change. */
const LiveTrackMarker = memo(function LiveTrackMarker({
  t,
  onSelect,
  onOpenJourney,
}: {
  t: LiveTrack;
  onSelect: (id: number) => void;
  onOpenJourney: (id: number) => void;
}) {
  const lat = t.latitude as number;
  const lng = t.longitude as number;
  const position = useMemo<LatLng>(() => [lat, lng], [lat, lng]);
  const handlers = useMemo(() => ({ click: () => onSelect(t.trackId) }), [onSelect, t.trackId]);
  return (
    <Marker
      position={position}
      icon={dutyEndIcon(t.isMocked ? COLOR_MOCKED : STATE_COLOR[t.state], "person")}
      title={`${t.employeeName}: ${STATE_LABEL[t.state]}`}
      eventHandlers={handlers}
    >
      <Popup>
        <div className="space-y-0.5 text-xs [&_p]:my-0" data-testid="live-popup">
          <p className="text-sm font-bold">{t.employeeName}</p>
          <p className="text-gray-600">
            {t.department ?? "No department"} · {t.destination}
          </p>
          <p>
            <b>{STATE_LABEL[t.state]}</b>
            {t.stateSince ? ` since ${fmtTime(t.stateSince)}` : ""}
          </p>
          <p>Last seen {t.lastPointAt ? `${timeAgo(t.lastPointAt)} (${fmtDateTime(t.lastPointAt)})` : "never"}</p>
          <p>
            {t.batteryPct !== null ? `Battery ${Math.round(t.batteryPct)}%` : "Battery unknown"}
            {t.network ? ` · ${t.network}` : ""}
          </p>
          <p>
            {t.stopCount} stop{t.stopCount === 1 ? "" : "s"} · {fmtDistance(t.distanceM)}
          </p>
          {t.isMocked && <p className="font-semibold text-red-600">Simulated location</p>}
          <button
            type="button"
            className="pt-1 font-semibold text-[#006496] hover:underline"
            onClick={() => onOpenJourney(t.trackId)}
          >
            Open journey
          </button>
        </div>
      </Popup>
    </Marker>
  );
});

export const LiveTrackMarkers = memo(function LiveTrackMarkers({
  tracks,
  onSelect,
  onOpenJourney,
}: {
  tracks: LiveTrack[];
  onSelect: (id: number) => void;
  onOpenJourney: (id: number) => void;
}) {
  return (
    <>
      {tracks.filter(hasFix).map((t) => (
        <LiveTrackMarker key={`track-${t.trackId}`} t={t} onSelect={onSelect} onOpenJourney={onOpenJourney} />
      ))}
    </>
  );
});

/** The legend of the board's pins. */
export function LiveLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="live-legend">
      {(["moving", "stationary", "offline", "location_off"] as const).map((s) => (
        <span key={s} className="flex items-center gap-1.5 text-[11px] font-semibold text-gray-700">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: STATE_COLOR[s] }} />
          {STATE_LABEL[s]}
        </span>
      ))}
    </div>
  );
}
