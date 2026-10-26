import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderMdPage, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import { THEME_DEVICE_STORAGE_KEY, ThemeProvider, readDeviceTheme, useTheme } from "@/contexts/ThemeContext";
import type { ThemeId } from "@/lib/themes";

// The theme the page is drawn in: the live preview, else the device's own choice ("Use only on this device", a ThemeId in
// localStorage that is never sent to the server), else the org-wide theme from the server. These tests render the real
// provider with a fake server.

type Ctx = ReturnType<typeof useTheme>;
let ctx: Ctx;
let seen: ThemeId[];
let states: string[];
let page: RenderedPage | undefined;
let puts: unknown[];

function Probe() {
  const t = useTheme();
  ctx = t;
  seen.push(t.effectiveTheme);
  states.push(t.orgThemeState);
  return (
    <p data-testid="probe">
      {t.theme}|{t.deviceTheme ?? "none"}|{t.effectiveTheme}
    </p>
  );
}

const html = () => document.documentElement;
const probe = () => page!.container.querySelector('[data-testid="probe"]')!.textContent;

beforeEach(() => {
  seen = [];
  states = [];
  puts = [];
  for (const key of ["uk_textile_theme", "uk_textile_theme_custom", THEME_DEVICE_STORAGE_KEY])
    localStorage.removeItem(key);
  html().removeAttribute("style");
  html().classList.remove("dark");
  delete html().dataset.theme;
});
afterEach(() => {
  page?.unmount();
  page = undefined;
});

async function open({
  org = "default",
  custom = {} as Record<string, string>,
  device,
  stored,
  storedCustom,
}: {
  /** What the server says the org-wide theme is. */
  org?: string;
  custom?: Record<string, string>;
  /** localStorage's device key, as stored (may be junk). */
  device?: string;
  /** localStorage's cached org-wide theme (what a browser kept from its last visit). */
  stored?: string;
  storedCustom?: Record<string, string>;
} = {}) {
  if (device !== undefined) localStorage.setItem(THEME_DEVICE_STORAGE_KEY, device);
  if (stored !== undefined) localStorage.setItem("uk_textile_theme", stored);
  if (storedCustom !== undefined) localStorage.setItem("uk_textile_theme_custom", JSON.stringify(storedCustom));
  page = await renderMdPage(
    () => (
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    ),
    {
      "/api/theme-settings": () => ({ themeName: org, themeCustom: custom }),
      "/api/theme-settings/update": (_params, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          themeName: string;
          themeCustom: Record<string, string>;
        };
        puts.push(body);
        return body;
      },
    },
    { path: "/hr/settings?tab=themes" },
  );
  return page;
}

