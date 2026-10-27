import { expect, test, type Page } from "@playwright/test";
import { loginAsHr } from "./helpers";

// Clean Professional, area "shell + dashboard + employees + organization" (src/themes/clean/areas/shell-dashboard.css).
// The foundation's own checks live in theme-clean.spec.ts; these hold what this area added:
//   * every page of the area is flat (no blur, no drop shadow other than an indicator bar or the ring of a chosen card, no
//     gradient on a card, button or panel) and nothing sticks out sideways, on a laptop and on a phone;
//   * the pieces the area re-drew (the dashboard's icon tiles, count pills and bars, the stat cards, the roster, the branch
//     and bulk-upload cards, the page-search palette, the collapsed menu's flyout, the floating banners) look the way the
//     theme says;
//   * the same elements keep their old look in the default theme (the expected values were read from the application
//     BEFORE this area's CSS existed).

const DEVICE_KEY = "uk_textile_theme_device";

async function useDevice(page: Page, theme: string | null, collapsedMenu = false) {
  await page.addInitScript(
    ([key, value, collapsed]) => {
      if (value) localStorage.setItem(key as string, value as string);
      else localStorage.removeItem(key as string);
      if (collapsed) localStorage.setItem("hr_sidebar_collapsed", "1");
    },
    [DEVICE_KEY, theme, collapsedMenu] as const,
  );
}

/** The page has drawn: the shell is there, and no loader, skeleton or "can't reach the server" screen is still showing (that
 *  screen is a failed call, and it dismisses itself when the server answers again). */
