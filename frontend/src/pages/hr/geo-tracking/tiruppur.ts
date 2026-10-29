// Live Map: where the map opens, and what counts as "the Tiruppur area". The company works in and around Tiruppur, so the Live Map
// and the On-Duty Map open on a window of about 60 km x 40 km around the town (zoom 11) instead of the whole of India. The map is
// never locked: HR can still pan and zoom anywhere, and "Fit all" / "Back to Tiruppur" bring the view back. Everything that lies
// farther out than the radius below (a branch or an employee in another town) is counted, so it is never lost off the edge.
/** [latitude, longitude]: the same pair the rest of Geo Attendance uses. */
export type LatLng = [number, number];

/** Tiruppur, Tamil Nadu. */
export const TIRUPPUR_CENTER: LatLng = [11.1085, 77.3411];
/** Zoom 11: about 75 m per pixel, so a desktop map shows roughly 60 km across (30 km each side of the centre). */
export const TIRUPPUR_ZOOM = 11;
/** The Tiruppur area: places within this distance of the centre. */
export const TIRUPPUR_RADIUS_KM = 30;
/** The deepest zoom "Fit all" goes to: a single employee is shown with their surroundings, not as a pinprick. */
export const FIT_MAX_ZOOM = 15;
/** Space (px) kept between the pins and the edge of the map when it fits them all. */
export const FIT_PADDING: [number, number] = [48, 48];

const EARTH_KM = 6371.0088;
const rad = (deg: number): number => (deg * Math.PI) / 180;

/** The great-circle distance between two places, in kilometres. */
export function distanceKm(a: LatLng, b: LatLng): number {
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The same distance in metres: stops that are a few metres apart are the same place. */
export const distanceM = (a: LatLng, b: LatLng): number => distanceKm(a, b) * 1000;

export const inTiruppurArea = (p: LatLng): boolean => distanceKm(TIRUPPUR_CENTER, p) <= TIRUPPUR_RADIUS_KM;

/** The places of a list that lie outside the Tiruppur area. */
export function outsideTiruppur<T extends { pos: LatLng }>(items: T[]): T[] {
  return items.filter((item) => !inTiruppurArea(item.pos));
}

/** "12 km from Tiruppur": how far a place is from the centre, for the popup of something far out. */
export function farFromTiruppurText(p: LatLng): string | null {
  const km = distanceKm(TIRUPPUR_CENTER, p);
  return km > TIRUPPUR_RADIUS_KM ? `${Math.round(km)} km from Tiruppur` : null;
}

/** A one-line reminder of what the window is, for the map's caption. */
export const TIRUPPUR_CAPTION = `Tiruppur area (${TIRUPPUR_RADIUS_KM} km)`;
