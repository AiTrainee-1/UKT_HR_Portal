// Journey History: the map of one journey (Leaflet, the same as the rest of Geo Attendance; the street map, the satellite view
// or the satellite view with road and area names).
//   * the COMPLETE route: a thin line through every recorded position (stationary periods in their own colour), the travel on
//     top of it as a solid line, a gap (no location) as a dashed grey line between where the signal was lost and where it came
//     back, an estimated stretch dashed in a lighter blue; simulated (fake GPS) travel in the red the page uses;
//   * one dot per recorded position (click one for its time, accuracy, speed, activity, battery and network, with Google Maps);
//   * numbered pins for the stops (amber while it is waiting, purple from 15 minutes: a long stop), with a popup of start,
//     end, duration and the address (or the coordinates), and "Open in Google Maps";
//   * a flag at the start, a person at the last known position, round pins for the events (location off, no network ...);
//   * fitted to the whole route when it opens, and moved to whatever is picked in the timeline (which it also highlights).
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import { Circle, CircleMarker, MapContainer, Marker, Polyline, Popup, useMap } from "react-leaflet";
import { BaseMapLayers } from "@/components/geo/BaseMapLayers";
import type { JourneyDetail } from "@/lib/api-client/custom-hooks";
import {
  accuracyWord,
  boundsOf,
  eventStyle,
  fmtCoords,
  fmtDateTime,
  fmtDuration,
  fmtTime,
  pointFacts,
  stopGroupLabel,
  timeRange,
  type LatLng,
  type MapModel,
  type TrailDot,
  type TrailModel,
} from "./logic";
import {
  COLOR_ENDPOINT,
  COLOR_ESTIMATED,
  COLOR_GAP,
  COLOR_LONG_STOP,
  COLOR_MOCK,
  COLOR_TRAVEL,
  COLOR_WAIT,
  endPin,
  eventIcon,
  stopIcon,
} from "./mapIcons";
import { PlaceLinks } from "./PlaceLinks";
import { Chip, MapLegend } from "./ui";

const INDIA_CENTER: LatLng = [20.5937, 78.9629];
/** A recorded position the pipeline set aside (too inaccurate, a GPS jump). */
const COLOR_POOR = "#9ca3af";
const COLOR_TRAIL = "#1e3a8a";
const COLOR_PICKED = "#0284c7";

type Bounds = [LatLng, LatLng];
type Focus = { key: string; bounds: Bounds | null; center: LatLng | null; zoom: number };

/** Moves the map: to the whole route when a journey opens (or first has a position, or "Fit route" is pressed), and to the picked item. */
function MapController({
  bounds,
  fitSignal,
  focus,
}: {
  bounds: Bounds | null;
  fitSignal: string;
  focus: Focus | null;
}) {
  const map = useMap();
  const latest = useRef(bounds);
  latest.current = bounds;

  useEffect(() => {
    const fit = () => {
      map.invalidateSize();
      const b = latest.current;
      if (!b) return;
      // not animated: Leaflet drops a move that is asked for while another is still animating, and this one is asked for again
      // as the page settles
      if (b[0][0] === b[1][0] && b[0][1] === b[1][1]) map.setView(b[0], 16, { animate: false });
      else map.fitBounds(b, { padding: [32, 32], maxZoom: 17, animate: false });
    };
    fit();
    // The page lays itself out around the map after it mounts (a scrollbar appears, the cards above it settle), so the map is
    // fitted again for as long as its box keeps changing in the first moments; after that the reader's own panning is left alone.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(map.getContainer());
    const stop = window.setTimeout(() => observer.disconnect(), 1200);
    return () => {
      window.clearTimeout(stop);
      observer.disconnect();
    };
  }, [map, fitSignal]);

  useEffect(() => {
    if (!focus) return;
    if (focus.bounds) map.fitBounds(focus.bounds, { padding: [56, 56], maxZoom: 17 });
    else if (focus.center) map.setView(focus.center, Math.max(map.getZoom(), focus.zoom));
  }, [map, focus]);

  return null;
}

