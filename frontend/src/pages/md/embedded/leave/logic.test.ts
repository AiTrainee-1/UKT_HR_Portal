import { describe, expect, it } from "vitest";
import { permissions, summary, trend } from "./fixtures";
import { daysText, groupParams, kpiTiles, leaveAddress, rowDetail, rowValue, trendRows } from "./logic";
import type { LvListItem } from "./types";

describe("leave logic", () => {
  it("writes days", () => {
    expect(daysText(1)).toBe("1 day");
    expect(daysText(0.5)).toBe("0.5 days");
    expect(daysText(3)).toBe("3 days");
  });

  it("gives the figures their drill-downs, the permission tile only when permissions are known", () => {
    expect(kpiTiles(summary).map((t) => t.id)).toEqual([
      "days",
      "rate",
      "per-head",
      "applied",
      "rejected",
      "short",
      "waiting",
    ]);
    const tiles = kpiTiles(summary, permissions);
    const p = tiles.find((t) => t.id === "permissions");
    expect(p?.value).toBe("2");
    expect(p?.drill?.params).toEqual({ what: "permissions", filter: "excess" });
    expect(tiles.find((t) => t.id === "waiting")?.tone).toBe("red");
  });

  it("narrows the leave-taken list to a group", () => {
    expect(groupParams("type", { key: "x:casual", label: "Casual (untyped)" })).toEqual({
      leaveType: "Casual (untyped)",
    });
    expect(groupParams("department", { key: "__none__", label: "No department" })).toEqual({ dept: "__none__" });
    expect(groupParams("reason", { key: "Sick Leave", label: "Sick Leave" })).toEqual({ reason: "Sick Leave" });
  });

  it("lines the previous period up beside the trend", () => {
    const rows = trendRows(trend);
    expect(rows[1]).toMatchObject({ date: "2026-11-10", previous: 1, "x:casual": 1 });
  });

  it("describes a drill-down row", () => {
    const row = {
      type: "Sick",
      from: "2026-11-09",
      to: "2026-11-11",
      daysInPeriod: 3,
      status: "approved",
    } as LvListItem;
    expect(rowDetail(row)).toBe("Sick · 09 Nov 2026 to 11 Nov 2026 · 3 days");
    expect(rowValue(row)).toEqual({ text: "Approved", tone: "md-analytics-tone-good" });
    expect(rowValue({ status: "pending", waitingDays: 8 } as LvListItem)?.text).toBe("Waiting 8 days");
    expect(leaveAddress("permissions")).toBe("/md/leave?tab=permissions");
  });
});
