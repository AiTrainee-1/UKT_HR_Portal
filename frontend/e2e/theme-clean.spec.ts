import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { HR_PASSWORD, HR_USERNAME, loginAsHr } from "./helpers";

// The "Clean Professional" theme (src/themes/clean/) is an alternative look that is on only when someone picks it in
// Settings -> Themes: for everybody, or for one device only. These checks hold the promises made about it:
//   * the default theme, and every other existing theme, draw exactly what they always drew (the expected values below were
//     read from the application BEFORE the theme existed, so they are the old look, not a copy of the new CSS);
//   * Clean Professional draws something different: flat, bordered, solid, square-cornered;
//   * "Use only on this device" is kept in this browser, survives a reload and the sign-in page, and changes nothing for
//     anyone else; making it the theme for everybody reaches a second browser;
//   * nothing sticks out sideways on a phone or a laptop;
//   * the Managing Director's portal keeps its own look whichever theme is chosen.

const DEVICE_KEY = "uk_textile_theme_device";

const style = (page: Page, selector: string, props: string[]) =>
  page
    .locator(selector)
    .first()
    .evaluate((el, ps) => Object.fromEntries(ps.map((p) => [p, getComputedStyle(el).getPropertyValue(p)])), props);

/** Like style(), but a missing element is `null` instead of a wait for it (used where the element may not exist). */
const styleIfAny = (page: Page, selector: string, props: string[]) =>
  page.evaluate(
    ([sel, ps]) => {
      const el = document.querySelector(sel as string);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return Object.fromEntries((ps as string[]).map((p) => [p, cs.getPropertyValue(p)]));
    },
    [selector, props] as const,
  );

async function useDevice(page: Page, theme: string | null) {
  await page.addInitScript(
    ([key, value]) => {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    },
    [DEVICE_KEY, theme] as const,
  );
}

async function openEmployees(page: Page) {
  await page.goto("/hr/employees");
  await expect(page.getByTestId("button-add-employee")).toBeVisible();
  await expect(page.locator("tbody [data-slot='table-row']").first()).toBeVisible();
  await page.waitForTimeout(400);
}

const htmlTheme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme);

test.describe.configure({ mode: "serial" });

