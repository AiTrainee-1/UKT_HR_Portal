// The status banner and the month strip in HR's staff month workflow (2026-11-10): a month still open, Payroll Done
// with the payment pending, and Paid on a date; Cleared shown as "verified", never as paid; held salaries, new joiners
// waiting and people paid separately as small counts. Rendered on their own (the page renders them with its queries).

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import StatusBanner from "./StatusBanner";
import StatusStrip from "./StatusStrip";
import { finalizedStatus, openStatus, paidStatus, sepStatus, statusFixture } from "./fixtures";
import type { PayrollStatus } from "./types";

let root: Root | undefined;
let container: HTMLElement | undefined;

function render(node: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}

const text = (c: HTMLElement, id: string) => c.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe("the status banner", () => {
  it("a month still open: verified is a count, nothing is paid", () => {
    const c = render(<StatusBanner status={openStatus} />);
    expect(c.querySelector('[data-testid="md-payroll-status-banner"]')?.getAttribute("data-state")).toBe("generated");
    expect(text(c, "md-payroll-status-banner")).toContain("Generated, still open");
    expect(text(c, "md-payroll-status-detail")).toContain("Payroll Done has not been pressed");
    expect(text(c, "md-payroll-status-fact-cleared")).toBe("2 of 8 verified");
    expect(text(c, "md-payroll-status-banner")).not.toContain("Paid");
  });

  it("Payroll Done: payment pending for N days, with the held salary and the new joiner waiting", () => {
    const c = render(<StatusBanner status={finalizedStatus} />);
    expect(text(c, "md-payroll-status-banner")).toContain("Payroll Done · payment pending");
    expect(text(c, "md-payroll-status-detail")).toContain("Payment pending for 5 days");
    expect(text(c, "md-payroll-status-fact-hold")).toBe("1 on hold · ₹17,865");
    expect(text(c, "md-payroll-status-fact-joiners")).toBe("1 new joiner waiting");
    const dates = text(c, "md-payroll-status-dates");
    expect(dates).toContain("Payroll Done07 Oct 2026, 3:00 pm");
    expect(dates).not.toContain("Marked paid");
  });

  it("Paid: the Mark as Paid date and the people paid separately", () => {
    const c = render(<StatusBanner status={paidStatus} />);
    expect(text(c, "md-payroll-status-detail")).toBe("HR marked it as paid on 09 Oct 2026, 2 days after Payroll Done.");
    expect(text(c, "md-payroll-status-dates")).toContain("Marked paid09 Oct 2026, 11:00 am");
    expect(text(c, "md-payroll-status-fact-separately")).toBe("1 paid separately");
  });

  it("an answer from before the workflow still reads as it did", () => {
    const c = render(<StatusBanner status={sepStatus} />);
    expect(text(c, "md-payroll-status-detail")).toBe("6 of 8 slips are not marked paid (₹63,145 net pay).");
    expect(c.querySelector('[data-testid="md-payroll-status-facts"]')).toBeNull();
    expect(text(c, "md-payroll-status-dates")).toContain("Last marked paid");
  });

  it("uses no text smaller than 11px", () => {
    const c = render(<StatusBanner status={finalizedStatus} />);
    for (const el of Array.from(c.querySelectorAll("[class]"))) {
      for (const m of el.getAttribute("class")!.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) {
        expect(Number(m[1]), el.outerHTML.slice(0, 80)).toBeGreaterThanOrEqual(11);
      }
    }
  });
});

describe("the month strip", () => {
  const months = statusFixture.months.map((m) =>
    m.month === "2026-09" ? finalizedStatus : m.month === "2026-08" ? { ...paidStatus, month: "2026-08" } : m,
  );
  const data: PayrollStatus = { ...statusFixture, months };
  const query = { data, isPending: false, isError: false } as never;

  it("says how long the payment has been pending and keeps the legend honest about Cleared", () => {
    const c = render(<StatusStrip query={query} selected="2026-09" onSelect={() => undefined} />);
    const sep = c.querySelector('[data-testid="md-payroll-status-2026-09"]')!;
    expect(sep.getAttribute("data-state")).toBe("finalized");
    expect(sep.textContent).toContain("Payment pending");
    expect(sep.textContent).toContain("Pending 5 days");
    expect(sep.textContent).toContain("₹1.1 L unpaid");
    expect(text(c, "md-payroll-status-2026-08")).toContain("Paid");
    expect(text(c, "md-payroll-status-strip")).toContain("Cleared alone is a check, not a payment");
    for (const el of Array.from(c.querySelectorAll("[class]"))) {
      for (const m of el.getAttribute("class")!.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) {
        expect(Number(m[1])).toBeGreaterThanOrEqual(11);
      }
    }
  });
});
