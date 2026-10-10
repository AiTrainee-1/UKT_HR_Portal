import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Users } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MD_GOLD, MD_GOLD_GRADIENT } from "../MdSidebar";
import { CHART } from "./chartTheme";
import InsightList, { type Insight } from "./InsightList";
import { ModeTabs } from "./MdHeaderParts";
import StatCard, { DeltaChip, STAT_TONES } from "./StatCard";
import { EmptyBlock, ErrorBanner, NoteBanner, SkeletonBlock } from "./states";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The building blocks every MD page is made of. These pin what a page can count on from them (the names that carry meaning,
// the roles that assistive technology reads, the tones that keep their meaning): the page tests cover what they put inside.

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
  vi.restoreAllMocks();
});

const render = (node: React.ReactNode) => act(() => root.render(node));

describe("the stat card's tones", () => {
  it("keep the names pages use, and each points at a palette tone class and a chart colour", () => {
    expect(Object.keys(STAT_TONES).sort()).toEqual(
      ["amber", "blue", "green", "indigo", "purple", "red", "slate", "teal"].sort(),
    );
    for (const tone of Object.values(STAT_TONES)) {
      expect(tone.box).toMatch(/^md-shell-tone-[a-z]+$/);
      expect(tone.accent).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it("use wine for the brand, and keep sage, ochre and crimson for good, watch and bad", () => {
    expect(STAT_TONES.blue.box).toBe("md-shell-tone-wine");
    expect(STAT_TONES.blue.accent).toBe(CHART.brand);
    expect(STAT_TONES.green.accent).toBe(CHART.good);
    expect(STAT_TONES.amber.accent).toBe(CHART.warn);
    expect(STAT_TONES.red.accent).toBe(CHART.bad);
    // a category colour is never the "bad" colour
    for (const key of ["slate", "blue", "indigo", "purple", "teal"] as const) {
      expect(STAT_TONES[key].accent).not.toBe(CHART.bad);
    }
  });
});

describe("StatCard", () => {
  it("is a glass card with the label, the figure and the tone's tile", () => {
    render(<StatCard label="Active headcount" value="227" icon={Users} tone="blue" testId="kpi-headcount" />);
    const card = host.querySelector<HTMLElement>('[data-testid="kpi-headcount"]')!;
    expect(card.className).toContain("md-card");
    expect(card.className).toContain("md-shell-tone-wine");
    expect(card.textContent).toContain("Active headcount");
    expect(host.querySelector('[data-testid="kpi-headcount-value"]')?.textContent).toBe("227");
    expect(card.getAttribute("role")).toBeNull();
  });

  it("becomes a button when it is clickable, and answers Enter and Space", () => {
    const onClick = vi.fn();
    render(<StatCard label="Payroll" value="₹57.3 L" icon={Users} onClick={onClick} testId="kpi-payroll" />);
    const card = host.querySelector<HTMLElement>('[data-testid="kpi-payroll"]')!;
    expect(card.getAttribute("role")).toBe("button");
    expect(card.tabIndex).toBe(0);
    act(() => card.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    act(() => card.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })));
    act(() => card.click());
    expect(onClick).toHaveBeenCalledTimes(3);
  });

  it("hides the figure behind the loader while it loads", () => {
    render(<StatCard label="Payroll" value="₹57.3 L" icon={Users} loading testId="kpi-payroll" />);
    expect(host.querySelector('[data-testid="kpi-payroll-value"]')?.className).toContain("opacity-0");
    expect(host.querySelector(".ukt-kpi-run")).not.toBeNull();
  });
});

describe("DeltaChip", () => {
  const chip = (tone: "good" | "bad" | "neutral", direction?: "up" | "down" | "flat") => {
    render(<DeltaChip text="+0.9%" tone={tone} direction={direction} />);
    return host.firstElementChild as HTMLElement;
  };

  it("is sage when the change is good news, crimson when it is bad, and plain when it is neither", () => {
    expect(chip("good", "up").className).toContain("md-chip-success");
    expect(chip("bad", "up").className).toContain("md-chip-danger");
    const neutral = chip("neutral", "flat");
    expect(neutral.className).not.toContain("md-chip-success");
    expect(neutral.className).not.toContain("md-chip-danger");
  });

  it("carries the direction in an arrow as well as in colour", () => {
    const el = chip("bad", "down");
    expect(el.textContent).toBe("+0.9%");
    expect(el.querySelector("svg")).not.toBeNull();
  });
});

describe("ModeTabs", () => {
  it("is a segmented tablist: the chosen side is selected, the other one is clickable", () => {
    const onSelect = vi.fn();
    render(<ModeTabs active="operations" onSelect={onSelect} label="Employees views" />);
    const list = host.querySelector<HTMLElement>('[role="tablist"]')!;
    expect(list.getAttribute("aria-label")).toBe("Employees views");
    expect(list.className).toContain("md-seg");
    const ops = host.querySelector<HTMLElement>('[data-testid="md-tab-operations"]')!;
    const insights = host.querySelector<HTMLElement>('[data-testid="md-tab-insights"]')!;
    expect(ops.getAttribute("aria-selected")).toBe("true");
    expect(insights.getAttribute("aria-selected")).toBe("false");
    expect(ops.className).toContain("md-seg-item");
    act(() => insights.click());
    expect(onSelect).toHaveBeenCalledWith("insights");
  });
});

describe("InsightList", () => {
  const items: Insight[] = [
    { id: "a", severity: "critical", title: "Payroll rose 20%", metric: "+20%", ask: "Why?" },
    {
      id: "b",
      severity: "warning",
      title: "Two units are short",
      detail: "12 departments",
      page: { path: "/md/employees", label: "Employees" },
    },
    { id: "c", severity: "info", title: "FYI" },
    { id: "d", severity: "good", title: "Attendance rose" },
  ];

  it("gives every severity its own tone and its own icon with a name", () => {
    render(<InsightList items={items} />);
    const row = (id: string) => host.querySelector<HTMLElement>(`[data-testid="insight-${id}"]`)!;
    expect(row("a").className).toContain("md-shell-sev-critical");
    expect(row("b").className).toContain("md-shell-sev-warning");
    expect(row("c").className).toContain("md-shell-sev-info");
    expect(row("d").className).toContain("md-shell-sev-good");
    const labels = items.map((i) => row(i.id).querySelector("svg")?.getAttribute("aria-label"));
    expect(labels).toEqual(["Critical", "Needs attention", "For your information", "Good news"]);
  });

  it("links to the page as a chip and offers Explain where there is a question", () => {
    render(<InsightList items={items} />);
    const link = host.querySelector<HTMLAnchorElement>('[data-testid="insight-b"] a')!;
    expect(link.getAttribute("href")).toBe("/md/employees");
    expect(link.className).toContain("md-chip");
    expect(host.querySelector('[data-testid="insight-a"] [data-testid="ask-ai"]')?.textContent).toContain("Explain");
  });

  it("says so, in a sand panel, when nothing needs attention", () => {
    render(<InsightList items={[]} emptyText="All quiet." />);
    const empty = host.querySelector<HTMLElement>('[data-testid="insights-empty"]')!;
    expect(empty.textContent).toContain("All quiet.");
    expect(empty.className).toContain("md-panel-sand");
  });
});

describe("the states", () => {
  it("announce a failure as an alert, in crimson, with a Retry that works", () => {
    const onRetry = vi.fn();
    render(<ErrorBanner message="Server said no" onRetry={onRetry} />);
    const banner = host.querySelector<HTMLElement>('[role="alert"]')!;
    expect(banner.getAttribute("data-testid")).toBe("md-error");
    expect(banner.className).toContain("md-shell-error");
    expect(banner.className).not.toContain("wine");
    expect(banner.textContent).toContain("Server said no");
    const retry = Array.from(banner.querySelectorAll("button")).find((b) => b.textContent?.includes("Retry"))!;
    act(() => retry.click());
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("show a caveat in a sand panel and an empty state with its explanation", () => {
    render(
      <>
        <NoteBanner>Today is still running.</NoteBanner>
        <EmptyBlock title="Nothing yet" testId="empty">
          No records in this period.
        </EmptyBlock>
      </>,
    );
    expect(host.querySelector('[data-testid="md-note"]')?.className).toContain("md-panel-sand");
    expect(host.querySelector('[data-testid="empty"]')?.textContent).toContain("No records in this period.");
  });

  it("show a loading placeholder that is announced as loading", () => {
    render(<SkeletonBlock />);
    const status = host.querySelector<HTMLElement>('[role="status"]')!;
    expect(status.getAttribute("aria-label")).toBe("Loading");
    expect(status.querySelectorAll(".clay-skeleton").length).toBeGreaterThan(2);
  });
});

describe("the retired gold", () => {
  it("is wine now, so no file that still imports it paints the portal gold", () => {
    expect(MD_GOLD.toLowerCase()).toBe("#7f011f");
    expect(MD_GOLD_GRADIENT).not.toMatch(/#/);
    expect(MD_GOLD_GRADIENT).toContain("--md-wine");
  });
});
