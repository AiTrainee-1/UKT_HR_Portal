import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const dir = import.meta.dirname;
const css = fs.readFileSync(path.join(dir, "settings-skin.css"), "utf8");
const page = fs.readFileSync(path.join(dir, "..", "Settings.tsx"), "utf8");
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");

/** The selector list of every rule (the inner rules of @media / @supports blocks included). */
function selectors(text: string): string[] {
  return [...strip(text).matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap((m) =>
    m[1]
      .trim()
      .split(/,(?![^(]*\))/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

describe("the glass-and-clay skin stays on the Settings page", () => {
  it("every selector starts with .settings-skin (inside the page) or html.settings-skin-on (portals opened from it)", () => {
    const stray = selectors(css).filter(
      (s) => !s.startsWith(".settings-skin") && !s.startsWith("html.settings-skin-on"),
    );
    expect(stray).toEqual([]);
  });

  it("has no @keyframes and no @import (a global at-rule would leak)", () => {
    expect(strip(css)).not.toMatch(/@keyframes|@import|@font-face/);
  });

  it("is switched on by Settings.tsx itself: the page root class, and the <html> class while the page is open", () => {
    expect(page).toContain('import "./settings/settings-skin.css"');
    expect(page).toMatch(/className="settings-skin[ "]/);
    expect(page).toContain('classList.add("settings-skin-on")');
    // taken off again when the page goes away
    expect(page).toContain('classList.remove("settings-skin-on")');
  });

  it("covers both halves of the look: frosted glass and soft clay", () => {
    expect(css).toMatch(/backdrop-filter:\s*blur/);
    expect(css).toMatch(/inset\s+-?\d+px\s+-?\d+px/); // clay: inner highlight and shadow
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("@supports not ((backdrop-filter: blur(1px))");
  });
});
