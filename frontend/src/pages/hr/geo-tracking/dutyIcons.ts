// On-Duty Map: the pins of an employee's journey, in the shapes of the Journey History map (a flag at the start, a person at the
// last position, numbered round pins for the stops) but filled with the EMPLOYEE's colour, so several journeys can be told apart.
// A stop of 15 minutes or more is a larger pin with a ring; a pin of an employee that is not in focus fades. Inline SVG / HTML like
// the rest (no image files, no box-shadow, no gradient: the flat themes check for both). Icons are cached: the map redraws every
// 20 s, and a new icon object per redraw would make every marker rebuild its element.
import L from "leaflet";

/**
 * What the start and the end pins are filled with. The owner's rule for ONE journey is that the start and the end are one colour
 * (green, COLOR_ENDPOINT in mapIcons.ts). With several journeys on one map the employee's colour is what ties a pin to its route,
 * so the pins are filled with it ("employee"; the flag / person shapes say start / end). "green" keeps the rule instead: a green pin
 * with a thick ring in the employee's colour.
 */
export const ENDPOINT_FILL: "employee" | "green" = "employee";
const ENDPOINT_GREEN = "#16a34a";

const cache = new Map<string, L.DivIcon>();

function cached(key: string, make: () => L.DivIcon): L.DivIcon {
  let icon = cache.get(key);
  if (!icon) {
    icon = make();
    cache.set(key, icon);
  }
  return icon;
}

const fade = (dim: boolean): string => (dim ? "opacity:0.35;" : "");
const RING = "outline:1px solid rgba(15,23,42,0.45);";
const FOCUS_RING = "outline:3px solid #0f172a;";

/** A numbered round pin for a stop: larger, with an outer ring in the employee's colour, when the stop is a long one (15 min or more). */
export function dutyStopIcon(
  label: string,
  color: string,
  opts: { long?: boolean; dim?: boolean; selected?: boolean } = {},
): L.DivIcon {
  const { long = false, dim = false, selected = false } = opts;
  return cached(`stop|${label}|${color}|${long}|${dim}|${selected}`, () => {
    const size = long ? 34 : 26;
    const width = size + Math.max(0, label.length - 2) * 7;
    const ring = selected ? FOCUS_RING : long ? `outline:3px solid ${color}55;` : RING;
    const html = `<div data-pin="stop" data-long="${long}" style="width:${width}px;height:${size}px;border-radius:9999px;background:${color};border:${long ? 3 : 2}px solid #fff;${ring}${fade(dim)}color:#fff;font:700 ${long ? 13 : 11}px/${size - (long ? 6 : 4)}px system-ui,sans-serif;text-align:center;white-space:nowrap;box-sizing:border-box">${label}</div>`;
    return L.divIcon({
      className: "",
      html,
      iconSize: [width, size],
      iconAnchor: [width / 2, size / 2],
      popupAnchor: [0, -size / 2],
    });
  });
}

/** The start (a flag) or the last position (a person) of an employee's journey: a teardrop pin in the employee's colour. */
export function dutyEndIcon(
  color: string,
  glyph: "flag" | "person",
  opts: { dim?: boolean; selected?: boolean; size?: number } = {},
): L.DivIcon {
  const { dim = false, selected = false, size = 30 } = opts;
  return cached(`end|${glyph}|${color}|${dim}|${selected}|${size}|${ENDPOINT_FILL}`, () => {
    const inner =
      glyph === "flag"
        ? `<path d="M8 20V6m0 0h8l-2 3 2 3H8" stroke="#fff" stroke-width="1.6" fill="none" stroke-linejoin="round"/>`
        : `<circle cx="12" cy="9" r="2.6" fill="#fff"/><path d="M7 18.5c0-2.8 2.2-5 5-5s5 2.2 5 5" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round"/>`;
    const green = ENDPOINT_FILL === "green";
    const fill = green ? ENDPOINT_GREEN : color;
    const stroke = selected ? "#0f172a" : green ? color : "#fff";
    const strokeWidth = selected ? 2.2 : green ? 2.6 : 1.5;
    const html = `<svg data-pin="${glyph}" width="${size}" height="${size * 1.25}" viewBox="0 0 24 30" xmlns="http://www.w3.org/2000/svg" style="${fade(dim)}"><path d="M12 29C12 29 22 17.5 22 11C22 5.5 17.5 1 12 1C6.5 1 2 5.5 2 11C2 17.5 12 29 12 29Z" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/><g transform="translate(0,-1.5)">${inner}</g></svg>`;
    return L.divIcon({
      className: "",
      html,
      iconSize: [size, size * 1.25],
      iconAnchor: [size / 2, size * 1.25],
      popupAnchor: [0, -size * 1.1],
    });
  });
}