test("the default theme still draws the glass-and-clay look it always did", async ({ page }) => {
  await loginAsHr(page);
  expect(await htmlTheme(page)).toBe("default");
  await openEmployees(page);

  expect(await style(page, "body", ["background-color", "color", "font-size", "line-height"])).toEqual({
    "background-color": "rgb(244, 247, 251)",
    color: "rgb(12, 36, 49)",
    "font-size": "16px",
    "line-height": "24px",
  });
  expect(await style(page, '[data-slot="card"]', ["border-top-width", "border-top-left-radius", "box-shadow"])).toEqual(
    {
      "border-top-width": "0px",
      "border-top-left-radius": "16px",
      "box-shadow":
        "rgba(0, 100, 150, 0.1) 10px 10px 20px 0px, rgba(255, 255, 255, 0.85) -5px -5px 15px 0px, rgba(255, 255, 255, 0.7) 3px 3px 6px 0px inset, rgba(0, 100, 150, 0.04) -3px -3px 8px 0px inset",
    },
  );
  expect(
    await style(page, '[data-testid="button-add-employee"]', [
      "background-image",
      "border-top-left-radius",
      "box-shadow",
      "font-weight",
      "min-height",
    ]),
  ).toEqual({
    "background-image": "linear-gradient(to right bottom in oklab, rgb(0, 100, 150) 0%, rgb(0, 128, 191) 100%)",
    "border-top-left-radius": "12px",
    "box-shadow":
      "rgba(0, 100, 150, 0.18) 6px 6px 14px 0px, rgba(255, 255, 255, 0.7) -3px -3px 10px 0px, rgba(255, 255, 255, 0.35) 2px 2px 4px 0px inset, rgba(0, 0, 0, 0.12) -2px -2px 6px 0px inset",
    "font-weight": "600",
    "min-height": "36px",
  });
  expect(
    await style(page, '[data-testid="button-bulk-upload"]', [
      "border-top-width",
      "border-top-left-radius",
      "box-shadow",
    ]),
  ).toEqual({
    "border-top-width": "1px",
    "border-top-left-radius": "12px",
    "box-shadow":
      "rgba(0, 100, 150, 0.18) 6px 6px 14px 0px, rgba(255, 255, 255, 0.7) -3px -3px 10px 0px, rgba(255, 255, 255, 0.35) 2px 2px 4px 0px inset, rgba(0, 0, 0, 0.12) -2px -2px 6px 0px inset",
  });
  expect(
    await style(page, '[data-testid="input-search"]', [
      "background-color",
      "border-top-color",
      "border-top-left-radius",
      "height",
    ]),
  ).toEqual({
    "background-color": "rgba(0, 0, 0, 0)",
    "border-top-color": "rgb(222, 230, 237)",
    "border-top-left-radius": "6px",
    height: "36px",
  });
  expect(await style(page, '[data-testid="select-department"]', ["border-top-color", "height"])).toEqual({
    "border-top-color": "rgb(222, 230, 237)",
    height: "36px",
  });
  expect(
    await style(page, 'th[data-slot="table-head"]', [
      "background-color",
      "color",
      "font-size",
      "font-weight",
      "padding-left",
    ]),
  ).toEqual({
    "background-color": "rgba(0, 0, 0, 0)",
    color: "rgb(100, 116, 139)",
    "font-size": "14px",
    "font-weight": "500",
    "padding-left": "16px",
  });
  expect(await style(page, 'tbody [data-slot="table-cell"]', ["padding-top", "padding-left"])).toEqual({
    "padding-top": "8px",
    "padding-left": "16px",
  });
  expect(
    await style(page, '[data-testid="employees-tabs"] [data-slot="pill-tabs"]', [
      "background-color",
      "border-bottom-width",
    ]),
  ).toEqual({ "background-color": "rgb(243, 244, 246)", "border-bottom-width": "0px" });
  expect(await style(page, '[data-testid="employees-tabs"] [data-slot="pill-tab-fill"]', ["display"])).toEqual({
    display: "block",
  });
  expect(await style(page, "aside", ["background-color", "border-right-color", "box-shadow"])).toEqual({
    "background-color": "rgb(246, 250, 254)",
    "border-right-color": "rgba(0, 100, 150, 0.08)",
    "box-shadow": "rgba(0, 100, 150, 0.08) 10px 0px 30px 0px, rgba(255, 255, 255, 0.9) 2px 0px 8px 0px",
  });
  expect(await style(page, "aside .clay-nav-active", ["background-image", "border-top-left-radius", "color"])).toEqual({
    "background-image": "linear-gradient(135deg, rgb(0, 100, 150), rgb(0, 128, 191))",
    "border-top-left-radius": "12px",
    color: "rgb(255, 255, 255)",
  });
  expect(await style(page, "main h2", ["font-size", "font-weight"])).toEqual({
    "font-size": "24px",
    "font-weight": "900",
  });
  expect(
    await style(page, '[data-slot="page-number"][aria-current="page"]', ["background-color", "border-top-left-radius"]),
  ).toEqual({ "background-color": "rgb(255, 255, 255)", "border-top-left-radius": "8px" });

  // a menu and a dialog keep their frosted, shadowed look too
  await page.getByTestId("select-department").click();
  expect(await style(page, '[data-slot="select-content"]', ["border-top-left-radius", "backdrop-filter"])).toEqual({
    "border-top-left-radius": "6px",
    "backdrop-filter": "none",
  });
  await page.keyboard.press("Escape");
  await page.goto("/hr/settings?tab=themes");
  await page.getByTestId("theme-customize").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await style(page, '[data-slot="dialog-content"]', ["border-top-left-radius", "box-shadow"])).toEqual({
    "border-top-left-radius": "12px",
    "box-shadow": "rgba(15, 23, 42, 0.3) 0px 20px 50px -12px",
  });
  expect(await style(page, '[data-slot="dialog-overlay"]', ["background-color"])).toEqual({
    "background-color": "rgba(15, 23, 42, 0.45)",
  });
});

