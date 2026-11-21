import { describe, expect, it } from "vitest";
import { summary } from "./fixtures";
import { deltaOf, hoursText, kpiTiles, requestedText, requestsAddress, standingText } from "./logic";
import type { RqListItem } from "./types";

describe("requests logic", () => {
  it("says a length of time the way the MD would", () => {
    expect(hoursText(0.25)).toBe("15 minutes");
    expect(hoursText(1)).toBe("1 hour");
    expect(hoursText(24)).toBe("24 hours");
    expect(hoursText(240)).toBe("10 days");
    expect(hoursText(null)).toBe("—");
  });

  it("writes the date a request is for", () => {
    expect(
      requestedText({
        from: "2026-11-17",
        to: "2026-11-18",
        note: "2 days",
        label: "Requested dates",
        precision: "day",
      }),
    ).toBe("17 Nov 2026 to 18 Nov 2026 · 2 days");
    expect(requestedText({ from: "2026-12-01", to: null, note: null, label: "Deduct from", precision: "month" })).toBe(
      "Dec 2026",
    );
    expect(requestedText(null)).toBeNull();
  });

  it("says where a request stands", () => {
    const base = { holder: "hod", holderLabel: "Department Head", ageHours: 30, outcome: "waiting" } as RqListItem;
    expect(standingText(base)).toBe("Waiting 30 hours, with the Department Head");
    expect(
      standingText({
        ...base,
        outcome: "approved",
        partial: true,
        decidedBy: "Priya",
        decisionHours: 24,
      } as RqListItem),
    ).toBe("Approved in part by Priya in 24 hours");
  });

  it("colours a change by whether it is good news", () => {
    expect(deltaOf({ value: 24, previous: 2, change: { abs: 22, pct: 1100 } }, { higherIsBetter: false })).toEqual({
      text: "+22 (+1100%)",
      tone: "bad",
      direction: "up",
    });
    expect(
      deltaOf({ value: 40, previous: 50, change: { abs: -10, pct: -20 } }, { higherIsBetter: null, points: true }),
    ).toEqual({
      text: "-10 pts",
      tone: "neutral",
      direction: "down",
    });
  });

  it("gives every figure but the speed a drill-down", () => {
    const tiles = kpiTiles(summary);
    expect(tiles.map((t) => t.id)).toEqual([
      "waiting",
      "aged",
      "hod",
      "submitted",
      "decided",
      "approval",
      "rejected",
      "speed",
    ]);
    expect(tiles.find((t) => t.id === "aged")?.drill?.params).toEqual({ status: "waiting", band: "aged" });
    expect(tiles.find((t) => t.id === "speed")?.drill).toBeUndefined();
    expect(tiles.find((t) => t.id === "aged")?.tone).toBe("red");
  });

  it("opens the Requests page on a kind and a request", () => {
    expect(requestsAddress("leave", 12)).toBe("/md/requests?kind=leave&focus=12");
    expect(requestsAddress("all", 12)).toBe("/md/requests");
  });
});
