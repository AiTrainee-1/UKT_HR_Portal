import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { CompensationChip, CompensationLegend, CompensationSymbol } from "./CompensationMarker";
import { COMPENSATION_KINDS, countMarks, type CompensationFields } from "./kinds";

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

const NOTE = "Arrived 09:47, inside the 30 min allowance.";

const DAYS: Record<string, CompensationFields> = {
  ot_allowance: { compensationKind: "ot_allowance", compensationMinutes: 30, compensationNote: NOTE },
  window_late_in: { compensationKind: "window_late_in", compensationNote: "Late-in of 10:30 announced." },
  window_early_out: { compensationKind: "window_early_out", compensationNote: "Early-out of 15:00 announced." },
  birthday: { compensationKind: "birthday", compensationNote: "Birthday: paid leave." },
  relaxation: { compensationKind: "relaxation", compensationNote: "0.5 shift relaxation applied." },
};

const WORDS: Record<string, string> = {
  ot_allowance: "OT allowance used (30 min)",
  window_late_in: "Announced late-in",
  window_early_out: "Announced early-out",
  birthday: "Birthday leave",
  relaxation: "Relaxation (compensation day)",
};

const SHORT: Record<string, string> = {
  ot_allowance: "OT",
  window_late_in: "LI",
  window_early_out: "EO",
  birthday: "BD",
  relaxation: "RX",
};

describe("CompensationChip", () => {
  it.each(Object.keys(DAYS))("draws the %s chip with its words, an icon and the note as a tooltip", (kind) => {
    const el = mount(createElement(CompensationChip, { day: DAYS[kind] }));
    const chip = el.querySelector(`[data-testid="compensation-chip-${kind}"]`)!;
    expect(chip).not.toBeNull();
    expect(chip.textContent).toContain(WORDS[kind]);
    // an icon beside the words, hidden from a screen reader
    const icon = chip.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon!.getAttribute("aria-hidden")).toBe("true");
    // the note: a tooltip for the mouse, hidden text for a screen reader
    expect(chip.getAttribute("title")).toBe(`${WORDS[kind]}: ${DAYS[kind].compensationNote}`);
    expect(chip.querySelector(".sr-only")?.textContent).toContain(DAYS[kind].compensationNote);
  });

  it("gives each kind a different colour as well as different words", () => {
    const classes = Object.keys(DAYS).map((kind) => {
      const el = mount(createElement(CompensationChip, { day: DAYS[kind] }));
      const cls = el.querySelector("[data-testid^='compensation-chip-']")!.className;
      act(() => root!.unmount());
      host!.remove();
      return cls.split(" ").find((c) => c.startsWith("bg-"));
    });
    expect(new Set(classes).size).toBe(5);
  });

  it("shows the note in plain sight with withNote (a detail view)", () => {
    const el = mount(createElement(CompensationChip, { day: DAYS.ot_allowance, withNote: true }));
    expect(el.querySelector('[data-testid="compensation-note"]')?.textContent).toBe(NOTE);
    // not said twice to a screen reader
    expect(el.querySelector(".sr-only")).toBeNull();
  });

  it("has no note line when the engine sent no note", () => {
    const el = mount(createElement(CompensationChip, { day: { compensationKind: "birthday" }, withNote: true }));
    expect(el.querySelector('[data-testid="compensation-chip-birthday"]')?.getAttribute("title")).toBe(
      "Birthday leave",
    );
    expect(el.querySelector('[data-testid="compensation-note"]')).toBeNull();
  });

  it("draws nothing for an ordinary day", () => {
    for (const day of [
      null,
      undefined,
      {},
      { compensationKind: null, compensationMinutes: 0, compensationNote: null },
    ]) {
      const el = mount(createElement(CompensationChip, { day }));
      expect(el.innerHTML).toBe("");
      act(() => root!.unmount());
      host!.remove();
    }
  });

  it("draws a kind it does not know as a plain Compensation chip", () => {
    const el = mount(createElement(CompensationChip, { day: { compensationKind: "festival_pay" } }));
    expect(el.querySelector('[data-testid="compensation-chip-other"]')?.textContent).toBe("Compensation");
  });

  it("uses the small size in a table and keeps a caller's class", () => {
    const el = mount(createElement(CompensationChip, { day: DAYS.birthday, size: "sm", className: "mt-2" }));
    const chip = el.querySelector("[data-testid='compensation-chip-birthday']")!;
    expect(chip.className).toContain("text-[10px]");
    expect(chip.className).toContain("mt-2");
  });
});