// the colour themes that existed before: the page behind and the text take the theme's colours as ever, the card, the main
// button and the menu are drawn as ever
const OTHER_THEMES: Record<string, { page: string; text: string }> = {
  dark: { page: "rgb(15, 23, 41)", text: "rgb(248, 250, 252)" },
  premium: { page: "rgb(19, 16, 12)", text: "rgb(241, 237, 228)" },
  mono: { page: "rgb(255, 255, 255)", text: "rgb(23, 23, 23)" },
  "mono-dark": { page: "rgb(0, 0, 0)", text: "rgb(255, 255, 255)" },
  professional: { page: "rgb(248, 250, 252)", text: "rgb(15, 23, 41)" },
};
for (const [theme, expected] of Object.entries(OTHER_THEMES)) {
  test(`the ${theme} theme is untouched`, async ({ page }) => {
    await useDevice(page, theme);
    await loginAsHr(page);
    expect(await htmlTheme(page)).toBe(theme);
    await openEmployees(page);
    expect(await style(page, "body", ["background-color", "color", "font-size"])).toEqual({
      "background-color": expected.page,
      color: expected.text,
      "font-size": "16px",
    });
    expect(await style(page, '[data-slot="card"]', ["border-top-width", "border-top-left-radius"])).toEqual({
      "border-top-width": "0px",
      "border-top-left-radius": "16px",
    });
    expect(
      await style(page, '[data-testid="button-add-employee"]', ["background-image", "border-top-left-radius"]),
    ).toEqual({
      "background-image": "linear-gradient(to right bottom in oklab, rgb(0, 100, 150) 0%, rgb(0, 128, 191) 100%)",
      "border-top-left-radius": "12px",
    });
    expect(await style(page, "aside", ["background-color", "box-shadow"])).toEqual({
      "background-color": "rgb(246, 250, 254)",
      "box-shadow": "rgba(0, 100, 150, 0.08) 10px 0px 30px 0px, rgba(255, 255, 255, 0.9) 2px 0px 8px 0px",
    });
    expect(await style(page, 'th[data-slot="table-head"]', ["font-size", "padding-left"])).toEqual({
      "font-size": "14px",
      "padding-left": "16px",
    });
  });
}

