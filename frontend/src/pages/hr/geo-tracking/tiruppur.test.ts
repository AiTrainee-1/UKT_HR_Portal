import { describe, expect, it } from "vitest";
import {
  FIT_MAX_ZOOM,
  TIRUPPUR_CENTER,
  TIRUPPUR_RADIUS_KM,
  TIRUPPUR_ZOOM,
  distanceKm,
  distanceM,
  farFromTiruppurText,
  inTiruppurArea,
  outsideTiruppur,
  type LatLng,
} from "./tiruppur";

// The Live Map and the On-Duty Map open on Tiruppur, not on the whole of India, and count what lies outside the Tiruppur area.

describe("the Tiruppur window", () => {
  it("is centred on Tiruppur, Tamil Nadu, at a zoom that shows about 60 km across", () => {
    expect(TIRUPPUR_CENTER).toEqual([11.1085, 77.3411]);
    expect(TIRUPPUR_ZOOM).toBeGreaterThanOrEqual(11);
    expect(TIRUPPUR_ZOOM).toBeLessThanOrEqual(12);
    expect(TIRUPPUR_RADIUS_KM).toBeGreaterThanOrEqual(25);
    expect(TIRUPPUR_RADIUS_KM).toBeLessThanOrEqual(30);
    // fitting a single place still shows its surroundings
    expect(FIT_MAX_ZOOM).toBeLessThanOrEqual(16);
  });

  it("is nowhere near the middle of India (the old default view)", () => {
    expect(distanceKm(TIRUPPUR_CENTER, [20.5937, 78.9629])).toBeGreaterThan(1000);
  });
});

describe("distances", () => {
  it("knows how far apart two places are", () => {
    // one degree of latitude is about 111 km
    expect(distanceKm([11, 77], [12, 77])).toBeCloseTo(111.2, 0);
    expect(distanceKm([11, 77], [11, 77])).toBe(0);
    expect(distanceM([11, 77], [11.001, 77])).toBeCloseTo(111.2, 0);
  });

  it("is the same in both directions", () => {
    const a: LatLng = [11.1085, 77.3411];
    const b: LatLng = [10.9958, 77.2896]; // Palladam
    expect(distanceKm(a, b)).toBeCloseTo(distanceKm(b, a), 9);
    expect(distanceKm(a, b)).toBeGreaterThan(12);
    expect(distanceKm(a, b)).toBeLessThan(15);
  });
});

describe("the Tiruppur area", () => {
  const places: { key: string; pos: LatLng }[] = [
    { key: "mill", pos: [11.1085, 77.3411] }, // the centre
    { key: "avinashi", pos: [11.1925, 77.2686] }, // about 12 km
    { key: "kangeyam", pos: [11.0054, 77.5614] }, // about 25 km
    { key: "coimbatore", pos: [11.0168, 76.9558] }, // about 43 km
    { key: "erode", pos: [11.341, 77.7172] }, // about 49 km
  ];

  it("holds the places within the radius", () => {
    expect(inTiruppurArea(TIRUPPUR_CENTER)).toBe(true);
    expect(inTiruppurArea(places[1].pos)).toBe(true);
    expect(inTiruppurArea(places[2].pos)).toBe(true);
  });

  it("counts what lies outside, so a branch in another town is never lost off the edge of the map", () => {
    expect(outsideTiruppur(places).map((p) => p.key)).toEqual(["coimbatore", "erode"]);
    expect(outsideTiruppur([])).toEqual([]);
  });

  it("says how far a far place is, and nothing for a near one", () => {
    expect(farFromTiruppurText(places[0].pos)).toBeNull();
    expect(farFromTiruppurText(places[3].pos)).toMatch(/^\d+ km from Tiruppur$/);
    expect(Number.parseInt(farFromTiruppurText(places[4].pos) ?? "", 10)).toBeGreaterThan(45);
  });
});
