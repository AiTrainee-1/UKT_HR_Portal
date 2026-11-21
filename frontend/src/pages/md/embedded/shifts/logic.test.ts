import { describe, expect, it } from "vitest";
import * as fx from "./fixtures";
import { assistantSummary, changeRows, lateBars, shiftBars, shiftTiles, spanText } from "./logic";

describe("Manage Shift insights logic", () => {
  it("builds the tiles; the ones with people behind them say which shift", () => {
    const tiles = Object.fromEntries(shiftTiles(fx.summary).map((t) => [t.id, t]));
    expect(tiles.covered.value).toBe("88.2%");
    expect(tiles.none.people).toBe("none");
    expect(tiles.production.people).toBe("production");
    expect(tiles.production.sub).toBe("1 on a special shift · 2 default shifts");
    expect(tiles.changes.delta).toEqual({ text: "-2", tone: "neutral", direction: "down" });
    const legacy = shiftTiles({ ...fx.summary, production: { ...fx.summary.production!, inForce: false } });
    expect(legacy.find((t) => t.id === "production")?.people).toBeUndefined();
  });

  it("lists every shift with its people, then those without one", () => {
    const bars = shiftBars(fx.coverage);
    expect(bars.map((b) => [b.key, b.value])).toEqual([
      ["production", 9],
      ["3", 5],
      ["special-7", 1],
      ["none", 2],
    ]);
    expect(bars[0].sub).toBe("Day 08:30, Night 21:00 · production");
    expect(bars[1].sub).toBe("09:00-17:30 · Unit 1 · staff");
  });

  it("shapes the changes, the lateness and a person's dates", () => {
    expect(changeRows(fx.changes)[1]).toEqual({ label: "03 Nov", moved: 1, first: 0, renewed: 0 });
    expect(lateBars(fx.late)[1]).toMatchObject({
      key: "3",
      value: 7.1,
      sub: "1 late of 14 worked days · small sample",
    });
    const row = fx.people(new URLSearchParams("shift=special-7")).rows[0];
    expect(spanText(row)).toBe("since 01 Oct");
    expect(spanText({ ...row, until: "2026-11-30" })).toBe("01 Oct - 30 Nov");
    expect(spanText({ ...row, since: null })).toBeUndefined();
    expect(assistantSummary(fx.summary)).toMatchObject({ "Without a shift": "2", "On a shift": "88.2%" });
  });
});
