// On-Duty Map: the map itself. Each employee's day is drawn the way the Journey History map draws a journey (a route line under
// everything, numbered pins for the stops, a flag at the start, a person at the last position) in that employee's own colour, so
// several journeys can be read at once. The one in focus is drawn on top and the others fade; an employee HR hid is not drawn.
// Opens on the Tiruppur window; fits everybody once the day's data has arrived (and when the date changes), never again by itself:
// the board refreshes every 20 s and must not drag the map back while HR is looking at something.
import { Fragment, useEffect, useRef } from "react";
import type { Map as LeafletMap } from "leaflet";
import { MapContainer, Marker, Polyline, Popup, useMap } from "react-leaflet";
import { BaseMapLayers } from "@/components/geo/BaseMapLayers";
import { dutyEndIcon, dutyStopIcon } from "./dutyIcons";
import type { DutyEntry } from "./dutyMap";
import { fmtDateTime, fmtDistance, fmtDuration, fmtTime, timeRange, causeLabel, STATE_LABEL } from "./logic";
import { MapBridge, viewPlaces } from "./mapKit";
import { PlaceLinks } from "./PlaceLinks";
import { TIRUPPUR_CENTER, TIRUPPUR_ZOOM, farFromTiruppurText, type LatLng } from "./tiruppur";

/** Fades an employee that is not in focus. */
const DIM_LINE = 0.18;

/** Moves the map: to everybody when the day's data first arrives, to an employee when one is picked. Lives inside the MapContainer. */
function MapController({
  fitPoints,
  fitSignal,
  focusPoints,
  focusSignal,
}: {
  fitPoints: LatLng[];
  fitSignal: string;
  focusPoints: LatLng[];
  focusSignal: string;
}) {
  const map = useMap();
  const latestFit = useRef(fitPoints);
  latestFit.current = fitPoints;
  const latestFocus = useRef(focusPoints);
  latestFocus.current = focusPoints;

  useEffect(() => {
    if (fitSignal) viewPlaces(map, latestFit.current);
  }, [map, fitSignal]);

  useEffect(() => {
    if (focusSignal && latestFocus.current.length > 0) viewPlaces(map, latestFocus.current);
  }, [map, focusSignal]);

  return null;
}

