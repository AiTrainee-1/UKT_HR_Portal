import { useMemo, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup, Polyline, Circle } from "react-leaflet";
import L from "leaflet";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { PillTabs } from "@/components/ui/pill-tabs";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { useListEmployees, useListBranches, type Employee } from "@/lib/api-client";
import {
  useOnDutyRequestsHR, useUpdateOnDutyRequestHR,
  useLiveLocationTeam, useLiveLocationTrail, useLiveLocationRoute, useOnDutyMap,
  useUpdateEmployeeLocationTracking,
  fetchAuthedImageObjectUrl, type OnDutyRequestItem, type LiveLocationTeamMember,
} from "@/lib/api-client/custom-hooks";
import {
  MapPinned, CheckCircle2, XCircle, Navigation, Search, Radar, Clock, AlertTriangle,
  Image as ImageIcon, Building2, User, Route as RouteIcon, Users, ShieldCheck, ShieldAlert,
} from "lucide-react";

const INDIA_CENTER: [number, number] = [20.5937, 78.9629];

// ── Marker icons ─────────────────────────────────────────────────────────
// Meaningful shaped icons (not plain dots) so the map reads at a glance:
// a building pin for company/branch locations, a person pin for employees,
// colored per status. All built as inline SVG divIcons — no external assets.

function pinIcon(color: string, glyph: "building" | "person" | "flag" | "dot", size = 30) {
  const glyphSvg =
    glyph === "building"
      ? `<path d="M9 21V10.5h6V21M6 21V6.5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1V21M9.5 9h1M13.5 9h1M9.5 12h1M13.5 12h1" stroke="#fff" stroke-width="1.4" fill="none" stroke-linecap="round"/>`
      : glyph === "person"
      ? `<circle cx="12" cy="9" r="2.6" fill="#fff"/><path d="M7 18.5c0-2.8 2.2-5 5-5s5 2.2 5 5" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round"/>`
      : glyph === "flag"
      ? `<path d="M8 20V6m0 0h8l-2 3 2 3H8" stroke="#fff" stroke-width="1.6" fill="none" stroke-linejoin="round"/>`
      : `<circle cx="12" cy="12" r="3.2" fill="#fff"/>`;
  const html = `
    <svg width="${size}" height="${size * 1.25}" viewBox="0 0 24 30" xmlns="http://www.w3.org/2000/svg" style="filter:drop-shadow(0 2px 4px rgba(0,0,0,0.35))">
      <path d="M12 29C12 29 22 17.5 22 11C22 5.5 17.5 1 12 1C6.5 1 2 5.5 2 11C2 17.5 12 29 12 29Z" fill="${color}" stroke="#fff" stroke-width="1.5"/>
      <g transform="translate(0,-1.5)">${glyphSvg}</g>
    </svg>`;
  return L.divIcon({ className: "", html, iconSize: [size, size * 1.25], iconAnchor: [size / 2, size * 1.25] });
}

const COLOR_COMPANY = "#0f766e";
const COLOR_NORMAL = "#006496";
const COLOR_ON_DUTY = "#d97706";
const COLOR_MOCKED = "#dc2626";
const COLOR_START = "#16a34a";
const COLOR_END = "#dc2626";

const PALETTE = ["#006496", "#d97706", "#7c3aed", "#0f766e", "#db2777", "#4338ca", "#059669", "#b45309"];

function colorFor(index: number) {
  return PALETTE[index % PALETTE.length];
}