async function ready(page: Page) {
  // a page's code is compiled the first time the dev server is asked for it, which can take a while on a cold stack
  await expect(page.locator('[data-ui-shell="main"]')).toBeVisible({ timeout: 45_000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  await page
    .waitForFunction(
      () =>
        !document.querySelector(
          ".ukt-circle, .ukt-kpi-run, [data-slot=skeleton], .clay-skeleton, .spinnerContainer, .ss-grid",
        ),
      null,
      { timeout: 30_000 },
    )
    .catch(() => {});
  await page.waitForTimeout(300);
}

const style = (page: Page, selector: string, props: string[], nth = 0) =>
  page
    .locator(selector)
    .nth(nth)
    .evaluate((el, ps) => Object.fromEntries(ps.map((p) => [p, getComputedStyle(el).getPropertyValue(p)])), props);

/** What a CSS colour value computes to, so a rule that reads a token can be compared with the token itself. */
const resolved = (page: Page, value: string) =>
  page.evaluate((v) => {
    const probe = document.createElement("div");
    probe.style.color = v;
    document.body.appendChild(probe);
    const out = getComputedStyle(probe).color;
    probe.remove();
    return out;
  }, value);

async function employeeId(page: Page, code: string) {
  const token = await page.evaluate(() => localStorage.getItem("uk_textile_token"));
  const res = await page.request.get("/api/employees", { headers: { Authorization: `Bearer ${token}` } });
  const rows = (await res.json()) as { id: number; employeeCode: string }[];
  const found = rows.find((r) => r.employeeCode === code);
  expect(found, `employee ${code} in the seed data`).toBeTruthy();
  return found!.id;
}

/** The flat-page audit: what is blurred, shadowed or gradient-filled, and how far the page sticks out sideways. */
async function audit(page: Page) {
  return page.evaluate(() => {
    const describe = (el: Element) =>
      `${el.tagName.toLowerCase()}${el.getAttribute("data-slot") ? `[${el.getAttribute("data-slot")}]` : ""}.${String(
        (el as HTMLElement).className && typeof (el as HTMLElement).className === "string"
          ? (el as HTMLElement).className
          : "",
      )
        .split(" ")
        .slice(0, 4)
        .join(".")}`;
    // a computed box-shadow that draws something: not "none", not Tailwind's all-transparent ring and shadow variables
    const draws = (value: string) => {
      if (!value || value === "none") return false;
      const parts: string[] = [];
      let depth = 0;
      let current = "";
      for (const ch of value) {
        if (ch === "(") depth++;
        if (ch === ")") depth--;
        if (ch === "," && depth === 0) {
          parts.push(current.trim());
          current = "";
        } else current += ch;
      }
      if (current.trim()) parts.push(current.trim());
      return parts.some((part) => {
        const clear = /rgba\([^)]*,\s*0\)/.test(part) || /\/\s*0\)/.test(part);
        const numbers = part
          .replace(/(rgba?|color)\([^)]*\)/g, "")
          .trim()
          .split(/\s+/)
          .map((n) => parseFloat(n));
        return !clear && numbers.some((n) => n);
      });
    };
    const blurred: string[] = [];
    const shadowed: string[] = [];
    const gradients: string[] = [];
    document.querySelectorAll("body *").forEach((el) => {
      const cs = getComputedStyle(el);
      if (cs.backdropFilter && cs.backdropFilter !== "none") blurred.push(describe(el));
      // an inset shadow is the menu's 3px bar on the open page or the line under the tabs; a 0 blur ring is the outline of
      // the chosen card: indicators, not elevation
      if (
        draws(cs.boxShadow) &&
        !/inset/.test(cs.boxShadow) &&
        el.getAttribute("data-selected") !== "true" &&
        el.getAttribute("aria-checked") !== "true"
      ) {
        shadowed.push(`${describe(el)} :: ${cs.boxShadow.slice(0, 70)}`);
      }
      // the 4% dot pattern behind an ID card (a document preview, drawn with its own design) is the one allowed gradient
      if (/gradient/.test(cs.backgroundImage) && !el.matches('[class*="opacity-[0.04]"]')) {
        gradients.push(`${describe(el)} :: ${cs.backgroundImage.slice(0, 60)}`);
      }
    });
    return {
      blurred,
      shadowed,
      gradients,
      sideways: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
}

const PAGES = [
  "/hr/dashboard",
  "/hr/employees",
  "/hr/employees?tab=coemp",
  "/hr/employees/productionEmployee",
  "/hr/employees/bulk-upload",
  "/hr/employees/new",
  "/hr/departments",
  "/hr/designations",
  "/hr/branches",
  "/hr/promotion",
  "/hr/increment",
];

test.describe.configure({ mode: "serial" });

for (const [label, size] of [
  ["a laptop", { width: 1366, height: 800 }],
  ["a phone", { width: 390, height: 844 }],
] as const) {
  test(`Clean Professional: the pages of the shell, dashboard, employees and organization area are flat and fit ${label}`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await page.setViewportSize(size);
    await useDevice(page, "clean");
    await loginAsHr(page);
    const profile = `/hr/employees/${await employeeId(page, "E2E001")}`;
    for (const path of [...PAGES, profile, `${profile}/edit`]) {
      await page.goto(path);
      await ready(page);
      expect(await page.evaluate(() => document.documentElement.dataset.theme), path).toBe("clean");
      const found = await audit(page);
      expect(found.sideways, `${path}: wider than the screen`).toBeLessThanOrEqual(1);
      expect(found.blurred, `${path}: frosted glass`).toEqual([]);
      expect(found.shadowed, `${path}: a drop shadow on the page`).toEqual([]);
      expect(found.gradients, `${path}: a gradient`).toEqual([]);
    }
  });
}

test("Clean Professional: the dashboard's tiles, pills, bars and title", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 800 });
  await useDevice(page, "clean");
  await loginAsHr(page);
  await ready(page);
  const soft = await resolved(page, "var(--clean-primary-soft)");
  const brand = await resolved(page, "hsl(var(--primary))");

  // the icon tile of a card: one soft brand square, no clay shadow (the page paints it with its own accent inline)
  const tile = await style(page, '[data-ui-shell="main"] div.w-9.h-9.rounded-xl', [
    "background-color",
    "border-top-left-radius",
    "box-shadow",
  ]);
  expect(tile).toEqual({ "background-color": soft, "border-top-left-radius": "6px", "box-shadow": "none" });
  const tileIcons = await page
    .locator('[data-ui-shell="main"] div.w-9.h-9.rounded-xl > span')
    .evaluateAll((els) => els.map((el) => getComputedStyle(el).color));
  expect(new Set(tileIcons), "all six icons are the brand colour, not amber, purple and rose").toEqual(
    new Set([brand]),
  );

  // the capsule buttons of the header are 6px buttons; the main one is solid brand
  const sync = page.getByRole("button", { name: /Auto Sync|Syncing/ });
  expect(await sync.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe("6px");
  expect(await sync.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("1px");
  const add = page.getByRole("button", { name: "+ Add Employee" });
  expect(
    await add.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { radius: cs.borderTopLeftRadius, image: cs.backgroundImage, colour: cs.backgroundColor };
    }),
  ).toEqual({ radius: "6px", image: "none", colour: brand });

  // the department bars are the brand colour, not eight blues
  const bars = await page
    .locator('[data-ui-shell="main"] div.h-2.rounded-full[style*="width"]')
    .evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
  expect(bars.length).toBeGreaterThan(0);
  expect(new Set(bars)).toEqual(new Set([brand]));

  // the title is the same size and weight as on every other page; the section headings are readable
  expect(await style(page, '[data-ui-shell="main"] h2', ["font-size", "font-weight"])).toEqual({
    "font-size": "22px",
    "font-weight": "700",
  });
  const heading = await style(page, '[data-ui-shell="main"] h3.uppercase', ["font-size"]);
  expect(heading["font-size"]).toBe("11px");

  // the tinted tiles of the geo and recruitment sections are quiet grey panels with a line
  const geo = await style(page, '[data-ui-shell="main"] button.text-left.rounded-xl.p-3', [
    "border-top-width",
    "border-top-left-radius",
    "box-shadow",
  ]);
  expect(geo).toEqual({ "border-top-width": "1px", "border-top-left-radius": "8px", "box-shadow": "none" });
});

