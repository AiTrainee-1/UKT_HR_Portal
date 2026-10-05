// The two hand-built charts, rendered at a fixed size (jsdom has no layout, so recharts' ResponsiveContainer is given a
// width and height): proves the waterfall draws one bar per step in the right colour with its amount above it, and the
// histogram draws one column per band.

import { act, cloneElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildWaterfall } from "./logic";
import { distributionFixture } from "./fixtures";
import type { BridgeStep } from "./types";

vi.mock("recharts", async () => {
  const actual = await vi.importActual<typeof import("recharts")>("recharts");
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement }) =>
      cloneElement(children, { width: 720, height: 300 } as object),
  };
});

import DistributionCard from "./DistributionCard";
import WaterfallChart from "./WaterfallChart";

const step = (id: BridgeStep["id"], amount: number, people: number): BridgeStep => ({
  id,
  label: id,
  amount,
  people,
  detail: "",
});
const STEPS: BridgeStep[] = [
  step("joined", 15000, 1),
  step("left", -40000, 1),
  step("rate", 2480, 2),
  step("overtime", 1000, 1),
  step("attendance", -1392.31, 3),
  step("oneoffs", 0, 0),
  step("other", -1000, 1),
];

let root: Root | undefined;
let container: HTMLElement | undefined;

function render(node: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

const labels = (c: HTMLElement) => [...c.querySelectorAll("text")].map((t) => t.textContent);

describe("the waterfall", () => {
  const bars = buildWaterfall({ label: "Aug 2026 gross pay", amount: 134500 }, STEPS, {
    label: "Sep 2026 gross pay",
    amount: 110587.69,
  });

  it("draws a bar per step, red where cost rises, green where it falls, blue for the totals", () => {
    const c = render(<WaterfallChart bars={bars} />);
    expect(c.querySelectorAll('path[fill="#ef4444"]')).toHaveLength(3); // joined, pay rate, overtime
    expect(c.querySelectorAll('path[fill="#22c55e"]')).toHaveLength(3); // left, attendance, other
    expect(c.querySelectorAll('path[fill="#006496"]')).toHaveLength(2); // the two totals
  });

  it("writes each bar's amount above it, with the sign on a step", () => {
    const c = render(<WaterfallChart bars={bars} />);
    const text = labels(c);
    for (const expected of ["₹1.3 L", "+₹15,000", "-₹40,000", "+₹2,480", "+₹1,000", "-₹1,392", "-₹1,000", "₹1.1 L"]) {
      expect(text, expected).toContain(expected);
    }
    // the zero step (nothing and nobody) is not drawn
    expect(c.textContent).not.toContain("One-offs");
  });

  it("labels the columns with short names and says the axis does not start at zero", () => {
    const c = render(<WaterfallChart bars={bars} />);
    const text = labels(c);
    for (const expected of ["Aug 2026", "Joined", "Left", "Pay rate", "Overtime", "Attendance", "Other", "Sep 2026"]) {
      expect(text, expected).toContain(expected);
    }
    expect(c.querySelector('[data-testid="md-payroll-waterfall-axis-note"]')?.textContent).toContain("not zero");
  });

  it("scrolls sideways inside its card rather than squeezing its labels on a phone", () => {
    const c = render(<WaterfallChart bars={bars} />);
    const inner = c.querySelector<HTMLElement>('[data-testid="md-payroll-waterfall-chart"]')!;
    expect(inner.style.minWidth).toBe("540px");
    expect(inner.parentElement!.className).toContain("overflow-x-auto");
  });
});

describe("the pay histogram", () => {
  it("draws one column per band with its count above it", () => {
    const query = { data: distributionFixture, isPending: false, isError: false } as never;
    const c = render(<DistributionCard query={query} label="Sep 2026" />);
    const text = labels(c);
    for (const tick of ["Nil", "<10k", "10k–15k", "15k–20k", "20k–25k", "25k–30k"]) expect(text, tick).toContain(tick);
    expect(text).toContain("3"); // three people in ₹15k–20k
    // four of the six bands have people in them; an empty band draws no bar
    expect(c.querySelectorAll('path[fill="#006496"]')).toHaveLength(4);
  });
});