const dotStyle = (d: TrailDot, renderer: L.Renderer | undefined): L.CircleMarkerOptions => {
  if (!d.point.used) {
    return { renderer, radius: 3, color: COLOR_POOR, weight: 1, fillColor: "#ffffff", fillOpacity: 0.8 };
  }
  const fill = d.point.mock
    ? COLOR_MOCK
    : d.stopNumber !== null
      ? d.longStop
        ? COLOR_LONG_STOP
        : COLOR_WAIT
      : COLOR_TRAVEL;
  return { renderer, radius: 4, color: "#ffffff", weight: 1.5, fillColor: fill, fillOpacity: 1 };
};

/** How close (screen pixels) a click or the mouse must be to a dot to pick it. */
const DOT_PICK_PX = 10;

/**
 * One dot per recorded position. A journey can hold thousands, so they are not React elements: one canvas layer draws them all.
 * The canvas sits in its own pane that lets every click through (a canvas over the map would swallow the clicks meant for the
 * travel and gap lines); a click on the map picks the nearest dot within DOT_PICK_PX, and the mouse turns into a pointer over one.
 * The picked dot gets its own ring and popup from React (see JourneyMap).
 */
function TrailDots({ dots, showPoor, onPick }: { dots: TrailDot[]; showPoor: boolean; onPick: (key: string) => void }) {
  const map = useMap();
  const pick = useRef(onPick);
  pick.current = onPick;

  useEffect(() => {
    const pane = map.getPane("trailDots") ?? map.createPane("trailDots");
    pane.style.zIndex = "450"; // above the lines (400), below the pins (600)
    pane.style.pointerEvents = "none";
    const renderer = L.canvas({ pane: "trailDots", padding: 0.4 }) ?? undefined;
    const group = L.featureGroup();
    const shown: TrailDot[] = [];
    for (const d of dots) {
      if (!d.point.used && !showPoor) continue;
      shown.push(d);
      group.addLayer(L.circleMarker(d.pos, { ...dotStyle(d, renderer), interactive: false }));
    }
    group.addTo(map);

    const nearest = (at: L.Point): TrailDot | null => {
      let best: TrailDot | null = null;
      let bestPx = DOT_PICK_PX;
      for (const d of shown) {
        const p = map.latLngToContainerPoint(d.pos);
        const px = Math.hypot(p.x - at.x, p.y - at.y);
        if (px <= bestPx) {
          best = d;
          bestPx = px;
        }
      }
      return best;
    };
    const onClick = (e: L.LeafletMouseEvent) => {
      const hit = nearest(e.containerPoint);
      if (hit) pick.current(hit.key);
    };
    const onMove = (e: L.LeafletMouseEvent) => {
      map.getContainer().style.cursor = nearest(e.containerPoint) ? "pointer" : "";
    };
    map.on("click", onClick);
    map.on("mousemove", onMove);
    return () => {
      map.off("click", onClick);
      map.off("mousemove", onMove);
      map.getContainer().style.cursor = "";
      group.remove();
    };
  }, [map, dots, showPoor]);

  return null;
}

