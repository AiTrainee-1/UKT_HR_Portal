import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { THEMES } from "@/lib/themes";
import { THEME_DEVICE_STORAGE_KEY } from "@/contexts/ThemeContext";

// index.html carries a small script that puts the saved theme on <html> before the first frame (so a theme that redraws
// the page's structure never flashes the default look, and the sign-in pages wear the device's own theme). It mirrors
// ThemeContext.tsx: the device's choice, else the org-wide theme, plus the org-wide custom colours unless the device is on
// another theme. This runs the real script in jsdom for each combination and keeps its theme ids in step with the catalogue.

const html = fs.readFileSync(path.resolve(import.meta.dirname, "../index.html"), "utf8");
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1])
  .find((s) => s.includes("uk_textile_theme"))!;
const root = () => document.documentElement;

function run(stored: { org?: string; device?: string; custom?: string }) {
  if (stored.org !== undefined) localStorage.setItem("uk_textile_theme", stored.org);
  if (stored.device !== undefined) localStorage.setItem(THEME_DEVICE_STORAGE_KEY, stored.device);
  if (stored.custom !== undefined) localStorage.setItem("uk_textile_theme_custom", stored.custom);
  new Function(script)();
}

beforeEach(() => {
  localStorage.clear();
  root().removeAttribute("style");
  root().removeAttribute("data-theme");
  root().classList.remove("dark");
});
afterEach(() => localStorage.clear());

describe("the pre-React theme script in index.html", () => {
  it("exists, and lists exactly the themes of the catalogue", () => {
    expect(script).toBeTruthy();
    const ids = JSON.parse(script.match(/var ids = (\[[^\]]*\]);/)![1]) as string[];
    expect(ids).toEqual(THEMES.map((t) => t.id));
    expect(ids).toContain("clean");
  });

  it("uses the storage keys ThemeContext uses", () => {
    expect(script).toContain('"uk_textile_theme"');
    expect(script).toContain(`"${THEME_DEVICE_STORAGE_KEY}"`);
    expect(script).toContain('"uk_textile_theme_custom"');
  });

  it("puts the default on a browser that has stored nothing", () => {
    run({});
    expect(root().dataset.theme).toBe("default");
    expect(root().classList.contains("dark")).toBe(false);
  });

  it("puts the org-wide theme the browser kept", () => {
    run({ org: "premium" });
    expect(root().dataset.theme).toBe("premium");
  });

  it("puts the device's own theme first, even before anyone has signed in", () => {
    run({ org: "premium", device: "clean" });
    expect(root().dataset.theme).toBe("clean");
  });

  it("ignores a stored value that is not a theme", () => {
    run({ org: "no-such-theme", device: "Clean" });
    expect(root().dataset.theme).toBe("default");
    run({ org: "mono", device: "" });
    expect(root().dataset.theme).toBe("mono");
  });

  it("marks the dark theme with the dark class, like ThemeContext", () => {
    run({ org: "dark" });
    expect(root().dataset.theme).toBe("dark");
    expect(root().classList.contains("dark")).toBe(true);
  });

  it("applies the org-wide custom colours with the org-wide theme, and with a device choice of the same theme", () => {
    run({ org: "premium", custom: JSON.stringify({ "--primary": "0 0% 50%" }) });
    expect(root().style.getPropertyValue("--primary")).toBe("0 0% 50%");
    root().removeAttribute("style");
    run({ org: "premium", device: "premium", custom: JSON.stringify({ "--primary": "0 0% 50%" }) });
    expect(root().style.getPropertyValue("--primary")).toBe("0 0% 50%");
  });

  it("does not apply them on a device that has chosen another theme", () => {
    run({ org: "premium", device: "clean", custom: JSON.stringify({ "--primary": "0 0% 50%" }) });
    expect(root().dataset.theme).toBe("clean");
    expect(root().style.getPropertyValue("--primary")).toBe("");
  });

  it("does not throw on malformed custom colours, and the theme is still put on", () => {
    expect(() => run({ org: "mono", custom: "{not json" })).not.toThrow();
    expect(root().dataset.theme).toBe("mono");
  });
});
