import { describe, expect, it } from "vitest";
import { simplify, thinPath } from "./thin";
import type { LatLng } from "./tiruppur";

// A long line is thinned for drawing only: the shape stays, the first and last positions stay, the list given is never changed.

const straight = (n: number): LatLng[] => Array.from({ length: n }, (_, i) => [11 + i * 0.0001, 77 + i * 0.0001]);

describe("thinning a line for the map", () => {
  it("drops the positions that lie on a straight line and keeps both ends", () => {
    const line = straight(500);
    const out = thinPath(line);
    expect(out).toEqual([line[0], line[499]]);
    expect(line).toHaveLength(500); // the data itself is not touched
  });

  it("keeps every corner farther off the line than the tolerance", () => {
    const corner: LatLng[] = [
      [11, 77],
      [11.001, 77],
      [11.002, 77],
      [11.002, 77.001], // a right turn ~109 m along
      [11.002, 77.002],
    ];
    expect(simplify(corner, 4)).toEqual([corner[0], corner[2], corner[4]]);
    // a wiggle of about a metre is noise at the tolerance of 4 m
    const wiggle: LatLng[] = [
      [11, 77],
      [11.0005, 77.00001],
      [11.001, 77],
    ];
    expect(simplify(wiggle, 4)).toEqual([wiggle[0], wiggle[2]]);
    expect(simplify(wiggle, 0.5)).toEqual(wiggle);
  });

  it("caps a very long journey at the number of positions asked for", () => {
    const zigzag: LatLng[] = Array.from({ length: 9000 }, (_, i) => [11 + i * 0.00003, 77 + (i % 2) * 0.0003]);
    const out = thinPath(zigzag, { maxPoints: 1500 });
    expect(out.length).toBeLessThanOrEqual(1500);
    expect(out[0]).toEqual(zigzag[0]);
    expect(out[out.length - 1]).toEqual(zigzag[8999]);
  });

  it("returns short lines as they are", () => {
    expect(thinPath([])).toEqual([]);
    expect(thinPath([[11, 77]])).toEqual([[11, 77]]);
  });
});