function bearingDeg(a: [number, number], b: [number, number]): number {
  const [lat1, lon1] = a.map((d) => (d * Math.PI) / 180);
  const [lat2, lon2] = b.map((d) => (d * Math.PI) / 180);
  const dLon = lon2 - lon1;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

function arrowIcon(color: string, rotationDeg: number) {
  const html = `<div style="width:0;height:0;transform:rotate(${rotationDeg}deg);border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:12px solid ${color};filter:drop-shadow(0 1px 2px rgba(0,0,0,0.4));"></div>`;
  return L.divIcon({ className: "", html, iconSize: [12, 12], iconAnchor: [6, 6] });
}

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m ago`;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function Legend({ items }: { items: { color: string; label: string; icon?: "building" | "person" }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-3 px-1">
      {items.map((it) => (
        <span key={it.label} className="flex items-center gap-1.5 text-[11px] font-semibold text-gray-600">
          <span
            className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
            style={{ background: it.color, boxShadow: "0 0 0 2px #fff, 0 0 0 3px rgba(0,0,0,0.08)" }}
          />
          {it.label}
        </span>
      ))}
    </div>
  );
}

const STAGE_LABEL: Record<OnDutyRequestItem["status"], string> = {
  pending_hod: "Awaiting Department Head",
  pending_hr: "Awaiting HR",
  approved: "Approved",
  rejected: "Rejected",
};

// ── Live Map tab ─────────────────────────────────────────────────────────

function LiveMapTab() {
  const { data: team, isLoading } = useLiveLocationTeam();
  const { data: branches } = useListBranches();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const { data: trail } = useLiveLocationTrail(selectedId);

  const withFix = (team ?? []).filter((m) => m.latitude != null && m.longitude != null);
  type BranchWithFence = { id: number; name: string; geofenceLat: number; geofenceLng: number; geofenceRadiusM?: number | null };
  const branchesWithFence = (branches ?? []).filter(
    (b: any) => b.geofenceLat != null && b.geofenceLng != null,
  ) as unknown as BranchWithFence[];

  const center: [number, number] =
    withFix.length > 0
      ? [withFix[0].latitude!, withFix[0].longitude!]
      : branchesWithFence.length > 0
      ? [branchesWithFence[0].geofenceLat, branchesWithFence[0].geofenceLng]
      : INDIA_CENTER;

  return (
    <div className="grid lg:grid-cols-[280px_1fr] gap-4 items-start">
      <Card className="border-0 shadow-sm">
        <CardContent className="p-3 space-y-2">
          <p className="text-xs font-bold text-gray-600 px-1 flex items-center gap-1.5">
            <Radar size={13} className="text-teal-700" /> Tracking-Enabled Employees ({team?.length ?? 0})
          </p>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12 rounded-lg" />)}
            </div>
          ) : (team ?? []).length === 0 ? (
            <p className="text-xs text-center text-gray-400 py-8">
              No employees have live tracking enabled. Turn it on from the Tracking Settings tab.
            </p>
          ) : (
            <div className="max-h-[420px] overflow-y-auto space-y-1">
              {(team ?? []).map((m: LiveLocationTeamMember & { isOnDutyToday?: boolean }) => (
                <button
                  key={m.employeeId}
                  onClick={() => setSelectedId(m.employeeId)}
                  className={`w-full text-left px-2.5 py-2 rounded-lg border transition-colors ${
                    selectedId === m.employeeId ? "bg-teal-50 border-teal-200" : "border-transparent hover:bg-gray-50"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ background: !m.latitude ? "#d1d5db" : m.isMocked ? COLOR_MOCKED : m.isOnDutyToday ? COLOR_ON_DUTY : COLOR_NORMAL }}
                    />
                    <p className="text-xs font-semibold truncate flex-1">{m.employeeName}</p>
                    {m.isOnDutyToday && <span className="text-[9px] font-bold px-1 py-0.5 rounded bg-amber-50 text-amber-700 shrink-0">ON-DUTY</span>}
                  </div>
                  <p className="text-[10px] text-gray-400 mt-0.5 ml-4">
                    {m.department ?? "—"} · {m.latitude ? timeAgo(m.lastSeenAt) : "no signal yet"}
                  </p>
                </button>
              ))}
            </div>
          )}
          <div className="pt-2 mt-1 border-t">
            <Legend
              items={[
                { color: COLOR_COMPANY, label: "Company Location" },
                { color: COLOR_NORMAL, label: "Employee" },
                { color: COLOR_ON_DUTY, label: "On-Duty Today" },
                { color: COLOR_MOCKED, label: "Simulated Location" },
              ]}
            />
          </div>
        </CardContent>
      </Card>

      <Card className="border-0 shadow-sm overflow-hidden">
        <div className="h-[560px]">
          <MapContainer center={center} zoom={withFix.length > 0 || branchesWithFence.length > 0 ? 12 : 5} style={{ height: "100%", width: "100%" }}>
            <TileLayer
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              attribution="&copy; OpenStreetMap contributors"
            />
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
            {withFix.map((m: LiveLocationTeamMember & { isOnDutyToday?: boolean }) => (
              <Marker
                key={m.employeeId}
                position={[m.latitude!, m.longitude!]}
                icon={pinIcon(m.isMocked ? COLOR_MOCKED : m.isOnDutyToday ? COLOR_ON_DUTY : COLOR_NORMAL, "person")}
                eventHandlers={{ click: () => setSelectedId(m.employeeId) }}
              >
                <Popup>
                  <p className="font-semibold">{m.employeeName}</p>
                  <p className="text-xs text-gray-500">{m.department ?? "—"}</p>
                  <p className="text-xs text-gray-400 mt-1">Last seen {timeAgo(m.lastSeenAt)}</p>
                  {m.isOnDutyToday && <p className="text-xs text-amber-600 font-semibold mt-1">On-Duty today</p>}
                  {m.isMocked && <p className="text-xs text-red-500 font-semibold mt-1">⚠ Simulated location</p>}
                </Popup>
              </Marker>
            ))}
            {trail && trail.length > 1 && (
              <Polyline
                positions={trail.map((p) => [p.latitude, p.longitude] as [number, number])}
                pathOptions={{ color: COLOR_NORMAL, weight: 3, opacity: 0.6 }}
              />
            )}
          </MapContainer>
        </div>
      </Card>
    </div>
  );
}

