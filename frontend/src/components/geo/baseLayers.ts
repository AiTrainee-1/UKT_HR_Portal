// The base maps the portal's Leaflet maps can show, and which one the person picked last (remembered in this browser).
//   * Street map = OpenStreetMap: roads, lanes, bus stops and the names volunteers have entered.
//   * Satellite = Esri World Imagery: rooftops, compounds and parking, so a stop can be told to be inside a building or beside the
//     road, which the street map cannot show.
//   * Satellite + names = the same imagery with Esri's road-name and area-name labels on top (Esri's free public tiles; the
//     labels are drawn only at the zoom levels where Esri has them for this region).
// No key and no account are needed for any of them. Google's own map needs a paid key to be used this way; its place names are
// offered through the "Google Maps view" of the selected place instead.

export type BaseLayerId = "street" | "satellite" | "hybrid";

export type TileSpec = {
  url: string;
  /** Shown in the corner of the map; empty for a layer that is credited by another layer of the same group. */
  attribution: string;
  /** The deepest level with real tiles: deeper zooms stretch these. */
  maxNativeZoom: number;
  /** The deepest level the layer is shown at (default MAX_ZOOM). */
  maxZoom?: number;
};

export type BaseLayerSpec = {
  id: BaseLayerId;
  /** What the layer switch shows. */
  label: string;
  /** Drawn in this order, the last on top. */
  tiles: TileSpec[];
};

const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/";

const STREET: TileSpec = {
  url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxNativeZoom: 19,
};

const IMAGERY: TileSpec = {
  url: `${ESRI}World_Imagery/MapServer/tile/{z}/{y}/{x}`,
  attribution: "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
  maxNativeZoom: 19,
};

/** Road names (real tiles to level 18; the level above stretches them). */
const ROAD_NAMES: TileSpec = {
  url: `${ESRI}Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}`,
  attribution: "",
  maxNativeZoom: 18,
};

/** Area, locality and landmark names (real tiles to level 16, shown to 17: stretched further they would blur). */
const AREA_NAMES: TileSpec = {
  url: `${ESRI}Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`,
  attribution: "",
  maxNativeZoom: 16,
  maxZoom: 17,
};

export const BASE_LAYERS: BaseLayerSpec[] = [
  { id: "street", label: "Street map", tiles: [STREET] },
  { id: "satellite", label: "Satellite", tiles: [IMAGERY] },
  { id: "hybrid", label: "Satellite + names", tiles: [IMAGERY, AREA_NAMES, ROAD_NAMES] },
];

/** The deepest zoom of the maps: every layer has real (or stretched) tiles down to it, so a switch never leaves a blank map. */
export const MAX_ZOOM = 19;

export const DEFAULT_BASE_LAYER: BaseLayerId = "street";
export const BASE_LAYER_STORAGE_KEY = "hr-map-base-layer";

const isBaseLayerId = (value: unknown): value is BaseLayerId => BASE_LAYERS.some((l) => l.id === value);

/** localStorage can be missing or throw (private window, blocked site data): the map then simply starts on the street map. */
function browserStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readBaseLayer(storage: Pick<Storage, "getItem"> | null = browserStorage()): BaseLayerId {
  try {
    const saved = storage?.getItem(BASE_LAYER_STORAGE_KEY);
    return isBaseLayerId(saved) ? saved : DEFAULT_BASE_LAYER;
  } catch {
    return DEFAULT_BASE_LAYER;
  }
}

export function saveBaseLayer(id: BaseLayerId, storage: Pick<Storage, "setItem"> | null = browserStorage()): void {
  try {
    storage?.setItem(BASE_LAYER_STORAGE_KEY, id);
  } catch {
    // not remembered: the next map starts on the street map again
  }
}

/** The layer behind the name Leaflet reports when the person picks one in the switch (null for a name that is not ours). */
export function baseLayerIdForName(name: string): BaseLayerId | null {
  return BASE_LAYERS.find((l) => l.label === name)?.id ?? null;
}