export default function OnDutyMapView({
  entries,
  colors,
  hidden,
  focusId,
  hoverId,
  fitPoints,
  fitSignal,
  focusPoints,
  focusSignal,
  onPick,
  onMap,
}: {
  entries: DutyEntry[];
  /** employee id -> colour */
  colors: ReadonlyMap<number, string>;
  hidden: ReadonlySet<number>;
  focusId: number | null;
  hoverId: number | null;
  fitPoints: LatLng[];
  /** Changes when the map should fit everybody again; empty = not yet (nothing to fit). */
  fitSignal: string;
  focusPoints: LatLng[];
  /** Changes when the map should fit the employee in focus; empty = none. */
  focusSignal: string;
  onPick: (employeeId: number) => void;
  onMap: (map: LeafletMap | null) => void;
}) {
  // the employee in focus is drawn last (on top)
  const drawn = entries
    .filter((e) => !hidden.has(e.employeeId))
    .sort((a, b) => Number(a.employeeId === focusId) - Number(b.employeeId === focusId));

  return (
    <MapContainer
      center={TIRUPPUR_CENTER}
      zoom={TIRUPPUR_ZOOM}
      style={{ height: "100%", width: "100%" }}
      scrollWheelZoom
    >
      <BaseMapLayers />
      <MapBridge onMap={onMap} />
      <MapController fitPoints={fitPoints} fitSignal={fitSignal} focusPoints={focusPoints} focusSignal={focusSignal} />

      {drawn.map((e, order) => {
        const color = colors.get(e.employeeId) ?? "#475569";
        const dim = focusId !== null && focusId !== e.employeeId;
        const bold = hoverId === e.employeeId || focusId === e.employeeId;
        const base = 400 + order * 20;
        const pick = () => onPick(e.employeeId);
        return (
          <Fragment key={e.employeeId}>
            {/* the old position pings: a plain line, only for an employee without a journey */}
            {e.legacy.length > 1 && (
              <Polyline
                positions={e.legacy}
                pathOptions={{ color, weight: bold ? 5 : 3, opacity: dim ? DIM_LINE : 0.7 }}
                eventHandlers={{ click: pick }}
              />
            )}

            {/* a white casing under each leg keeps a route readable on the satellite view and where routes cross */}
            {e.legs.map((leg) => (
              <Polyline
                key={`${leg.key}-casing`}
                positions={leg.line}
                interactive={false}
                pathOptions={{ color: "#ffffff", weight: bold ? 9 : 7, opacity: dim ? 0.25 : 0.85 }}
              />
            ))}
            {e.legs.map((leg) => (
              <Polyline
                key={leg.key}
                positions={leg.line}
                pathOptions={{
                  color,
                  weight: bold ? 6 : 4,
                  opacity: dim ? DIM_LINE : 0.95,
                  dashArray: leg.estimated ? "6 8" : undefined,
                }}
                eventHandlers={{ click: pick }}
              >
                <Popup>
                  <div className="space-y-0.5 text-xs [&_p]:my-0" data-testid="duty-leg-popup">
                    <p className="text-sm font-bold">{e.employeeName}</p>
                    <p>
                      Travelled <b>{fmtDistance(leg.distanceM)}</b>
                      {leg.avgSpeedKmh > 0 ? `, ${Math.round(leg.avgSpeedKmh)} km/h on average` : ""}
                    </p>
                    <p className="text-gray-500">{timeRange(leg.startedAt, leg.endedAt)}</p>
                    {leg.estimated && <p className="text-gray-500">Drawn between two known positions.</p>}
                  </div>
                </Popup>
              </Polyline>
            ))}
            {e.gaps.map((g) => (
              <Polyline
                key={g.key}
                positions={g.line}
                pathOptions={{ color, weight: bold ? 4 : 3, opacity: dim ? DIM_LINE : 0.7, dashArray: "4 8" }}
                eventHandlers={{ click: pick }}
              >
                <Popup>
                  <div className="space-y-0.5 text-xs [&_p]:my-0">
                    <p className="text-sm font-bold">{e.employeeName}</p>
                    <p>
                      No location for <b>{fmtDuration(g.durationS)}</b>
                      {g.cause ? `: ${causeLabel(g.cause).toLowerCase()}` : ""}
                    </p>
                    <p className="text-gray-500">{timeRange(g.startedAt, g.endedAt)}</p>
                  </div>
                </Popup>
              </Polyline>
            ))}

            {e.pins.map((pin) => (
              <Marker
                key={pin.key}
                position={pin.pos}
                icon={dutyStopIcon(pin.label, color, { long: pin.long, dim })}
                title={`${e.employeeName}: ${pin.stops.length > 1 ? `stops ${pin.label}` : `stop ${pin.label}`}`}
                zIndexOffset={base + 100}
                eventHandlers={{ click: pick }}
              >
                <Popup>
                  <div
                    className="space-y-1 text-xs [&_p]:my-0"
                    data-testid="duty-stop-popup"
                    data-stops={pin.stops.length}
                  >
                    <p className="text-sm font-bold">
                      {e.employeeName}
                      <span className="font-semibold text-gray-500">
                        {" · "}
                        {pin.stops.length > 1 ? `Stops ${pin.label}: the same place` : `Stop ${pin.label}`}
                      </span>
                    </p>
                    {pin.stops.map((s) => (
                      <p key={s.key}>
                        {pin.stops.length > 1 && <b>Stop {s.number}: </b>}
                        {timeRange(s.startedAt, s.endedAt, s.open)}
                        {" · "}
                        <b>{fmtDuration(s.durationS)}</b>
                        {s.long ? " (long stop)" : ""}
                      </p>
                    ))}
                    {pin.stops[0].address && <p className="text-gray-600">{pin.stops[0].address}</p>}
                    <PlaceLinks lat={pin.pos[0]} lng={pin.pos[1]} className="pt-1" />
                  </div>
                </Popup>
              </Marker>
            ))}

            {e.start && (
              <Marker
                position={e.start}
                icon={dutyEndIcon(color, "flag", { dim })}
                title={`${e.employeeName}: start`}
                zIndexOffset={base + 200}
                eventHandlers={{ click: pick }}
              >
                <Popup>
                  <div className="space-y-0.5 text-xs [&_p]:my-0">
                    <p className="text-sm font-bold">{e.employeeName}</p>
                    <p>Start{e.journeys[0]?.startedAt ? ` · ${fmtDateTime(e.journeys[0].startedAt)}` : ""}</p>
                    <PlaceLinks lat={e.start[0]} lng={e.start[1]} className="pt-1" />
                  </div>
                </Popup>
              </Marker>
            )}
            {e.end && (
              <Marker
                position={e.end}
                icon={dutyEndIcon(color, "person", { dim })}
                title={`${e.employeeName}: ${e.live ? "latest position" : "end"}`}
                zIndexOffset={base + 300}
                eventHandlers={{ click: pick }}
              >
                <Popup>
                  <div className="space-y-0.5 text-xs [&_p]:my-0" data-testid="duty-end-popup">
                    <p className="text-sm font-bold">{e.employeeName}</p>
                    <p>
                      {e.live ? "Latest position" : "End of the journey"}
                      {e.endAt ? ` · ${fmtTime(e.endAt)}` : ""}
                    </p>
                    {e.live && e.state && <p>{STATE_LABEL[e.state]}</p>}
                    {e.mocked && <p className="font-semibold text-red-600">Simulated location was reported</p>}
                    {farFromTiruppurText(e.end) && <p className="text-gray-500">{farFromTiruppurText(e.end)}</p>}
                    <PlaceLinks lat={e.end[0]} lng={e.end[1]} className="pt-1" />
                  </div>
                </Popup>
              </Marker>
            )}
          </Fragment>
        );
      })}
    </MapContainer>
  );
}
