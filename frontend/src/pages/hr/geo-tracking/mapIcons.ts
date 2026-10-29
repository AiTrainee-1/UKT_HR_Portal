// Journey History: the map's pins, drawn as inline SVG / HTML divIcons (no image files, so nothing to load or to break), and
// the colours of the route. A pin is a picture: no box-shadow and no gradient (the flat themes check for both).
import L from "leaflet";
import type { EventStyle } from "./logic";

export const COLOR_TRAVEL = "#006496";
export const COLOR_ESTIMATED = "#4aa3c7";
export const COLOR_GAP = "#6b7280";
export const COLOR_WAIT = "#d97706";
export const COLOR_LONG_STOP = "#7c3aed";
export const COLOR_MOCK = "#dc2626";
/** The start and the end of a journey are ONE colour (green), whatever the journey is doing: stops keep amber / purple, travel blue. */
export const COLOR_ENDPOINT = "#16a34a";
export const COLOR_START = COLOR_ENDPOINT;
export const COLOR_SELECTED = "#0f172a";

const GLYPH: Record<EventStyle["glyph"], string> = {
  gps: `<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><path d="M3 3l18 18"/>`,
  network: `<path d="M3 9a14 14 0 0 1 18 0M6.5 12.5a9 9 0 0 1 11 0M10 16a4 4 0 0 1 4 0"/><path d="M3 3l18 18"/>`,
  power: `<path d="M12 3v8"/><path d="M6.5 6.8a7.5 7.5 0 1 0 11 0"/>`,
  app: `<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 9l6 6M15 9l-6 6"/>`,
  mock: `<path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5M12 17.5v.01"/>`,
  battery: `<rect x="3" y="8" width="15" height="8" rx="2"/><path d="M21 11v2M7 12h3"/>`,
  lock: `<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>`,
  clock: `<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>`,
  flag: `<path d="M6 21V4m0 0h11l-2 4 2 4H6"/>`,
  dot: `<circle cx="12" cy="12" r="2.5" fill="#fff"/>`,
};

/**
 * A numbered round pin: stop 1, 2, 3 ... The ring is thicker for the stop picked in the timeline. Several stops at one place
 * share one pin with a longer label ("1 · 3"): the pin grows into a pill so every number is readable.
 */
export function stopIcon(label: number | string, color: string, selected = false): L.DivIcon {
  const size = selected ? 34 : 28;
  const text = String(label);
  const width = size + Math.max(0, text.length - 2) * 7;
  const ring = selected ? `outline:3px solid ${COLOR_SELECTED};` : "outline:1px solid rgba(15,23,42,0.45);";
  const html = `<div data-pin="stop" style="width:${width}px;height:${size}px;border-radius:9999px;background:${color};border:3px solid #fff;${ring}color:#fff;font:700 12px/${size - 6}px system-ui,sans-serif;text-align:center;white-space:nowrap;box-sizing:border-box">${text}</div>`;
  return L.divIcon({
    className: "",
    html,
    iconSize: [width, size],
    iconAnchor: [width / 2, size / 2],
    popupAnchor: [0, -size / 2],
  });
}

/** A round event pin with a small picture (location off, no network, phone off ...). */
export function eventIcon(style: EventStyle, selected = false): L.DivIcon {
  const size = selected ? 32 : 26;
  const ring = selected ? `outline:3px solid ${COLOR_SELECTED};` : "outline:1px solid rgba(15,23,42,0.45);";
  const html = `<div data-pin="event" style="width:${size}px;height:${size}px;border-radius:9999px;background:${style.color};border:2px solid #fff;${ring}display:flex;align-items:center;justify-content:center;box-sizing:border-box"><svg width="${size - 10}" height="${size - 10}" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${GLYPH[style.glyph]}</svg></div>`;
  return L.divIcon({
    className: "",
    html,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  });
}

/** The journey's start (a flag) or its last position (a person), as a teardrop pin. */
export function endPin(color: string, glyph: "flag" | "person", size = 30): L.DivIcon {
  const inner =
    glyph === "flag"
      ? `<path d="M8 20V6m0 0h8l-2 3 2 3H8" stroke="#fff" stroke-width="1.6" fill="none" stroke-linejoin="round"/>`
      : `<circle cx="12" cy="9" r="2.6" fill="#fff"/><path d="M7 18.5c0-2.8 2.2-5 5-5s5 2.2 5 5" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round"/>`;
  const html = `<svg data-pin="${glyph}" width="${size}" height="${size * 1.25}" viewBox="0 0 24 30" xmlns="http://www.w3.org/2000/svg"><path d="M12 29C12 29 22 17.5 22 11C22 5.5 17.5 1 12 1C6.5 1 2 5.5 2 11C2 17.5 12 29 12 29Z" fill="${color}" stroke="#fff" stroke-width="1.5"/><g transform="translate(0,-1.5)">${inner}</g></svg>`;
  return L.divIcon({
    className: "",
    html,
    iconSize: [size, size * 1.25],
    iconAnchor: [size / 2, size * 1.25],
    popupAnchor: [0, -size * 1.1],
  });
}