test("Clean Professional draws a flat, bordered, solid look instead", async ({ page }) => {
  await useDevice(page, "clean");
  await loginAsHr(page);
  expect(await htmlTheme(page)).toBe("clean");
  await openEmployees(page);

  expect(await style(page, "body", ["background-color", "color", "font-size"])).toEqual({
    "background-color": "rgb(234, 238, 243)",
    color: "rgb(31, 41, 55)",
    "font-size": "14px",
  });
  expect(await style(page, '[data-slot="card"]', ["border-top-width", "border-top-left-radius", "box-shadow"])).toEqual(
    {
      "border-top-width": "1px",
      "border-top-left-radius": "8px",
      "box-shadow": "none",
    },
  );
  expect(
    await style(page, '[data-testid="button-add-employee"]', [
      "background-image",
      "background-color",
      "border-top-left-radius",
      "box-shadow",
      "font-weight",
    ]),
  ).toEqual({
    "background-image": "none",
    "background-color": "rgb(29, 86, 179)",
    "border-top-left-radius": "6px",
    "box-shadow": "none",
    "font-weight": "500",
  });
  expect(
    await style(page, '[data-testid="button-bulk-upload"]', ["background-color", "border-top-color", "box-shadow"]),
  ).toEqual({
    "background-color": "rgb(255, 255, 255)",
    "border-top-color": "rgb(158, 170, 186)",
    "box-shadow": "none",
  });
  expect(
    await style(page, '[data-testid="input-search"]', [
      "background-color",
      "border-top-color",
      "border-top-left-radius",
      "height",
    ]),
  ).toEqual({
    "background-color": "rgb(255, 255, 255)",
    "border-top-color": "rgb(114, 128, 150)",
    "border-top-left-radius": "6px",
    height: "36px",
  });
  expect(await style(page, 'th[data-slot="table-head"]', ["background-color", "font-size", "font-weight"])).toEqual({
    "background-color": "rgb(230, 235, 241)",
    "font-size": "12px",
    "font-weight": "600",
  });
  // rows are at least 44px, with a 1px line under each
  const row = await page
    .locator("tbody [data-slot='table-row']")
    .first()
    .evaluate((el) => ({
      height: el.getBoundingClientRect().height,
      line: getComputedStyle(el).borderBottomWidth,
    }));
  expect(row.height).toBeGreaterThanOrEqual(44);
  expect(row.line).toBe("1px");
  // tabs are underlined, not pills
  expect(
    await style(page, '[data-testid="employees-tabs"] [data-slot="pill-tabs"]', [
      "background-color",
      "border-top-left-radius",
    ]),
  ).toEqual({ "background-color": "rgba(0, 0, 0, 0)", "border-top-left-radius": "0px" });
  expect(
    await style(page, '[data-testid="employees-tabs"] [data-slot="pill-tab"][aria-selected="true"]', [
      "border-bottom-width",
      "border-bottom-color",
    ]),
  ).toEqual({ "border-bottom-width": "2px", "border-bottom-color": "rgb(29, 86, 179)" });
  // a white menu with a line on its right edge, the open page marked by a soft fill and a bar
  expect(await style(page, "aside", ["background-color", "border-right-color", "box-shadow"])).toEqual({
    "background-color": "rgb(255, 255, 255)",
    "border-right-color": "rgb(195, 204, 216)",
    "box-shadow": "none",
  });
  expect(await style(page, "aside .clay-nav-active", ["background-image"])).toEqual({ "background-image": "none" });
  expect(await style(page, "main h2", ["font-size", "font-weight"])).toEqual({
    "font-size": "22px",
    "font-weight": "700",
  });

  // floating layers: a flat dialog with a very light shadow and no blur
  await page.getByTestId("select-department").click();
  const menu = await style(page, '[data-slot="select-content"]', [
    "border-top-left-radius",
    "backdrop-filter",
    "background-color",
  ]);
  expect(menu).toEqual({
    "border-top-left-radius": "6px",
    "backdrop-filter": "none",
    "background-color": "rgb(255, 255, 255)",
  });
  await page.keyboard.press("Escape");
  await page.goto("/hr/settings?tab=themes");
  await page.getByTestId("theme-customize").click();
  const dialog = await style(page, '[data-slot="dialog-content"]', [
    "border-top-left-radius",
    "backdrop-filter",
    "background-image",
  ]);
  expect(dialog).toEqual({ "border-top-left-radius": "8px", "backdrop-filter": "none", "background-image": "none" });
  const overlay = await style(page, '[data-slot="dialog-overlay"]', ["backdrop-filter"]);
  expect(overlay).toEqual({ "backdrop-filter": "none" });
  await page.keyboard.press("Escape");

  // nothing drawn in the page carries a glass blur
  const blurred = await page.evaluate(
    () =>
      Array.from(document.body.querySelectorAll("*")).filter((el) => {
        const filter = getComputedStyle(el).backdropFilter;
        return filter && filter !== "none";
      }).length,
  );
  expect(blurred).toBe(0);
});

