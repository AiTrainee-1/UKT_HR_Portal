// Journey Simulation: the map. The recorded route is drawn faintly from start to end (thinned for drawing only, on a canvas), the
// stops carry their numbered pins (amber, purple from 15 minutes), the start a green flag and the last recorded position a green
// person, as on the journey map. While the replay runs the travelled part is drawn solid behind the moving marker, position by
// position (in chunks, so a frame only ever redraws the newest few hundred positions), and a gap appears as a dashed line the
// moment the signal was lost. Everything here is Leaflet driven directly from the player's frames: React renders this once
// per journey, not once per frame.
import { useEffect, useRef } from "react";
import L from "leaflet";
import { MapContainer, useMap } from "react-leaflet";
import { BaseMapLayers } from "@/components/geo/BaseMapLayers";
import { fmtTime, fmtDuration } from "../logic";
import { COLOR_ENDPOINT, COLOR_GAP, COLOR_LONG_STOP, COLOR_TRAVEL, COLOR_WAIT, endPin, stopIcon } from "../mapIcons";
import { thinPath } from "../thin";
import { TIRUPPUR_CENTER, TIRUPPUR_ZOOM, type LatLng } from "../tiruppur";
import { positionAt, type SimStop, type SimTrack } from "./playback";
import { puckIcon, setHeading, type PuckLook } from "./simIcons";

/** The travelled line is redrawn per frame only for its newest stretch: older stretches are finished lines. */
const CHUNK = 250;
const GHOST = "#64748b";

const iso = (t: number) => new Date(t).toISOString();

/** The recorded route split where the signal was lost (a gap is the dashed line, not part of the route). */
function routeRuns(track: SimTrack): LatLng[][] {
  const runs: LatLng[][] = [];
  let run: LatLng[] = [];
  track.points.forEach((p, i) => {
    run.push([p.lat, p.lng]);
    if (track.gapAfter[i]) {
      runs.push(run);
      run = [];
    }
  });
  if (run.length) runs.push(run);
  return runs;
}

function stopTitle(s: SimStop): string {
  const until = s.endT === null ? "still there" : fmtTime(iso(s.endT));
  return `Stop ${s.number}: ${fmtTime(iso(s.startT))} - ${until}${s.durationS !== null ? ` (${fmtDuration(s.durationS)})` : ""}`;
}

