import { describe, expect, it } from "vitest";
import { SEEDED } from "./fixtures";
import { draftFrom, type ShiftRulesDraft } from "./form";
import { clockInExample, cutOffTime, doubleTapExample, morningRows } from "./night-morning";

// The worked examples of Night and early morning (owner 2026-11-18), from what is typed on the tab.

const seeded = () => draftFrom(SEEDED);
function edited(edit: (d: ShiftRulesDraft) => void): ShiftRulesDraft {
  const d = structuredClone(seeded());
  edit(d);
  return d;
}
const day = (d: ShiftRulesDraft) => morningRows(d).find((r) => r.group === "Day shift")!;

describe("night and early morning examples", () => {
  it("says from when each day shift's early arrivals count and by when a clock-in ends the night", () => {
    expect(day(seeded())).toEqual({
      group: "Day shift",
      night: false,
      start: "08:30",
      arrivalFrom: "06:00",
      clockInBy: "08:45",
    });
    expect(morningRows(seeded()).find((r) => r.group === "Night shift")?.night).toBe(true);
    expect(day(edited((d) => (d.earlyArrivalMinutes = "120"))).arrivalFrom).toBe("06:30");
    expect(day(edited((d) => (d.clockInAgainMinutes = "5"))).clockInBy).toBe("08:35");
    // a box that cannot be read yet shows the default rather than nothing
    expect(day(edited((d) => (d.earlyArrivalMinutes = "abc"))).arrivalFrom).toBe("06:00");
    // a group that is off is not listed
    expect(morningRows(edited((d) => (d.groups[0].enabled = false))).some((r) => r.group === "Day shift")).toBe(false);
  });

  it("works the cut-off out from the latest next-morning leaving time", () => {
    expect(cutOffTime(seeded())).toBe("07:00"); // 05:30 + 90 minutes
    expect(cutOffTime(edited((d) => (d.cutOffMinutes = "30")))).toBe("06:00");
    expect(cutOffTime(edited((d) => (d.cutOffEnabled = false)))).toBeNull();
  });

  it("decides the clock-in-again example by the switch and the minutes", () => {
    expect(clockInExample(seeded(), day(seeded()))).toEqual({ out: "06:18", again: "08:31", endsNight: true });
    const none = edited((d) => (d.clockInAgainMinutes = "0"));
    expect(clockInExample(none, day(none)).endsNight).toBe(false);
    const off = edited((d) => (d.clockInAgainEnabled = false));
    expect(clockInExample(off, day(off)).endsNight).toBe(false);
  });

  it("decides the double-tap example by the switch and the minutes", () => {
    expect(doubleTapExample(seeded()).onePunch).toBe(true);
    expect(doubleTapExample(edited((d) => (d.doubleTapMinutes = "3"))).onePunch).toBe(false);
    expect(doubleTapExample(edited((d) => (d.doubleTapEnabled = false))).onePunch).toBe(false);
  });
});
