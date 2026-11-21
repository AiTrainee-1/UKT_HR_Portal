import { describe, expect, it } from "vitest";
import {
  applyUrlPatch,
  monthFromParams,
  monthPatch,
  oneOf,
  pageFromParams,
  periodFromParams,
  periodKey,
  periodPatch,
  periodQuery,
  scopeFromParams,
  scopePatch,
} from "./url-filters";

const p = (search: string) => new URLSearchParams(search);
const NOW = new Date(2026, 10, 21);

describe("MD page filters in the address", () => {
  it("sets and removes parameters", () => {
    expect(applyUrlPatch("?a=1&b=2", { a: null, c: 3 })).toBe("?b=2&c=3");
    expect(applyUrlPatch("?a=1", { a: "" })).toBe("");
  });

  it("reads a month that is real and not in the future", () => {
    expect(monthFromParams(p("month=2026-09"), NOW)).toBe("2026-09");
    expect(monthFromParams(p("month=2026-12"), NOW)).toBeNull();
    expect(monthFromParams(p("month=2026-13"), NOW)).toBeNull();
    expect(monthFromParams(p(""), NOW)).toBeNull();
  });

  it("reads a period: a valid custom range, a known preset, else the fallback", () => {
    const fallback = { preset: "last_30_days" } as const;
    expect(periodFromParams(p("from=2026-09-01&to=2026-09-30"), fallback)).toEqual({
      preset: "custom",
      from: "2026-09-01",
      to: "2026-09-30",
    });
    expect(periodFromParams(p("from=2026-09-30&to=2026-09-01"), fallback)).toEqual(fallback);
    expect(periodFromParams(p("period=last_7_days"), fallback)).toEqual({ preset: "last_7_days" });
    expect(periodFromParams(p("period=nonsense"), fallback)).toEqual(fallback);
  });

  it("never sends a period and a month together", () => {
    expect(periodPatch({ preset: "this_month" })).toEqual({ period: "this_month", from: null, to: null, month: null });
    expect(monthPatch("2026-09")).toEqual({ month: "2026-09", period: null, from: null, to: null });
    expect(periodQuery({ preset: "last_7_days" }, "2026-09")).toEqual({ month: "2026-09" });
    expect(periodQuery({ preset: "custom", from: "2026-09-01", to: "2026-09-02" }, null)).toEqual({
      from: "2026-09-01",
      to: "2026-09-02",
    });
    expect(periodKey({ preset: "last_7_days" }, null)).not.toBe(periodKey({ preset: "last_7_days" }, "2026-09"));
  });

  it("reads and writes the scope, and small values", () => {
    expect(scopeFromParams(p("branch=1&department=Stitching&type=staff"))).toEqual({
      branch: "1",
      department: "Stitching",
      type: "staff",
    });
    expect(scopeFromParams(p("type=other")).type).toBe("");
    expect(scopePatch({ branch: "", department: "Cutting", type: "" })).toEqual({
      branch: null,
      department: "Cutting",
      type: null,
    });
    expect(oneOf(p("status=approved"), "status", ["pending", "approved"] as const, "pending")).toBe("approved");
    expect(oneOf(p("status=x"), "status", ["pending", "approved"] as const, "pending")).toBe("pending");
    expect(pageFromParams(p("page=3"))).toBe(3);
    expect(pageFromParams(p("page=0"))).toBe(1);
  });
});
