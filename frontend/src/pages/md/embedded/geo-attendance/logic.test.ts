import { describe, expect, it } from "vitest";
import { CHART } from "@/components/md/kit/chartTheme";
import { EVERYONE } from "@/lib/md/period";
import type { MdOrg } from "@/lib/md/types";
import * as fx from "./fixtures";
import {
  NONE_KEY,
  ageBars,
  askQuestions,
  assistantSummary,
  bandBars,
  compareRows,
  decisionLine,
  deltaChip,
  focusScope,
  hasActivity,
  hoursText,
  isSilent,
  kpiTiles,
  liveChips,
  liveStatus,
  minutesOutText,
  participationText,
  periodText,
  previousText,
  scopeText,
  signalText,
  statusSlices,
  trendRows,
} from "./logic";

describe("deltaChip", () => {
  it("colours a change by whether it is good news", () => {
    expect(deltaChip({ abs: -9.6, pct: -14.4 }, "pts", "up")).toEqual({
      text: "-9.6 pts",
      tone: "bad",
      direction: "down",
    });
    expect(deltaChip({ abs: -1, pct: -25 }, "hours", "down")).toEqual({
      text: "-1 h",
      tone: "good",
      direction: "down",
    });
    expect(deltaChip({ abs: 6, pct: 150 }, "pct", "none")).toEqual({ text: "+150%", tone: "neutral", direction: "up" });
  });

  it("falls back to the plain difference when there is no previous figure to take a percentage of", () => {
    expect(deltaChip({ abs: 2, pct: null }, "pct", "down")).toEqual({ text: "+2", tone: "bad", direction: "up" });
  });

  it("shows a change that rounds to nothing as flat and neutral", () => {
    expect(deltaChip({ abs: 0.01, pct: 0.02 }, "pct", "down")).toEqual({
      text: "0%",
      tone: "neutral",
      direction: "flat",
    });
    expect(deltaChip({ abs: 0, pct: null }, "pts", "up")).toEqual({
      text: "0 pts",
      tone: "neutral",
      direction: "flat",
    });
    expect(deltaChip({ abs: 0, pct: null }, "hours", "down")?.text).toBe("0 h");
  });

  it("has no chip without a change", () => {
    expect(deltaChip(null, "pct", "up")).toBeNull();
    expect(deltaChip(undefined, "pct", "up")).toBeNull();
  });
});

describe("words for times", () => {
  it("writes a waiting time as hours or days", () => {
    expect(hoursText(5.4)).toBe("5.4 h");
    expect(hoursText(3)).toBe("3.0 h");
    expect(hoursText(30)).toBe("30 h");
    expect(hoursText(251)).toBe("10.5 days");
    expect(hoursText(null)).toBe("—");
  });

  it("writes how long someone has been out", () => {
    expect(minutesOutText(45)).toBe("45 m");
    expect(minutesOutText(360)).toBe("6 h");
    expect(minutesOutText(925)).toBe("15 h 25 m");
    expect(minutesOutText(14790)).toBe("10.3 days");
  });
});

