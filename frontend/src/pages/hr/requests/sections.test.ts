import { describe, expect, it } from "vitest";
import { focusFromSearch, focusKey, hubKind, requestLinkTarget, searchForSection, sectionFromSearch } from "./sections";

describe("the sections of the Requests page in the address", () => {
  it("reads ?tab=, anything else being the Requests list", () => {
    expect(sectionFromSearch("")).toBe("requests");
    expect(sectionFromSearch("?tab=hods")).toBe("hods");
    expect(sectionFromSearch("tab=notify&kind=leave")).toBe("notify");
    expect(sectionFromSearch("?tab=HODS")).toBe("hods");
    expect(sectionFromSearch("?tab=other")).toBe("requests");
  });

  it("switches the section keeping kind and the rest, and drops focus", () => {
    expect(searchForSection("?kind=leave&focus=4", "hods")).toBe("kind=leave&tab=hods");
    expect(searchForSection("kind=leave&tab=hods", "requests")).toBe("kind=leave");
    expect(searchForSection("", "notify")).toBe("tab=notify");
    expect(searchForSection("", "requests")).toBe("");
  });
});

describe("focus", () => {
  it("reads kind + focus, with the head's attendance category as the hub's attendance_correction", () => {
    expect(focusFromSearch("?kind=leave&focus=12")).toEqual({ kind: "leave", id: 12 });
    expect(focusFromSearch("kind=attendance&focus=3")).toEqual({ kind: "attendance_correction", id: 3 });
    expect(focusFromSearch("?kind=leave")).toBeNull();
    expect(focusFromSearch("?focus=12")).toBeNull();
    expect(focusFromSearch("?kind=leave&focus=abc")).toBeNull();
    expect(focusFromSearch("?kind=leave&focus=-1")).toBeNull();
    expect(focusKey({ kind: "missing_punch", id: 7 })).toBe("missing_punch-7");
    expect(hubKind("  ")).toBeNull();
    expect(hubKind("permission")).toBe("permission");
  });

  it("knows a link to this page from any other address", () => {
    expect(requestLinkTarget("/hr/requests?kind=leave&focus=12")).toEqual({ kind: "leave", id: 12 });
    expect(requestLinkTarget("/hr/requests/?kind=on_duty&focus=2")).toEqual({ kind: "on_duty", id: 2 });
    expect(requestLinkTarget("/hr/compensation?kind=leave&focus=12")).toBeNull();
    expect(requestLinkTarget("/hr/requests")).toBeNull();
    expect(requestLinkTarget("")).toBeNull();
  });
});