export default function JourneyMap({
  detail,
  model,
  trail,
  trailStatus,
  selectedKey,
  onSelect,
  fitSignal,
}: {
  detail: JourneyDetail;
  /** What to draw (see mapModel in logic.ts). */
  model: MapModel;
  /** Every recorded position (see trailModel in logic.ts); null until it has loaded (or when it could not). */
  trail: TrailModel | null;
  trailStatus: "loading" | "ready" | "error";
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  /** Changes when the map should fit the whole route again (a new journey, the "Fit route" button). */
  fitSignal: string;
}) {
  const bounds = useMemo(() => boundsOf(model.all), [model.all]);
  const active = detail.track.status === "active";
  const markers = useRef<Record<string, L.Marker | L.CircleMarker | null>>({});
  const [showPoints, setShowPoints] = useState(true);
  const [showPoor, setShowPoor] = useState(false);

  const pickedDot = selectedKey?.startsWith("pt-") ? trail?.byKey.get(selectedKey) : undefined;

  // where the map goes when a row of the timeline is picked
  const focus = useMemo<Focus | null>(() => {
    if (!selectedKey) return null;
    const travel = model.travel.find((t) => t.key === selectedKey);
    if (travel) return { key: selectedKey, bounds: boundsOf(travel.line), center: null, zoom: 16 };
    const gap = model.gaps.find((g) => g.key === selectedKey);
    if (gap) return { key: selectedKey, bounds: boundsOf(gap.line), center: null, zoom: 16 };
    const stop = model.stops.find((s) => s.key === selectedKey);
    if (stop) return { key: selectedKey, bounds: null, center: stop.pos, zoom: 16 };
    const event = model.events.find((e) => e.key === selectedKey);
    if (event) return { key: selectedKey, bounds: null, center: event.pos, zoom: 16 };
    const dot = trail?.byKey.get(selectedKey);
    if (dot) return { key: selectedKey, bounds: null, center: dot.pos, zoom: 17 };
    return null;
  }, [selectedKey, model, trail]);

  useEffect(() => {
    if (selectedKey) markers.current[selectedKey]?.openPopup();
  }, [selectedKey, focus]);

  return (
    <div className="space-y-2" data-testid="journey-map">
      <div className="relative h-[460px] overflow-hidden rounded-lg border" data-testid="journey-map-canvas">
        <MapContainer
          center={model.end ?? INDIA_CENTER}
          zoom={model.all.length > 0 ? 14 : 5}
          style={{ height: "100%", width: "100%" }}
          scrollWheelZoom
        >
          <BaseMapLayers />
          <MapController bounds={bounds} fitSignal={fitSignal} focus={focus} />

          {/* the complete trail: a thin line through every recorded position, under everything else */}
          {trail?.runs.map((run) => (
            <Polyline
              key={run.key}
              positions={run.line}
              interactive={false}
              pathOptions={{
                color: run.stopNumber !== null ? (run.longStop ? COLOR_LONG_STOP : COLOR_WAIT) : COLOR_TRAIL,
                weight: run.stopNumber !== null ? 2 : 2.5,
                opacity: 0.75,
              }}
            />
          ))}

          {model.travel.map((t) => {
            const selected = t.key === selectedKey;
            const color = t.mock ? COLOR_MOCK : t.estimated ? COLOR_ESTIMATED : COLOR_TRAVEL;
            return (
              <Polyline
                key={t.key}
                positions={t.line}
                pathOptions={{
                  color,
                  weight: selected ? 8 : 4,
                  opacity: selected ? 1 : 0.85,
                  dashArray: t.estimated ? "6 8" : undefined,
                }}
                eventHandlers={{ click: () => onSelect(t.key) }}
              />
            );
          })}
          {model.gaps.map((g) => {
            const selected = g.key === selectedKey;
            return (
              <Polyline
                key={g.key}
                positions={g.line}
                pathOptions={{
                  color: COLOR_GAP,
                  weight: selected ? 6 : 3,
                  opacity: selected ? 1 : 0.9,
                  dashArray: "4 8",
                }}
                eventHandlers={{ click: () => onSelect(g.key) }}
              />
            );
          })}

          {trail && showPoints && <TrailDots dots={trail.dots} showPoor={showPoor} onPick={onSelect} />}

          {pickedDot && (
            <CircleMarker
              key={pickedDot.key}
              ref={(m) => {
                markers.current[pickedDot.key] = m;
              }}
              center={pickedDot.pos}
              radius={9}
              pathOptions={{ color: COLOR_PICKED, weight: 3, fillColor: COLOR_PICKED, fillOpacity: 0.25 }}
              eventHandlers={{ click: () => onSelect(null) }}
            >
              <Popup>
                <div className="space-y-1 text-xs [&_p]:my-0" data-testid="point-popup">
                  <p className="text-sm font-bold">Recorded position</p>
                  {!pickedDot.point.used && (
                    <p className="text-gray-500">Set aside: poor accuracy or a GPS jump, so not part of the route.</p>
                  )}
                  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5">
                    {pointFacts(pickedDot.point).map(([label, value]) => (
                      <Fragment key={label}>
                        <dt className="text-gray-500">{label}</dt>
                        <dd className="m-0 font-semibold text-gray-900">{value}</dd>
                      </Fragment>
                    ))}
                  </dl>
                  {pickedDot.stopNumber !== null && (
                    <p className="text-gray-600">Recorded during stop {pickedDot.stopNumber}.</p>
                  )}
                  {accuracyWord(pickedDot.point.accuracyM) === "poor" && (
                    <p className="text-gray-500">The real place can be some distance from the dot.</p>
                  )}
                  <PlaceLinks lat={pickedDot.pos[0]} lng={pickedDot.pos[1]} />
                </div>
              </Popup>
            </CircleMarker>
          )}

          {model.stopGroups.map((g) => {
            const picked = g.stops.find((s) => s.key === selectedKey);
            const several = g.stops.length > 1;
            const long = g.stops.some((s) => s.row.longStop);
            const label = stopGroupLabel(g);
            return (
              <Fragment key={g.key}>
                {picked && picked.radiusM > 0 && (
                  <Circle
                    center={picked.pos}
                    radius={picked.radiusM}
                    pathOptions={{
                      color: picked.row.longStop ? COLOR_LONG_STOP : COLOR_WAIT,
                      weight: 1,
                      fillOpacity: 0.12,
                    }}
                  />
                )}
                <Marker
                  ref={(m) => {
                    for (const s of g.stops) markers.current[s.key] = m;
                  }}
                  position={g.pos}
                  icon={stopIcon(label, long ? COLOR_LONG_STOP : COLOR_WAIT, picked !== undefined)}
                  title={
                    several
                      ? `Stops ${label}: the same place`
                      : `Stop ${g.stops[0].row.stopNumber}: ${timeRange(g.stops[0].row.startedAt, g.stops[0].row.endedAt, g.stops[0].row.open)}`
                  }
                  zIndexOffset={picked ? 1000 : 400}
                  eventHandlers={{ click: () => (several ? undefined : onSelect(g.stops[0].key)) }}
                >
                  <Popup>
                    <div className="space-y-1 text-xs [&_p]:my-0" data-testid="stop-popup" data-stops={g.stops.length}>
                      {several && (
                        <p className="text-sm font-bold">
                          Stops {label} <span className="font-semibold text-gray-500">· the same place</span>
                        </p>
                      )}
                      {g.stops.map((s) => (
                        <div key={s.key} className="space-y-0.5" data-testid="stop-popup-item">
                          <p className="text-sm font-bold">
                            {several ? (
                              <button
                                type="button"
                                onClick={() => onSelect(s.key)}
                                className="text-left font-bold text-[#006496] underline"
                                data-testid="stop-popup-pick"
                              >
                                Stop {s.row.stopNumber}
                              </button>
                            ) : (
                              <>Stop {s.row.stopNumber}</>
                            )}
                          </p>
                          <p>
                            {timeRange(s.row.startedAt, s.row.endedAt, s.row.open)}
                            {" · "}
                            <b>{fmtDuration(s.row.durationS)}</b>{" "}
                            <Chip
                              className={s.row.longStop ? "bg-purple-50 text-purple-700" : "bg-amber-50 text-amber-800"}
                            >
                              {s.row.longStop ? "long stop" : "waiting"}
                            </Chip>
                          </p>
                          {!several && <p>{s.row.title}</p>}
                          {!several && s.row.detail && <p className="text-gray-500">{s.row.detail}</p>}
                        </div>
                      ))}
                      {several && <p>{g.stops[0].row.title}</p>}
                      <PlaceLinks lat={g.pos[0]} lng={g.pos[1]} className="pt-1" />
                    </div>
                  </Popup>
                </Marker>
              </Fragment>
            );
          })}

          {model.events.map((e) => {
            const style = eventStyle(e.event.kind);
            const selected = e.key === selectedKey;
            return (
              <Marker
                key={e.key}
                ref={(m) => {
                  markers.current[e.key] = m;
                }}
                position={e.pos}
                icon={eventIcon(style, selected)}
                title={style.label}
                zIndexOffset={selected ? 1000 : 300}
                eventHandlers={{ click: () => onSelect(e.key) }}
              >
                <Popup>
                  <div className="space-y-0.5 text-xs [&_p]:my-0" data-testid="event-popup">
                    <p className="text-sm font-bold">{style.label}</p>
                    <p>
                      {fmtDateTime(e.event.startedAt, true)}
                      {e.event.endedAt ? ` - ${fmtTime(e.event.endedAt, true)}` : active ? " - still open" : ""}
                    </p>
                    <p className="text-gray-500">Last known place: {fmtCoords(e.pos[0], e.pos[1])}</p>
                    <PlaceLinks lat={e.pos[0]} lng={e.pos[1]} className="pt-1" />
                  </div>
                </Popup>
              </Marker>
            );
          })}

          {model.start && (
            <Marker
              position={model.start}
              icon={endPin(COLOR_ENDPOINT, "flag")}
              title="Start of the journey"
              zIndexOffset={600}
            >
              <Popup>
                Start · {fmtDateTime(detail.summary.firstPointAt ?? detail.track.startedAt, true)}
                <br />
                {fmtCoords(model.start[0], model.start[1])}
                <PlaceLinks lat={model.start[0]} lng={model.start[1]} className="pt-1" />
              </Popup>
            </Marker>
          )}
          {model.end && (
            <Marker
              position={model.end}
              icon={endPin(COLOR_ENDPOINT, "person")}
              title={active ? "Latest position" : "End of the journey"}
              zIndexOffset={700}
            >
              <Popup>
                {active ? "Latest position" : "End of the journey"}
                {" · "}
                {fmtDateTime(detail.track.lastPointAt ?? detail.track.endedAt, true)}
                <br />
                {fmtCoords(model.end[0], model.end[1])}
                {detail.track.hasMock && <p className="font-semibold text-red-600">Simulated location was reported</p>}
                <PlaceLinks lat={model.end[0]} lng={model.end[1]} className="pt-1" />
              </Popup>
            </Marker>
          )}
        </MapContainer>

        {model.all.length === 0 && (
          <div
            className="pointer-events-none absolute inset-0 z-[500] flex items-center justify-center bg-white/70 p-6 text-center"
            data-testid="journey-map-empty"
          >
            <p className="max-w-xs rounded-lg bg-white px-4 py-3 text-sm text-gray-600 ring-1 ring-gray-200">
              {active
                ? "No location has arrived yet. The route appears here as soon as the phone sends its first position."
                : "No location was recorded for this journey."}
            </p>
          </div>
        )}
      </div>

      <div
        className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[11px] text-gray-600"
        data-testid="trail-controls"
        data-trail={trailStatus}
      >
        {trailStatus === "loading" && <span>Loading every recorded position ...</span>}
        {trailStatus === "error" && (
          <span className="text-amber-700" data-testid="trail-error">
            The recorded positions could not be loaded: the route is shown as the simplified line.
          </span>
        )}
        {trail && (
          <>
            <label className="flex cursor-pointer items-center gap-1.5 font-semibold">
              <input
                type="checkbox"
                checked={showPoints}
                onChange={(e) => setShowPoints(e.target.checked)}
                data-testid="trail-show-points"
              />
              Show every recorded position ({trail.used})
            </label>
            {trail.poor > 0 && (
              <label className="flex cursor-pointer items-center gap-1.5 font-semibold">
                <input
                  type="checkbox"
                  checked={showPoor}
                  onChange={(e) => setShowPoor(e.target.checked)}
                  disabled={!showPoints}
                  data-testid="trail-show-poor"
                />
                Include {trail.poor} set aside (poor accuracy)
              </label>
            )}
            <span data-testid="trail-count">
              {trail.truncated
                ? `${trail.dots.length} of ${trail.total} positions shown (a very long journey is thinned for the map)`
                : `${trail.total} ${trail.total === 1 ? "position" : "positions"} recorded`}
              {trail.source === "segments" ? " · rebuilt from the stored route (the raw positions were deleted)" : ""}
            </span>
          </>
        )}
      </div>

      <MapLegend
        items={[
          { color: COLOR_TRAVEL, label: "Travel", shape: "line" },
          { color: COLOR_GAP, label: "Gap (no location)", shape: "dash" },
          { color: COLOR_ESTIMATED, label: "Estimated", shape: "dash" },
          ...(trail ? [{ color: COLOR_TRAVEL, label: "Recorded position" }] : []),
          { color: COLOR_WAIT, label: "Waiting (under 15 min)" },
          { color: COLOR_LONG_STOP, label: "Long stop (15 min or more)" },
          { color: COLOR_ENDPOINT, label: "Start and end" },
          { color: COLOR_MOCK, label: "Simulated location", shape: "line" },
        ]}
      />
    </div>
  );
}
