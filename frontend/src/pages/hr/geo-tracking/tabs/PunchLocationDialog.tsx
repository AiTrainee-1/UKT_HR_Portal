// Punch Verifications -> "View on map": where a punch was taken and how the employee got there. Reviewing a punch needs more than
// the raw latitude / longitude printed on the card: the punch pin (red when the device reported a mocked / spoofed fix), its GPS
// accuracy radius, and that day's recorded route with direction arrows (the same route source and arrow helper as the On-Duty
// Map's single-employee view, so the two always draw the same path). Links out to Google Maps for the satellite view or
// turn-by-turn directions, which Leaflet's tiles alone cannot give.
import { useMemo } from "react";
import { Circle, MapContainer, Marker, Polyline, Popup } from "react-leaflet";
import { AlertTriangle, Clock, MapPinned, Navigation, Target } from "lucide-react";
import { BaseMapLayers } from "@/components/geo/BaseMapLayers";
import { Chip } from "@/components/payroll/kit/parts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLiveLocationRoute, type OnDutyPunchVerificationItem } from "@/lib/api-client/custom-hooks";
import { COLOR_MOCKED, COLOR_NORMAL, COLOR_ON_DUTY, COLOR_START, arrowIcon, arrowSamples, pinIcon } from "../pins";

export default function PunchLocationDialog({
  verification,
  onClose,
}: {
  verification: OnDutyPunchVerificationItem | null;
  onClose: () => void;
}) {
  const { data: route, isLoading: routeLoading } = useLiveLocationRoute(
    verification?.employeeId ?? null,
    verification?.punchDate ?? "",
  );

  const points = useMemo(
    () => (route?.points ?? []).map((p) => [p.latitude, p.longitude] as [number, number]),
    [route],
  );
  const arrows = useMemo(() => arrowSamples(points), [points]);

  // Unmount entirely when closed rather than toggling `open`: a Leaflet map built inside a hidden container renders at zero
  // size and stays blank.
  if (!verification) return null;

  const pos: [number, number] = [verification.latitude, verification.longitude];
  const query = `${verification.latitude},${verification.longitude}`;
  const punchColor = verification.isMocked ? COLOR_MOCKED : COLOR_ON_DUTY;
  const kind = verification.punchType === "IN" ? "Check-In" : "Check-Out";

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl gap-3 p-4 sm:p-6">
        <DialogHeader className="space-y-1 text-left">
          <DialogTitle className="flex items-center gap-2 text-base">
            <MapPinned size={16} className="text-[#006496]" /> Punch #{verification.punchNumber} · {kind} location
          </DialogTitle>
          <DialogDescription className="text-xs">
            Where the punch was taken, and the route the employee recorded that day.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-gray-600">
          <span className="text-sm font-bold text-gray-900">{verification.employeeName}</span>
          <span className="flex items-center gap-1">
            <Clock size={12} /> {verification.punchTime.slice(0, 5)} on {verification.punchDate}
          </span>
          <span className="font-mono text-[11px] text-gray-500">{query}</span>
          {verification.accuracyM != null && (
            <span className="flex items-center gap-1">
              <Target size={12} /> ±{Math.round(verification.accuracyM)} m accuracy
            </span>
          )}
          {verification.isMocked && (
            <Chip tone="danger" icon={AlertTriangle}>
              Simulated location
            </Chip>
          )}
        </div>

        <div className="h-72 overflow-hidden rounded-xl border sm:h-80">
          <MapContainer center={pos} zoom={16} className="h-full w-full" scrollWheelZoom>
            <BaseMapLayers />

            {/* That day's travel path, drawn behind the punch pin */}
            {points.length > 1 && (
              <>
                <Polyline positions={points} pathOptions={{ color: COLOR_NORMAL, weight: 3, opacity: 0.7 }} />
                {arrows.map((a, i) => (
                  <Marker key={i} position={a.pos} icon={arrowIcon(COLOR_NORMAL, a.rot)} />
                ))}
                <Marker position={points[0]} icon={pinIcon(COLOR_START, "flag", 24)}>
                  <Popup>Route start</Popup>
                </Marker>
              </>
            )}

            {/* GPS accuracy radius: how much slack the fix actually had */}
            {verification.accuracyM != null && verification.accuracyM > 0 && (
              <Circle
                center={pos}
                radius={verification.accuracyM}
                pathOptions={{ color: punchColor, fillColor: punchColor, fillOpacity: 0.12, weight: 1 }}
              />
            )}

            <Marker position={pos} icon={pinIcon(punchColor, "person", 34)}>
              <Popup>
                {kind} #{verification.punchNumber}
                <br />
                {verification.punchTime.slice(0, 5)} on {verification.punchDate}
              </Popup>
            </Marker>
          </MapContainer>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <p className="text-[11px] text-gray-500">
            {routeLoading
              ? "Loading route…"
              : points.length > 1
                ? `Route shown from ${points.length} recorded points on ${verification.punchDate}.`
                : "No route recorded for this day - showing the punch location only."}
          </p>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" asChild>
              <a
                href={`https://www.google.com/maps/search/?api=1&query=${query}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <MapPinned size={12} /> Open in Google Maps
              </a>
            </Button>
            <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" asChild>
              <a
                href={`https://www.google.com/maps/dir/?api=1&destination=${query}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Navigation size={12} /> Directions
              </a>
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