describe("the figures strip", () => {
  const tiles = kpiTiles(fx.summary, fx.trend, fx.verification);
  const tile = (id: string) => tiles.find((t) => t.id === id)!;

  it("has eight tiles in a fixed order", () => {
    expect(tiles.map((t) => t.id)).toEqual([
      "sessions",
      "people",
      "punches",
      "office",
      "verified",
      "waiting",
      "speed",
      "mocked",
    ]);
  });

  it("shows the hand-counted figures", () => {
    expect(tile("sessions").value).toBe("10");
    expect(tile("sessions").sub).toBe("6 people out");
    expect(tile("people").value).toBe("83%");
    expect(tile("punches").value).toBe("14");
    expect(tile("punches").sub).toBe("1.4 per session");
    expect(tile("office").value).toBe("4");
    expect(tile("verified").value).toBe("57.1%");
    expect(tile("verified").sub).toBe("8 of 14 punches");
    expect(tile("waiting").value).toBe("4");
    expect(tile("waiting").sub).toBe("Oldest 10.5 days · 2 requests");
    expect(tile("speed").value).toBe("3.0 h");
    expect(tile("speed").sub).toBe("89% decided within a day");
    expect(tile("mocked").value).toBe("2");
    expect(tile("mocked").sub).toBe("1 far from the unit · 3 at odd hours");
  });

  it("colours each change by whether it is good news", () => {
    expect(tile("verified").delta?.tone).toBe("bad"); // fewer verified
    expect(tile("speed").delta?.tone).toBe("good"); // faster
    expect(tile("mocked").delta?.tone).toBe("bad"); // more simulated locations
    expect(tile("sessions").delta?.tone).toBe("neutral"); // more sessions is neither good nor bad
  });

  it("draws a sparkline from the trend where it has one", () => {
    expect(tile("sessions").spark).toHaveLength(14);
    expect(tile("punches").spark?.[1]).toBe(5);
    expect(tile("office").spark?.[1]).toBe(3);
    expect(tile("verified").spark).toBeUndefined();
  });

  it("says where each figure is explained", () => {
    expect(tile("waiting").source).toBe("verification");
    expect(tile("waiting").provenanceIds).toEqual(["geo-backlog"]);
    expect(tile("speed").provenanceIds).toEqual(["geo-turnaround"]);
  });

  it("copes with the verification not being here yet", () => {
    const early = kpiTiles(fx.summary);
    expect(early.find((t) => t.id === "waiting")?.value).toBe("—");
    expect(early.find((t) => t.id === "verified")?.sub).toBe("No punches");
  });

  it("shows a dash, never a zero, where there is no rate", () => {
    const empty = kpiTiles(fx.emptySummary, fx.emptyTrend, fx.emptyVerification);
    expect(empty.find((t) => t.id === "verified")?.value).toBe("—");
    expect(empty.find((t) => t.id === "speed")?.value).toBe("—");
    expect(empty.find((t) => t.id === "people")?.value).toBe("—");
    expect(empty.find((t) => t.id === "punches")?.sub).toBe("No sessions");
    expect(empty.find((t) => t.id === "waiting")?.sub).toBe("0 requests waiting");
  });

  it("names the period the changes compare with", () => {
    expect(previousText(fx.summary)).toBe("18 Aug to 31 Aug 2026");
  });
});

describe("this period against the previous", () => {
  const rows = compareRows(fx.summary);
  const row = (id: string) => rows.find((r) => r.id === id)!;

  it("lists nine figures side by side", () => {
    expect(rows).toHaveLength(9);
    expect(row("sessions")).toMatchObject({ current: "10", previous: "4" });
    expect(row("verified")).toMatchObject({ current: "57.1%", previous: "66.7%" });
    expect(row("rejected")).toMatchObject({ current: "21.4%", previous: "33.3%" });
    expect(row("speed")).toMatchObject({ current: "3.0 h", previous: "4.0 h" });
  });

  it("says which way is good news for each", () => {
    expect(row("rejected").delta?.tone).toBe("good"); // fewer rejections
    expect(row("verified").delta?.tone).toBe("bad");
    expect(row("mocked").delta?.tone).toBe("bad");
    expect(row("sessions").delta?.tone).toBe("neutral");
  });
});

describe("the trend", () => {
  it("makes one row per day with the 7-day average", () => {
    const rows = trendRows(fx.trend);
    expect(rows).toHaveLength(14);
    expect(rows[1]).toMatchObject({ date: "2026-09-02", sessions: 3, punches: 5, officePunches: 3 });
    expect(rows[1].average).toBe(0.4); // 3 sessions in the 2 days so far, over 7
  });

  it("has no moving average for weekly points", () => {
    expect(trendRows(fx.weeklyTrend).every((r) => r.average === null)).toBe(true);
  });

  it("knows when there is nothing to draw", () => {
    expect(hasActivity(fx.trend)).toBe(true);
    expect(hasActivity(fx.emptyTrend)).toBe(false);
  });
});

