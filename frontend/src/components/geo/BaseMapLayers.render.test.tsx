import { act } from "react";
import { MapContainer } from "react-leaflet";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mapEvents } from "@/pages/hr/geo-tracking/leafletMock";
import { all, installBrowserStubs, mount, unmount } from "@/pages/hr/settings/endpoint-sharing/testing";
import { BaseMapLayers } from "./BaseMapLayers";
import { BASE_LAYER_STORAGE_KEY } from "./baseLayers";

// The layer switch of the portal's maps in jsdom, with react-leaflet replaced by plain elements (jsdom cannot draw a map).
vi.mock("react-leaflet", async () => (await import("@/pages/hr/geo-tracking/leafletMock")).leafletMock);

const MapUnderTest = () => (
  <MapContainer>
    <BaseMapLayers />
  </MapContainer>
);

const layers = () =>
  all("base-layer").map((el) => ({
    name: el.dataset.name,
    checked: el.dataset.checked === "true",
    urls: [...el.querySelectorAll<HTMLElement>('[data-testid="tile-layer"]')].map((t) => t.dataset.url ?? ""),
    credit: [...el.querySelectorAll<HTMLElement>('[data-testid="tile-layer"]')]
      .map((t) => t.dataset.attribution ?? "")
      .join(" "),
  }));

beforeAll(installBrowserStubs);
beforeEach(() => {
  window.localStorage.clear();
  mapEvents.current = {};
});
afterEach(unmount);

describe("BaseMapLayers", () => {
  it("offers the street map, the satellite view and the satellite view with names, on the street map when nothing was chosen", () => {
    mount("/", MapUnderTest);
    expect(layers().map((l) => [l.name, l.checked])).toEqual([
      ["Street map", true],
      ["Satellite", false],
      ["Satellite + names", false],
    ]);
    expect(layers()[0].urls).toHaveLength(1);
    expect(layers()[0].urls[0]).toContain("tile.openstreetmap.org");
    expect(layers()[1].urls).toHaveLength(1);
    expect(layers()[1].urls[0]).toContain("World_Imagery");
    expect(layers()[2].urls).toHaveLength(3);
    expect(layers()[2].urls[1]).toContain("World_Boundaries_and_Places");
    expect(layers()[2].urls[2]).toContain("World_Transportation");
    expect(layers()[0].credit).toContain("OpenStreetMap");
    expect(layers()[1].credit).toContain("Esri");
    expect(layers()[2].credit).toContain("Esri");
  });

  it("opens on the layer that was picked last", () => {
    window.localStorage.setItem(BASE_LAYER_STORAGE_KEY, "hybrid");
    mount("/", MapUnderTest);
    expect(layers().map((l) => [l.name, l.checked])).toEqual([
      ["Street map", false],
      ["Satellite", false],
      ["Satellite + names", true],
    ]);
  });

  it("remembers a pick made in the switch, and ignores a layer that is not ours", () => {
    mount("/", MapUnderTest);
    act(() => mapEvents.current.baselayerchange({ name: "Satellite" }));
    expect(window.localStorage.getItem(BASE_LAYER_STORAGE_KEY)).toBe("satellite");
    act(() => mapEvents.current.baselayerchange({ name: "Satellite + names" }));
    expect(window.localStorage.getItem(BASE_LAYER_STORAGE_KEY)).toBe("hybrid");
    act(() => mapEvents.current.baselayerchange({ name: "Street map" }));
    expect(window.localStorage.getItem(BASE_LAYER_STORAGE_KEY)).toBe("street");
    act(() => mapEvents.current.baselayerchange({ name: "Terrain" }));
    expect(window.localStorage.getItem(BASE_LAYER_STORAGE_KEY)).toBe("street");
  });
});
