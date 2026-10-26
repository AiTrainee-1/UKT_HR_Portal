import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderMdPage, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { hexToHslTriple, THEMES } from "@/lib/themes";
import ThemesTab from "../ThemesTab";
import { THEMES_SETTINGS } from "../ThemesTab.meta";
import { DARK_TEXT, hex, LIGHT_TEXT, PALETTES } from "./palettes";

// jsdom render checks of the Themes tab inside the real ThemeProvider with a fake server: the cards are drawn from the
// real palette, Preview touches only this screen, switching a theme on sends the same request as before, a theme with
// custom colours is not left without asking, and the Customize dialog saves a first-time colour (with the readable
// text colour it needs) and asks before a reset. The page itself is covered by e2e/settings.spec.ts.

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }), toast }));

const HR = { role: "hr", employeeId: null, name: "Test HR", isSuperAdmin: true, permissions: {} };

type ThemeBody = { themeName?: string; themeCustom?: Record<string, string> };

let page: RenderedPage | undefined;
let puts: ThemeBody[];

beforeEach(() => {
  puts = [];
  toast.mockClear();
  localStorage.removeItem("uk_textile_theme");
  localStorage.removeItem("uk_textile_theme_custom");
  localStorage.removeItem("uk_textile_theme_device");
  document.documentElement.removeAttribute("style");
  delete document.documentElement.dataset.theme;
});
afterEach(() => {
  page?.unmount();
  page = undefined;
});

async function open({
  themeName = "default",
  themeCustom = {} as Record<string, string>,
  editable = true,
  readOnly = false,
  device = undefined as string | undefined,
  /** The org-wide theme this browser kept from its last visit (it may be out of date). */
  cached = undefined as string | undefined,
  /** The server does not answer /api/theme-settings. */
  serverDown = false,
} = {}) {
  let current = { themeName, themeCustom };
  if (device !== undefined) localStorage.setItem("uk_textile_theme_device", device);
  if (cached !== undefined) localStorage.setItem("uk_textile_theme", cached);
  page = await renderMdPage(
    () => (
      <ThemeProvider>
        <ThemesTab readOnly={readOnly} />
      </ThemeProvider>
    ),
    {
      "/api/auth/me": HR,
      "/api/payroll-settings": { companyName: "UKTextiles", companyLogo: null, companyWideRulesEditable: editable },
      "/api/theme-settings": () => (serverDown ? { status: 503, body: { error: "down" } } : current),
      "/api/theme-settings/update": (_params, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as ThemeBody;
        puts.push(body);
        current = {
          themeName: body.themeName ?? current.themeName,
          themeCustom: body.themeCustom ?? current.themeCustom,
        };
        return current;
      },
    },
    { path: "/hr/settings?tab=themes" },
  );
  return page;
}

/** A button on the page or in an open dialog (which renders in a portal), by its words or its aria-label. */
const button = (name: string) =>
  [...document.body.querySelectorAll("button")].find(
    (b) => b.textContent?.replace(/\s+/g, " ").trim() === name || b.getAttribute("aria-label") === name,
  );

async function press(name: string) {
  const b = button(name);
  expect(b, `button "${name}"`).toBeDefined();
  await act(async () => {
    b!.click();
  });
  await page!.settle();
}

const html = () => document.documentElement;

