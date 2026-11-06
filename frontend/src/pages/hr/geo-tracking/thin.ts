// Geo Attendance: a long line thinned for DRAWING only. A journey recorded every 3 seconds is thousands of positions; drawn in
// full, every pan and zoom re-projects and repaints all of them although at city zoom most lie within a pixel of their
// neighbours. thinPath keeps the shape (Douglas-Peucker: a position stays when leaving it out would move the line by more than
// the tolerance) and always the first and last position. The data itself is never changed: the dots, the popups, the figures
// and the replay read the full list.
import type { LatLng } from "./tiruppur";

const M_PER_DEG = 111_320;

/** Perpendicular distance (metres) of p from the segment a-b, on a local flat projection (fine at city scale). */
function offsetM(p: LatLng, a: LatLng, b: LatLng, cosLat: number): number {
  const ax = a[1] * cosLat;
  const ay = a[0];
  const bx = b[1] * cosLat - ax;
  const by = b[0] - ay;
  const px = p[1] * cosLat - ax;
  const py = p[0] - ay;
  const len2 = bx * bx + by * by;
  const f = len2 > 0 ? Math.max(0, Math.min(1, (px * bx + py * by) / len2)) : 0;
  return Math.hypot(px - f * bx, py - f * by) * M_PER_DEG;
}

/** Douglas-Peucker with a tolerance in metres (iterative: a 10,000-point line never overflows the stack). */
export function simplify(points: LatLng[], toleranceM: number): LatLng[] {
  if (points.length <= 2 || toleranceM <= 0) return points.slice();
  const cosLat = Math.cos((points[0][0] * Math.PI) / 180);
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [from, to] = stack.pop()!;
    let worst = -1;
    let at = -1;
    for (let i = from + 1; i < to; i++) {
      const d = offsetM(points[i], points[from], points[to], cosLat);
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (at > 0 && worst > toleranceM) {
      keep[at] = 1;
      stack.push([from, at], [at, to]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

/** Douglas-Peucker is quadratic on a line where every position is a corner: it runs on windows of this many positions. */
const WINDOW = 256;

/**
 * The line for the map: simplified at `toleranceM` (window by window, so the work grows with the length, never with its
 * square), then, if it still has more than `maxPoints` positions, every k-th one is kept (the first and last always).
 */
export function thinPath(points: LatLng[], { toleranceM = 4, maxPoints = 2000 } = {}): LatLng[] {
  if (points.length <= 2) return points.slice();
  const pass = (line: LatLng[]): LatLng[] => {
    const next: LatLng[] = [];
    for (let from = 0; from < line.length - 1; from += WINDOW) {
      const part = simplify(line.slice(from, Math.min(line.length, from + WINDOW + 1)), toleranceM);
      // windows share their end position: it is written once
      next.push(...(next.length ? part.slice(1) : part));
    }
    return next;
  };
  // the ends of the windows are kept by the first pass; a later pass (on the shorter line, so over other windows) lets them go
  let out = pass(points);
  for (let round = 0; round < 4; round++) {
    const next = pass(out);
    if (next.length === out.length) break;
    out = next;
  }
  if (out.length <= maxPoints) return out;
  const step = (out.length - 1) / (maxPoints - 1);
  return Array.from({ length: maxPoints }, (_, k) => out[Math.min(out.length - 1, Math.round(k * step))]);
}
