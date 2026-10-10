import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MdInsightDto } from "@/lib/md/types";
import BriefingList from "./BriefingList";
import { StripFigure, StripInsights, StripNote } from "./InsightStrip";
import SegTabs from "./SegTabs";

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

const render = (node: ReactNode) => act(() => root.render(node));

describe("SegTabs", () => {
  const items = [
    { value: "a", label: "Departments", count: 12 },
    { value: "b", label: "Units" },
  ];

  it("is a tablist of buttons with the chosen one selected, and a count after the label", () => {
    render(<SegTabs items={items} value="a" onChange={() => {}} label="Group by" />);
    const list = host.querySelector('[role="tablist"]');
    expect(list?.getAttribute("aria-label")).toBe("Group by");
    const tabs = [...host.querySelectorAll<HTMLElement>('button[role="tab"]')];
    expect(tabs.map((t) => t.textContent)).toEqual(["Departments12", "Units"]);
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false"]);
    expect(tabs[0].className).toContain("md-seg-item");
  });

  it("tells the page which view was chosen", () => {
    const onChange = vi.fn();
    render(<SegTabs items={items} value="a" onChange={onChange} />);
    act(() => host.querySelectorAll<HTMLElement>('[role="tab"]')[1].click());
    expect(onChange).toHaveBeenCalledWith("b");
  });
});

describe("the insights strip", () => {
  const item = (severity: MdInsightDto["severity"], title: string, ask?: string): MdInsightDto => ({
    id: title,
    severity,
    title,
    detail: "because",
    ask,
  });

  it("names every severity dot for a screen reader and puts the words beside it", () => {
    render(
      <StripInsights
        testId="list"
        items={[item("critical", "A"), item("warning", "B"), item("info", "C"), item("good", "D", "Explain D")]}
      />,
    );
    const dots = [...host.querySelectorAll<HTMLElement>('[data-testid="list"] [role="img"]')];
    expect(dots.map((d) => d.getAttribute("aria-label"))).toEqual([
      "Critical",
      "Needs attention",
      "For your information",
      "Good news",
    ]);
    expect(dots[0].className).toContain("md-analytics-tone-bad");
    expect(dots[1].className).toContain("md-analytics-tone-watch");
    expect(host.querySelectorAll('[data-testid="list"] li')[0].textContent).toContain("A — because");
    expect(host.querySelectorAll('[data-testid="ask-ai"]')).toHaveLength(1); // only the item with a question
  });

  it("draws nothing for an empty list", () => {
    render(<StripInsights testId="list" items={[]} />);
    expect(host.querySelector('[data-testid="list"]')).toBeNull();
  });

  it("puts a figure's value straight after its label, with the note in its tone", () => {
    render(
      <StripFigure testId="fig" label="Absences followed up" value="44.4%">
        <StripNote tone="bad">-22.3 pts</StripNote>
      </StripFigure>,
    );
    expect(host.querySelector('[data-testid="fig"]')?.textContent).toBe("Absences followed up44.4%-22.3 pts");
    expect(host.querySelector(".md-analytics-figure-note")?.className).toContain("md-analytics-tone-bad");
  });
});

describe("BriefingList", () => {
  it("leads each sentence with a dot in the tone the server gave it", () => {
    render(
      <BriefingList
        testIdPrefix="s"
        sentences={[
          { id: "1", tone: "good", text: "Good." },
          { id: "2", tone: "bad", text: "Bad." },
          { id: "3", tone: "neutral", text: "Plain." },
        ]}
      />,
    );
    const dots = [...host.querySelectorAll<HTMLElement>(".md-analytics-dot")];
    expect(dots.map((d) => d.className.match(/md-analytics-tone-\w+/)?.[0])).toEqual([
      "md-analytics-tone-good",
      "md-analytics-tone-bad",
      "md-analytics-tone-wine",
    ]);
    expect(host.querySelector('[data-testid="s-2"]')?.textContent).toBe("Bad.");
  });
});
