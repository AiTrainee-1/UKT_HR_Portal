// Live Map: the new feed of On-Duty tracks (GET /api/tracking/live) next to the old feed of employees HR switched live tracking
// on for. A track is listed from the moment the employee submitted the On-Duty request, whether or not it is approved yet.
// Each row says what the phone is doing (moving, stationary, offline, location off), when it was last heard from, its battery
// and network, where the request stands, and links to the journey.
import { Fragment, useEffect, useMemo, useRef } from "react";
import { Marker, Popup, useMap } from "react-leaflet";
import { AlertTriangle, ArrowUpRight, BatteryMedium, Signal, Wifi } from "lucide-react";
import { Avatar, Chip } from "@/components/payroll/kit/parts";
import { Skeleton } from "@/components/ui/skeleton";
import {
  isTrackingForbidden,
  trackingErrorMessage,
  type LiveLocationTeamMember,
  type LiveTrack,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { dutyEndIcon } from "./dutyIcons";
import { ApprovalPill, Note, StateChip } from "./kit";
import { fmtDateTime, fmtDistance, fmtTime, sortLive, STATE_COLOR, STATE_LABEL, timeAgo } from "./logic";
import { COLOR_MOCKED } from "./pins";

const hasFix = (t: LiveTrack): boolean => t.latitude !== null && t.longitude !== null;

/**
 * Employees the old feed and the new feed both know: the old marker is dropped when the new feed has a position that is newer
 * (or the old feed has none), so one person is never drawn twice. The old list itself is left as it was.
 */
export function supersededTeamIds(team: LiveLocationTeamMember[], tracks: LiveTrack[]): Set<number> {
  const out = new Set<number>();
  for (const t of tracks) {
    if (!hasFix(t)) continue;
    const old = team.find((m) => m.employeeId === t.employeeId);
    if (!old) continue;
    const oldAt = old.lastSeenAt ? Date.parse(old.lastSeenAt) : NaN;
    const newAt = t.lastPointAt ? Date.parse(t.lastPointAt) : NaN;
    if (old.latitude === null || Number.isNaN(oldAt) || Number.isNaN(newAt) || newAt >= oldAt) out.add(t.employeeId);
  }
  return out;
}

const COUNT_DOT: Record<string, string> = {
  moving: "bg-green-500",
  stationary: "bg-amber-500",
  offline: "bg-slate-400",
  "location off": "bg-red-500",
};

/** The counts above the list: "2 moving, 1 stationary, 1 offline". */
function Counts({ tracks }: { tracks: LiveTrack[] }) {
  const n = (s: LiveTrack["state"]) => tracks.filter((t) => t.state === s).length;
  const parts = [
    ["moving", n("moving")],
    ["stationary", n("stationary")],
    ["offline", n("offline")],
    ["location off", n("location_off")],
  ] as const;
  return (
    <p className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 lg:grid-cols-2" data-testid="live-counts">
      {parts.map(([label, count]) => (
        <Fragment key={label}>
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold",
              count > 0 ? "border-slate-200 bg-white text-gray-800" : "border-transparent bg-slate-50 text-gray-400",
            )}
          >
            <span
              aria-hidden
              className={cn("h-1.5 w-1.5 rounded-full", count > 0 ? COUNT_DOT[label] : "bg-slate-300")}
            />
            {count} {label}
          </span>{" "}
        </Fragment>
      ))}
    </p>
  );
}

export function LiveTrackList({
  tracks,
  loading,
  error,
  selectedId,
  onSelect,
  onOpenJourney,
}: {
  tracks: LiveTrack[];
  loading: boolean;
  error: unknown;
  selectedId: number | null;
  onSelect: (id: number) => void;
  onOpenJourney: (id: number) => void;
}) {
  const rows = useMemo(() => sortLive(tracks), [tracks]);
  return (
    <div className="space-y-3" data-testid="live-tracks">
      <p className="flex items-center gap-1.5 text-sm font-bold text-gray-900">
        <Signal size={14} className="text-[#006496]" /> On-Duty tracks ({tracks.length})
      </p>
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
      ) : error ? (
        <Note tone="warn" testId="live-tracks-error">
          <span role="alert">
            {isTrackingForbidden(error)
              ? "You are not allowed to see On-Duty tracks."
              : trackingErrorMessage(error, "The On-Duty tracks could not be loaded.")}
          </span>
        </Note>
      ) : rows.length === 0 ? (
        <p
          className="rounded-xl border border-dashed px-3 py-6 text-center text-xs text-gray-500"
          data-testid="live-tracks-empty"
        >
          No On-Duty journey is being recorded now. A track starts when an employee submits an On-Duty request.
        </p>
      ) : (
        <>
          <Counts tracks={tracks} />
          <div className="max-h-[430px] space-y-2 overflow-y-auto pr-0.5">
            {rows.map((t) => (
              <div
                key={t.trackId}
                data-testid="live-track"
                data-track-id={t.trackId}
                data-state={t.state}
                className={cn(
                  "rounded-xl border bg-white p-3 transition-colors",
                  selectedId === t.trackId
                    ? "border-sky-300 bg-sky-50/60 ring-1 ring-sky-200"
                    : "hover:border-slate-300",
                )}
              >
                <button
                  type="button"
                  className="flex w-full items-start gap-3 text-left"
                  onClick={() => onSelect(t.trackId)}
                >
                  <Avatar name={t.employeeName} size={34} />
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
                    className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-[#006496] hover:underline"
                    data-testid="open-journey"
                    onClick={() => onOpenJourney(t.trackId)}
                  >
                    Open journey <ArrowUpRight size={12} />
                  </button>
                </div>
              </div>
            ))}
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

export function LiveTrackMarkers({
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
        <Marker
          key={`track-${t.trackId}`}
          position={[t.latitude as number, t.longitude as number]}
          icon={dutyEndIcon(t.isMocked ? COLOR_MOCKED : STATE_COLOR[t.state], "person")}
          title={`${t.employeeName}: ${STATE_LABEL[t.state]}`}
          eventHandlers={{ click: () => onSelect(t.trackId) }}
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
      ))}
    </>
  );
}

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