describe("the device's own theme", () => {
  it("is on the page from the first render, before the server has answered, and the server never overwrites it", async () => {
    await open({ org: "professional", device: "clean", stored: "premium" });
    // the very first render already used the device's theme (not the cached org theme, not the default)
    expect(seen[0]).toBe("clean");
    expect(seen.every((t) => t === "clean")).toBe(true);
    expect(html().dataset.theme).toBe("clean");
    // the server said "professional" for everyone: that is the org-wide theme, the device keeps its own
    expect(probe()).toBe("professional|clean|clean");
    expect(localStorage.getItem(THEME_DEVICE_STORAGE_KEY)).toBe("clean");
    expect(localStorage.getItem("uk_textile_theme")).toBe("professional");
  });

  it("with no device choice, the org-wide theme shows (cached first, then the server's)", async () => {
    await open({ org: "premium", stored: "dark" });
    expect(seen[0]).toBe("dark");
    expect(probe()).toBe("premium|none|premium");
    expect(html().dataset.theme).toBe("premium");
  });

  it("ignores a stored value that is not a theme (a removed theme, a hand-edited key)", async () => {
    await open({ org: "premium", device: "glass-pro" });
    expect(probe()).toBe("premium|none|premium");
    expect(html().dataset.theme).toBe("premium");
    expect(readDeviceTheme()).toBeNull();
    localStorage.setItem(THEME_DEVICE_STORAGE_KEY, "");
    expect(readDeviceTheme()).toBeNull();
    localStorage.setItem(THEME_DEVICE_STORAGE_KEY, "Clean");
    expect(readDeviceTheme()).toBeNull();
    localStorage.setItem(THEME_DEVICE_STORAGE_KEY, "clean");
    expect(readDeviceTheme()).toBe("clean");
  });

  it("precedence is: live preview, then the device's choice, then the org-wide theme", async () => {
    await open({ org: "professional", device: "clean" });
    expect(html().dataset.theme).toBe("clean");

    await act(async () => ctx.preview("dark"));
    expect(html().dataset.theme).toBe("dark");
    expect(html().classList.contains("dark")).toBe(true);
    expect(ctx.effectiveTheme).toBe("dark");

    await act(async () => ctx.preview(null));
    expect(html().dataset.theme).toBe("clean");
    expect(html().classList.contains("dark")).toBe(false);

    await act(async () => ctx.setDeviceTheme(null));
    expect(html().dataset.theme).toBe("professional");
    expect(ctx.deviceTheme).toBeNull();
    expect(localStorage.getItem(THEME_DEVICE_STORAGE_KEY)).toBeNull();
  });

  it("setting it writes only localStorage: nothing is sent to the server", async () => {
    await open({ org: "default" });
    expect(html().dataset.theme).toBe("default");
    await act(async () => ctx.setDeviceTheme("clean"));
    expect(html().dataset.theme).toBe("clean");
    expect(localStorage.getItem(THEME_DEVICE_STORAGE_KEY)).toBe("clean");
    expect(page!.requests().filter((r) => r.startsWith("/api/theme-settings/update"))).toEqual([]);
    expect(puts).toEqual([]);
  });

  it("saving the org-wide theme leaves the device's choice alone", async () => {
    await open({ org: "default", device: "clean" });
    await act(async () => {
      await ctx.save("premium", {});
    });
    expect(puts).toEqual([{ themeName: "premium", themeCustom: {} }]);
    expect(ctx.theme).toBe("premium");
    expect(ctx.deviceTheme).toBe("clean");
    expect(html().dataset.theme).toBe("clean");
    expect(localStorage.getItem(THEME_DEVICE_STORAGE_KEY)).toBe("clean");
  });

  it("follows a change made in another tab of the same browser (the storage event)", async () => {
    await open({ org: "default" });
    expect(html().dataset.theme).toBe("default");
    await act(async () => {
      localStorage.setItem(THEME_DEVICE_STORAGE_KEY, "mono");
      window.dispatchEvent(new StorageEvent("storage", { key: THEME_DEVICE_STORAGE_KEY, newValue: "mono" }));
    });
    expect(html().dataset.theme).toBe("mono");
    await act(async () => {
      localStorage.removeItem(THEME_DEVICE_STORAGE_KEY);
      window.dispatchEvent(new StorageEvent("storage", { key: THEME_DEVICE_STORAGE_KEY, newValue: null }));
    });
    expect(html().dataset.theme).toBe("default");
  });
});

describe("what is known about the org-wide theme", () => {
  it("starts as the cached copy and becomes the server's once it answers (a label for everyone waits for that)", async () => {
    await open({ org: "default", stored: "premium" });
    expect(states[0]).toBe("cached");
    expect(ctx.orgThemeState).toBe("confirmed");
    expect(ctx.theme).toBe("default");
  });

  it("says unreachable when the server does not answer, and keeps drawing the cached theme", async () => {
    localStorage.setItem("uk_textile_theme", "premium");
    page = await renderMdPage(
      () => (
        <ThemeProvider>
          <Probe />
        </ThemeProvider>
      ),
      { "/api/theme-settings": { status: 503, body: { error: "down" } } },
      { path: "/hr-login" },
    );
    expect(ctx.orgThemeState).toBe("unreachable");
    expect(ctx.theme).toBe("premium");
    expect(html().dataset.theme).toBe("premium");
  });

  it("appliedTheme is what is on <html>, including a preview", async () => {
    await open({ org: "premium", device: "clean" });
    expect(ctx.appliedTheme).toBe(html().dataset.theme);
    await act(async () => ctx.preview("mono"));
    expect(ctx.appliedTheme).toBe("mono");
    expect(html().dataset.theme).toBe("mono");
  });
});

describe("the org-wide custom colours belong to the org-wide theme", () => {
  const custom = { "--primary": "0 0% 50%" };

  it("are drawn when the device follows the org-wide theme, or has chosen the same one", async () => {
    await open({ org: "premium", custom });
    expect(html().style.getPropertyValue("--primary")).toBe("0 0% 50%");
    await act(async () => ctx.setDeviceTheme("premium"));
    expect(html().style.getPropertyValue("--primary")).toBe("0 0% 50%");
  });

  it("are not drawn on a device that uses another theme: it shows that theme as it comes", async () => {
    await open({ org: "premium", custom, device: "clean" });
    expect(html().dataset.theme).toBe("clean");
    expect(html().style.getPropertyValue("--primary")).toBe("");
    await act(async () => ctx.setDeviceTheme(null));
    expect(html().dataset.theme).toBe("premium");
    expect(html().style.getPropertyValue("--primary")).toBe("0 0% 50%");
  });

  it("a preview of the org-wide theme from a device on another theme shows its colours (that is what everyone sees)", async () => {
    await open({ org: "premium", custom, device: "clean" });
    await act(async () => ctx.preview("premium"));
    expect(html().dataset.theme).toBe("premium");
    expect(html().style.getPropertyValue("--primary")).toBe("0 0% 50%");
  });
});
