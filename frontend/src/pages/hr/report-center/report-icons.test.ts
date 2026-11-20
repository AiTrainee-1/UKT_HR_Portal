import { FileText } from "lucide-react";
import { describe, expect, it } from "vitest";
import { CATEGORY_STYLE, categoryStyle, iconFor } from "./report-icons";

describe("report icons", () => {
  it("knows the icons of the new categories (Shift: Clock, Customise: SlidersHorizontal)", () => {
    expect(iconFor("Clock")).not.toBe(FileText);
    expect(iconFor("SlidersHorizontal")).not.toBe(FileText);
    expect(iconFor("SlidersHorizontal")).not.toBe(iconFor("Clock"));
  });

  it("falls back to a document for an unknown or missing name", () => {
    expect(iconFor("NoSuchIcon")).toBe(FileText);
    expect(iconFor(null)).toBe(FileText);
    expect(iconFor(undefined)).toBe(FileText);
  });
});

describe("category colours", () => {
  it("gives Shift and Customise colours of their own, apart from every other category", () => {
    for (const id of ["shift", "customise"]) {
      expect(categoryStyle(id)).toBe(CATEGORY_STYLE[id]);
      const others = Object.entries(CATEGORY_STYLE).filter(([k]) => k !== id);
      expect(others.map(([, s]) => s.dot)).not.toContain(CATEGORY_STYLE[id].dot);
    }
    expect(categoryStyle("shift").dot).toBe("bg-cyan-500");
    expect(categoryStyle("customise").dot).toBe("bg-purple-500");
  });

  it("keeps every existing category as it was", () => {
    expect(categoryStyle("payroll").dot).toBe("bg-emerald-500");
    expect(categoryStyle("attendance").dot).toBe("bg-sky-500");
    expect(categoryStyle("employees").dot).toBe("bg-indigo-500");
    expect(categoryStyle("hr").dot).toBe("bg-teal-500");
    expect(categoryStyle("unknown")).toBe(CATEGORY_STYLE.admin);
  });
});
