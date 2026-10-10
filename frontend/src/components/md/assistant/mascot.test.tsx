import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeAssistant, getAssistantState } from "@/lib/md/assistant-store";
import Launcher from "./Launcher";
import { MascotFace, RadioMascot, RADIO_SHEETS, type MascotMood } from "./mascot";

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
  closeAssistant();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** matchMedia the way a browser with a mouse and no reduced-motion setting answers (`pointer` queries yes, the rest no). */
function stubMatchMedia(reducedMotion: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: query.includes("reduced-motion") ? reducedMotion : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

describe("the sheets", () => {
  it("are the two files in public/mascots", () => {
    expect(RADIO_SHEETS.directions).toMatch(/mascots\/radio-directions\.webp$/);
    expect(RADIO_SHEETS.reactions).toMatch(/mascots\/radio-reactions\.webp$/);
  });
});

describe("MascotFace", () => {
  const render = (mood?: MascotMood, size = 40) => {
    act(() => root.render(<MascotFace size={size} mood={mood} />));
    return host.querySelector<HTMLElement>('[data-testid="assistant-face"]')!;
  };

  it("looks straight ahead from the directions sheet when idle", () => {
    const face = render("idle");
    expect(face.dataset.mood).toBe("idle");
    expect(face.style.backgroundImage).toContain("radio-directions.webp");
    expect(face.style.width).toBe("40px");
  });

  it("takes its expression from the reactions sheet for every other mood, each a different cell", () => {
    const positions = new Set<string>();
    for (const mood of ["working", "pleased", "error", "stopped"] as const) {
      const face = render(mood);
      expect(face.dataset.mood).toBe(mood);
      expect(face.style.backgroundImage).toContain("radio-reactions.webp");
      positions.add(face.style.backgroundPosition);
    }
    expect(positions.size).toBe(4);
  });

  it("is decorative: a screen reader skips it", () => {
    expect(render("idle").getAttribute("aria-hidden")).toBe("true");
  });

  it("scales the whole sheet with its size, so the head stays in the frame at any size", () => {
    const px = (s: string) => parseFloat(s);
    const small = px(render("idle", 28).style.backgroundSize);
    const big = px(render("idle", 56).style.backgroundSize);
    expect(big).toBeCloseTo(small * 2, 5);
  });
});

describe("RadioMascot", () => {
  beforeEach(() => stubMatchMedia(false));

  it("is the package's button, named for what it is for when the caller says so", () => {
    act(() => root.render(<RadioMascot size={100} buttonLabel="Open the AI assistant" />));
    const button = host.querySelector("button")!;
    expect(button.getAttribute("aria-label")).toBe("Open the AI assistant");
    expect(button.style.width).toBe("100px");
  });

  it("keeps the package's own name (a toy to poke) when no name is given", () => {
    act(() => root.render(<RadioMascot size={100} label="AI assistant" />));
    expect(host.querySelector("button")!.getAttribute("aria-label")).toBe("Boop the AI assistant");
  });
});

describe("Launcher", () => {
  it("opens the assistant a moment after the poke, so the reaction shows first", async () => {
    stubMatchMedia(false);
    vi.stubGlobal("Element", Element);
    Element.prototype.animate = vi.fn() as never;
    act(() => root.render(<Launcher />));
    const launcher = host.querySelector<HTMLElement>('[data-testid="assistant-launcher"]')!;
    expect(launcher.querySelector("button")!.getAttribute("aria-label")).toBe("Open the AI assistant");

    act(() => launcher.querySelector("button")!.click());
    expect(getAssistantState().open).toBe(false);
    // a second click while the first is on its way does not stack another opening
    act(() => launcher.querySelector("button")!.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 400)));
    expect(getAssistantState().open).toBe(true);
  });

  // (Opening at once for someone who asks for reduced motion is checked in AssistantHost.test.tsx: framer-motion reads
  // that setting once per page, so it cannot be flipped between tests in one file.)

  it("is labelled for the pointer too: the tooltip names the shortcut", () => {
    stubMatchMedia(false);
    act(() => root.render(<Launcher />));
    expect(host.querySelector('[data-testid="assistant-launcher"]')!.getAttribute("title")).toBe("Ask AI (Ctrl J)");
  });
});