// ── Route Map tab ────────────────────────────────────────────────────────

function RouteMapTab() {
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [date, setDate] = useState(todayStr());
  const { data: employees, isLoading: employeesLoading } = useListEmployees({ status: "active" });
  const trackedEmployees = (employees ?? []).filter(
    (e) => (e as Employee & { locationTrackingEnabled?: boolean }).locationTrackingEnabled,
  );
  const filtered = trackedEmployees.filter((e) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return e.employeeCode.toLowerCase().includes(q) || `${e.firstName} ${e.lastName}`.toLowerCase().includes(q);
  });

  const { data: route, isLoading: routeLoading } = useLiveLocationRoute(selectedId, date);
  const points = (route?.points ?? []).map((p) => [p.latitude, p.longitude] as [number, number]);
  const center = points.length > 0 ? points[Math.floor(points.length / 2)] : INDIA_CENTER;

  // Sample a handful of interior points to place direction arrows along the
  // path without cluttering the map — start/end get their own distinct pins.
  const arrowSamples = useMemo(() => {
    if (points.length < 2) return [];
    const step = Math.max(1, Math.floor(points.length / 8));
    const out: { pos: [number, number]; rot: number }[] = [];
    for (let i = step; i < points.length - 1; i += step) {
      out.push({ pos: points[i], rot: bearingDeg(points[i - 1], points[i + 1] ?? points[i]) });
    }
    return out;
  }, [points]);

  return (
    <div className="grid lg:grid-cols-[280px_1fr] gap-4 items-start">
      <Card className="border-0 shadow-sm">
        <CardContent className="p-3 space-y-2.5">
          <div>
            <p className="text-xs font-bold text-gray-600 px-1 mb-1.5 flex items-center gap-1.5">
              <RouteIcon size={13} className="text-teal-700" /> Route Map
            </p>
            <Input type="date" className="h-9 text-sm" value={date} max={todayStr()} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input className="pl-8 h-9 text-sm" placeholder="Search On-Duty/tracked staff…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          {employeesLoading ? (
            <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 rounded-lg" />)}</div>
          ) : filtered.length === 0 ? (
            <p className="text-xs text-center text-gray-400 py-8">
              No tracking-enabled employees match. Route Map only shows staff with Live Tracking turned on (mainly On-Duty employees).
            </p>
          ) : (
            <div className="max-h-[380px] overflow-y-auto space-y-1">
              {filtered.map((e) => (
                <button
                  key={e.id}
                  onClick={() => setSelectedId(e.id)}
                  className={`w-full text-left px-2.5 py-2 rounded-lg border transition-colors ${
                    selectedId === e.id ? "bg-teal-50 border-teal-200" : "border-transparent hover:bg-gray-50"
                  }`}
                >
                  <p className="text-xs font-semibold truncate">{e.firstName} {e.lastName}</p>
                  <p className="text-[10px] text-gray-400 mt-0.5">{e.employeeCode} · {e.departmentName ?? "—"}</p>
                </button>
              ))}
            </div>
          )}
          <div className="pt-2 mt-1 border-t">
            <Legend
              items={[
                { color: COLOR_START, label: "Route start" },
                { color: COLOR_END, label: "Latest position" },
              ]}
            />
          </div>
        </CardContent>
      </Card>

      <Card className="border-0 shadow-sm overflow-hidden">
        <div className="h-[560px] relative">
          {!selectedId ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-400">
              <RouteIcon size={32} className="mb-2 text-gray-200" />
              <p className="text-sm">Select an employee to view their travel route.</p>
            </div>
          ) : routeLoading ? (
            <Skeleton className="h-full w-full" />
          ) : points.length === 0 ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-400">
              <RouteIcon size={32} className="mb-2 text-gray-200" />
              <p className="text-sm">No location pings recorded for {route?.employeeName ?? "this employee"} on {date}.</p>
            </div>
          ) : (
            <MapContainer center={center} zoom={13} style={{ height: "100%", width: "100%" }}>
              <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap contributors" />
              <Polyline positions={points} pathOptions={{ color: COLOR_NORMAL, weight: 4, opacity: 0.7 }} />
              {arrowSamples.map((a, i) => (
                <Marker key={i} position={a.pos} icon={arrowIcon(COLOR_NORMAL, a.rot)} />
              ))}
              <Marker position={points[0]} icon={pinIcon(COLOR_START, "flag")}>
                <Popup>Route start · {route?.points[0]?.recordedAt ? new Date(route.points[0].recordedAt).toLocaleTimeString() : ""}</Popup>
              </Marker>
              <Marker position={points[points.length - 1]} icon={pinIcon(COLOR_END, "person")}>
                <Popup>Latest position · {route?.points[route.points.length - 1]?.recordedAt ? new Date(route.points[route.points.length - 1].recordedAt).toLocaleTimeString() : ""}</Popup>
              </Marker>
            </MapContainer>
          )}
        </div>
      </Card>
    </div>
  );
}

