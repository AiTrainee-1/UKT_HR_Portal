import { describe, expect, it } from "vitest";
import * as fx from "./fixtures";
import { assistantSummary, deltaChip, kpiTiles, movementRows, personSecondary, workforceAsks } from "./logic";

describe("Employees insights logic", () => {
  it("writes a change with its sign and colours it by what is good news", () => {
    expect(deltaChip({ abs: 3, pct: 100 }, null)).toEqual({ text: "+3", tone: "neutral", direction: "up" });
    expect(deltaChip({ abs: -1, pct: -20 }, "down")).toEqual({ text: "-1", tone: "good", direction: "down" });
    expect(deltaChip({ abs: -0.8, pct: null }, "down", "pts", 1)).toEqual({
      text: "-0.8 pts",
      tone: "good",
      direction: "down",
    });
    expect(deltaChip({ abs: 0, pct: 0 }, "up")).toEqual({ text: "0", tone: "neutral", direction: "flat" });
    expect(deltaChip(null, "up")).toBeNull();
  });

  it("builds the eight tiles, each figure with what a click lists", () => {
    const tiles = kpiTiles(fx.summary, "Nov 2026");
    expect(tiles.map((t) => t.id)).toEqual([
      "headcount",
      "joiners",
      "leavers",
      "net",
      "attrition",
      "early",
      "factory",
      "tenure",
    ]);
    const by = Object.fromEntries(tiles.map((t) => [t.id, t]));
    expect(by.headcount.value).toBe("120");
    expect(by.headcount.sub).toBe("80 staff · 40 production today");
    expect(by.attrition.sub).toBe("58.5% a year at this pace");
    expect(by.factory.sub).toBe("7.5% of the people here today");
    expect(by.joiners.ask).toEqual({ group: "joiners", title: "Joiners", subtitle: "Nov 2026" });
    expect(by.factory.ask?.open?.path).toBe("/md/employees/factory-emp");
    expect(by.net.ask).toBeUndefined(); // a difference has no list of its own
  });

  it("shapes the movement chart and the group rows", () => {
    expect(movementRows(fx.movement.points)[1]).toEqual({ label: "09 Nov", joiners: 3, leavers: 2, headcount: 120 });
    const asks = workforceAsks(fx.workforce);
    expect(asks.labels.map((l) => [l.label, l.ask.value])).toEqual([
      ["Driver", "1"],
      ["Security", "4"],
      ["No label", "none"],
    ]);
    expect(asks.cycles.at(-1)).toMatchObject({
      label: "No pay cycle yet",
      value: 2,
      ask: { group: "cycle", value: "none" },
    });
    expect(asks.statutory[1].ask).toMatchObject({ group: "statutory", value: "tds", title: "TDS" });
  });

  it("describes a person and tells the assistant the headline", () => {
    const row = fx.people(new URLSearchParams("group=active")).rows[0];
    expect(personSecondary(row)).toBe("Operator · Stitching · Unit 1");
    expect(personSecondary({ ...row, type: "production", cycle: "Weekly" })).toBe(
      "Operator · Stitching · Unit 1 · Weekly pay",
    );
    expect(assistantSummary(fx.summary, fx.workforce)).toEqual({
      Headcount: "120",
      Joiners: "6",
      Leavers: "4",
      Attrition: "3.4%",
      "Factory Employees": "9",
      "Production without a pay cycle": "2",
    });
    expect(assistantSummary(undefined, undefined)).toEqual({});
  });
});