test("Clean Professional: stat cards, the roster, branches and the bulk upload cards", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 800 });
  await useDevice(page, "clean");
  await loginAsHr(page);
  const brand = await resolved(page, "hsl(var(--primary))");
  const soft = await resolved(page, "var(--clean-primary-soft)");
  const white = "rgb(255, 255, 255)";

  // a stat card is one white card with a line, whatever tone the page gave it
  await page.goto("/hr/departments");
  await ready(page);
  const stat = page.locator('[data-ui-shell="main"] [class*="rounded-2xl"][class*="items-start"]').first();
  expect(
    await stat.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, line: cs.borderTopWidth, radius: cs.borderTopLeftRadius };
    }),
  ).toEqual({ bg: white, line: "1px", radius: "8px" });
  // its icon is the soft brand square
  expect(await stat.locator('[class~="bg-white/60"]').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    soft,
  );

  // the pay-cycle cards are the same cards; the chosen one has the brand line
  await page.goto("/hr/employees/productionEmployee");
  await ready(page);
  const weekly = page.getByTestId("pe-stat-weekly");
  expect(await weekly.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("1px");
  const unassigned = page.getByTestId("pe-stat-unassigned");
  await unassigned.locator("button").click();
  expect(
    await unassigned.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { colour: cs.borderTopColor, selected: el.getAttribute("data-selected") };
    }),
  ).toEqual({ colour: brand, selected: "true" });

  // the roster fits its card (a table of eight columns or more has 6px cell padding; with 12px it was 76px too wide)
  await page.goto("/hr/employees");
  await ready(page);
  await expect(page.locator("tbody [data-slot='table-row']").first()).toBeVisible();
  const fit = await page
    .locator("table")
    .first()
    .evaluate((table) => {
      const box = table.closest('[data-slot="table-container"]') as HTMLElement;
      return { table: table.getBoundingClientRect().width, box: box.clientWidth, scroll: box.scrollWidth };
    });
  expect(fit.scroll, "the roster does not scroll sideways").toBeLessThanOrEqual(fit.box + 1);
  expect(await style(page, "table th", ["padding-left"], 1)).toEqual({ "padding-left": "6px" });
  expect(await style(page, "table th", ["padding-left"], 0)).toEqual({ "padding-left": "16px" });

  // a branch's icon is the solid brand colour (it was a teal gradient) and the card/table toggle is no longer a black block
  await page.goto("/hr/branches");
  await ready(page);
  const icon = page.locator('[data-testid^="branch-card-"] div.h-10.w-10').first();
  expect(
    await icon.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { image: cs.backgroundImage, colour: cs.backgroundColor };
    }),
  ).toEqual({ image: "none", colour: brand });
  const toggle = await style(page, '[data-testid="view-grid"]', [
    "background-color",
    "color",
    "border-top-left-radius",
  ]);
  // (the chosen segment is a white tile with a line and the dark brand ink: the segmented-group rule of primitives.css; what
  // matters here is that it is no longer a black block)
  expect(toggle["background-color"]).not.toBe("rgb(17, 24, 39)");
  expect(toggle.color).toBe(await resolved(page, "var(--clean-b-800)"));
  expect(await style(page, '[data-testid="filter-head-office"]', ["border-top-left-radius"])).toEqual({
    "border-top-left-radius": "6px",
  });

  // the bulk upload kind cards: the picked one is brand, not emerald, and neither carries a gradient
  await page.goto("/hr/employees/bulk-upload");
  await ready(page);
  const picked = page.getByTestId("category-staff");
  expect(
    await picked.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { image: cs.backgroundImage, bg: cs.backgroundColor, line: cs.borderTopColor };
    }),
  ).toEqual({ image: "none", bg: soft, line: brand });
  expect(
    await picked
      .locator(":scope > div")
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe(brand);
  await page.getByTestId("category-production").click();
  await expect(page.getByTestId("category-staff")).toHaveCSS("background-color", white);
});

