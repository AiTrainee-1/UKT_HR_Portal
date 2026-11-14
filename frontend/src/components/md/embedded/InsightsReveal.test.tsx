import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HideInsightsButton, InsightsReveal } from "./InsightsReveal";

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

/** A stand-in for a page's strip: its header carries the Hide button, as both real strips do. */
function Strip() {
  return (
    <div data-testid="strip">
      <span>MD insights</span>
      <button type="button">Ask AI about this page</button>
      <HideInsightsButton />
      <p>FABRIC attrition is 38.5%</p>
    </div>
  );
}

function Frame() {
  const [open, setOpen] = useState(false);
  return (
    <InsightsReveal open={open} onOpenChange={setOpen}>
      <Strip />
    </InsightsReveal>
  );
}

const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = (el: HTMLElement | null) => act(() => el?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

describe("MD insights, folded by default", () => {
  it("shows only the small card at first; the strip is there but folded away", () => {
    act(() => root.render(<Frame />));
    const show = q("md-insights-show");
    expect(show?.tagName).toBe("BUTTON");
    expect(show?.textContent).toContain("Show insights");
    expect(show?.getAttribute("aria-expanded")).toBe("false");
    const region = q("md-insights-region");
    expect(region?.getAttribute("data-open")).toBe("false");
    expect(show?.getAttribute("aria-controls")).toBe(region?.id);
    // still mounted (its figures load while folded), so opening it is instant
    expect(q("strip")).not.toBeNull();
  });

  it("opens with Show insights, puts the focus on Hide, and folds back with Hide insights", () => {
    act(() => root.render(<Frame />));
    click(q("md-insights-show"));
    expect(q("md-insights-show")).toBeNull();
    expect(q("md-insights-region")?.getAttribute("data-open")).toBe("true");
    const hide = q("md-insights-hide");
    expect(hide?.getAttribute("aria-label")).toBe("Hide insights");
    expect(hide?.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(hide);
    expect(q("strip")?.textContent).toContain("FABRIC attrition");

    click(hide);
    expect(q("md-insights-region")?.getAttribute("data-open")).toBe("false");
    expect(document.activeElement).toBe(q("md-insights-show"));
  });

  it("draws no Hide button for a strip shown on its own (outside the fold)", () => {
    act(() => root.render(<Strip />));
    expect(q("md-insights-hide")).toBeNull();
  });
});
