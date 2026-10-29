import { describe, expect, it } from "vitest";
import { DUTY_PALETTE, assignDutyColors, colorDistance, dutyColor } from "./dutyColors";

// On-Duty Map: every employee has a colour of their own, and keeps it while the page is open.

describe("the palette", () => {
  it("has hex colours only (Leaflet draws them as they are), all different", () => {
    for (const c of DUTY_PALETTE) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    expect(new Set(DUTY_PALETTE).size).toBe(DUTY_PALETTE.length);
  });

  it("keeps the colours the portal already means something by to itself: no red (simulated location), no grey (no signal)", () => {
    for (const c of DUTY_PALETTE) {
      expect(colorDistance(c, "#dc2626"), `${c} against the red`).toBeGreaterThan(110);
      expect(colorDistance(c, "#6b7280"), `${c} against the grey`).toBeGreaterThan(80);
    }
  });

  it("has colours that can be told apart: no two are alike", () => {
    for (let i = 0; i < DUTY_PALETTE.length; i++)
      for (let j = i + 1; j < DUTY_PALETTE.length; j++)
        expect(
          colorDistance(DUTY_PALETTE[i], DUTY_PALETTE[j]),
          `${DUTY_PALETTE[i]} against ${DUTY_PALETTE[j]}`,
        ).toBeGreaterThan(80);
  });

  it("goes on with generated colours past the end of the palette, each a valid hex", () => {
    const more = Array.from({ length: 30 }, (_, i) => dutyColor(DUTY_PALETTE.length + i));
    for (const c of more) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    expect(new Set(more).size).toBe(more.length);
    expect(dutyColor(0)).toBe(DUTY_PALETTE[0]);
  });
});

describe("assignDutyColors", () => {
  it("gives the first people the first colours, in order of employee id", () => {
    const slots = assignDutyColors([30, 10, 20]);
    expect([...slots.entries()].sort((a, b) => a[0] - b[0])).toEqual([
      [10, 0],
      [20, 1],
      [30, 2],
    ]);
  });

  it("gives everybody a colour of their own", () => {
    const ids = Array.from({ length: 25 }, (_, i) => i + 1);
    const slots = assignDutyColors(ids);
    expect(new Set(slots.values()).size).toBe(ids.length);
  });

  it("keeps what an employee already has when the list refreshes or somebody joins", () => {
    const first = assignDutyColors([10, 20, 30]);
    const later = assignDutyColors([5, 10, 20, 30, 40], first);
    for (const id of [10, 20, 30]) expect(later.get(id)).toBe(first.get(id));
    expect(later.get(5)).toBe(3); // the new ones take the next free slots, in order of id
    expect(later.get(40)).toBe(4);
  });

  it("frees the colour of somebody who is no longer listed", () => {
    const first = assignDutyColors([10, 20, 30]);
    const later = assignDutyColors([10, 30, 99], first);
    expect(later.get(10)).toBe(0);
    expect(later.get(30)).toBe(2);
    expect(later.get(99)).toBe(1); // 20's colour, now free
    expect(later.has(20)).toBe(false);
  });

  it("does not change anything when nothing changed", () => {
    const first = assignDutyColors([3, 1, 2]);
    expect([...assignDutyColors([1, 2, 3], first)]).toEqual([...first]);
  });
});
