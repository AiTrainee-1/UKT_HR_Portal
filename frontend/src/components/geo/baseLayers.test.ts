import { describe, expect, it } from "vitest";
import {
  BASE_LAYERS,
  BASE_LAYER_STORAGE_KEY,
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
  it("offers the street map first, then the satellite view with and without names, each credited", () => {
    expect(BASE_LAYERS.map((l) => l.id)).toEqual(["street", "satellite", "hybrid"]);
    expect(BASE_LAYERS.map((l) => l.label)).toEqual(["Street map", "Satellite", "Satellite + names"]);
    expect(DEFAULT_BASE_LAYER).toBe("street");
    const [street, satellite, hybrid] = BASE_LAYERS;
    expect(street.tiles).toHaveLength(1);
    expect(street.tiles[0].url).toContain("openstreetmap.org");
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
    saveBaseLayer("satellite", storage);
    expect(storage.data[BASE_LAYER_STORAGE_KEY]).toBe("satellite");
    expect(readBaseLayer(storage)).toBe("satellite");
    saveBaseLayer("hybrid", storage);
    expect(readBaseLayer(storage)).toBe("hybrid");
    saveBaseLayer("street", storage);
    expect(readBaseLayer(storage)).toBe("street");
  });

  it("ignores a saved value that is not a layer of ours", () => {
    expect(readBaseLayer(memory({ [BASE_LAYER_STORAGE_KEY]: "terrain" }))).toBe("street");
    expect(readBaseLayer(memory({ [BASE_LAYER_STORAGE_KEY]: "" }))).toBe("street");
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
