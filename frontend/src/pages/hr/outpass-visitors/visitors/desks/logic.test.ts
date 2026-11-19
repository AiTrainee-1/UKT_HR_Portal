import { describe, expect, it } from "vitest";
import {
  DESK_PAGE_DEFAULTS,
  deskSignInAddress,
  recordFilterCount,
  recordsQuery,
  recordsSummary,
  type DeskPageValues,
} from "./logic";

// 14 Oct 2026, 11:30 in India (a Wednesday)
const NOW = new Date("2026-10-14T06:00:00Z");
const values = (patch: Partial<DeskPageValues> = {}): DeskPageValues => ({ ...DESK_PAGE_DEFAULTS, ...patch });

describe("Manage Reception logic", () => {
  it("the one desk sign-in address", () => {
    expect(deskSignInAddress("http://localhost:5173")).toBe("http://localhost:5173/reception-login");
    expect(deskSignInAddress("https://hrms.example/")).toBe("https://hrms.example/reception-login");
  });

  it("asks for the chosen desk's records of this month by default, with paging", () => {
    expect(Object.fromEntries(recordsQuery(values(), 21, { now: NOW }))).toEqual({
      deskId: "21",
      from: "2026-10-01",
      to: "2026-10-14",
      page: "1",
      pageSize: "25",
    });
  });

  it("All desks sends the Desk filter only when one is picked; an export has no paging", () => {
    expect(recordsQuery(values(), "all", { now: NOW }).has("deskId")).toBe(false);
    const q = recordsQuery(
      values({ recDesk: "22", recType: "check_out", recQ: "audit", recRange: "custom", recFrom: "2026-10-02" }),
      "all",
      { paging: false, now: NOW },
    );
    expect(Object.fromEntries(q)).toEqual({ deskId: "22", from: "2026-10-02", type: "check_out", q: "audit" });
    // a chosen desk wins over a leftover Desk filter
    expect(recordsQuery(values({ recDesk: "22" }), 21, { now: NOW }).get("deskId")).toBe("21");
    expect(recordsQuery(values({ recRange: "all" }), 21, { now: NOW }).has("from")).toBe(false);
  });

  it("counts the record filters (the dates once) and words the summary", () => {
    expect(recordFilterCount(values())).toBe(0);
    expect(recordFilterCount(values({ recRange: "custom", recFrom: "2026-10-02", recType: "check_in" }))).toBe(2);
    expect(recordFilterCount(values({ desk: "21", deskQ: "front", recPage: "3" }))).toBe(0);
    expect(recordsSummary(1, { checkIns: 1, checkOuts: 0, total: 1 })).toBe("1 record · 1 check-in · 0 check-outs");
    expect(recordsSummary(1200, undefined)).toBe("1,200 records");
  });
});
