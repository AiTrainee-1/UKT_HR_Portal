// Journey History: links to Google Maps for a place. Pure functions.
//   * "Open in Google Maps" and "Directions" are plain links (no key, no account, no billing): Google's own website opens on the
//     coordinates, with its local names, shops and landmarks.
//   * The embed is Google's keyless `output=embed` view, shown in an iframe: one place at a time (a pin on Google's map). It
//     cannot draw our route, numbered stops or clickable points, which is why the route itself stays on our own map and the
//     Google view is offered for the place that is picked.
const six = (v: number): string => v.toFixed(6);

/** The place on Google Maps (opens the website or the app). */
export const googleMapsUrl = (lat: number, lng: number): string =>
  `https://www.google.com/maps/search/?api=1&query=${six(lat)},${six(lng)}`;

/** Directions to the place, from wherever the person opening the link is. */
export const googleDirectionsUrl = (lat: number, lng: number): string =>
  `https://www.google.com/maps/dir/?api=1&destination=${six(lat)},${six(lng)}`;

/** Google's keyless embed of the place: use it as the `src` of an iframe. */
export const googleEmbedUrl = (lat: number, lng: number, zoom = 18): string =>
  `https://www.google.com/maps?q=${six(lat)},${six(lng)}&z=${Math.min(21, Math.max(1, Math.round(zoom)))}&output=embed&hl=en`;

/** 11.132100, 77.325460: what is pasted into a search box or a message. */
export const coordsText = (lat: number, lng: number): string => `${six(lat)}, ${six(lng)}`;

/** Where the person's choice to see the Google view is remembered (this browser only). */
export const GOOGLE_VIEW_STORAGE_KEY = "hr-google-view";

function storage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Is the Google view switched on? Off until the person turns it on (it asks Google for a map as soon as it is shown). */
export function readGoogleView(store: Pick<Storage, "getItem"> | null = storage()): boolean {
  try {
    return store?.getItem(GOOGLE_VIEW_STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

export function saveGoogleView(on: boolean, store: Pick<Storage, "setItem"> | null = storage()): void {
  try {
    store?.setItem(GOOGLE_VIEW_STORAGE_KEY, on ? "on" : "off");
  } catch {
    // not remembered: it starts off again next time
  }
}
