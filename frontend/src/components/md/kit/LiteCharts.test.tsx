import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Donut, niceTicks, StackedBars, StackedColumns } from "./LiteCharts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const segments = [
  { key: "present", label: "Present", value: 82, color: "var(--a)" },
  { key: "cl", label: "CL", value: 4, color: "var(--b)" },
  { key: "absent", label: "Absent", value: 0, color: "var(--c)" },
];

describe("niceTicks", () => {
  it("gives round steps from 0 that reach the largest value", () => {
    expect(niceTicks(256)).toEqual([0, 100, 200, 300]);
    expect(niceTicks(9)).toEqual([0, 2.5, 5, 7.5, 10]);
    expect(niceTicks(4_528_710)).toEqual([0, 2_000_000, 4_000_000, 6_000_000]);
    expect(niceTicks(0)).toEqual([0, 1]);
  });
});

describe("Donut", () => {
  it("draws one slice per non-empty segment, says what it shows, and keeps its middle", () => {
    act(() =>
      root.render(
        <Donut segments={segments} ariaLabel="Today" testId="ring">
          <span>91%</span>
        </Donut>,
      ),
    );
    const ring = host.querySelector('[data-testid="ring"]')!;
    expect(ring.querySelectorAll("path")).toHaveLength(2);
    expect(ring.querySelector("svg")!.getAttribute("aria-label")).toBe("Today");
    expect(ring.textContent).toContain("91%");
  });

  it("is a full circle for a single segment", () => {
    act(() => root.render(<Donut segments={[segments[0]]} testId="ring" />));
    expect(host.querySelectorAll("path")).toHaveLength(0);
    expect(host.querySelectorAll("circle")).toHaveLength(1);
  });
});

describe("StackedColumns", () => {
  const rows = [
    { day: "11", present: 65, absent: 77 },
    { day: "12", present: 82, absent: 60 },
    { day: "13", present: 0, absent: 0 },
  ];
  const series = [
    { key: "present", label: "Present", color: "var(--a)" },
    { key: "absent", label: "Absent", color: "var(--c)" },
  ];

  it("draws a column per row with its parts, an empty column for an empty row, and the tooltip under the pointer", () => {
    act(() =>
      root.render(
        <StackedColumns
          rows={rows}
          series={series}
          rowKey={(r) => r.day}
          label={(r) => r.day}
          value={(r, key) => r[key as "present" | "absent"]}
          tooltip={(r) => <span>day {r.day}</span>}
          testId="cols"
          ariaLabel="Days"
        />,
      ),
    );
    const cols = host.querySelectorAll<HTMLElement>("[data-col]");
    expect(cols).toHaveLength(3);
    expect(cols[0].querySelectorAll("span")).toHaveLength(2);
    expect(cols[2].querySelectorAll("span")).toHaveLength(0);
    expect(host.querySelector('[data-testid="cols"]')!.getAttribute("aria-label")).toBe("Days");
    act(() => {
      cols[1].dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    });
    expect(host.textContent).toContain("day 12");
  });
});

describe("StackedBars", () => {
  it("makes the longest row full width and gives each row its total", () => {
    act(() =>
      root.render(
        <StackedBars
          testId="bars"
          rows={[
            { key: "a", name: "Unit A", parts: [{ key: "s", label: "Staff", value: 10, color: "var(--a)" }] },
            {
              key: "b",
              name: "Unit B",
              parts: [
                { key: "s", label: "Staff", value: 3, color: "var(--a)" },
                { key: "p", label: "Production", value: 2, color: "var(--b)" },
              ],
            },
          ]}
        />,
      ),
    );
    const rows = host.querySelectorAll("li");
    expect(rows[0].textContent).toContain("10");
    expect(rows[1].textContent).toContain("5");
    const widths = [...host.querySelectorAll<HTMLElement>(".md-grow-x")].map((el) => el.style.width);
    expect(widths).toEqual(["100%", "50%"]);
    expect(rows[1].querySelector('[title="Production: 2"]')).not.toBeNull();
  });
});
