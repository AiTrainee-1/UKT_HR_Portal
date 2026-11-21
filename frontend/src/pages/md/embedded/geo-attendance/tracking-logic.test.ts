import { describe, expect, it } from "vitest";
import { alertKindBars, trackLine, trackStateTone, trackingEmpty, trackingTiles } from "./tracking-logic";
import { emptyTracking, tracking } from "./tracking-fixtures";

describe("On-Duty tracking logic", () => {
  it("makes the six tiles from the hand-counted journeys and alerts", () => {
    const tiles = Object.fromEntries(trackingTiles(tracking).map((t) => [t.id, t]));
    expect(tiles.journeys.value).toBe("3");
    expect(tiles.journeys.sub).toBe("3 people · 6 stops");
    expect(tiles.km.value).toBe("64.0 km");
    expect(tiles.km.sub).toBe("21.3 km a journey");
    expect(tiles.gaps.value).toBe("67%");
    expect(tiles.gaps.sub).toBe("2 of 3 · 0.7 h without data");
    expect(tiles.alerts.value).toBe("4");
    expect(tiles.alerts.sub).toBe("2 people · 1 open now");
    expect(tiles.alerts.delta?.tone).toBe("bad"); // more alerts is bad news
    expect(tiles.alerts.opens).toBe("alerts");
    expect(tiles.escalated.value).toBe("1");
    expect(tiles.escalated.opens).toBe("escalated");
    expect(tiles.fix.value).toBe("30m");
    expect(tiles.fix.sub).toBe("75% fixed by the employee");
  });

  it("ranks the alert kinds and leaves out the ones that never fired", () => {
    const bars = alertKindBars(tracking);
    expect(bars.map((b) => b.kind)).toEqual([
      "location_off",
      "permission_restricted",
      "missing_punch",
      "punch_reminder",
    ]);
    expect(bars[0].sub).toBe("1 open now");
    expect(bars[1].sub).toBeUndefined();
  });

  it("reads a phone's tracking state", () => {
    expect(trackStateTone("moving")).toBe("good");
    expect(trackStateTone("stationary")).toBe("good");
    expect(trackStateTone("waiting_first_fix")).toBe("warn");
    expect(trackStateTone("offline")).toBe("bad");
    expect(trackStateTone("location_off")).toBe("bad");
    expect(trackStateTone(null)).toBeNull();
    expect(trackLine({ trackStateLabel: "Stationary", batteryPct: 64, travelledKm: 2, openAlerts: 1 })).toBe(
      "Stationary · 64% battery · 2.0 km · 1 open alert",
    );
    expect(trackLine({ trackStateLabel: null })).toBeNull();
  });

  it("knows an empty period", () => {
    expect(trackingEmpty(tracking)).toBe(false);
    expect(trackingEmpty(emptyTracking)).toBe(true);
  });
});