describe("Settings -> Themes", () => {
  it("draws every theme with the colours its stylesheet really gives it (Clean Professional's from its own tokens.css)", async () => {
    await open();
    for (const t of THEMES) {
      const card = page!.container.querySelector(`[data-testid="theme-card-${t.id}"]`)!;
      expect(card, t.id).not.toBeNull();
      const background = card.querySelector('[data-sketch="background"]')!.getAttribute("fill");
      expect(background).toBe(`hsl(${PALETTES[t.id]["--background"]})`);
      expect(card.querySelector('[data-sketch="primary-button"]')!.getAttribute("fill")).toBe(
        `hsl(${PALETTES[t.id]["--primary"]})`,
      );
      expect(card.querySelector('[data-swatch="--primary"]')!.getAttribute("data-hex")).toBe(
        hex(PALETTES[t.id]["--primary"]),
      );
    }
    // The Dark theme's primary is near-white, not the sky blue the old hand-typed strip showed.
    const dark = page!.container.querySelector('[data-testid="theme-card-dark"] [data-swatch="--primary"]')!;
    expect(dark.getAttribute("data-hex")).toBe("#f8fafc");
    expect(page!.container.querySelector('[data-testid="theme-card-default"]')!.getAttribute("data-active")).toBe(
      "true",
    );
    expect(page!.requests().filter((r) => r.startsWith("/api/theme-settings/update"))).toEqual([]);
  });

  it("offers Clean Professional next to the others, drawn flat, with a name and words of its own", async () => {
    await open();
    expect(page!.container.querySelectorAll('[data-testid^="theme-card-"]')).toHaveLength(THEMES.length);
    const card = page!.container.querySelector('[data-testid="theme-card-clean"]')!;
    expect(card.textContent).toContain("Clean Professional");
    expect(card.textContent).toContain("No glass, shadows or gradients");
    expect(card.querySelector('[data-sketch="menu-active"]')).not.toBeNull();
    // the existing colour theme of a similar name is still its own card
    expect(page!.container.querySelector('[data-testid="theme-card-professional"]')!.textContent).toContain(
      "Professional Theme",
    );
  });

  it("has a search entry for every setting it draws, with the same title and words", async () => {
    await open();
    expect(THEMES_SETTINGS.length).toBeGreaterThan(0);
    for (const meta of THEMES_SETTINGS) {
      const block = page!.container.querySelector(`[data-setting-id="${meta.id}"]`);
      expect(block, meta.id).not.toBeNull();
      expect(block!.querySelector("h4")!.textContent).toBe(meta.title);
      expect(block!.querySelector('[data-testid="setting-purpose"]')!.textContent).toBe(meta.purpose);
    }
    expect(page!.container.querySelectorAll("[data-setting-id]")).toHaveLength(THEMES_SETTINGS.length);
  });

  it("previews a theme on this screen only, as switching it on would show it, and stops again", async () => {
    await open({ themeCustom: { "--primary": "0 0% 50%" } });
    expect(html().dataset.theme).toBe("default");
    expect(html().style.getPropertyValue("--primary")).toBe("0 0% 50%");

    await page!.click('[data-testid="theme-preview-dark"]');
    expect(html().dataset.theme).toBe("dark");
    // Another theme is previewed without this theme's custom colours, because that is what activating it gives.
    expect(html().style.getPropertyValue("--primary")).toBe("");
    expect(page!.container.querySelector('[data-testid="theme-previewing"]')).not.toBeNull();
    expect(page!.container.querySelector('[data-testid="theme-card-dark"]')!.getAttribute("data-showing")).toBe("true");
    expect(puts).toEqual([]);

    await press("Stop preview");
    expect(html().dataset.theme).toBe("default");
    expect(html().style.getPropertyValue("--primary")).toBe("0 0% 50%");
    expect(page!.container.querySelector('[data-testid="theme-previewing"]')).toBeNull();
  });

  it("switches a theme on for everyone with the same request as before", async () => {
    await open();
    await press("Enable Premium Theme");
    expect(puts).toEqual([{ themeName: "premium", themeCustom: {} }]);
    expect(html().dataset.theme).toBe("premium");
    expect(page!.container.querySelector('[data-testid="theme-card-premium"]')!.getAttribute("data-active")).toBe(
      "true",
    );
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Theme applied" }));
    expect(toast.mock.calls[0][0].description).toContain("Premium Theme is now active for everyone.");
  });

  it("asks before switching away from a theme that has custom colours, and switches on Yes", async () => {
    await open({ themeCustom: { "--primary": "0 0% 50%" } });
    expect(page!.container.querySelector('[data-testid="custom-primary"]')!.textContent).toContain("#808080");

    await press("Enable Dark Theme");
    expect(page!.container.querySelector('[data-testid="theme-switch-confirm"]')!.textContent).toContain(
      "drops the 1 custom colour set on Default Theme",
    );
    expect(puts).toEqual([]);

    await press("Keep Default Theme");
    expect(page!.container.querySelector('[data-testid="theme-switch-confirm"]')).toBeNull();
    expect(html().dataset.theme).toBe("default");

    await press("Enable Dark Theme");
    await press("Switch anyway");
    expect(puts).toEqual([{ themeName: "dark", themeCustom: {} }]);
    expect(toast.mock.calls[0][0].description).toContain("The 1 custom colour of Default Theme were dropped.");
  });

  it("saves a first-time custom colour, with the readable text colour it needs, and previews it while picking", async () => {
    await open();
    await press("Customize");
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("Customize Default Theme");

    const navy = hexToHslTriple("#0d2a38");
    await page!.type('input[aria-label="Sidebar"]', "#0d2a38");
    // Shown at once on this screen: the navy, and white menu text because the theme's own deep-blue text would vanish.
    expect(html().style.getPropertyValue("--sidebar")).toBe(navy);
    expect(html().style.getPropertyValue("--sidebar-foreground")).toBe(LIGHT_TEXT);
    expect(document.body.querySelector('[data-testid="text-on-sidebar"]')!.textContent).toContain(
      "white text is saved with it",
    );
    expect(puts).toEqual([]);

    await press("Save colours");
    expect(puts).toEqual([
      { themeName: "default", themeCustom: { "--sidebar": navy, "--sidebar-foreground": LIGHT_TEXT } },
    ]);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Custom colours saved" }));
    expect(toast.mock.calls[0][0].description).toContain("1 colour (and 1 text colour to keep them readable)");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(page!.container.querySelector('[data-testid="custom-sidebar"]')!.textContent).toContain(
      "#0d2a38 with white text",
    );
  });

  it("resets the colours only after a confirm, with the request the Reset always sent", async () => {
    await open({ themeCustom: { "--primary": "0 0% 50%", "--accent": "0 0% 40%" } });
    await press("Customize");
    await press("Reset to theme default");
    expect(document.body.querySelector('[role="dialog"] [role="alert"]')!.textContent).toContain(
      "Removes the 2 saved colours for everyone",
    );
    expect(puts).toEqual([]);
    await press("Keep them");
    expect(button("Yes, reset")).toBeUndefined();

    await press("Reset to theme default");
    await press("Yes, reset");
    expect(puts).toEqual([{ themeName: "default", themeCustom: {} }]);
    expect(page!.container.querySelector('[data-testid="custom-none"]')).not.toBeNull();
    expect(html().style.getPropertyValue("--primary")).toBe("");
  });

  it("lets a branch login preview but not switch or customize, and says why", async () => {
    await open({ editable: false });
    expect(page!.container.querySelector('[data-testid="theme-branch-note"]')!.textContent).toContain(
      "has no branch copy",
    );
    for (const t of THEMES) expect(button(`Enable ${t.label}`)!.disabled, t.id).toBe(true);
    expect(button("Customize")!.disabled).toBe(true);
    expect((page!.container.querySelector('[data-testid="theme-preview-dark"]') as HTMLButtonElement).disabled).toBe(
      false,
    );
    await page!.click('[data-testid="theme-preview-dark"]');
    expect(html().dataset.theme).toBe("dark");
    expect(puts).toEqual([]);
  });

  it("lets a view-only role look but not switch or customize", async () => {
    await open({ readOnly: true });
    for (const t of THEMES) expect(button(`Enable ${t.label}`)!.disabled, t.id).toBe(true);
    expect(button("Customize")!.disabled).toBe(true);
    expect(page!.container.querySelector('[data-testid="theme-branch-note"]')).toBeNull();
  });

  it("uses a theme only on this device: nothing is sent to the server, and the cards say which is which", async () => {
    await open();
    await page!.click('[data-testid="theme-device-clean"]');
    expect(puts).toEqual([]);
    expect(page!.requests().filter((r) => r.startsWith("/api/theme-settings/update"))).toEqual([]);
    expect(localStorage.getItem("uk_textile_theme_device")).toBe("clean");
    expect(html().dataset.theme).toBe("clean");

    const clean = page!.container.querySelector('[data-testid="theme-card-clean"]')!;
    const def = page!.container.querySelector('[data-testid="theme-card-default"]')!;
    expect(clean.getAttribute("data-device")).toBe("true");
    expect(clean.getAttribute("data-active")).toBe("false");
    expect(clean.querySelector('[data-testid="theme-status-device"]')!.textContent).toBe("Active on this device");
    expect(clean.querySelector('[data-testid="theme-status-everyone"]')).toBeNull();
    expect(def.getAttribute("data-active")).toBe("true");
    expect(def.querySelector('[data-testid="theme-status-everyone"]')!.textContent).toBe("Active for everyone");
    expect(def.querySelector('[data-testid="theme-status-device"]')).toBeNull();
    // the summary names both, and the screen
    expect(page!.container.querySelector('[data-testid="theme-everyone-line"]')!.textContent).toContain(
      "Default Theme",
    );
    expect(page!.container.querySelector('[data-testid="theme-device-line"]')!.textContent).toContain(
      "Clean Professional",
    );
    expect(page!.container.querySelector('[data-testid="theme-screen-line"]')!.textContent).toContain(
      "Clean Professional",
    );
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Theme set for this device" }));
  });

  it("clears the device's choice from the summary, and from the card that holds it", async () => {
    await open({ device: "clean" });
    expect(html().dataset.theme).toBe("clean");
    const clear = page!.container.querySelector('[data-testid="theme-device-clear"]') as HTMLButtonElement;
    expect(clear.disabled).toBe(false);
    await page!.click('[data-testid="theme-device-clear"]');
    expect(html().dataset.theme).toBe("default");
    expect(localStorage.getItem("uk_textile_theme_device")).toBeNull();
    expect((page!.container.querySelector('[data-testid="theme-device-clear"]') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(page!.container.querySelector('[data-testid="theme-device-line"]')!.textContent).toContain(
      "Same as everyone",
    );

    // pressing the card's own button again is the same toggle
    await page!.click('[data-testid="theme-device-dark"]');
    expect(html().dataset.theme).toBe("dark");
    await page!.click('[data-testid="theme-device-dark"]');
    expect(html().dataset.theme).toBe("default");
    expect(localStorage.getItem("uk_textile_theme_device")).toBeNull();
    expect(puts).toEqual([]);
  });

  it("keeps the device's own theme when the server says another one is for everyone", async () => {
    await open({ themeName: "premium", device: "clean" });
    expect(html().dataset.theme).toBe("clean");
    expect(page!.container.querySelector('[data-testid="theme-card-premium"]')!.getAttribute("data-active")).toBe(
      "true",
    );
    expect(page!.container.querySelector('[data-testid="theme-card-clean"]')!.getAttribute("data-device")).toBe("true");
    expect(page!.container.querySelector('[data-testid="theme-everyone-line"]')!.textContent).toContain(
      "Premium Theme",
    );
  });

  it("a preview wins over the device's choice, and stopping it brings the device's theme back", async () => {
    await open({ device: "clean" });
    await page!.click('[data-testid="theme-preview-dark"]');
    expect(html().dataset.theme).toBe("dark");
    expect(page!.container.querySelector('[data-testid="theme-screen-line"]')!.textContent).toContain("(preview)");
    await press("Stop preview");
    expect(html().dataset.theme).toBe("clean");
  });

  it("lets a view-only role and a branch login choose a theme for their own device (it is not a company setting)", async () => {
    await open({ readOnly: true });
    expect((page!.container.querySelector('[data-testid="theme-device-clean"]') as HTMLButtonElement).disabled).toBe(
      false,
    );
    await page!.click('[data-testid="theme-device-clean"]');
    expect(html().dataset.theme).toBe("clean");
    page!.unmount();
    page = undefined;

    await open({ editable: false });
    expect((page!.container.querySelector('[data-testid="theme-device-mono"]') as HTMLButtonElement).disabled).toBe(
      false,
    );
    await page!.click('[data-testid="theme-device-mono"]');
    expect(html().dataset.theme).toBe("mono");
    expect(button("Enable Premium Theme")!.disabled).toBe(true);
    expect(puts).toEqual([]);
  });

  it("makes Clean Professional the theme for everyone with the usual request, and the Customize panel edits its six colours", async () => {
    await open();
    await press("Enable Clean Professional");
    expect(puts).toEqual([{ themeName: "clean", themeCustom: {} }]);
    expect(html().dataset.theme).toBe("clean");

    await press("Customize");
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Customize Clean Professional");
    // its own words (the buttons and the menu follow the colours), not the colour themes' "fixed blue" cautions
    expect(dialog.textContent).toContain("The main buttons, links, active tabs");
    expect(dialog.textContent).not.toContain("keep their own fixed blue");
    expect(dialog.querySelector('[data-testid="token-primary"] code')!.textContent).toBe(
      hex(PALETTES.clean["--primary"]),
    );

    // a light primary: shown at once, and saved with the near-black button text it needs
    const light = hexToHslTriple("#ffe08a");
    await page!.type('input[aria-label="Primary"]', "#ffe08a");
    expect(html().style.getPropertyValue("--primary")).toBe(light);
    await press("Save colours");
    expect(puts[1]).toEqual({
      themeName: "clean",
      themeCustom: { "--primary": light, "--primary-foreground": DARK_TEXT },
    });
  });

  it("asks before switching away from Clean Professional when it has custom colours, like any other theme", async () => {
    await open({ themeName: "clean", themeCustom: { "--primary": "0 0% 50%" } });
    await press("Enable Dark Theme");
    expect(page!.container.querySelector('[data-testid="theme-switch-confirm"]')!.textContent).toContain(
      "drops the 1 custom colour set on Clean Professional",
    );
    expect(puts).toEqual([]);
  });

  // The labels on the cards, from their separate sources (status.test.ts holds the rules; this is the page).
  const labels = () =>
    Object.fromEntries(
      THEMES.map((t) => {
        const card = page!.container.querySelector(`[data-testid="theme-card-${t.id}"]`)!;
        return [
          t.id,
          {
            everyone: card.querySelector('[data-testid="theme-status-everyone"]') !== null,
            device: card.querySelector('[data-testid="theme-status-device"]') !== null,
            showing: card.getAttribute("data-showing") === "true",
          },
        ];
      }),
    ) as Record<string, { everyone: boolean; device: boolean; showing: boolean }>;
  const wearing = (key: "everyone" | "device" | "showing") =>
    Object.entries(labels())
      .filter(([, l]) => l[key])
      .map(([id]) => id);

  it("labels: the org-wide theme only", async () => {
    await open({ themeName: "premium" });
    expect(wearing("everyone")).toEqual(["premium"]);
    expect(wearing("device")).toEqual([]);
    expect(wearing("showing")).toEqual(["premium"]);
    expect(html().dataset.theme).toBe("premium");
  });

  it("labels: no device key means no device choice, even when the org-wide theme is the one showing", async () => {
    await open({ themeName: "default" });
    expect(localStorage.getItem("uk_textile_theme_device")).toBeNull();
    expect(wearing("device")).toEqual([]);
    expect(page!.container.querySelector('[data-testid="theme-device-line"]')!.textContent).toContain(
      "Same as everyone",
    );
    for (const t of THEMES) {
      const button = page!.container.querySelector(`[data-testid="theme-device-${t.id}"]`)!;
      expect(button.getAttribute("aria-pressed"), t.id).toBe("false");
      expect(button.textContent, t.id).toContain("Use only on this device");
    }
  });

  it("labels: a device choice only (it differs from the org-wide theme)", async () => {
    await open({ themeName: "default", device: "clean" });
    expect(wearing("everyone")).toEqual(["default"]);
    expect(wearing("device")).toEqual(["clean"]);
    expect(wearing("showing")).toEqual(["clean"]);
    expect(html().dataset.theme).toBe("clean");
  });

  it("labels: both the same theme (one card wears both labels)", async () => {
    await open({ themeName: "premium", device: "premium" });
    expect(wearing("everyone")).toEqual(["premium"]);
    expect(wearing("device")).toEqual(["premium"]);
    expect(wearing("showing")).toEqual(["premium"]);
    const card = page!.container.querySelector('[data-testid="theme-card-premium"]')!;
    expect(card.textContent).toContain("Active for everyone");
    expect(card.textContent).toContain("Active on this device");
    expect(html().dataset.theme).toBe("premium");
  });

  it("labels: both different (each card its own label, and the screen follows the device)", async () => {
    await open({ themeName: "premium", device: "clean" });
    expect(wearing("everyone")).toEqual(["premium"]);
    expect(wearing("device")).toEqual(["clean"]);
    expect(wearing("showing")).toEqual(["clean"]);
    expect(html().dataset.theme).toBe("clean");
  });

  it("labels: a preview moves only 'showing', and stopping it moves it back", async () => {
    await open({ themeName: "premium", device: "clean" });
    await page!.click('[data-testid="theme-preview-dark"]');
    expect(wearing("showing")).toEqual(["dark"]);
    expect(wearing("everyone")).toEqual(["premium"]);
    expect(wearing("device")).toEqual(["clean"]);
    expect(html().dataset.theme).toBe("dark");
    await press("Stop preview");
    expect(wearing("showing")).toEqual(["clean"]);
    expect(html().dataset.theme).toBe("clean");
  });

  it("labels: 'Showing' is the theme really on <html>, whatever route put it there", async () => {
    await open({ themeName: "premium", device: "clean" });
    expect(labels()[html().dataset.theme!].showing).toBe(true);
    await page!.click('[data-testid="theme-preview-mono"]');
    expect(wearing("showing")).toEqual([html().dataset.theme]);
    await press("Stop preview");
    await page!.click('[data-testid="theme-device-clean"]');
    expect(wearing("showing")).toEqual([html().dataset.theme]);
    expect(html().dataset.theme).toBe("premium");
  });

  it("labels: a stale copy cached by this browser never shows as what everyone uses", async () => {
    // this browser kept "premium" from its last visit, but the server now says "default" (someone changed it)
    await open({ themeName: "default", cached: "premium" });
    expect(wearing("everyone")).toEqual(["default"]);
    expect(wearing("showing")).toEqual(["default"]);
    expect(html().dataset.theme).toBe("default");
    expect(localStorage.getItem("uk_textile_theme")).toBe("default");
    expect(wearing("device")).toEqual([]);
  });

  it("labels: when the server does not answer, no card claims to be what everyone uses, and the summary says so", async () => {
    await open({ serverDown: true, cached: "premium" });
    expect(wearing("everyone")).toEqual([]);
    expect(wearing("device")).toEqual([]);
    // the last known theme is still what is drawn, and the summary calls it that
    expect(html().dataset.theme).toBe("premium");
    expect(wearing("showing")).toEqual(["premium"]);
    expect(page!.container.querySelector('[data-testid="theme-everyone-line"]')!.textContent).toContain("last known");
  });
});
