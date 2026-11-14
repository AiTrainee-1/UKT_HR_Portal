// The Payroll page's charts drawn at a real size (jsdom has no layout, so recharts' ResponsiveContainer is given a width
// and height): one bar per month or department in the page's colours, the chosen month at full strength, and a click on
// a bar picking what it stands for.

import { act, cloneElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("recharts", async () => {
  const actual = await vi.importActual<typeof import("recharts")>("recharts");
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement }) =>
      cloneElement(children, { width: 720, height: 300 } as object),
  };
});

import {
  DEDUCTION_COLORS,
  DepartmentChart,
  DeductionTypesChart,
  PAY_COLORS,
  PeopleChart,
  PersonChart,
  SalaryTrendChart,
} from "./charts";
import { CHART } from "@/components/md/kit/chartTheme";
import { departmentsFixture, monthlyFixture, peopleFixture, personFixture } from "./fixtures";
import { deductionRows, departmentBars, flowRows, peopleBars, personChartRows } from "./logic";

let root: Root | undefined;
let host: HTMLElement | undefined;

function render(node: ReactElement) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

const bars = (el: HTMLElement, color: string) =>
  [...el.querySelectorAll<SVGPathElement>(".recharts-bar-rectangle path")].filter(
    (p) => p.getAttribute("fill") === color,
  );

const click = (el: Element) => act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));

const monthly = monthlyFixture(new URLSearchParams());

describe("the salary trend", () => {
  it("stacks the three parts for every month, marks the chosen month, and picks a month on a click", () => {
    const onSelect = vi.fn();
    const el = render(<SalaryTrendChart rows={flowRows(monthly.months, "2026-10")} onSelect={onSelect} />);
    const net = bars(el, PAY_COLORS.netPaid);
    expect(net).toHaveLength(12);
    expect(bars(el, PAY_COLORS.otherDeductions)).toHaveLength(12);
    expect(bars(el, PAY_COLORS.attendanceDeduction)).toHaveLength(12);
    // every month keeps its colours; the chosen one has a band behind it and its name in wine
    expect(el.querySelectorAll(".recharts-reference-area")).toHaveLength(1);
    const wine = [...el.querySelectorAll(".recharts-xAxis text")].filter((t) => t.getAttribute("fill") === CHART.brand);
    expect(wine.map((t) => t.textContent)).toEqual(["Oct"]);
    // the earned salary and company cost lines
    expect(el.querySelectorAll(".recharts-line")).toHaveLength(2);
    click(net[3]);
    expect(onSelect).toHaveBeenCalledWith(monthly.months[3].month);
  });
});

describe("deductions by type", () => {
  it("draws a stack per type and leaves out a type switched off", () => {
    const rows = deductionRows(monthly.months, null);
    const el = render(<DeductionTypesChart rows={rows} hidden={new Set(["pf"])} />);
    expect(bars(el, DEDUCTION_COLORS.lossOfPay)).toHaveLength(12);
    expect(bars(el, DEDUCTION_COLORS.pf)).toHaveLength(0);
  });
});

describe("departments", () => {
  it("draws a bar per department, biggest first, and opens a department on a click", () => {
    const onPick = vi.fn();
    const data = departmentsFixture(new URLSearchParams());
    const el = render(
      <DepartmentChart bars={departmentBars(data.rows)} measure="cost" onPick={onPick} narrow={false} />,
    );
    const cost = bars(el, PAY_COLORS.companyCost);
    expect(cost).toHaveLength(5);
    expect(el.textContent).toContain("Cutting");
    click(cost[0]);
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ department: "Cutting", unit: "Unit 1" }));
  });

  it("splits each department's pay in the 'paid vs deducted' view", () => {
    const data = departmentsFixture(new URLSearchParams());
    const el = render(<DepartmentChart bars={departmentBars(data.rows)} measure="pay" narrow />);
    expect(bars(el, PAY_COLORS.netPaid)).toHaveLength(5);
    expect(bars(el, PAY_COLORS.otherDeductions)).toHaveLength(5);
    // a department with no attendance deduction draws no empty sliver
    expect(bars(el, PAY_COLORS.attendanceDeduction).length).toBeLessThan(5);
  });
});

describe("employees", () => {
  it("compares the people of a page and opens one on a click", () => {
    const onOpen = vi.fn();
    const people = peopleFixture(new URLSearchParams("sort=netPaid&dir=desc"));
    const el = render(<PeopleChart bars={peopleBars(people.rows, 8)} onOpen={onOpen} narrow={false} />);
    const net = bars(el, PAY_COLORS.netPaid);
    expect(net).toHaveLength(8);
    click(net[0]);
    expect(onOpen).toHaveBeenCalledWith(104);
  });

  it("draws one employee's months: actual, earned and net paid bars and the deductions line", () => {
    const onSelect = vi.fn();
    const el = render(<PersonChart rows={personChartRows(personFixture(107).months)} onSelect={onSelect} />);
    expect(bars(el, PAY_COLORS.actualSalary)).toHaveLength(3);
    expect(bars(el, PAY_COLORS.earnedSalary)).toHaveLength(3);
    click(bars(el, PAY_COLORS.netPaid)[0]);
    expect(onSelect).toHaveBeenCalledWith("2026-08");
  });

  it("has no actual salary bars for a production worker", () => {
    const el = render(<PersonChart rows={personChartRows(personFixture(103).months)} />);
    expect(bars(el, PAY_COLORS.actualSalary)).toHaveLength(0);
    expect(bars(el, PAY_COLORS.netPaid)).toHaveLength(14);
  });
});