test("Clean Professional: the page-search palette, the collapsed menu and the floating banners", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 800 });
  await useDevice(page, "clean", true);
  await loginAsHr(page);
  await page.goto("/hr/employees");
  await ready(page);

  // the flyout of a group on the collapsed rail: the open page keeps a readable label (it was white on a pale fill)
  await page.locator("aside nav .cursor-pointer").nth(1).click();
  const flyout = page.locator('[data-slot="popover-panel"]');
  await expect(flyout).toBeVisible();
  const label = flyout.locator(".clay-nav-active span").filter({ hasText: "All Employees" }).first();
  const labelColour = await label.evaluate((el) => getComputedStyle(el).color);
  expect(labelColour).toBe(await resolved(page, "hsl(var(--accent-foreground))"));
  await page.keyboard.press("Escape");

  // the page-search palette is a floating layer: a line and the light shadow, over the dialog scrim
  await page
    .getByRole("button", { name: /search/i })
    .first()
    .click();
  const palette = page.locator("body > div.fixed.inset-0 > div.relative").first();
  await expect(palette).toBeVisible();
  const look = await palette.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { line: cs.borderTopWidth, shadow: cs.boxShadow !== "none", blur: cs.backdropFilter };
  });
  expect(look).toEqual({ line: "1px", shadow: true, blur: "none" });
  expect(
    await page
      .locator("body > div.fixed.inset-0")
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe(await resolved(page, "var(--clean-scrim)"));
  await page.keyboard.press("Escape");

  // the progress banners (biometric sync, payroll, salary slips, WhatsApp, resume screening) only exist while a run is on, so
  // this draws one with their exact classes and checks what the theme makes of it
  const banner = await page.evaluate(() => {
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div id="fake-banner" class="fixed bottom-5 right-5 z-[100] w-80 rounded-2xl border border-cyan-100 bg-white/95 backdrop-blur-xl shadow-[0_16px_48px_-12px_rgba(15,40,80,0.35)] p-4">
         <div class="h-1.5 w-full rounded-full bg-cyan-100/70 overflow-hidden"><div id="fake-bar" class="h-full rounded-full bg-gradient-to-r from-cyan-400 via-blue-500 to-indigo-500" style="width:60%"></div></div>
       </div>`,
    );
    const cs = getComputedStyle(document.getElementById("fake-banner")!);
    const bar = getComputedStyle(document.getElementById("fake-bar")!);
    const out = {
      blur: cs.backdropFilter,
      shadow: cs.boxShadow !== "none",
      radius: cs.borderTopLeftRadius,
      bg: cs.backgroundColor,
      barImage: bar.backgroundImage,
      barColour: bar.backgroundColor,
    };
    document.getElementById("fake-banner")!.remove();
    return out;
  });
  expect(banner.blur).toBe("none");
  expect(banner.shadow).toBe(true);
  expect(banner.radius).toBe("8px");
  expect(banner.bg).toBe("rgb(255, 255, 255)");
  expect(banner.barImage).toBe("none");
  expect(banner.barColour).toBe(await resolved(page, "hsl(var(--primary))"));
});

test("Clean Professional: on a phone the title-bar buttons and the profile header wrap, and the attendance card stacks", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await useDevice(page, "clean");
  await loginAsHr(page);

  await page.goto("/hr/employees");
  await ready(page);
  for (const id of ["button-toggle-inactive", "button-bulk-upload", "button-add-employee"]) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box!.x + box!.width, `${id} is inside the screen`).toBeLessThanOrEqual(390);
  }

  const profile = `/hr/employees/${await employeeId(page, "E2E001")}`;
  await page.goto(profile);
  await ready(page);
  const download = await page.getByRole("button", { name: /Download ID Card|Preparing/ }).boundingBox();
  expect(download!.x + download!.width, "Download ID Card is inside the screen").toBeLessThanOrEqual(390);

  await page.goto("/hr/dashboard");
  await ready(page);
  const cell = page.locator('[data-ui-shell="main"] div.grid-cols-2.divide-x > div').first();
  expect(await cell.evaluate((el) => getComputedStyle(el).flexDirection)).toBe("column");
  const staff = page.locator('[data-ui-shell="main"] div.grid-cols-2.divide-x > div').nth(1);
  const edge = await staff.evaluate((el) => {
    const card = el.getBoundingClientRect();
    return Array.from(el.querySelectorAll("p,span")).every((c) => c.getBoundingClientRect().right <= card.right + 1);
  });
  expect(edge, "the figures of the second column are not cut off").toBe(true);
});

// ── the default theme is what it was ────────────────────────────────────────────────────────────────────────────────

test("the default theme draws the same elements as before this area's CSS existed", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 800 });
  await useDevice(page, null);
  await loginAsHr(page);
  await ready(page);
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("default");

  expect(
    await style(page, '[data-ui-shell="main"] div.w-9.h-9.rounded-xl', [
      "background-color",
      "border-top-left-radius",
      "box-shadow",
    ]),
  ).toEqual({
    "background-color": "rgba(0, 100, 150, 0.094)",
    "border-top-left-radius": "12px",
    "box-shadow":
      "rgba(0, 100, 150, 0.125) 4px 4px 10px 0px, rgba(255, 255, 255, 0.8) -2px -2px 6px 0px, rgba(255, 255, 255, 0.6) 2px 2px 4px 0px inset",
  });
  expect(await style(page, '[data-ui-shell="main"] div.w-9.h-9.rounded-xl > span', ["color"], 2)).toEqual({
    color: "rgb(245, 158, 11)",
  });
  expect(
    await style(
      page,
      '[data-ui-shell="main"] button.rounded-full[class*="text-[11px]"]',
      ["border-top-left-radius", "border-top-width", "background-color"],
      1,
    ),
  ).toEqual({
    "border-top-left-radius": "3.35544e+07px",
    "border-top-width": "0px",
    "background-color": "rgba(0, 100, 150, 0.06)",
  });
  expect(
    await style(page, '[data-ui-shell="main"] button.rounded-full.text-white', [
      "border-top-left-radius",
      "background-image",
      "border-top-width",
    ]),
  ).toEqual({
    "border-top-left-radius": "3.35544e+07px",
    "background-image": "linear-gradient(135deg, rgb(0, 100, 150), rgb(0, 150, 199))",
    "border-top-width": "0px",
  });
  expect(
    await style(page, '[data-ui-shell="main"] div.h-2.rounded-full[style*="width"]', ["background-color"]),
  ).toEqual({
    "background-color": "rgb(0, 100, 150)",
  });
  expect(
    await style(page, '[data-ui-shell="main"] button.text-left.rounded-xl.p-3', [
      "background-color",
      "border-top-width",
    ]),
  ).toEqual({
    "background-color": "rgba(0, 100, 150, 0.05)",
    "border-top-width": "0px",
  });
  expect(await style(page, '[data-ui-shell="main"] h3.uppercase', ["font-size", "letter-spacing"])).toEqual({
    "font-size": "10px",
    "letter-spacing": "1px",
  });
  expect(await style(page, '[data-ui-shell="main"] h2', ["font-size", "font-weight"])).toEqual({
    "font-size": "20px",
    "font-weight": "900",
  });

  await page.goto("/hr/employees");
  await ready(page);
  await expect(page.locator("tbody [data-slot='table-row']").first()).toBeVisible();
  expect(await style(page, "table th", ["padding-left", "padding-right"], 1)).toEqual({
    "padding-left": "8px",
    "padding-right": "8px",
  });
  expect(await style(page, "table th", ["padding-left"], 0)).toEqual({ "padding-left": "16px" });
  expect(await style(page, 'tbody td:last-child [data-slot="button"]', ["width", "height"])).toEqual({
    width: "36px",
    height: "36px",
  });
  expect(await style(page, "tbody td:last-child > div", ["column-gap"])).toEqual({ "column-gap": "4px" });

  await page.goto("/hr/departments");
  await ready(page);
  const stat = await style(page, '[data-ui-shell="main"] [class*="rounded-2xl"][class*="items-start"]', [
    "border-top-width",
    "border-top-left-radius",
  ]);
  expect(stat).toEqual({ "border-top-width": "0px", "border-top-left-radius": "16px" });

  await page.goto("/hr/employees/productionEmployee");
  await ready(page);
  expect(await style(page, '[data-testid="pe-stat-weekly"]', ["border-top-width", "border-top-left-radius"])).toEqual({
    "border-top-width": "0px",
    "border-top-left-radius": "16px",
  });
  await page.getByTestId("pe-stat-unassigned").locator("button").click();
  await page.waitForTimeout(700); // the ring is drawn by a transition: read it when it has settled
  expect(await style(page, '[data-testid="pe-stat-unassigned"]', ["box-shadow"])).toEqual({
    "box-shadow": "rgb(217, 119, 6) 0px 0px 0px 2px",
  });

  await page.goto("/hr/branches");
  await ready(page);
  expect(await style(page, '[data-testid^="branch-card-"] div.h-10.w-10', ["background-image"])).toEqual({
    "background-image": "linear-gradient(135deg, rgb(15, 118, 110), rgb(6, 182, 212))",
  });
  expect(await style(page, '[data-testid="view-grid"]', ["color", "border-top-left-radius"])).toEqual({
    color: "rgb(255, 255, 255)",
    "border-top-left-radius": "6px",
  });
  expect(await style(page, '[data-testid="filter-head-office"]', ["border-top-left-radius"])).toEqual({
    "border-top-left-radius": "3.35544e+07px",
  });

  await page.goto("/hr/employees/bulk-upload");
  await ready(page);
  expect(await style(page, '[data-testid="category-staff"]', ["background-image", "border-top-left-radius"])).toEqual({
    "background-image":
      "linear-gradient(to right bottom, oklch(0.979 0.021 166.113) 0%, rgb(255, 255, 255) 50%, rgb(255, 255, 255) 100%)",
    "border-top-left-radius": "16px",
  });

  // the page-search palette: still the old shadowed, frosted look
  await page
    .getByRole("button", { name: /search/i })
    .first()
    .click();
  const palette = page.locator("body > div.fixed.inset-0 > div.relative").first();
  await expect(palette).toBeVisible();
  expect(await palette.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("0px");
  expect(await palette.evaluate((el) => getComputedStyle(el).boxShadow)).toContain("rgba(0, 100, 150, 0.15)");
});
