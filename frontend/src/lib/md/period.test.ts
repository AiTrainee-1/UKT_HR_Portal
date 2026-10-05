import { describe, expect, it } from "vitest";
import {
  COMMON_PRESETS,
  PRESET_LABEL,
  describeScope,
  EVERYONE,
  isValidCustom,
  periodParams,
  scopeIsEveryone,
  scopeParams,
} from "./period";

describe("period parameters", () => {
  it("sends a preset by name and a custom range as from/to", () => {
    expect(periodParams({ preset: "last_30_days" })).toEqual({ period: "last_30_days" });
    expect(periodParams({ preset: "custom", from: "2026-09-01", to: "2026-09-30" })).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
    });
  });

  it("accepts only complete, ordered dates for a custom range", () => {
    expect(isValidCustom("2026-09-01", "2026-09-30")).toBe(true);
    expect(isValidCustom("2026-09-30", "2026-09-30")).toBe(true);
    expect(isValidCustom("2026-10-01", "2026-09-30")).toBe(false);
    expect(isValidCustom("", "2026-09-30")).toBe(false);
    expect(isValidCustom("2026-9-1", "2026-09-30")).toBe(false);
  });

  it("labels every preset the pages offer", () => {
    for (const preset of COMMON_PRESETS) expect(PRESET_LABEL[preset]).toBeTruthy();
  });
});

describe("scope", () => {
  it("sends only what is chosen", () => {
    expect(scopeParams(EVERYONE)).toEqual({});
    expect(scopeParams({ branch: "2", department: "Stitching", type: "staff" })).toEqual({
      branch: "2",
      department: "Stitching",
      type: "staff",
    });
    expect(scopeParams({ branch: "", department: "Cutting", type: "" })).toEqual({ department: "Cutting" });
  });

  it("knows when it is everyone", () => {
    expect(scopeIsEveryone(EVERYONE)).toBe(true);
    expect(scopeIsEveryone({ ...EVERYONE, type: "production" })).toBe(false);
  });

  it("describes the scope in words", () => {
    expect(describeScope(EVERYONE)).toBe("All units · all departments · staff and production");
    expect(describeScope({ branch: "1", department: "Cutting", type: "production" }, "Unit 1", "Cutting")).toBe(
      "Unit 1 · Cutting · production only",
    );
    expect(describeScope({ branch: "1", department: "x", type: "staff" })).toBe(
      "one unit · one department · staff only",
    );
  });
});