test("Use only on this device: kept in this browser, shown on the sign-in page, and nobody else's screen changes", async ({
  page,
  browser,
}) => {
  await loginAsHr(page);
  await page.goto("/hr/settings?tab=themes");
  const clean = page.getByTestId("theme-card-clean");
  await expect(clean).toBeVisible();
  await expect(page.getByTestId("theme-card-default")).toHaveAttribute("data-active", "true");

  await page.getByTestId("theme-device-clean").click();
  expect(await htmlTheme(page)).toBe("clean");
  await expect(clean).toHaveAttribute("data-device", "true");
  await expect(clean.getByTestId("theme-status-device")).toHaveText("Active on this device");
  await expect(page.getByTestId("theme-card-default").getByTestId("theme-status-everyone")).toHaveText(
    "Active for everyone",
  );
  expect(await page.evaluate((k) => localStorage.getItem(k), DEVICE_KEY)).toBe("clean");

  // nothing was saved for everyone
  const token = await page.evaluate(() => localStorage.getItem("uk_textile_token"));
  const server = await page.request.get("/api/theme-settings", { headers: { Authorization: `Bearer ${token}` } });
  expect((await server.json()).themeName).toBe("default");

  // a reload keeps it, and it is on the page before the app has started (index.html paints it first)
  await page.reload();
  await expect(page.getByTestId("theme-card-clean")).toHaveAttribute("data-device", "true");
  expect(await htmlTheme(page)).toBe("clean");

  // the sign-in page of this browser wears it too: sign out, and look
  await page.evaluate(() => localStorage.removeItem("uk_textile_token"));
  await page.goto("/hr-login");
  await expect(page.getByTestId("input-username")).toBeVisible();
  expect(await htmlTheme(page)).toBe("clean");

  // another browser (another device) is not affected
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await loginAsHr(otherPage);
  expect(await htmlTheme(otherPage)).toBe("default");
  await other.close();

  // clearing it goes back to what everyone uses
  await loginAsHr(page);
  await page.goto("/hr/settings?tab=themes");
  await page.getByTestId("theme-device-clear").click();
  expect(await htmlTheme(page)).toBe("default");
  expect(await page.evaluate((k) => localStorage.getItem(k), DEVICE_KEY)).toBeNull();
  await expect(page.getByTestId("theme-device-line")).toContainText("Same as everyone");

  // a value that is not a theme is ignored
  await page.evaluate((k) => localStorage.setItem(k, "no-such-theme"), DEVICE_KEY);
  await page.reload();
  await expect(page.getByTestId("theme-card-default")).toHaveAttribute("data-active", "true");
  expect(await htmlTheme(page)).toBe("default");
});

test("Clean Professional for everyone reaches another browser, and switching back restores the old look exactly", async ({
  page,
  browser,
}) => {
  await loginAsHr(page);
  await page.goto("/hr/settings?tab=themes");
  try {
    await page.getByRole("switch", { name: "Enable Clean Professional" }).click();
    await expect(page.getByTestId("theme-card-clean")).toHaveAttribute("data-active", "true");
    expect(await htmlTheme(page)).toBe("clean");

    // a second browser that signs in gets it (and keeps the copy for its sign-in page)
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await loginAsHr(otherPage);
    await expect.poll(() => htmlTheme(otherPage)).toBe("clean");
    expect(await otherPage.evaluate(() => localStorage.getItem("uk_textile_theme"))).toBe("clean");
    await other.close();
  } finally {
    // put it back: the other specs run on the default look
    await page.getByRole("switch", { name: "Enable Default Theme" }).click();
    await expect(page.getByTestId("theme-card-default")).toHaveAttribute("data-active", "true");
  }
  expect(await htmlTheme(page)).toBe("default");
  await openEmployees(page);
  expect(await style(page, '[data-slot="card"]', ["border-top-width", "border-top-left-radius"])).toEqual({
    "border-top-width": "0px",
    "border-top-left-radius": "16px",
  });
  expect(await style(page, "aside", ["background-color"])).toEqual({ "background-color": "rgb(246, 250, 254)" });
});

const PAGES = [
  "/hr/dashboard",
  "/hr/employees",
  "/hr/settings?tab=company",
  "/hr/payroll",
  "/hr/attendance/staff",
  "/hr/leave",
  "/hr/requests",
];
for (const [label, size] of [
  ["a laptop", { width: 1366, height: 768 }],
  ["a phone", { width: 390, height: 844 }],
] as const) {
  test(`Clean Professional: nothing is wider than the screen on ${label}`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(size);
    await useDevice(page, "clean");
    await loginAsHr(page);
    for (const path of PAGES) {
      await page.goto(path);
      await expect(page.locator("main")).toBeVisible();
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(500);
      expect(await htmlTheme(page), path).toBe("clean");
      const measure = () =>
        page.evaluate(() => {
          const main = document.querySelector("main");
          return {
            page: document.documentElement.scrollWidth - window.innerWidth,
            main: main ? main.scrollWidth - main.clientWidth : 0,
          };
        });
      const over = await measure();
      // the same page in the default theme, for comparison (the attribute is all the styles key on)
      await page.evaluate(() => (document.documentElement.dataset.theme = "default"));
      const before = await measure();
      await page.evaluate(() => (document.documentElement.dataset.theme = "clean"));
      expect(over.page, `${path}: the page is wider than the screen`).toBeLessThanOrEqual(1);
      // a row of buttons that already ran past the edge of the content area (Employees on a phone) is not made worse
      expect(over.main, `${path}: the content is wider than its area (default: ${before.main})`).toBeLessThanOrEqual(
        Math.max(1, before.main + 1),
      );
    }
  });
}