describe("CompensationSymbol", () => {
  it.each(Object.keys(DAYS))("is a compact %s symbol with a label for a screen reader and a tooltip", (kind) => {
    const el = mount(createElement(CompensationSymbol, { day: DAYS[kind] }));
    const symbol = el.querySelector(`[data-testid="compensation-symbol-${kind}"]`)!;
    expect(symbol.textContent).toBe(SHORT[kind]);
    expect(symbol.getAttribute("role")).toBe("img");
    expect(symbol.getAttribute("aria-label")).toBe(`${WORDS[kind]}: ${DAYS[kind].compensationNote}`);
    expect(symbol.getAttribute("title")).toBe(symbol.getAttribute("aria-label"));
  });

  it("drops its own tooltip where the cell has one, but keeps the label", () => {
    const el = mount(createElement(CompensationSymbol, { day: DAYS.relaxation, tooltip: false }));
    const symbol = el.querySelector("[data-testid='compensation-symbol-relaxation']")!;
    expect(symbol.hasAttribute("title")).toBe(false);
    expect(symbol.getAttribute("aria-label")).toContain("Relaxation (compensation day)");
  });

  it("hides from a screen reader when the words sit beside it", () => {
    const el = mount(createElement(CompensationSymbol, { day: DAYS.birthday, decorative: true }));
    const symbol = el.querySelector("[data-testid='compensation-symbol-birthday']")!;
    expect(symbol.getAttribute("aria-hidden")).toBe("true");
    expect(symbol.hasAttribute("aria-label")).toBe(false);
    expect(symbol.hasAttribute("role")).toBe(false);
  });

  it("draws nothing for an ordinary day", () => {
    expect(mount(createElement(CompensationSymbol, { day: {} })).innerHTML).toBe("");
  });
});

describe("CompensationLegend", () => {
  it("lists all five kinds, each with its symbol and words, when none is named", () => {
    const el = mount(createElement(CompensationLegend));
    const legend = el.querySelector('[data-testid="compensation-legend"]')!;
    expect(legend.getAttribute("role")).toBe("group");
    expect(legend.getAttribute("aria-label")).toBe("Compensation markers");
    for (const kind of COMPENSATION_KINDS) {
      const entry = legend.querySelector(`[data-testid="compensation-legend-${kind}"]`)!;
      expect(entry, kind).not.toBeNull();
      expect(entry.textContent).toContain(SHORT[kind]);
      expect(entry.textContent).toContain(WORDS[kind].replace(" (30 min)", ""));
      // the meaning is the tooltip
      expect(entry.getAttribute("title")!.length).toBeGreaterThan(20);
    }
  });

  it("lists only the kinds in view, with how many days of each", () => {
    const counts = countMarks([DAYS.relaxation, DAYS.relaxation, DAYS.birthday, {}]);
    const el = mount(createElement(CompensationLegend, { counts }));
    const entries = Array.from(el.querySelectorAll('[data-testid^="compensation-legend-"]')).map((e) =>
      e.getAttribute("data-testid"),
    );
    expect(entries).toEqual(["compensation-legend-birthday", "compensation-legend-relaxation"]);
    expect(el.querySelector('[data-testid="compensation-legend-relaxation"]')?.textContent).toContain("×2");
    expect(el.querySelector('[data-testid="compensation-legend-birthday"]')?.textContent).toContain("×1");
  });

  it("does not say the words twice to a screen reader (its symbols are decorative)", () => {
    const el = mount(createElement(CompensationLegend, { kinds: ["birthday"] }));
    expect(el.querySelector("[role='img']")).toBeNull();
    expect(el.querySelector("[data-testid='compensation-symbol-birthday']")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("spells each meaning out with describe", () => {
    const el = mount(createElement(CompensationLegend, { kinds: ["window_late_in"], describe: true }));
    expect(el.textContent).toContain("The company announced a late-in time");
    expect(el.querySelector('[data-testid="compensation-legend-window_late_in"]')?.hasAttribute("title")).toBe(false);
  });

  it("draws nothing when no kind is in view", () => {
    expect(mount(createElement(CompensationLegend, { counts: {} })).innerHTML).toBe("");
    act(() => root!.unmount());
    host!.remove();
    expect(mount(createElement(CompensationLegend, { kinds: [] })).innerHTML).toBe("");
  });
});
