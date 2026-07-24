import { useMemo, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup, Polyline, Circle } from "react-leaflet";
import L from "leaflet";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { PillTabs } from "@/components/ui/pill-tabs";
import {
  Pagination, PaginationContent, PaginationItem, PaginationLink,
  PaginationNext, PaginationPrevious,
} from "@/components/ui/pagination";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { useListEmployees, useListBranches, type Employee } from "@/lib/api-client";
import {
  useOnDutySessionsHR, useUpdateOnDutySessionHR,
  useOnDutyPunchVerificationsHR, useUpdateOnDutyPunchVerificationHR,
  useLiveLocationTeam, useLiveLocationTrail, useLiveLocationRoute, useOnDutyMap,
  useUpdateEmployeeLocationTracking,
  fetchAuthedImageObjectUrl, type OnDutySessionItem, type OnDutyPunchVerificationItem, type LiveLocationTeamMember,
} from "@/lib/api-client/custom-hooks";
import {
  MapPinned, CheckCircle2, XCircle, Navigation, Search, Radar, Clock, AlertTriangle,
  Image as ImageIcon, Building2, User, Route as RouteIcon, Users, ShieldCheck, ShieldAlert, Camera,
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

const STAGE_LABEL: Record<OnDutySessionItem["status"], string> = {
  pending_hod: "Awaiting Department Head",
  pending_hr: "Awaiting HR",
  active: "Active",
  completed: "Completed",
  rejected: "Rejected",
};

const PUNCH_STATUS_LABEL: Record<OnDutyPunchVerificationItem["status"], string> = {
  pending: "Awaiting HR",
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

// ── On-Duty Map tab ───────────────────────────────────────────────────────
// Two views sharing one date-scoped map: "All On-Duty" is the live overview
// of everyone On-Duty on the selected day (colored per employee), "Single
// Employee" is a detailed directional route lookup for one tracked employee
// on that day — the two used to be separate tabs (Route Map / On-Duty Map)
// but overlapped enough (both draw routes on a map) that HR asked for them
// combined into one, with nothing lost.

function OnDutyMapTab() {
  const [viewMode, setViewMode] = useState<"all" | "single">("all");
  const [date, setDate] = useState(todayStr());
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const { data: mapData, isLoading: mapLoading } = useOnDutyMap(date);
  const employees = mapData?.employees ?? [];
  const withFix = employees.filter((e) => e.latitude != null && e.longitude != null);
  const centerAll: [number, number] = withFix.length > 0 ? [withFix[0].latitude!, withFix[0].longitude!] : INDIA_CENTER;

  const { data: trackedList, isLoading: employeesLoading } = useListEmployees({ status: "active" });
  const trackedEmployees = (trackedList ?? []).filter(
    (e) => (e as Employee & { locationTrackingEnabled?: boolean }).locationTrackingEnabled,
  );
  const filteredTracked = trackedEmployees.filter((e) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return e.employeeCode.toLowerCase().includes(q) || `${e.firstName} ${e.lastName}`.toLowerCase().includes(q);
  });

  const { data: route, isLoading: routeLoading } = useLiveLocationRoute(viewMode === "single" ? selectedId : null, date);
  const points = (route?.points ?? []).map((p) => [p.latitude, p.longitude] as [number, number]);
  const centerSingle = points.length > 0 ? points[Math.floor(points.length / 2)] : INDIA_CENTER;

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
    <div className="grid lg:grid-cols-[300px_1fr] gap-4 items-start">
      <Card className="border-0 shadow-sm">
        <CardContent className="p-3 space-y-2.5">
          <div>
            <p className="text-xs font-bold text-gray-600 px-1 mb-1.5 flex items-center gap-1.5">
              <Users size={13} className="text-teal-700" /> On-Duty Map
            </p>
            <Input type="date" className="h-9 text-sm" value={date} max={todayStr()} onChange={(e) => setDate(e.target.value)} />
          </div>

          <PillTabs
            items={[
              { value: "all", label: `All On-Duty${employees.length ? ` (${employees.length})` : ""}`, icon: <Users size={12} /> },
              { value: "single", label: "Single Employee", icon: <RouteIcon size={12} /> },
            ]}
            value={viewMode}
            onChange={(v) => { setViewMode(v as typeof viewMode); setSelectedId(null); }}
            size="sm"
          />

          {viewMode === "all" ? (
            mapLoading ? (
              <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-14 rounded-lg" />)}</div>
            ) : employees.length === 0 ? (
              <p className="text-xs text-center text-gray-400 py-8">No employees were On-Duty on {date}.</p>
            ) : (
              <div className="max-h-[360px] overflow-y-auto space-y-1.5">
                {employees.map((e, i) => (
                  <div key={e.employeeId} className="px-2.5 py-2 rounded-lg border border-transparent hover:bg-gray-50">
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: colorFor(i) }} />
                      <p className="text-xs font-semibold truncate flex-1">{e.employeeName}</p>
                    </div>
                    <p className="text-[10px] text-gray-400 mt-0.5 ml-4.5">
                      {e.department ?? "—"} · {e.locationTrackingEnabled ? timeAgo(e.lastSeenAt) : "tracking off"}
                    </p>
                    <p className="text-[10px] text-gray-500 mt-1 ml-4.5 italic truncate">
                      {e.session.destination} · <span className="not-italic font-bold">{STAGE_LABEL[e.session.status as OnDutySessionItem["status"]] ?? e.session.status}</span>
                    </p>
                    <div className="flex flex-wrap gap-1 mt-1 ml-4.5">
                      {e.punches.map((p) => (
                        <span
                          key={p.punchNumber}
                          className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                            p.status === "approved" ? "bg-green-50 text-green-700"
                            : p.status === "rejected" ? "bg-red-50 text-red-600"
                            : "bg-amber-50 text-amber-700"
                          }`}
                        >
                          #{p.punchNumber} {p.punchType} {p.punchTime.slice(0, 5)} · {PUNCH_STATUS_LABEL[p.status as OnDutyPunchVerificationItem["status"]] ?? p.status}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : (
            <>
              <div className="relative">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                <Input className="pl-8 h-9 text-sm" placeholder="Search tracked staff…" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
              {employeesLoading ? (
                <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 rounded-lg" />)}</div>
              ) : filteredTracked.length === 0 ? (
                <p className="text-xs text-center text-gray-400 py-8">
                  No tracking-enabled employees match. This view only shows staff with Live Tracking turned on (mainly On-Duty employees).
                </p>
              ) : (
                <div className="max-h-[320px] overflow-y-auto space-y-1">
                  {filteredTracked.map((e) => (
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
            </>
          )}

          <div className="pt-2 mt-1 border-t">
            {viewMode === "all" ? (
              employees.length > 0 && <Legend items={employees.map((e, i) => ({ color: colorFor(i), label: e.employeeName }))} />
            ) : (
              <Legend
                items={[
                  { color: COLOR_START, label: "Route start" },
                  { color: COLOR_END, label: "Latest position" },
                ]}
              />
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="border-0 shadow-sm overflow-hidden">
        <div className="h-[560px] relative">
          {viewMode === "all" ? (
            mapLoading ? (
              <Skeleton className="h-full w-full" />
            ) : withFix.length === 0 ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-400">
                <Users size={32} className="mb-2 text-gray-200" />
                <p className="text-sm">No live positions to show for On-Duty staff on {date}.</p>
              </div>
            ) : (
              <MapContainer center={centerAll} zoom={11} style={{ height: "100%", width: "100%" }}>
                <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap contributors" />
                {employees.map((e, i) => {
                  const color = colorFor(i);
                  const empRoute = e.routePoints.map((p) => [p.latitude, p.longitude] as [number, number]);
                  return (
                    <div key={e.employeeId}>
                      {empRoute.length > 1 && <Polyline positions={empRoute} pathOptions={{ color, weight: 3, opacity: 0.65 }} />}
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
            )
          ) : !selectedId ? (
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
            <MapContainer center={centerSingle} zoom={13} style={{ height: "100%", width: "100%" }}>
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

// ── On-Duty Approvals tab (session destination gate — no photos) ─────────

function ApprovalsTab() {
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<"pending" | "active" | "completed" | "rejected">("pending");
  const { data: sessions, isLoading } = useOnDutySessionsHR(statusFilter);
  const updateMutation = useUpdateOnDutySessionHR();

  const handleDecision = async (session: OnDutySessionItem, status: "approved" | "rejected") => {
    try {
      await updateMutation.mutateAsync({ id: session.id, status });
      toast({ title: `Session ${status}`, description: `${session.employeeName}'s On-Duty request for ${session.destination}.` });
    } catch (err: any) {
      toast({ title: "Failed to update session", description: err?.message, variant: "destructive" });
    }
  };

  return (
    <div className="space-y-3">
      <PillTabs
        items={[
          { value: "pending", label: "Pending" },
          { value: "active", label: "Active" },
          { value: "completed", label: "Completed" },
          { value: "rejected", label: "Rejected" },
        ]}
        value={statusFilter}
        onChange={(v) => setStatusFilter(v as typeof statusFilter)}
        size="sm"
      />

      {isLoading ? (
        <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}</div>
      ) : (sessions ?? []).length === 0 ? (
        <Card className="border-0 shadow-sm">
          <CardContent className="py-14 text-center">
            <MapPinned size={32} className="text-gray-200 mx-auto mb-3" />
            <p className="text-sm text-gray-500">No {statusFilter} On-Duty sessions.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {(sessions ?? []).map((session) => (
            <Card key={session.id} className="border-0 shadow-sm">
              <CardContent className="p-4 flex items-start gap-4 flex-wrap">
                <div className="flex-1 min-w-[240px]">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-bold text-gray-900">{session.employeeName}</p>
                    <span className="text-[11px] font-mono text-gray-400">({session.employeeCode})</span>
                    <span className={`flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded ${
                      session.status === "active" ? "bg-teal-50 text-teal-700"
                      : session.status === "completed" ? "bg-green-50 text-green-700"
                      : session.status === "rejected" ? "bg-red-50 text-red-600"
                      : session.status === "pending_hr" ? "bg-blue-50 text-blue-700"
                      : "bg-amber-50 text-amber-700"
                    }`}>
                      {session.status === "pending_hod" ? <ShieldAlert size={10} /> : session.status === "pending_hr" ? <ShieldCheck size={10} /> : null}
                      {STAGE_LABEL[session.status]}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">{session.department ?? "—"} · {session.branchName ?? "no branch"}</p>
                  <p className="text-xs text-gray-700 mt-1.5 italic">Destination: "{session.destination}"</p>
                  {session.hodReviewedBy && (
                    <p className="text-[11px] text-gray-400 mt-1.5">
                      HOD: {session.status === "rejected" && !session.hrReviewedBy ? "rejected" : "approved"} by {session.hodReviewedBy}
                      {session.hodReviewComment ? ` — "${session.hodReviewComment}"` : ""}
                    </p>
                  )}
                  {session.hrReviewedBy && (
                    <p className="text-[11px] text-gray-400">
                      HR: {session.status === "rejected" ? "rejected" : "approved"} by {session.hrReviewedBy}
                      {session.hrReviewComment ? ` — "${session.hrReviewComment}"` : ""}
                    </p>
                  )}
                  {session.status === "completed" && (
                    <p className="text-[11px] text-gray-400 mt-1">
                      Ended {session.completionReason === "auto_4th_punch" ? "automatically (4th punch approved)" : "manually by the employee"}
                      {session.completedAt ? ` at ${new Date(session.completedAt).toLocaleString()}` : ""}
                    </p>
                  )}
                  {session.status === "pending_hod" && (
                    <p className="text-[11px] text-amber-600 mt-1">No Department Head has acted yet — approving here finalizes it directly.</p>
                  )}
                </div>
                {(session.status === "pending_hod" || session.status === "pending_hr") && (
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      size="sm" className="h-8 gap-1.5 text-xs bg-green-600 hover:bg-green-700"
                      disabled={updateMutation.isPending}
                      onClick={() => handleDecision(session, "approved")}
                    >
                      <CheckCircle2 size={12} /> Approve
                    </Button>
                    <Button
                      size="sm" variant="destructive" className="h-8 gap-1.5 text-xs"
                      disabled={updateMutation.isPending}
                      onClick={() => handleDecision(session, "rejected")}
                    >
                      <XCircle size={12} /> Reject
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Punch Verifications tab (per-punch selfie + GPS, HR-only) ────────────

function PhotoDialog({ verificationId, onClose }: { verificationId: number | null; onClose: () => void }) {
  const { token } = useAuth();
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useMemo(() => {
    if (verificationId == null) {
      setUrl(null);
      return;
    }
    setLoading(true);
    fetchAuthedImageObjectUrl(`/api/on-duty-punch-verifications/${verificationId}/photo`, () => token)
      .then(setUrl)
      .catch(() => setUrl(null))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verificationId]);

  return (
    <Dialog open={verificationId != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Camera size={16} /> Punch Verification Photo</DialogTitle>
        </DialogHeader>
        {loading ? (
          <Skeleton className="h-72 rounded-lg" />
        ) : url ? (
          <img src={url} className="w-full h-72 object-cover rounded-lg border" alt="Punch verification selfie" />
        ) : (
          <div className="h-72 rounded-lg border bg-gray-50 flex items-center justify-center text-xs text-gray-400">
            Failed to load
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PunchVerificationsTab() {
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<"pending" | "approved" | "rejected">("pending");
  const { data: verifications, isLoading } = useOnDutyPunchVerificationsHR(statusFilter);
  const updateMutation = useUpdateOnDutyPunchVerificationHR();
  const [photoId, setPhotoId] = useState<number | null>(null);

  const handleDecision = async (v: OnDutyPunchVerificationItem, status: "approved" | "rejected") => {
    try {
      await updateMutation.mutateAsync({ id: v.id, status });
      toast({ title: `Punch ${status}`, description: `${v.employeeName}'s punch #${v.punchNumber} (${v.punchType === "IN" ? "Check-In" : "Check-Out"}).` });
    } catch (err: any) {
      toast({ title: "Failed to update punch", description: err?.message, variant: "destructive" });
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
      ) : (verifications ?? []).length === 0 ? (
        <Card className="border-0 shadow-sm">
          <CardContent className="py-14 text-center">
            <Camera size={32} className="text-gray-200 mx-auto mb-3" />
            <p className="text-sm text-gray-500">No {statusFilter} punch verifications.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {(verifications ?? []).map((v) => (
            <Card key={v.id} className="border-0 shadow-sm">
              <CardContent className="p-4 flex items-start gap-4 flex-wrap">
                <div className="flex-1 min-w-[240px]">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-bold text-gray-900">{v.employeeName}</p>
                    <span className="text-[11px] font-mono text-gray-400">({v.employeeCode})</span>
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${v.punchType === "IN" ? "bg-green-50 text-green-700" : "bg-orange-50 text-orange-700"}`}>
                      #{v.punchNumber} {v.punchType === "IN" ? "CHECK-IN" : "CHECK-OUT"}
                    </span>
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                      v.status === "approved" ? "bg-green-50 text-green-700"
                      : v.status === "rejected" ? "bg-red-50 text-red-600"
                      : "bg-amber-50 text-amber-700"
                    }`}>
                      {PUNCH_STATUS_LABEL[v.status]}
                    </span>
                    {v.isMocked && (
                      <span className="flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded bg-red-50 text-red-600">
                        <AlertTriangle size={10} /> Simulated location
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-1">{v.department ?? "—"}</p>
                  <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
                    <span className="flex items-center gap-1"><Clock size={11} /> {v.punchTime.slice(0, 5)} on {v.punchDate}</span>
                    <span className="flex items-center gap-1"><MapPinned size={11} /> {v.latitude.toFixed(5)}, {v.longitude.toFixed(5)}</span>
                  </div>
                  {v.hrReviewedBy && (
                    <p className="text-[11px] text-gray-400 mt-1.5">
                      {v.status === "rejected" ? "Rejected" : "Approved"} by {v.hrReviewedBy}
                      {v.hrReviewComment ? ` — "${v.hrReviewComment}"` : ""}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button size="sm" variant="outline" className="gap-1.5 h-8 text-xs" onClick={() => setPhotoId(v.id)}>
                    <ImageIcon size={12} /> View Photo
                  </Button>
                  {v.status === "pending" && (
                    <>
                      <Button
                        size="sm" className="h-8 gap-1.5 text-xs bg-green-600 hover:bg-green-700"
                        disabled={updateMutation.isPending}
                        onClick={() => handleDecision(v, "approved")}
                      >
                        <CheckCircle2 size={12} /> Approve
                      </Button>
                      <Button
                        size="sm" variant="destructive" className="h-8 gap-1.5 text-xs"
                        disabled={updateMutation.isPending}
                        onClick={() => handleDecision(v, "rejected")}
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

      <PhotoDialog verificationId={photoId} onClose={() => setPhotoId(null)} />
    </div>
  );
}

// ── Tracking Settings tab ────────────────────────────────────────────────

const TRACKING_PAGE_SIZE = 10;

function TrackingSettingsTab() {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "enabled" | "disabled">("all");
  const [page, setPage] = useState(1);
  const { data: employees, isLoading } = useListEmployees({ status: "active" });
  const toggleMutation = useUpdateEmployeeLocationTracking();

  const withEnabled = (employees ?? []).map((e) => ({
    ...e,
    trackingEnabled: (e as Employee & { locationTrackingEnabled?: boolean }).locationTrackingEnabled ?? false,
  }));
  const enabledCount = withEnabled.filter((e) => e.trackingEnabled).length;
  const disabledCount = withEnabled.length - enabledCount;

  const searched = withEnabled.filter((e) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return e.employeeCode.toLowerCase().includes(q) || `${e.firstName} ${e.lastName}`.toLowerCase().includes(q);
  });
  const filtered = searched.filter((e) =>
    filter === "all" ? true : filter === "enabled" ? e.trackingEnabled : !e.trackingEnabled
  );
  const totalPages = Math.max(1, Math.ceil(filtered.length / TRACKING_PAGE_SIZE));
  const pageSafe = Math.min(page, totalPages);
  const paged = filtered.slice((pageSafe - 1) * TRACKING_PAGE_SIZE, pageSafe * TRACKING_PAGE_SIZE);

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
      <div className="grid grid-cols-3 gap-3">
        <Card className="border-0 shadow-sm">
          <CardContent className="p-3.5 flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center shrink-0"><Users size={15} className="text-gray-500" /></div>
            <div className="min-w-0">
              <p className="text-lg font-black text-gray-900 leading-none">{withEnabled.length}</p>
              <p className="text-[10px] text-gray-400 font-semibold uppercase tracking-wide mt-1">Total Employees</p>
            </div>
          </CardContent>
        </Card>
        <Card className="border-0 shadow-sm">
          <CardContent className="p-3.5 flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-teal-50 flex items-center justify-center shrink-0"><Radar size={15} className="text-teal-600" /></div>
            <div className="min-w-0">
              <p className="text-lg font-black text-teal-700 leading-none">{enabledCount}</p>
              <p className="text-[10px] text-gray-400 font-semibold uppercase tracking-wide mt-1">Tracking Enabled</p>
            </div>
          </CardContent>
        </Card>
        <Card className="border-0 shadow-sm">
          <CardContent className="p-3.5 flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center shrink-0"><Radar size={15} className="text-gray-400" /></div>
            <div className="min-w-0">
              <p className="text-lg font-black text-gray-500 leading-none">{disabledCount}</p>
              <p className="text-[10px] text-gray-400 font-semibold uppercase tracking-wide mt-1">Tracking Disabled</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative max-w-sm w-full">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <Input
            className="pl-8 h-9 text-sm"
            placeholder="Search employees…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          />
        </div>
        <PillTabs
          items={[
            { value: "all", label: `All (${withEnabled.length})` },
            { value: "enabled", label: `Enabled (${enabledCount})` },
            { value: "disabled", label: `Disabled (${disabledCount})` },
          ]}
          value={filter}
          onChange={(v) => { setFilter(v as typeof filter); setPage(1); }}
        />
      </div>

      <Card className="border-0 shadow-sm">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10 rounded" />)}</div>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-center text-gray-400 py-10">No employees match.</p>
          ) : (
            <>
              <div className="divide-y">
                {paged.map((emp) => (
                  <div key={emp.id} className="flex items-center gap-3 px-4 py-2.5">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold truncate">{emp.firstName} {emp.lastName}</p>
                      <p className="text-[11px] text-gray-400 font-mono">
                        {emp.employeeCode} · {emp.departmentName ?? "—"} · {emp.branchName ?? "no branch"}
                      </p>
                    </div>
                    <Switch
                      checked={emp.trackingEnabled}
                      onCheckedChange={(v) => handleToggle(emp, v)}
                      disabled={toggleMutation.isPending}
                      aria-label="Toggle live location tracking"
                    />
                  </div>
                ))}
              </div>
              {totalPages > 1 && (
                <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between border-t border-gray-50">
                  <p className="text-xs text-gray-400">
                    Showing {(pageSafe - 1) * TRACKING_PAGE_SIZE + 1}–{Math.min(pageSafe * TRACKING_PAGE_SIZE, filtered.length)} of {filtered.length}
                  </p>
                  <Pagination className="mx-0 w-auto">
                    <PaginationContent>
                      <PaginationItem>
                        <PaginationPrevious
                          href="#"
                          className={pageSafe === 1 ? "pointer-events-none opacity-50" : undefined}
                          onClick={(e) => { e.preventDefault(); if (pageSafe > 1) setPage(pageSafe - 1); }}
                        />
                      </PaginationItem>
                      {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                        <PaginationItem key={p}>
                          <PaginationLink href="#" isActive={p === pageSafe} onClick={(e) => { e.preventDefault(); setPage(p); }}>
                            {p}
                          </PaginationLink>
                        </PaginationItem>
                      ))}
                      <PaginationItem>
                        <PaginationNext
                          href="#"
                          className={pageSafe === totalPages ? "pointer-events-none opacity-50" : undefined}
                          onClick={(e) => { e.preventDefault(); if (pageSafe < totalPages) setPage(pageSafe + 1); }}
                        />
                      </PaginationItem>
                    </PaginationContent>
                  </Pagination>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function GeoAttendance() {
  const [tab, setTab] = useState<"approvals" | "verifications" | "map" | "onduty" | "tracking">("approvals");
  const { data: pendingSessions } = useOnDutySessionsHR("pending");
  const { data: pendingPunches } = useOnDutyPunchVerificationsHR("pending");

  return (
    <HrLayout>
      <div className="space-y-5">
        <div>
          <h2 className="text-2xl font-black text-gray-900">Geo Attendance</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Office Geo Punch, On-Duty approvals, punch verification, live tracking, and travel routes for employees working on and off premises.
          </p>
        </div>

        <PillTabs
          items={[
            { value: "approvals", label: `On-Duty Approvals${pendingSessions?.length ? ` (${pendingSessions.length})` : ""}`, icon: <MapPinned size={13} /> },
            { value: "verifications", label: `Punch Verifications${pendingPunches?.length ? ` (${pendingPunches.length})` : ""}`, icon: <Camera size={13} /> },
            { value: "map", label: "Live Map", icon: <Radar size={13} /> },
            { value: "onduty", label: "On-Duty Map", icon: <Users size={13} /> },
            { value: "tracking", label: "Tracking Settings", icon: <Navigation size={13} /> },
          ]}
          value={tab}
          onChange={(v) => setTab(v as typeof tab)}
        />

        {tab === "approvals" && <ApprovalsTab />}
        {tab === "verifications" && <PunchVerificationsTab />}
        {tab === "map" && <LiveMapTab />}
        {tab === "onduty" && <OnDutyMapTab />}
        {tab === "tracking" && <TrackingSettingsTab />}
      </div>
    </HrLayout>
  );
}
