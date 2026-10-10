// The pieces the money pages are built from: the segmented switch, the change chip, the state colours and the report
// category tones. They carry the skin (md-theme/areas/money.css), so what these tests pin is the contract with that file:
// the roles a screen reader hears, the classes the CSS paints, and that no old colour name has crept back in.

import fs from "node:fs";
import path from "node:path";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CATEGORY_STYLE } from "@/pages/hr/report-center/report-icons";
import { categoryTone } from "../reports/category-tone";
import { STATE_STYLE } from "./logic";
import { Delta, SegTabs, toneClass } from "./parts";
import type { PayrollState } from "./types";

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

describe("the segmented switch", () => {
  const items = [
    { value: "all", label: "All", count: 14 },
    { value: "zero-pay", label: "Zero pay", count: 3 },
  ];

  it("is a tablist of tabs, the chosen one selected, each with its count", () => {
    const c = render(<SegTabs label="Kind" items={items} value="zero-pay" onChange={() => {}} />);
    expect(c.querySelector('[role="tablist"]')?.getAttribute("aria-label")).toBe("Kind");
    const tabs = [...c.querySelectorAll<HTMLElement>('[role="tab"]')];
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["false", "true"]);
    expect(tabs.map((t) => t.textContent)).toEqual(["All14", "Zero pay3"]);
    expect(tabs.every((t) => t.className.includes("md-seg-item"))).toBe(true);
    // the chosen item is held wine even while the pointer is over it (see .md-money-seg-on)
    expect(tabs.map((t) => t.className.includes("md-money-seg-on"))).toEqual([false, true]);
  });

  it("reports the option that is clicked", () => {
    const onChange = vi.fn();
    const c = render(<SegTabs label="Kind" items={items} value="all" onChange={onChange} />);
    act(() => c.querySelectorAll<HTMLElement>('[role="tab"]')[1].click());
    expect(onChange).toHaveBeenCalledWith("zero-pay");
  });
});

describe("the change chip", () => {
  it("is sage for good news, crimson for bad news and plain when it is neither, and says it in its arrow and sign too", () => {
    const c = render(
      <>
        <Delta text="-3.0%" tone="good" direction="down" />
        <Delta text="+8.0%" tone="bad" direction="up" />
        <Delta text="0.0%" tone="neutral" direction="flat" />
      </>,
    );
    const chips = [...c.querySelectorAll<HTMLElement>("[data-tone]")];
    expect(chips.map((x) => x.getAttribute("data-tone"))).toEqual(["good", "bad", "neutral"]);
    expect(chips[0].className).toContain("md-chip-success");
    expect(chips[1].className).toContain("md-chip-danger");
    expect(chips[2].className).not.toMatch(/md-chip-(success|danger)/);
    expect(chips.every((x) => x.querySelector("svg"))).toBe(true);
    expect(chips.map((x) => x.textContent)).toEqual(["-3.0%", "+8.0%", "0.0%"]);
  });
});

describe("the colour of a payroll month's state", () => {
  const states = Object.keys(STATE_STYLE) as PayrollState[];

  it("uses the palette, never a Tailwind colour name", () => {
    for (const state of states) {
      const { chip, dot } = STATE_STYLE[state];
      expect(`${chip} ${dot}`, state).not.toMatch(/\b(green|amber|blue|red|slate|gray|emerald)-\d/);
      expect(chip, state).toMatch(/^md-(chip|money-pill)-/);
      expect(dot, state).toMatch(/^bg-md-/);
    }
  });

  it("keeps sage, ochre and crimson for paid, part paid and not generated", () => {
    expect(STATE_STYLE.paid.chip).toBe("md-chip-success");
    expect(STATE_STYLE.part_paid.chip).toBe("md-chip-warning");
    expect(STATE_STYLE.not_generated.chip).toBe("md-chip-danger");
    // nothing else is allowed to borrow those three meanings
    const meaning = states.filter((s) => /success|warning|danger/.test(STATE_STYLE[s].chip));
    expect(meaning.sort()).toEqual(["not_generated", "paid", "part_paid"]);
  });
});

describe("the report category tones", () => {
  it("gives every category the Report Center knows a tone of its own, and a quiet one to a stranger", () => {
    for (const id of Object.keys(CATEGORY_STYLE)) {
      const { tone, dot } = categoryTone(id);
      expect(tone, id).toMatch(/^md-money-t-/);
      expect(dot, id).toMatch(/^bg-md-/);
    }
    expect(categoryTone("no-such-category")).toBe(categoryTone("admin"));
  });

  it("leaves sage, ochre and crimson to the status colours", () => {
    for (const id of Object.keys(CATEGORY_STYLE)) {
      expect(categoryTone(id).tone, id).not.toMatch(/success|warning|danger/);
    }
  });

  it("names tones the CSS defines", () => {
    expect(toneClass("wine")).toBe("md-money-t-wine");
    expect(categoryTone("md").tone).toBe(toneClass("wine"));
    const css = fs.readFileSync(path.resolve(import.meta.dirname, "../../../md-theme/areas/money.css"), "utf8");
    const named = new Set([...Object.keys(CATEGORY_STYLE), "no-such-category"].map((id) => categoryTone(id).tone));
    for (const tone of [
      "wine",
      "ink",
      "rose",
      "info",
      "mauve",
      "clay",
      "sky",
      "neutral",
      "success",
      "warning",
      "danger",
    ]) {
      named.add(toneClass(tone as Parameters<typeof toneClass>[0]));
    }
    for (const cls of named) expect(css, cls).toContain(`.${cls} {`);
  });
});
