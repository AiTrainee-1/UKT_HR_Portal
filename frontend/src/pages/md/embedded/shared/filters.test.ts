import { describe, expect, it } from "vitest";
import {
  filterParams,
  readFilters,
  thisMonth,
  whenLabel,
  whenParams,
  writeFilters,
  type InsightsDefaults,
} from "./filters";

const NOW = new Date(2026, 10, 21); // 21 Nov 2026

describe("Insights filters", () => {
  it("asks for the running month as this_month and an earlier month as the whole month", () => {
    expect(whenParams({ mode: "month", month: "2026-11" }, NOW)).toEqual({ period: "this_month" });
    expect(whenParams({ mode: "month", month: "2026-10" }, NOW)).toEqual({ month: "2026-10" });
    expect(whenParams({ mode: "period", period: { preset: "last_7_days" } }, NOW)).toEqual({ period: "last_7_days" });
    expect(
      whenParams({ mode: "period", period: { preset: "custom", from: "2026-11-01", to: "2026-11-15" } }, NOW),
    ).toEqual({ from: "2026-11-01", to: "2026-11-15" });
  });

  it("says the month or period in words", () => {
    expect(whenLabel({ mode: "month", month: "2026-11" }, NOW)).toBe("Nov 2026 (so far)");
    expect(whenLabel({ mode: "month", month: "2025-12" }, NOW)).toBe("Dec 2025");
    expect(whenLabel({ mode: "period", period: { preset: "last_30_days" } }, NOW)).toBe("Last 30 days");
  });

  it("sends the scope and only the extras that are chosen", () => {
    const params = filterParams(
      {
        when: { mode: "month", month: "2026-09" },
        scope: { branch: "1", department: "Stitching", type: "staff" },
        extra: { kind: "leave", gate: "" },
      },
      NOW,
    );
    expect(params).toEqual({ month: "2026-09", branch: "1", department: "Stitching", type: "staff", kind: "leave" });
  });

  it("reads the address, falling back to the defaults for anything missing or unusable", () => {
    const defaults: InsightsDefaults = { extra: { kind: "all" } };
    expect(readFilters("", defaults, NOW)).toEqual({
      when: thisMonth(NOW),
      scope: { branch: "", department: "", type: "" },
      extra: { kind: "all" },
    });
    const read = readFilters(
      "?tab=x&i.month=2026-08&i.unit=2&i.dept=Accounts&i.type=production&i.kind=leave",
      defaults,
      NOW,
    );
    expect(read.when).toEqual({ mode: "month", month: "2026-08" });
    expect(read.scope).toEqual({ branch: "2", department: "Accounts", type: "production" });
    expect(read.extra).toEqual({ kind: "leave" });
    // a month in the future, a bad type and an unknown preset are ignored
    const bad = readFilters("?i.month=2027-01&i.type=boss&i.period=forever", {}, NOW);
    expect(bad.when).toEqual(thisMonth(NOW));
    expect(bad.scope.type).toBe("");
    expect(readFilters("?i.period=last_7_days", {}, NOW).when).toEqual({
      mode: "period",
      period: { preset: "last_7_days" },
    });
    expect(readFilters("?i.from=2026-11-01&i.to=2026-11-10", {}, NOW).when).toEqual({
      mode: "period",
      period: { preset: "custom", from: "2026-11-01", to: "2026-11-10" },
    });
  });

  it("writes only what differs from the defaults and keeps the HR page's own parameters", () => {
    const defaults: InsightsDefaults = { extra: { kind: "all" } };
    expect(writeFilters("?kind=leave", readFilters("", defaults, NOW), defaults, NOW)).toBe("?kind=leave");
    const written = writeFilters(
      "?tab=monthly&i.month=2026-01",
      {
        when: { mode: "month", month: "2026-10" },
        scope: { branch: "1", department: "", type: "staff" },
        extra: { kind: "permission" },
      },
      defaults,
      NOW,
    );
    expect(written).toBe("?tab=monthly&i.month=2026-10&i.unit=1&i.type=staff&i.kind=permission");
    // and it reads back to the same filters
    expect(readFilters(written, defaults, NOW)).toEqual({
      when: { mode: "month", month: "2026-10" },
      scope: { branch: "1", department: "", type: "staff" },
      extra: { kind: "permission" },
    });
    expect(
      writeFilters(
        "",
        {
          when: { mode: "period", period: { preset: "custom", from: "2026-11-01", to: "2026-11-02" } },
          scope: { branch: "", department: "", type: "" },
          extra: {},
        },
        {},
        NOW,
      ),
    ).toBe("?i.from=2026-11-01&i.to=2026-11-02");
  });

  it("lets a page that defaults to a type be widened to everyone again", () => {
    const defaults: InsightsDefaults = { scope: { branch: "", department: "", type: "staff" } };
    const everyone = { when: thisMonth(NOW), scope: { branch: "", department: "", type: "" as const }, extra: {} };
    const written = writeFilters("", everyone, defaults, NOW);
    expect(written).toBe("?i.type=");
    expect(readFilters(written, defaults, NOW).scope.type).toBe("");
  });
});