describe("verification", () => {
  it("splits the punches by what HR decided", () => {
    expect(statusSlices(fx.verification).map((s) => [s.name, s.value])).toEqual([
      ["Verified", 8],
      ["Rejected by HR", 1],
      ["Voided with a rejected request", 2],
      ["Waiting for HR", 3],
    ]);
  });

  it("shows what waits for HR by how long it has waited", () => {
    const bars = ageBars(fx.verification.backlog);
    expect(bars.map((b) => [b.label, b.value, b.display])).toEqual([
      ["Under a day", 3, "2 punches · 1 request"],
      ["1 to 2 days", 0, "none"],
      ["2 to 7 days", 0, "none"],
      ["Over a week", 3, "2 punches · 1 request"],
    ]);
  });

  it("reads how fast HR decides in one sentence", () => {
    expect(decisionLine(fx.verification)).toBe(
      "HR typically decides a punch in 3.0 h, 9 in 10 within 29 h, 89% within a day.",
    );
    expect(decisionLine(fx.emptyVerification)).toBeNull();
  });
});

describe("how far from the unit", () => {
  it("drops bands with no punches and keeps the share", () => {
    const bars = bandBars(fx.reach);
    expect(bars).toHaveLength(7);
    expect(bars.find((b) => b.key === "upto_10")).toMatchObject({ value: 5, display: "5 · 36%", sub: "2 people" });
    expect(bars.find((b) => b.key === "beyond")?.color).toBe(CHART.bad);
    expect(bandBars(fx.emptyReach)).toEqual([]);
  });
});

describe("focusing the page on a group", () => {
  const org: MdOrg = {
    branches: [
      { id: 1, name: "Unit 1" },
      { id: 2, name: "Unit 2" },
    ],
    departments: [
      { id: 10, name: "Sales", branchId: 1, branchName: "Unit 1", employees: 3 },
      { id: 11, name: "Sales", branchId: 2, branchName: "Unit 2", employees: 1 },
      { id: 12, name: "Stores", branchId: 1, branchName: "Unit 1", employees: 1 },
    ],
  };

  it("narrows to a department by name", () => {
    expect(focusScope(EVERYONE, "department", { key: "Sales", label: "Sales" })).toEqual({
      ...EVERYONE,
      department: "Sales",
    });
    expect(focusScope({ ...EVERYONE, department: "Sales" }, "department", { key: "Sales", label: "Sales" })).toBeNull();
  });

  it("narrows to staff or production only for a real type", () => {
    expect(focusScope(EVERYONE, "type", { key: "staff", label: "Staff" })).toEqual({ ...EVERYONE, type: "staff" });
    expect(focusScope(EVERYONE, "type", { key: "other", label: "Other" })).toBeNull();
  });

  it("narrows to a unit and drops a department that unit does not have", () => {
    expect(focusScope(EVERYONE, "unit", { key: "Unit 1", label: "Unit 1" }, org)).toEqual({ ...EVERYONE, branch: "1" });
    expect(focusScope({ ...EVERYONE, department: "Stores" }, "unit", { key: "Unit 2", label: "Unit 2" }, org)).toEqual({
      ...EVERYONE,
      branch: "2",
      department: "",
    });
    expect(focusScope({ ...EVERYONE, department: "Sales" }, "unit", { key: "Unit 2", label: "Unit 2" }, org)).toEqual({
      ...EVERYONE,
      branch: "2",
      department: "Sales",
    });
    expect(focusScope(EVERYONE, "unit", { key: "Unit 1", label: "Unit 1" })).toBeNull(); // no unit list yet
    expect(focusScope({ ...EVERYONE, branch: "1" }, "unit", { key: "Unit 1", label: "Unit 1" }, org)).toBeNull();
  });

  it("never focuses on the group of people who have no department or unit", () => {
    expect(focusScope(EVERYONE, "department", { key: NONE_KEY, label: "No department" })).toBeNull();
  });

  it("says how many of a group went out", () => {
    const sales = fx.departments.rows[0];
    expect(participationText(sales)).toBe("3 employees · 100% went out");
    expect(participationText({ ...sales, headcount: 0, people: 2 })).toBe("2 people out");
    expect(participationText({ ...sales, headcount: 0, people: 0 })).toBeNull();
    expect(participationText({ ...sales, participationPct: null })).toBe("3 employees");
  });
});

