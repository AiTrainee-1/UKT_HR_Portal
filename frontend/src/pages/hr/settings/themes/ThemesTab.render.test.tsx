import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderMdPage, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { hexToHslTriple, THEMES } from "@/lib/themes";
import ThemesTab from "../ThemesTab";
import { THEMES_SETTINGS } from "../ThemesTab.meta";
import { hex, LIGHT_TEXT, PALETTES } from "./palettes";

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
} = {}) {
  let current = { themeName, themeCustom };
  page = await renderMdPage(
    () => (
      <ThemeProvider>
        <ThemesTab readOnly={readOnly} />
      </ThemeProvider>
    ),
    {
      "/api/auth/me": HR,
      "/api/payroll-settings": { companyName: "UKTextiles", companyLogo: null, companyWideRulesEditable: editable },
      "/api/theme-settings": () => current,
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
  it("draws the six themes with the colours src/index.css really gives them", async () => {
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
});