function Layers({
  track,
  subscribe,
  follow,
  reducedMotion,
  fitSignal,
  onPickStop,
}: {
  track: SimTrack;
  subscribe: (fn: (t: number) => void) => () => void;
  follow: boolean;
  reducedMotion: boolean;
  fitSignal: number;
  onPickStop: (stop: SimStop) => void;
}) {
  const map = useMap();
  const stopMarkers = useRef(new Map<string, { marker: L.Marker; stop: SimStop }>());
  const followRef = useRef(follow);
  followRef.current = follow;
  const reducedRef = useRef(reducedMotion);
  reducedRef.current = reducedMotion;
  const pickRef = useRef(onPickStop);
  pickRef.current = onPickStop;

  // the route, the stops and the two ends: once per journey
  useEffect(() => {
    const group = L.layerGroup().addTo(map);
    const canvas = L.canvas({ padding: 0.5 });
    for (const run of routeRuns(track)) {
      if (run.length < 2) continue;
      L.polyline(thinPath(run, { maxPoints: 1500 }), {
        renderer: canvas,
        color: GHOST,
        weight: 5,
        opacity: 0.35,
        interactive: false,
        lineCap: "round",
        lineJoin: "round",
      }).addTo(group);
    }
    stopMarkers.current = new Map();
    for (const stop of track.stops) {
      if (!stop.pos) continue;
      const marker = L.marker(stop.pos, {
        icon: stopIcon(stop.number, stop.long ? COLOR_LONG_STOP : COLOR_WAIT),
        title: stopTitle(stop),
        zIndexOffset: 400,
        keyboard: false,
      })
        .on("click", () => pickRef.current(stop))
        .addTo(group);
      stopMarkers.current.set(stop.key, { marker, stop });
    }
    const pts = track.points;
    if (pts.length) {
      L.marker([pts[0].lat, pts[0].lng], {
        icon: endPin(COLOR_ENDPOINT, "flag"),
        title: `Start · ${fmtTime(iso(pts[0].t), true)}`,
        zIndexOffset: 600,
        keyboard: false,
      }).addTo(group);
      if (pts.length > 1) {
        const last = pts[pts.length - 1];
        L.marker([last.lat, last.lng], {
          icon: endPin(COLOR_ENDPOINT, "person"),
          title: `Last recorded position · ${fmtTime(iso(last.t), true)}`,
          zIndexOffset: 700,
          keyboard: false,
        }).addTo(group);
      }
    }
    return () => {
      group.remove();
      stopMarkers.current = new Map();
    };
  }, [map, track]);

  // fit the whole route: when a journey opens and when "Fit route" is pressed
  useEffect(() => {
    const pts = track.points;
    if (pts.length === 0) return;
    map.invalidateSize();
    if (pts.length === 1) {
      map.setView([pts[0].lat, pts[0].lng], 16, { animate: false });
      return;
    }
    const bounds = L.latLngBounds(pts.map((p) => [p.lat, p.lng] as LatLng));
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16, animate: false });
  }, [map, track, fitSignal]);

  // the replay itself: the travelled line, the gaps reached, the marker
  useEffect(() => {
    const pts = track.points;
    if (pts.length === 0) return;
    const group = L.layerGroup().addTo(map);
    const lineOptions: L.PolylineOptions = {
      color: COLOR_TRAVEL,
      weight: 5,
      opacity: 0.95,
      interactive: false,
      lineCap: "round",
      lineJoin: "round",
    };
    let lines: L.Polyline[] = [];
    let head: L.Polyline | null = null;
    let headPts: LatLng[] = [];
    let drawn = -1;
    const gapLines = new Map<number, L.Polyline>();
    const marker = L.marker([pts[0].lat, pts[0].lng], {
      icon: puckIcon("still"),
      zIndexOffset: 2000,
      keyboard: false,
      interactive: false,
    }).addTo(group);
    let look: PuckLook = "still";
    let currentStop: string | null = null;
    let lastFollow = 0;

    const startLine = (seed: LatLng[]) => {
      headPts = seed;
      head = L.polyline(headPts, lineOptions).addTo(group);
      lines.push(head);
    };
    const clearLines = () => {
      for (const l of lines) l.remove();
      lines = [];
      head = null;
      headPts = [];
      drawn = -1;
    };

    const onFrame = (t: number) => {
      const s = positionAt(track, t);
      if (!s) return;
      if (s.index < drawn) clearLines();
      for (let i = drawn + 1; i <= s.index; i++) {
        const p: LatLng = [pts[i].lat, pts[i].lng];
        if (!head || (i > 0 && track.gapAfter[i - 1])) startLine([p]);
        else if (headPts.length >= CHUNK) startLine([headPts[headPts.length - 1], p]);
        else headPts.push(p);
      }
      drawn = s.index;
      if (head) head.setLatLngs(s.fraction > 0 ? [...headPts, [s.lat, s.lng]] : headPts);

      marker.setLatLng([s.lat, s.lng]);
      const nextLook: PuckLook = s.gap ? "gap" : s.mode;
      if (nextLook !== look) {
        marker.setIcon(puckIcon(nextLook));
        look = nextLook;
      }
      setHeading(marker, s.gap ? null : s.bearing, !reducedRef.current);

      for (const g of track.gaps) {
        const reached = g.startT <= t;
        const line = gapLines.get(g.index);
        if (reached && !line) {
          gapLines.set(
            g.index,
            L.polyline([g.from, g.to], {
              color: COLOR_GAP,
              weight: 3,
              opacity: 0.9,
              dashArray: "4 8",
              interactive: false,
            }).addTo(group),
          );
        } else if (!reached && line) {
          line.remove();
          gapLines.delete(g.index);
        }
      }

      const stopKey = s.stop?.key ?? null;
      if (stopKey !== currentStop) {
        const before = currentStop ? stopMarkers.current.get(currentStop) : undefined;
        before?.marker.setIcon(stopIcon(before.stop.number, before.stop.long ? COLOR_LONG_STOP : COLOR_WAIT));
        const now = stopKey ? stopMarkers.current.get(stopKey) : undefined;
        now?.marker.setIcon(stopIcon(now.stop.number, now.stop.long ? COLOR_LONG_STOP : COLOR_WAIT, true));
        currentStop = stopKey;
      }

      if (followRef.current) {
        const at = performance.now();
        const here = L.latLng(s.lat, s.lng);
        if (at - lastFollow > 350 && !map.getBounds().pad(-0.2).contains(here)) {
          lastFollow = at;
          map.panTo(here, { animate: !reducedRef.current, duration: 0.6 });
        }
      }
    };

    const unsubscribe = subscribe(onFrame);
    return () => {
      unsubscribe();
      group.remove();
    };
  }, [map, track, subscribe]);

  return null;
}

export default function SimulationMap({
  track,
  subscribe,
  follow,
  reducedMotion,
  fitSignal,
  onPickStop,
}: {
  track: SimTrack;
  subscribe: (fn: (t: number) => void) => () => void;
  follow: boolean;
  reducedMotion: boolean;
  fitSignal: number;
  onPickStop: (stop: SimStop) => void;
}) {
  const first = track.points[0];
  return (
    <MapContainer
      center={first ? [first.lat, first.lng] : TIRUPPUR_CENTER}
      zoom={first ? 14 : TIRUPPUR_ZOOM}
      style={{ height: "100%", width: "100%" }}
      scrollWheelZoom
      zoomAnimation={!reducedMotion}
      markerZoomAnimation={!reducedMotion}
      fadeAnimation={!reducedMotion}
      wheelPxPerZoomLevel={90}
    >
      <BaseMapLayers />
      <Layers
        track={track}
        subscribe={subscribe}
        follow={follow}
        reducedMotion={reducedMotion}
        fitSignal={fitSignal}
        onPickStop={onPickStop}
      />
    </MapContainer>
  );
}