// ── On-Duty Map tab ───────────────────────────────────────────────────────

function OnDutyMapTab() {
  const [date, setDate] = useState(todayStr());
  const { data, isLoading } = useOnDutyMap(date);
  const employees = data?.employees ?? [];
  const withFix = employees.filter((e) => e.latitude != null && e.longitude != null);
  const center: [number, number] = withFix.length > 0 ? [withFix[0].latitude!, withFix[0].longitude!] : INDIA_CENTER;

  return (
    <div className="grid lg:grid-cols-[300px_1fr] gap-4 items-start">
      <Card className="border-0 shadow-sm">
        <CardContent className="p-3 space-y-2.5">
          <div>
            <p className="text-xs font-bold text-gray-600 px-1 mb-1.5 flex items-center gap-1.5">
              <Users size={13} className="text-teal-700" /> On-Duty Today ({employees.length})
            </p>
            <Input type="date" className="h-9 text-sm" value={date} max={todayStr()} onChange={(e) => setDate(e.target.value)} />
          </div>
          {isLoading ? (
            <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-14 rounded-lg" />)}</div>
          ) : employees.length === 0 ? (
            <p className="text-xs text-center text-gray-400 py-8">No employees were On-Duty on {date}.</p>
          ) : (
            <div className="max-h-[440px] overflow-y-auto space-y-1.5">
              {employees.map((e, i) => (
                <div key={e.employeeId} className="px-2.5 py-2 rounded-lg border border-transparent hover:bg-gray-50">
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: colorFor(i) }} />
                    <p className="text-xs font-semibold truncate flex-1">{e.employeeName}</p>
                  </div>
                  <p className="text-[10px] text-gray-400 mt-0.5 ml-4.5">
                    {e.department ?? "—"} · {e.locationTrackingEnabled ? timeAgo(e.lastSeenAt) : "tracking off"}
                  </p>
                  <div className="flex flex-wrap gap-1 mt-1 ml-4.5">
                    {e.requests.map((r) => (
                      <span
                        key={r.id}
                        className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                          r.status === "approved" ? "bg-green-50 text-green-700"
                          : r.status === "rejected" ? "bg-red-50 text-red-600"
                          : "bg-amber-50 text-amber-700"
                        }`}
                      >
                        {r.punchType} {r.punchTime.slice(0, 5)} · {STAGE_LABEL[r.status as OnDutyRequestItem["status"]] ?? r.status}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-0 shadow-sm overflow-hidden">
        <div className="h-[560px] relative">
          {isLoading ? (
            <Skeleton className="h-full w-full" />
          ) : withFix.length === 0 ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-400">
              <Users size={32} className="mb-2 text-gray-200" />
              <p className="text-sm">No live positions to show for On-Duty staff on {date}.</p>
            </div>
          ) : (
            <MapContainer center={center} zoom={11} style={{ height: "100%", width: "100%" }}>
              <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap contributors" />
              {employees.map((e, i) => {
                const color = colorFor(i);
                const route = e.routePoints.map((p) => [p.latitude, p.longitude] as [number, number]);
                return (
                  <div key={e.employeeId}>
                    {route.length > 1 && <Polyline positions={route} pathOptions={{ color, weight: 3, opacity: 0.65 }} />}
                    {e.latitude != null && e.longitude != null && (
                      <Marker position={[e.latitude, e.longitude]} icon={pinIcon(color, "person")}>
                        <Popup>
                          <p className="font-semibold">{e.employeeName}</p>
                          <p className="text-xs text-gray-500">{e.department ?? "—"}</p>
                          <p className="text-xs text-gray-400 mt-1">Last seen {timeAgo(e.lastSeenAt)}</p>
                        </Popup>
                      </Marker>
                    )}
                  </div>
                );
              })}
            </MapContainer>
          )}
        </div>
        {employees.length > 0 && (
          <div className="px-4 py-2.5 border-t">
            <Legend items={employees.map((e, i) => ({ color: colorFor(i), label: e.employeeName }))} />
          </div>
        )}
      </Card>
    </div>
  );
}

// ── Pending Approvals tab ────────────────────────────────────────────────

function PhotoDialog({ requestId, onClose }: { requestId: number | null; onClose: () => void }) {
  const { token } = useAuth();
  const [urls, setUrls] = useState<[string | null, string | null]>([null, null]);
  const [loading, setLoading] = useState(false);

  useMemo(() => {
    if (requestId == null) {
      setUrls([null, null]);
      return;
    }
    setLoading(true);
    Promise.all([
      fetchAuthedImageObjectUrl(`/api/on-duty-requests/${requestId}/photo/1`, () => token),
      fetchAuthedImageObjectUrl(`/api/on-duty-requests/${requestId}/photo/2`, () => token),
    ])
      .then(([a, b]) => setUrls([a, b]))
      .catch(() => setUrls([null, null]))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId]);

  return (
    <Dialog open={requestId != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><ImageIcon size={16} /> Verification Photos</DialogTitle>
        </DialogHeader>
        {loading ? (
          <div className="grid grid-cols-2 gap-3">
            <Skeleton className="h-56 rounded-lg" />
            <Skeleton className="h-56 rounded-lg" />
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {urls.map((u, i) =>
              u ? (
                <img key={i} src={u} className="w-full h-56 object-cover rounded-lg border" alt={`Verification ${i + 1}`} />
              ) : (
                <div key={i} className="h-56 rounded-lg border bg-gray-50 flex items-center justify-center text-xs text-gray-400">
                  Failed to load
                </div>
              ),
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ApprovalsTab() {
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<"pending" | "approved" | "rejected">("pending");
  const { data: requests, isLoading } = useOnDutyRequestsHR(statusFilter);
  const updateMutation = useUpdateOnDutyRequestHR();
  const [photoRequestId, setPhotoRequestId] = useState<number | null>(null);

  const handleDecision = async (req: OnDutyRequestItem, status: "approved" | "rejected") => {
    try {
      await updateMutation.mutateAsync({ id: req.id, status });
      toast({ title: `Request ${status}`, description: `${req.employeeName}'s ${req.punchType === "IN" ? "Check-In" : "Check-Out"} On-Duty request.` });
    } catch (err: any) {
      toast({ title: "Failed to update request", description: err?.message, variant: "destructive" });
    }
  };

  return (
    <div className="space-y-3">
      <PillTabs
        items={[
          { value: "pending", label: "Pending" },
          { value: "approved", label: "Approved" },
          { value: "rejected", label: "Rejected" },
        ]}
        value={statusFilter}
        onChange={(v) => setStatusFilter(v as typeof statusFilter)}
        size="sm"
      />

      {isLoading ? (
        <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}</div>
      ) : (requests ?? []).length === 0 ? (
        <Card className="border-0 shadow-sm">
          <CardContent className="py-14 text-center">
            <MapPinned size={32} className="text-gray-200 mx-auto mb-3" />
            <p className="text-sm text-gray-500">No {statusFilter} On-Duty requests.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {(requests ?? []).map((req) => (
            <Card key={req.id} className="border-0 shadow-sm">
              <CardContent className="p-4 flex items-start gap-4 flex-wrap">
                <div className="flex-1 min-w-[240px]">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-bold text-gray-900">{req.employeeName}</p>
                    <span className="text-[11px] font-mono text-gray-400">({req.employeeCode})</span>
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${req.punchType === "IN" ? "bg-green-50 text-green-700" : "bg-orange-50 text-orange-700"}`}>
                      {req.punchType === "IN" ? "CHECK-IN" : "CHECK-OUT"}
                    </span>
                    <span className={`flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded ${
                      req.status === "approved" ? "bg-green-50 text-green-700"
                      : req.status === "rejected" ? "bg-red-50 text-red-600"
                      : req.status === "pending_hr" ? "bg-blue-50 text-blue-700"
                      : "bg-amber-50 text-amber-700"
                    }`}>
                      {req.status === "pending_hod" ? <ShieldAlert size={10} /> : req.status === "pending_hr" ? <ShieldCheck size={10} /> : null}
                      {STAGE_LABEL[req.status]}
                    </span>
                    {req.isMocked && (
                      <span className="flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded bg-red-50 text-red-600">
                        <AlertTriangle size={10} /> Simulated location
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-1">{req.department ?? "—"} · {req.branchName ?? "no branch"}</p>
                  <p className="text-xs text-gray-700 mt-1.5 italic">"{req.reason}"</p>
                  <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
                    <span className="flex items-center gap-1"><Clock size={11} /> {req.punchTime.slice(0, 5)} on {req.punchDate}</span>
                  </div>
                  {req.hodReviewedBy && (
                    <p className="text-[11px] text-gray-400 mt-1.5">
                      HOD: {req.status === "rejected" && !req.hrReviewedBy ? "rejected" : "approved"} by {req.hodReviewedBy}
                      {req.hodReviewComment ? ` — "${req.hodReviewComment}"` : ""}
                    </p>
                  )}
                  {req.hrReviewedBy && (
                    <p className="text-[11px] text-gray-400">
                      HR: {req.status === "rejected" ? "rejected" : "approved"} by {req.hrReviewedBy}
                      {req.hrReviewComment ? ` — "${req.hrReviewComment}"` : ""}
                    </p>
                  )}
                  {req.status === "pending_hod" && (
                    <p className="text-[11px] text-amber-600 mt-1">No Department Head has acted yet — approving here finalizes it directly.</p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button size="sm" variant="outline" className="gap-1.5 h-8 text-xs" onClick={() => setPhotoRequestId(req.id)}>
                    <ImageIcon size={12} /> View Photos
                  </Button>
                  {(req.status === "pending_hod" || req.status === "pending_hr") && (
                    <>
                      <Button
                        size="sm" className="h-8 gap-1.5 text-xs bg-green-600 hover:bg-green-700"
                        disabled={updateMutation.isPending}
                        onClick={() => handleDecision(req, "approved")}
                      >
                        <CheckCircle2 size={12} /> Approve
                      </Button>
                      <Button
                        size="sm" variant="destructive" className="h-8 gap-1.5 text-xs"
                        disabled={updateMutation.isPending}
                        onClick={() => handleDecision(req, "rejected")}
                      >
                        <XCircle size={12} /> Reject
                      </Button>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <PhotoDialog requestId={photoRequestId} onClose={() => setPhotoRequestId(null)} />
    </div>
  );
}

// ── Tracking Settings tab ────────────────────────────────────────────────

function TrackingSettingsTab() {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const { data: employees, isLoading } = useListEmployees({ status: "active" });
  const toggleMutation = useUpdateEmployeeLocationTracking();

  const filtered = (employees ?? []).filter((e) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return e.employeeCode.toLowerCase().includes(q) || `${e.firstName} ${e.lastName}`.toLowerCase().includes(q);
  });

  const handleToggle = async (emp: Employee, next: boolean) => {
    try {
      await toggleMutation.mutateAsync({ employeeId: emp.id, enabled: next });
      toast({ title: next ? "Live tracking enabled" : "Live tracking disabled", description: `${emp.firstName} ${emp.lastName}` });
    } catch {
      toast({ title: "Failed to update tracking", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-3">
      <div className="relative max-w-sm">
        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
        <Input className="pl-8 h-9 text-sm" placeholder="Search employees…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <Card className="border-0 shadow-sm">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10 rounded" />)}</div>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-center text-gray-400 py-10">No employees match.</p>
          ) : (
            <div className="max-h-[560px] overflow-y-auto divide-y">
              {filtered.map((emp) => {
                const enabled = (emp as Employee & { locationTrackingEnabled?: boolean }).locationTrackingEnabled ?? false;
                return (
                  <div key={emp.id} className="flex items-center gap-3 px-4 py-2.5">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold truncate">{emp.firstName} {emp.lastName}</p>
                      <p className="text-[11px] text-gray-400 font-mono">
                        {emp.employeeCode} · {emp.departmentName ?? "—"} · {emp.branchName ?? "no branch"}
                      </p>
                    </div>
                    <button
                      onClick={() => handleToggle(emp, !enabled)}
                      disabled={toggleMutation.isPending}
                      className={`relative w-10 h-5.5 h-6 rounded-full transition-colors shrink-0 ${enabled ? "bg-teal-600" : "bg-gray-200"}`}
                      aria-label="Toggle live location tracking"
                    >
                      <span
                        className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${enabled ? "translate-x-[18px]" : "translate-x-0.5"}`}
                      />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function GeoAttendance() {
  const [tab, setTab] = useState<"approvals" | "map" | "route" | "onduty" | "tracking">("approvals");
  const { data: pending } = useOnDutyRequestsHR("pending");

  return (
    <HrLayout>
      <div className="space-y-5">
        <div>
          <h2 className="text-2xl font-black text-gray-900">Geo Attendance</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Office Geo Punch, On-Duty approvals, live tracking, and travel routes for employees working on and off premises.
          </p>
        </div>

        <PillTabs
          items={[
            { value: "approvals", label: `On-Duty Approvals${pending?.length ? ` (${pending.length})` : ""}`, icon: <MapPinned size={13} /> },
            { value: "map", label: "Live Map", icon: <Radar size={13} /> },
            { value: "route", label: "Route Map", icon: <RouteIcon size={13} /> },
            { value: "onduty", label: "On-Duty Map", icon: <Users size={13} /> },
            { value: "tracking", label: "Tracking Settings", icon: <Navigation size={13} /> },
          ]}
          value={tab}
          onChange={(v) => setTab(v as typeof tab)}
        />

        {tab === "approvals" && <ApprovalsTab />}
        {tab === "map" && <LiveMapTab />}
        {tab === "route" && <RouteMapTab />}
        {tab === "onduty" && <OnDutyMapTab />}
        {tab === "tracking" && <TrackingSettingsTab />}
      </div>
    </HrLayout>
  );
}