// ── the Managing Director's portal keeps its own look in every theme ─────────────────────────────────────────────────

const MD_PASSWORD = "Passw0rd!md";
let adminToken = "";

async function signIn(request: APIRequestContext, username: string, password: string) {
  const res = await request.post("/api/auth/hr-login", { data: { username, password } });
  expect(res.status(), `sign in as ${username}`).toBe(200);
  return (await res.json()).token as string;
}

test("the MD portal is the same in Clean Professional as in the default theme", async ({ browser, request }) => {
  test.setTimeout(120_000);
  adminToken = await signIn(request, HR_USERNAME, HR_PASSWORD);
  const headers = { Authorization: `Bearer ${adminToken}` };
  const users = async () =>
    (await (await request.get("/api/hr-users", { headers })).json()) as { id: number; username: string }[];
  const clean = async () => {
    for (const u of (await users()).filter((u) => u.username.startsWith("md_theme"))) {
      await request.delete(`/api/hr-users/${u.id}`, { headers });
    }
  };
  await clean();
  const made = await request.post("/api/hr-users", {
    headers,
    data: { username: "md_theme_clean", password: MD_PASSWORD, fullName: "Theme Tester", isMd: true },
  });
  expect(made.status()).toBe(201);
  const mdToken = await signIn(request, "md_theme_clean", MD_PASSWORD);

  const read = async (theme: string | null) => {
    const context = await browser.newContext({ viewport: { width: 1366, height: 800 } });
    const page = await context.newPage();
    await page.addInitScript(
      ([token, device, key]) => {
        localStorage.setItem("uk_textile_token", token as string);
        if (device) localStorage.setItem(key as string, device as string);
      },
      [mdToken, theme, DEVICE_KEY],
    );
    await page.goto("/md/payroll");
    await expect(page.locator("html[data-md-theme]")).toHaveCount(1);
    await expect(page.getByTestId("md-page-title")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(2500); // the page keeps polling, so "network idle" never comes: give the charts time to draw
    const out = {
      theme: await htmlTheme(page),
      body: await styleIfAny(page, "body", ["background-color", "color", "font-size", "line-height"]),
      title: await styleIfAny(page, '[data-testid="md-page-title"]', [
        "font-size",
        "font-weight",
        "color",
        "font-family",
      ]),
      app: await styleIfAny(page, ".md-app-bg", ["background-image", "color"]),
      button: await styleIfAny(page, '[data-slot="button"]', [
        "background-color",
        "background-image",
        "border-top-left-radius",
        "box-shadow",
      ]),
      // the clean theme's variables are not declared on the MD portal's <html>
      leaked: await page.evaluate(() => {
        const cs = getComputedStyle(document.documentElement);
        return ["--clean-n-500", "--clean-line", "--clean-shadow-float"].map((v) => cs.getPropertyValue(v).trim());
      }),
    };
    await context.close();
    return out;
  };

  try {
    const plain = await read(null);
    const themed = await read("clean");
    expect(plain.theme).toBe("default");
    expect(themed.theme).toBe("clean");
    expect(themed.leaked).toEqual(["", "", ""]);
    // everything the MD portal draws is identical in the two themes
    const { theme: _a, ...plainLook } = plain;
    const { theme: _b, ...themedLook } = themed;
    expect(themedLook).toEqual(plainLook);
    // and it is still the MD's own skin (an indigo-tinted ink, not the clean slate)
    expect(themed.body.color).not.toBe("rgb(31, 41, 55)");
  } finally {
    await clean();
  }
});
