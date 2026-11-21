import { describe, expect, it } from "vitest";
import * as fx from "./fixtures";
import { againstCompany, assistantSummary, companyTiles, metricText, trendRows, verdictTone } from "./logic";

const def = (id: string) => fx.METRICS.find((m) => m.id === id)!;

describe("Branches insights logic", () => {
  it("writes each figure by its format", () => {
    expect(metricText("pct", 92)).toBe("92%");
    expect(metricText("hours", 30.5)).toBe("30.5 h");
    expect(metricText("years", 4.2)).toBe("4.2 yrs");
    expect(metricText("inr_compact", 2450000)).toBe("₹24.5 L");
    expect(metricText("number", 120)).toBe("120");
    expect(metricText("pct", null)).toBe("—");
  });

  it("says how a unit stands against the company", () => {
    const unit2 = fx.summary.rows[1].metrics;
    expect(verdictTone(unit2.attendancePct)).toBe("bad");
    expect(verdictTone(fx.summary.rows[0].metrics.latePct)).toBe("neutral");
    expect(verdictTone(unit2.costPerHead)).toBeNull();
    expect(againstCompany(def("attendancePct"), unit2.attendancePct)).toBe("-8.0 pts vs company");
    expect(againstCompany(def("headcount"), { ...unit2.headcount, sharePct: 33.3 })).toBe("33% of the company");
    expect(againstCompany(def("costPerHead"), { ...unit2.costPerHead, diffPct: -5.7 })).toBe("-6% vs company");
  });

  it("builds the company tiles with the change against the previous period", () => {
    const tiles = Object.fromEntries(companyTiles(fx.summary).map((t) => [t.id, t]));
    expect(tiles.units.value).toBe("2");
    expect(tiles.units.sub).toBe("120 active people · 9 factory");
    expect(tiles.attendancePct.value).toBe("88%");
    expect(tiles.attendancePct.delta).toEqual({ text: "+1.5 pts", tone: "good", direction: "up" });
    expect(tiles.absenteeismPct.delta).toEqual({ text: "-1.0 pts", tone: "good", direction: "down" });
    expect(tiles.payrollCost.sub).toBe("Oct 2026, gross");
    expect(tiles.overtimeHours.value).toBe("30.5 h");
  });

  it("shapes the trend rows and the assistant summary", () => {
    const rows = trendRows(fx.trend(new URLSearchParams("metric=attendancePct")));
    expect(rows[1]).toEqual({ label: "09 Nov", company: 88, u1: 93, u2: 78 });
    expect(assistantSummary(fx.summary)).toMatchObject({ Units: "2", Attendance: "88%" });
  });
});
