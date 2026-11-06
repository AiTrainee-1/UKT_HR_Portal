// Journey Simulation: the marker that travels the route. A round puck with a picture of what the employee is doing (on foot, on
// a two-wheeler, on a break, no location) and a small wedge that points the way they are heading. Inline SVG like every other
// pin of the portal (no image files, no box-shadow, no gradient). One icon per look, cached: the marker changes its icon only
// when the look changes, and the wedge is turned in place.
import L from "leaflet";
import type { TravelMode } from "./playback";

export type PuckLook = TravelMode | "gap";

export const PUCK_COLOR: Record<PuckLook, string> = {
  walking: "#006496",
  vehicle: "#006496",
  still: "#d97706",
  gap: "#6b7280",
};

export const PUCK_LABEL: Record<PuckLook, string> = {
  walking: "On foot",
  vehicle: "On the move",
  still: "Stopped",
  gap: "No location",
};

const GLYPH: Record<PuckLook, string> = {
  // a person walking
  walking: `<circle cx="13" cy="4.5" r="2" fill="#fff" stroke="none"/><path d="M10.5 21l1.8-6.2 2.7 2.4V21M8 11.5l2.6-2.6h3l2.2 3.4 2.2 1M12.3 9l-1.6 5.6"/>`,
  // a two-wheeler: what most field staff ride in Tiruppur
  vehicle: `<circle cx="5.5" cy="16.5" r="3.2"/><circle cx="18.5" cy="16.5" r="3.2"/><path d="M5.5 16.5l4-6.5h5l4 6.5M9.5 10l-1.5-3H6M14.5 10l1.5-3h2.5"/>`,
  // a cup: a break
  still: `<path d="M5 9h11v5a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4z"/><path d="M16 10.5h1.5a2.2 2.2 0 0 1 0 4.4H16M8 3.5v2.5M11.5 3.5v2.5"/>`,
  // location off
  gap: `<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><path d="M3 3l18 18"/>`,
};

const SIZE = 38;
const cache = new Map<PuckLook, L.DivIcon>();

/** The travelling marker for a look; turn its wedge with setHeading. */
export function puckIcon(look: PuckLook): L.DivIcon {
  const known = cache.get(look);
  if (known) return known;
  const color = PUCK_COLOR[look];
  // the wedge sits on a ring around the puck and is turned (by setHeading) around the centre; hidden when standing still
  const html = `<div data-pin="sim-puck" data-look="${look}" style="position:relative;width:${SIZE}px;height:${SIZE}px">
<div data-heading style="position:absolute;inset:-9px;transition:transform 0.25s linear;visibility:hidden"><svg width="${SIZE + 18}" height="${SIZE + 18}" viewBox="0 0 56 56"><path d="M28 1l6 9h-12z" fill="${color}" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg></div>
<div style="position:absolute;inset:0;border-radius:9999px;background:${color};border:3px solid #fff;outline:1px solid rgba(15,23,42,0.45);display:flex;align-items:center;justify-content:center;box-sizing:border-box"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${GLYPH[look]}</svg></div>
</div>`;
  const icon = L.divIcon({
    className: "",
    html,
    iconSize: [SIZE, SIZE],
    iconAnchor: [SIZE / 2, SIZE / 2],
  });
  cache.set(look, icon);
  return icon;
}

/** Points the wedge of a puck marker (or hides it when there is no heading). */
export function setHeading(marker: L.Marker | null, bearing: number | null, animate: boolean): void {
  const el = marker?.getElement()?.querySelector<HTMLElement>("[data-heading]");
  if (!el) return;
  if (bearing === null) {
    el.style.visibility = "hidden";
    return;
  }
  el.style.visibility = "visible";
  el.style.transition = animate ? "transform 0.25s linear" : "none";
  // turn the short way round: 350 -> 10 degrees is +20, not -340
  const before = Number(el.dataset.angle ?? bearing);
  const delta = ((((bearing - before) % 360) + 540) % 360) - 180;
  const angle = before + delta;
  el.dataset.angle = String(angle);
  el.style.transform = `rotate(${Math.round(angle)}deg)`;
}