describe("who is out now", () => {
  const [stale, awaiting, approved] = fx.live.rows;

  it("says where a request stands", () => {
    expect(liveStatus(stale)).toEqual({ label: "Left open", tone: "bad" });
    expect(liveStatus(awaiting)).toEqual({ label: "Awaiting approval", tone: "warn" });
    expect(liveStatus(approved)).toEqual({ label: "Approved", tone: "good" });
  });

  it("says what the phone last reported", () => {
    expect(signalText(approved)).toBe("20 m ago, 5.0 km from the unit");
    expect(signalText(awaiting)).toBe("1 h 30 m ago, 30.0 km from the unit");
    expect(signalText(stale)).toBe("Not tracked");
    expect(signalText({ ...stale, tracked: true })).toBe("No location yet");
    expect(signalText({ ...approved, minutesSinceSeen: 0, distanceFromUnitKm: null, lastSeenMocked: true })).toBe(
      "just now, simulated",
    );
  });

  it("knows when a tracked phone has gone quiet", () => {
    expect(isSilent(approved, 30)).toBe(false);
    expect(isSilent(awaiting, 30)).toBe(true);
    expect(isSilent(stale, 30)).toBe(false); // never tracked: not a missing signal
    expect(isSilent({ ...stale, tracked: true }, 30)).toBe(true);
  });

  it("makes the chips above the list", () => {
    expect(liveChips(fx.live).map((c) => [c.label, c.value])).toEqual([
      ["On duty today", 2],
      ["Left open", 2],
      ["Awaiting approval", 2],
      ["No location signal", 1],
    ]);
  });
});

describe("the assistant", () => {
  it("is given the headline figures in words", () => {
    const ctx = assistantSummary(fx.summary, fx.verification)!;
    expect(ctx["On-duty sessions"]).toBe(10);
    expect(ctx["Share of employees who went out"]).toBe("83%");
    expect(ctx["Verified by HR"]).toBe("57.1%");
    expect(ctx["Median hours to verify"]).toBe(3);
    expect(ctx["Simulated GPS punches"]).toBe(2);
    expect(ctx["Punches waiting for HR now"]).toBe(4);
    expect(assistantSummary(undefined)).toBeUndefined();
  });

  it("is given a null where there is no rate", () => {
    const ctx = assistantSummary(fx.emptySummary)!;
    expect(ctx["Verified by HR"]).toBeNull();
    expect(ctx["Punches waiting for HR now"]).toBeNull();
  });

  it("carries the period and the selection in every question", () => {
    const q = askQuestions("Last 30 days", "Unit 1 · all departments · staff only");
    for (const text of Object.values(q).filter((t) => t.includes("("))) {
      expect(text).toContain("Last 30 days");
    }
    expect(q.attention).toContain("Unit 1 · all departments · staff only");
    expect(askQuestions("Last 30 days", null).page).toContain("(Last 30 days)");
    expect(q.live).toContain("right now");
  });

  it("writes the period and the selection in words", () => {
    expect(periodText({ preset: "last_7_days" })).toBe("Last 7 days");
    expect(periodText({ preset: "custom", from: "2026-09-01", to: "2026-09-14" })).toBe("01 Sep 2026 to 14 Sep 2026");
    expect(scopeText(EVERYONE, "Unit 1 · all departments · staff only")).toBe("Unit 1 · all departments · staff only");
    expect(scopeText({ ...EVERYONE, department: "Sales" })).toBe("All units · Sales · staff and production");
  });
});
