import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import LateImageSheet, { IMAGE_WIDTH } from "./LateImageSheet";
import type { LateEntry } from "./late";

// The picture of the Daily Late Report: the same seven columns, title block, summary line and severity colours as the table,
// in the off-screen element the PNG is taken from. (The download itself, a real PNG file, is in e2e/report-log.spec.ts.)

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const entry = (id: number, name: string, minutesLate: number | null): LateEntry => ({
  employeeId: id,
  name,
  code: `E${id}`,
  department: "Admin",
  unit: "HO",
  shiftStart: "09:00",
  grace: 15,
  lateDeadline: "09:15",
  punchIn: "10:00",
  minutesLate,
  minutesAfterStart: minutesLate == null ? null : minutesLate + 15,
});

function draw(entries: LateEntry[], extra: { logoDataUrl?: string | null; filter?: string } = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      createElement(LateImageSheet, {
        testId: "sheet",
        input: {
          date: "2026-08-03",
          entries,
          company: "UK Textiles",
          branchLabel: "All Branches",
          logoDataUrl: extra.logoDataUrl ?? null,
          filter: extra.filter ?? "",
          now: new Date(2026, 9, 26, 11, 45),
        },
      }),
    );
  });
  return host;
}

describe("the Daily Late Report picture", () => {
  const entries = [entry(1, "Babu", 45), entry(2, "Chitra", 19), entry(3, "Anand", 6)];

  it("has the company block, the title and the date, and nothing like the summary or explanation lines", () => {
    const el = draw(entries);
    const text = el.textContent ?? "";
    expect(text).toContain("UK Textiles");
    expect(text).toContain("All Branches");
    expect(text).toContain("Daily Late Report");
    expect(text).toContain("Mon, 3 Aug 2026");
    expect(text).toContain("Generated 26 Oct 2026, 11:45 AM");
    expect(text).not.toContain("Total late");
    expect(text).not.toContain("Average");
    expect(text).not.toContain("Longest");
    expect(text).not.toContain("Total Minutes Late =");
    expect(el.querySelector("[data-testid='sheet-summary']")).toBeNull();
  });

  it("has the seven columns and one row per late employee, with no totals row", () => {
    const el = draw(entries);
    expect(Array.from(el.querySelectorAll("th")).map((th) => th.textContent)).toEqual([
      "Employee Name",
      "Employee Code",
      "Department",
      "Shift Start Time",
      "Grace Period (minutes)",
      "Actual Punch-In Time",
      "Total Minutes Late",
    ]);
    const rows = Array.from(el.querySelectorAll("tbody tr"));
    expect(rows).toHaveLength(3);
    expect(Array.from(rows[0].querySelectorAll("td")).map((td) => td.textContent)).toEqual([
      "Babu",
      "E1",
      "Admin",
      "09:00 AM",
      "15",
      "10:00 AM",
      "45 min",
    ]);
    expect(el.textContent).not.toContain("Total:");
  });

  it("tints the minutes by severity and shows the legend, with none of the old paper-sheet styling", () => {
    const el = draw(entries);
    const chips = Array.from(el.querySelectorAll<HTMLElement>("tbody tr td:last-child span"));
    expect(chips.map((c) => c.textContent)).toEqual(["45 min", "19 min", "6 min"]);
    expect(chips.map((c) => c.style.background)).toEqual([
      "rgb(254, 202, 202)",
      "rgb(254, 215, 170)",
      "rgb(254, 243, 199)",
    ]);
    const text = el.textContent ?? "";
    for (const label of ["1-10 min", "11-30 min", "31+ min"]) expect(text).toContain(label);
    expect(text).not.toContain("STAFF LATE REPORT");
    expect(text).not.toContain("Late Hours");
    expect(el.innerHTML).not.toContain("rgb(255, 255, 0)");
  });

  it("shows a dash for what is missing, the filter in words and the logo when there is one", () => {
    const sparse = { ...entry(4, "No Shift", null), shiftStart: null, grace: null };
    const el = draw([sparse], {
      filter: "Department: Admin",
      logoDataUrl: "data:image/png;base64,iVBORw0KGgo=",
    });
    expect(Array.from(el.querySelectorAll("tbody tr")[0].querySelectorAll("td")).map((td) => td.textContent)).toEqual([
      "No Shift",
      "E4",
      "Admin",
      "—",
      "—",
      "10:00 AM",
      "—",
    ]);
    expect(el.querySelector("[data-testid='sheet-filter']")?.textContent).toBe("Department: Admin");
    expect(el.querySelector("img")).not.toBeNull();
  });

  it("is as wide as its seven columns and grows as tall as the list is long", () => {
    expect(IMAGE_WIDTH).toBe(273 * 4 + 56);
    const el = draw(Array.from({ length: 60 }, (_, i) => entry(i + 1, `Person ${i + 1}`, (i % 45) + 1)));
    expect(el.querySelectorAll("tbody tr")).toHaveLength(60);
  });
});
