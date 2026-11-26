import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { InProgressChip } from "./index";

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

function mount(node: React.ReactElement): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

describe("InProgressChip", () => {
  it("says In progress with a pulsing dot, and when the day is counted as its tooltip and for a screen reader", () => {
    const el = mount(createElement(InProgressChip, { provisionalUntil: "2026-11-26T18:11:00+05:30" }));
    const chip = el.querySelector<HTMLElement>('[data-testid="in-progress-chip"]')!;
    expect(chip).not.toBeNull();
    expect(chip.dataset.inProgress).toBe("true");
    expect(chip.getAttribute("title")).toBe("Counted after the shift ends at 18:11");
    expect(chip.textContent).toBe("In progress. Counted after the shift ends at 18:11");
    expect(chip.querySelector(".sr-only")!.textContent).toContain("18:11");
    // the pulse respects reduced motion; the chip is neutral, never a verdict colour
    expect(chip.querySelector(".motion-safe\\:animate-ping")).not.toBeNull();
    expect(chip.className).toContain("bg-slate-50");
    expect(chip.className).not.toMatch(/emerald|amber|red-/);
  });

  it("works without a moment, takes a size, a class and its own test id", () => {
    const el = mount(createElement(InProgressChip, { size: "sm", className: "mt-1", testId: "x-chip" }));
    const chip = el.querySelector<HTMLElement>('[data-testid="x-chip"]')!;
    expect(chip.getAttribute("title")).toBe("Counted after the shift ends");
    expect(chip.className).toContain("text-[10px]");
    expect(chip.className).toContain("mt-1");
  });
});
