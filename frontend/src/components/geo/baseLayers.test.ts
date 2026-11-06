import { describe, expect, it } from "vitest";
import {
  BASE_LAYERS,
  BASE_LAYER_STORAGE_KEY,
  BASE_LAYER_VERSION,
  BASE_LAYER_VERSION_KEY,
  DEFAULT_BASE_LAYER,
  MAX_ZOOM,
  baseLayerIdForName,
  readBaseLayer,
  saveBaseLayer,
} from "./baseLayers";

const memory = (initial: Record<string, string> = {}) => {
  const data = { ...initial };
  return {
    data,
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
  };
};

describe("base map layers", () => {
  it("offers the street map first, Esri's street map, then the satellite view with and without names, each credited", () => {
    expect(BASE_LAYERS.map((l) => l.id)).toEqual(["street", "street-esri", "satellite", "hybrid"]);
    expect(BASE_LAYERS.map((l) => l.label)).toEqual([
      "Street map",
      "Street map (Esri)",
      "Satellite",
      "Satellite + names",
    ]);
    expect(DEFAULT_BASE_LAYER).toBe("street");
    const [street, streetEsri, satellite, hybrid] = BASE_LAYERS;
    expect(street.tiles).toHaveLength(1);
    // OpenStreetMap's own host, without the retired a/b/c sub-domains
    expect(street.tiles[0].url).toBe("https://tile.openstreetmap.org/{z}/{x}/{y}.png");
    expect(streetEsri.tiles.map((t) => t.url)).toEqual([
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
    ]);
    expect(streetEsri.tiles[0].attribution).toContain("Esri");
    expect(streetEsri.tiles[0].attribution).toContain("OpenStreetMap");
    expect(satellite.tiles).toHaveLength(1);
    expect(satellite.tiles[0].url).toContain("World_Imagery");
    // the names are drawn over the same imagery: road names last (on top), area names under them
    expect(hybrid.tiles.map((t) => /services\/(?:Reference\/)?([^/]+)\//.exec(t.url)?.[1])).toEqual([
      "World_Imagery",
      "World_Boundaries_and_Places",
      "World_Transportation",
    ]);
    // every layer carries its credit in the corner (a label tile is credited by the imagery under it)
    for (const l of BASE_LAYERS) expect(l.tiles.some((t) => t.attribution.length > 10)).toBe(true);
  });

  it("never asks a layer for more zoom than it has real tiles for, and keeps the deepest zoom the same for all", () => {
    for (const l of BASE_LAYERS) {
      for (const t of l.tiles) {
        expect(t.maxNativeZoom).toBeLessThanOrEqual(MAX_ZOOM);
        expect(t.maxZoom ?? MAX_ZOOM).toBeLessThanOrEqual(MAX_ZOOM);
        expect(t.url).toMatch(/\{z\}/);
      }
    }
    expect(MAX_ZOOM).toBe(19);
  });

  it("starts on the street map when nothing was chosen, and on the chosen layer afterwards", () => {
    const storage = memory();
    expect(readBaseLayer(storage)).toBe("street");
    saveBaseLayer("street-esri", storage);
    expect(readBaseLayer(storage)).toBe("street-esri");
    saveBaseLayer("satellite", storage);
    expect(storage.data[BASE_LAYER_STORAGE_KEY]).toBe("satellite");
    expect(readBaseLayer(storage)).toBe("satellite");
    saveBaseLayer("hybrid", storage);
    expect(readBaseLayer(storage)).toBe("hybrid");
    saveBaseLayer("street", storage);
    expect(readBaseLayer(storage)).toBe("street");
  });

  it("ignores a saved value that is not a layer of ours", () => {
    const now = { [BASE_LAYER_VERSION_KEY]: BASE_LAYER_VERSION };
    expect(readBaseLayer(memory({ ...now, [BASE_LAYER_STORAGE_KEY]: "terrain" }))).toBe("street");
    expect(readBaseLayer(memory({ ...now, [BASE_LAYER_STORAGE_KEY]: "" }))).toBe("street");
  });

  it("moves everyone to the street map once: a choice saved by the older portal is replaced, a later pick is kept", () => {
    // saved before the street map became everyone's default (no version written)
    const storage = memory({ [BASE_LAYER_STORAGE_KEY]: "satellite" });
    expect(readBaseLayer(storage)).toBe("street");
    expect(storage.data[BASE_LAYER_STORAGE_KEY]).toBe("street");
    expect(storage.data[BASE_LAYER_VERSION_KEY]).toBe(BASE_LAYER_VERSION);
    // only once: what is picked from now on is what the next map opens on
    saveBaseLayer("hybrid", storage);
    expect(readBaseLayer(storage)).toBe("hybrid");
    expect(readBaseLayer(storage)).toBe("hybrid");
    // a storage that can only be read is not migrated, but still opens on the street map
    expect(readBaseLayer({ getItem: (k: string) => (k === BASE_LAYER_STORAGE_KEY ? "satellite" : null) })).toBe(
      "street",
    );
  });

  it("never throws when the browser storage is missing or refuses", () => {
    const refusing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readBaseLayer(refusing)).toBe("street");
    expect(() => saveBaseLayer("satellite", refusing)).not.toThrow();
    expect(readBaseLayer(null)).toBe("street");
    expect(() => saveBaseLayer("satellite", null)).not.toThrow();
  });

  it("maps the name Leaflet reports back to a layer", () => {
    expect(baseLayerIdForName("Satellite")).toBe("satellite");
    expect(baseLayerIdForName("Satellite + names")).toBe("hybrid");
    expect(baseLayerIdForName("Street map")).toBe("street");
    expect(baseLayerIdForName("Terrain")).toBeNull();
  });
});
