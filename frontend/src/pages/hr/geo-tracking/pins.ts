// Geo Attendance: the pins of the Live Map (company locations, employees), the single-employee route lookup and the punch location
// dialog. Meaningful shaped icons (not plain dots) so the map reads at a glance: a building pin for a company / branch location, a
// person pin for an employee, coloured per status. Inline SVG divIcons, no external assets. (The Journey History map's own pins
// are in mapIcons.ts; the On-Duty Map's employee-coloured ones in dutyIcons.ts.)
import L from "leaflet";

export const COLOR_COMPANY = "#0f766e";
export const COLOR_NORMAL = "#006496";
export const COLOR_ON_DUTY = "#d97706";
export const COLOR_MOCKED = "#dc2626";
/** The start and the end of a route are one colour. */
export const COLOR_START = "#16a34a";
export const COLOR_END = COLOR_START;

export type PinGlyph = "building" | "person" | "flag" | "dot";

const cache = new Map<string, L.DivIcon>();

export function pinIcon(color: string, glyph: PinGlyph, size = 30): L.DivIcon {
  const key = `${color}|${glyph}|${size}`;
  const known = cache.get(key);
  if (known) return known;
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
  const icon = L.divIcon({ className: "", html, iconSize: [size, size * 1.25], iconAnchor: [size / 2, size * 1.25] });
  cache.set(key, icon);
  return icon;
}

export function bearingDeg(a: [number, number], b: [number, number]): number {
  const [lat1, lon1] = a.map((d) => (d * Math.PI) / 180);
  const [lat2, lon2] = b.map((d) => (d * Math.PI) / 180);
  const dLon = lon2 - lon1;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

export function arrowIcon(color: string, rotationDeg: number): L.DivIcon {
  const html = `<div style="width:0;height:0;transform:rotate(${rotationDeg}deg);border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:12px solid ${color};filter:drop-shadow(0 1px 2px rgba(0,0,0,0.4));"></div>`;
  return L.divIcon({ className: "", html, iconSize: [12, 12], iconAnchor: [6, 6] });
}

/** Direction arrows along a route: a handful of interior points, so the path shows which way it was walked without clutter. */
export function arrowSamples(points: [number, number][], count = 8): { pos: [number, number]; rot: number }[] {
  if (points.length < 2) return [];
  const step = Math.max(1, Math.floor(points.length / count));
  const out: { pos: [number, number]; rot: number }[] = [];
  for (let i = step; i < points.length - 1; i += step) {
    out.push({ pos: points[i], rot: bearingDeg(points[i - 1], points[i + 1] ?? points[i]) });
  }
  return out;
}
