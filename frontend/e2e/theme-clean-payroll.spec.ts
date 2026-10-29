import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { HR_PASSWORD, HR_USERNAME } from "./helpers";

// The payroll area of the "Clean Professional" theme (src/themes/clean/areas/payroll.css): Staff Payroll, Production Payroll, a
// payroll's details page, Bonus, Settlement, Promotion and Salary Increment, with their dialogs and the settlement sheet.
// What is held here:
//   * every page of the area, at a laptop and a phone width, is flat: nothing sticks out sideways, no frosted blur, no drop
//     shadow outside a floating layer, no gradient fill (the printed-format salary statement is left as designed: its sheet is
//     not themed, and the screen around it is checked like any other page);
//   * the figure tiles are white tiles with a 1px line (not pastel boxes), the downloads are neutral buttons (not green), the
//     views of a tab are underlined, the initials avatars are one colour, the production accent is the brand colour;
//   * the same pages in the default theme keep the look they always had (the values below were read from the application
//     before the area file existed).
// Data: February 2026 from seed_e2e.py (Asha, Ravi, Meena) paid through the API, and two advances made here and removed again.

const DEVICE_KEY = "uk_textile_theme_device";
const FEB = "/hr/payroll?month=2&year=2026";
const WIDTHS = [1366, 390] as const;

let token = "";
let advanceIds: number[] = [];
let ashaPayrollId = 0;

async function api(request: APIRequestContext, method: string, url: string, data?: unknown) {
  const res = await request.fetch(url, { method, headers: { Authorization: `Bearer ${token}` }, data });
  const text = await res.text();
  return { status: res.status(), body: text ? JSON.parse(text) : null };
}

test.beforeAll(async ({ request }) => {
  const login = await request.post("/api/auth/hr-login", { data: { username: HR_USERNAME, password: HR_PASSWORD } });
  token = (await login.json()).token as string;
  await api(request, "POST", "/api/payroll/generate", { month: 2, year: 2026 });
  const payrolls = (await api(request, "GET", "/api/payroll?month=2&year=2026")).body as {
    id: number;
    employeeCode: string;
  }[];
  ashaPayrollId = payrolls.find((p) => p.employeeCode === "E2E001")!.id;
  const employees = (await api(request, "GET", "/api/employees")).body as { id: number; employeeCode: string }[];
  const asha = employees.find((e) => e.employeeCode === "E2E001")!;
  const ravi = employees.find((e) => e.employeeCode === "E2E002")!;
  for (const [employee, amount] of [
    [asha, 6000],
    [ravi, 9000],
  ] as const) {
    const made = await api(request, "POST", "/api/advances", {
      employeeId: employee.id,
      advanceType: "general",
      amount,
      emiAmount: amount,
      purpose: "theme-clean-payroll",
      repaymentStartMonth: 3,
      repaymentStartYear: 2026,
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    advanceIds.push(made.body.id);
  }
  // one of them is decided, so the list shows a pending one (Approve / Reject) and an approved one
  await api(request, "PUT", `/api/advances/${advanceIds[1]}`, { status: "approved", approvedBy: "E2E Admin" });
});

test.afterAll(async ({ request }) => {
  for (const id of advanceIds) await api(request, "DELETE", `/api/advances/${id}`);
  advanceIds = [];
});

async function open(page: Page, theme: "clean" | "default", path: string, width: number = 1366) {
  await page.setViewportSize({ width, height: width < 500 ? 844 : 900 });
  await page.addInitScript(
    ([key, value, t]) => {
      localStorage.setItem("uk_textile_token", t);
      if (value === "default") localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    },
    [DEVICE_KEY, theme, token] as const,
  );
  await page.goto(path);
  // some pages poll, so "idle" may never come: wait a few seconds at most
  await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => undefined);
  await page.waitForTimeout(900);
}

const styleOf = (page: Page, selector: string, props: string[]) =>
  page
    .locator(selector)
    .first()
    .evaluate((el, ps) => Object.fromEntries(ps.map((p) => [p, getComputedStyle(el).getPropertyValue(p)])), props);

/** A computed colour (rgb(), oklch(), oklab(), color-mix result ...) as [r, g, b, alpha 0-1]: the browser's canvas converts it. */
const colourOf = (page: Page, selector: string, prop: string, nth = 0) =>
  page
    .locator(selector)
    .nth(nth)
    .evaluate((el, p) => {
      const value = getComputedStyle(el).getPropertyValue(p);
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = value;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], Math.round((d[3] / 255) * 100) / 100];
    }, prop);

const isBlue = ([r, , b]: number[]) => b > r + 30;
/** A soft brand tint (pale blue): a little more blue than red. */
const isBluish = ([r, , b]: number[]) => b > r + 8;
const isGreen = ([r, g, b]: number[]) => g > r + 20 && g > b;
const isWhite = ([r, g, b, a]: number[]) => r === 255 && g === 255 && b === 255 && a === 1;

/** What a flat page may not have: sideways overflow, a blur, a drop shadow outside a floating layer, a gradient fill. */
async function flatnessOf(page: Page, allowShadowWithin = "") {
  return page.evaluate((allowed) => {
    // floating layers keep the one light shadow; so does a bar that sticks over a list (the payslips' bulk-actions bar)
    const FLOATING =
      '[data-slot="popover-panel"],[data-slot="dropdown-content"],[data-slot="select-content"],[data-slot="dialog-content"],[data-slot="alert-dialog-content"],[data-slot="sheet-content"],[data-slot="toast"],[role="tooltip"],[data-radix-popper-content-wrapper],.recharts-tooltip-wrapper,[class~="sticky"]';
    // a drop shadow: a visible colour with an offset or a blur, and not inset (the tab rail and the menu's bar are inset lines)
    const hasDropShadow = (value: string) => {
      if (value === "none") return false;
      for (const part of value.split(/,(?![^(]*\))/)) {
        if (part.includes("inset")) continue;
        const sizes = (part.match(/-?[\d.]+px/g) ?? []).map(parseFloat);
        const visible = !part.trim().startsWith("rgba(0, 0, 0, 0)") && !part.includes("/ 0)");
        if (visible && (sizes[0] !== 0 || sizes[1] !== 0 || sizes[2] !== 0)) return true;
      }
      return false;
    };
    const blurred: string[] = [];
    const shadowed: string[] = [];
    const gradient: string[] = [];
    const name = (el: Element) =>
      `${el.tagName.toLowerCase()}.${String(el.getAttribute("class") ?? "")
        .split(/\s+/)
        .slice(0, 4)
        .join(".")}`;
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.backdropFilter !== "none") blurred.push(name(el));
      if (hasDropShadow(cs.boxShadow) && !el.closest(FLOATING) && !(allowed && el.closest(allowed)))
        shadowed.push(`${name(el)} => ${cs.boxShadow}`);
      if (cs.backgroundImage.includes("gradient") && !el.closest("svg")) gradient.push(name(el));
    }
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      blurred,
      shadowed,
      gradient,
    };
  }, allowShadowWithin);
}

type PageSpec = { name: string; path: () => string; ready: string; click?: string; allowShadow?: string };
const PAGES: PageSpec[] = [
  { name: "staff payroll: records", path: () => FEB, ready: '[data-testid="view-switch"]' },
  { name: "staff payroll: issues", path: () => `${FEB}&view=issues`, ready: '[data-testid="issues-panel"]' },
  { name: "staff payroll: skipped", path: () => `${FEB}&view=skipped`, ready: '[data-testid="view-switch"]' },
  { name: "staff payroll: rules", path: () => `${FEB}&view=rules`, ready: '[data-testid="view-switch"]' },
  {
    name: "staff payroll: table layout",
    path: () => FEB,
    ready: '[data-testid="payroll-record-layout-table"]',
    click: '[data-testid="payroll-record-layout-table"]',
  },
  {
    name: "staff payroll: salary statement",
    path: () => `${FEB}&tab=salary`,
    ready: '[data-testid="statement-toolbar"]',
  },
  {
    // the one allowance: the paper preview of the printed-format statement is a document on a desk, so its sheet keeps the
    // paper shadow it was designed with; everything around it is checked like any other page
    name: "staff payroll: statement paper preview",
    path: () => `${FEB}&tab=salary`,
    ready: '[data-testid="statement-toolbar"]',
    click: '[data-slot="pill-tab"]:has-text("Pages")',
    allowShadow: '[data-testid="statement-pages"]',
  },
  { name: "staff payroll: payslips", path: () => `${FEB}&tab=payslip`, ready: '[data-testid="staff-payroll-page"]' },
  { name: "payroll details", path: () => `/hr/payroll/details/${ashaPayrollId}`, ready: '[data-testid="pd-header"]' },
  { name: "production payroll", path: () => "/hr/production-payroll/weekly", ready: '[data-testid="pcp-cycle-badge"]' },
  { name: "bonus", path: () => "/hr/bonus", ready: '[data-ui-area="payroll"]' },
  {
    name: "settlement",
    path: () => "/hr/settlement",
    ready: '[data-testid="settlement-toolbar"]',
  },
  { name: "promotion", path: () => "/hr/promotion", ready: '[data-testid="stat-this-year"]' },
  { name: "salary increment", path: () => "/hr/increment", ready: '[data-testid="stat-total"]' },
];

test.describe.configure({ mode: "serial" });

for (const width of WIDTHS) {
  test(`every payroll page is flat at ${width}px: no overflow, no blur, no drop shadow, no gradient`, async ({
    page,
  }) => {
    // fourteen pages, each loaded and measured
    test.setTimeout(300_000);
    for (const spec of PAGES) {
      await open(page, "clean", spec.path(), width);
      expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("clean");
      await expect(page.locator(spec.ready).first(), spec.name).toBeVisible({ timeout: 40_000 });
      if (spec.click) await page.locator(spec.click).click();
      await page.waitForTimeout(300);
      const flat = await flatnessOf(page, spec.allowShadow);
      expect(flat.overflow, `${spec.name} sticks out sideways`).toBeLessThanOrEqual(1);
      expect(flat.blurred, `${spec.name} has a backdrop blur`).toEqual([]);
      expect(flat.shadowed, `${spec.name} has a drop shadow`).toEqual([]);
      // Allowed: nothing. (The salary statement's coloured strip is a flat colour here: the theme flattens gradient fills.)
      expect(flat.gradient, `${spec.name} has a gradient`).toEqual([]);
    }
  });
}

test("the figure tiles are white tiles with a 1px line and a tinted icon chip, not pastel boxes", async ({ page }) => {
  // the production payroll page keeps its dashboard of the period (the staff page has none)
  await open(page, "clean", "/hr/production-payroll/weekly");
  for (const id of ["pcp-dash-kpi-gross", "pcp-dash-kpi-deductions", "pcp-dash-kpi-net", "pcp-dash-kpi-pending"]) {
    const tile = `[data-testid="${id}"]`;
    expect(isWhite(await colourOf(page, tile, "background-color")), `${id} is white`).toBe(true);
    expect(await styleOf(page, tile, ["border-top-width", "border-top-left-radius", "box-shadow"])).toEqual({
      "border-top-width": "1px",
      "border-top-left-radius": "8px",
      "box-shadow": "none",
    });
    // the icon box is the tile's own colour at a low strength: tinted, neither white nor solid
    const chip = await colourOf(page, `${tile} > div:first-child`, "background-color");
    expect(chip[3], `${id} icon chip is tinted`).toBeGreaterThan(0.03);
    expect(chip[3]).toBeLessThan(0.3);
  }
  // the same tile on the pages that write their own copy of it
  for (const [path, ids] of [
    ["/hr/settlement", ["stat-pending", "stat-active", "stat-recovered", "stat-left"]],
    ["/hr/promotion", ["stat-this-year", "stat-employees", "stat-dept-moves", "stat-due"]],
    ["/hr/increment", ["stat-total", "stat-employees", "stat-amount", "stat-avg"]],
  ] as const) {
    await open(page, "clean", path);
    for (const id of ids) {
      const tile = `[data-testid="${id}"]`;
      expect(isWhite(await colourOf(page, tile, "background-color")), `${path} ${id} is white`).toBe(true);
      expect((await styleOf(page, tile, ["border-top-width"]))["border-top-width"]).toBe("1px");
    }
  }
});

test("Export and the other downloads are neutral secondary buttons, not green", async ({ page }) => {
  await open(page, "clean", FEB);
  expect(
    await styleOf(page, '[data-testid="staff-export"]', ["background-color", "border-top-color", "color"]),
  ).toEqual({
    "background-color": "rgb(255, 255, 255)",
    "border-top-color": "rgb(158, 170, 186)",
    color: "rgb(31, 41, 55)",
  });
  // the bank file is neutral when it can be made, and a flat grey (never green) when no payslip has bank details yet
  const bank = '[data-testid="staff-export-bank"]';
  expect(isGreen(await colourOf(page, bank, "color"))).toBe(false);
  expect(isGreen(await colourOf(page, bank, "border-top-color"))).toBe(false);
  expect(isGreen(await colourOf(page, bank, "background-color"))).toBe(false);
  await open(page, "clean", `${FEB}&tab=payslip`);
  const download = 'button[data-testid$="-download"]';
  await expect(page.locator(download).first()).toBeVisible();
  expect(isGreen(await colourOf(page, download, "color"))).toBe(false);
  expect(isGreen(await colourOf(page, download, "border-top-color"))).toBe(false);
});

test("the views of a tab are underlined tabs and the two-way switch is a 6px control", async ({ page }) => {
  await open(page, "clean", FEB);
  expect(
    await styleOf(page, '[data-testid="view-switch"]', ["background-color", "border-top-left-radius", "padding-left"]),
  ).toEqual({
    "background-color": "rgba(0, 0, 0, 0)",
    "border-top-left-radius": "0px",
    "padding-left": "0px",
  });
  expect(
    await styleOf(page, '[data-testid="view-records"]', [
      "border-bottom-width",
      "border-bottom-color",
      "background-color",
    ]),
  ).toEqual({
    "border-bottom-width": "2px",
    "border-bottom-color": "rgb(29, 86, 179)",
    "background-color": "rgba(0, 0, 0, 0)",
  });
  expect((await styleOf(page, '[data-testid="view-issues"]', ["border-bottom-color"]))["border-bottom-color"]).toBe(
    "rgba(0, 0, 0, 0)",
  );
  const group = '[role="group"][aria-label="Layout of the payroll list"]';
  expect((await styleOf(page, group, ["border-top-left-radius"]))["border-top-left-radius"]).toBe("6px");
  expect((await styleOf(page, `${group} > button`, ["border-top-left-radius"]))["border-top-left-radius"]).toBe("4px");
  // the chosen side is readable: its text against its fill is at least 4.5:1
  const [text, fill] = await Promise.all([
    colourOf(page, `${group} > button[aria-pressed="true"]`, "color"),
    colourOf(page, `${group} > button[aria-pressed="true"]`, "background-color"),
  ]);
  expect(contrast(text, over(fill, [255, 255, 255]))).toBeGreaterThanOrEqual(4.5); // the fill is the primary at a low opacity
});

test("the chosen issue-type chip is readable (brand text on a soft brand fill)", async ({ page }) => {
  await open(page, "clean", `${FEB}&view=issues`);
  const chip = '[data-testid="issues-type-all"]';
  await expect(page.locator(chip)).toHaveAttribute("aria-pressed", "true");
  const [text, fill] = await Promise.all([colourOf(page, chip, "color"), colourOf(page, chip, "background-color")]);
  expect(contrast(text, over(fill, [255, 255, 255]))).toBeGreaterThanOrEqual(4.5);
});

test("initials avatars are one colour", async ({ page }) => {
  await open(page, "clean", FEB);
  const colours = await page.evaluate(() =>
    Array.from(document.querySelectorAll('article span[aria-hidden="true"][style*="width"]')).map(
      (el) => getComputedStyle(el).backgroundColor,
    ),
  );
  expect(colours.length).toBeGreaterThan(1);
  expect(new Set(colours).size).toBe(1);
  expect(
    (await styleOf(page, 'article span[aria-hidden="true"][style*="width"]', ["border-top-left-radius"]))[
      "border-top-left-radius"
    ],
  ).toBe("6px");
  await open(page, "clean", "/hr/settlement");
  const advance = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="advances-table"] div[aria-hidden="true"]')).map(
      (el) => getComputedStyle(el).backgroundColor,
    ),
  );
  expect(advance.length).toBeGreaterThan(0);
  expect(new Set(advance).size).toBe(1);
});

test("the settlement table is no wider than it was, and its dialogs and sheet are flat", async ({ page }) => {
  const overflowOf = () =>
    page.evaluate(() => {
      const container = document
        .querySelector('[data-testid="advances-table"]')!
        .closest('[data-slot="table-container"]')!;
      return container.scrollWidth - container.clientWidth;
    });
  await open(page, "default", "/hr/settlement");
  const before = await overflowOf();
  await open(page, "clean", "/hr/settlement");
  // 12px cell padding would add about 100px to this eight-column table; a table that wide has 6px (tables.css)
  expect(await overflowOf()).toBeLessThanOrEqual(before);

  await page.getByRole("button", { name: "New Advance" }).click();
  const dialog = '[data-testid="create-advance-dialog"]';
  await expect(page.locator(dialog)).toBeVisible();
  expect(await styleOf(page, dialog, ["border-top-left-radius", "backdrop-filter", "background-image"])).toEqual({
    "border-top-left-radius": "8px",
    "backdrop-filter": "none",
    "background-image": "none",
  });
  await page.keyboard.press("Escape");
  await page.locator('[data-testid^="advance-row-"]').first().click();
  const sheet = '[data-testid="advance-detail"]';
  await expect(page.locator(sheet)).toBeVisible();
  expect((await styleOf(page, sheet, ["backdrop-filter"]))["backdrop-filter"]).toBe("none");
  // the initials in the sheet are the same brand tint as in the list
  const avatar = await colourOf(page, `${sheet} div[aria-hidden="true"]`, "background-color");
  expect(isBluish(avatar)).toBe(true);
});

test("a count bubble in the open menu row keeps white text on red", async ({ page }) => {
  await open(page, "clean", "/hr/settlement");
  const bubble =
    'aside .clay-nav-active span[style*="linear-gradient"], [data-ui-shell="sidebar"] .clay-nav-active span[style*="linear-gradient"]';
  // the bubble only exists while an advance waits for a decision (the first one made here does)
  await expect(page.locator(bubble).first()).toBeVisible();
  expect(await colourOf(page, bubble, "color")).toEqual([255, 255, 255, 1]);
});

test("the production accent is the brand colour, not amber", async ({ page }) => {
  await open(page, "clean", "/hr/production-payroll/weekly");
  await expect(page.getByTestId("pcp-cycle-badge")).toBeVisible();
  expect(isBluish(await colourOf(page, '[data-testid="pcp-cycle-badge"]', "background-color"))).toBe(true);
  expect(isBlue(await colourOf(page, '[data-testid="pcp-cycle-badge"]', "color"))).toBe(true);
  expect(
    (await styleOf(page, '[data-testid="pcp-cycle-badge"]', ["border-top-left-radius"]))["border-top-left-radius"],
  ).toBe("4px");
  expect(isBlue(await colourOf(page, '[data-testid^="production-payroll-"] h2 > svg', "color"))).toBe(true);
  const period = '[data-testid="pcp-period-bar"] > div:first-child > span:first-child';
  if (await page.locator(period).count()) expect(isBlue(await colourOf(page, period, "color"))).toBe(true);
});

test("the production generate dialog and the details page leave amber to warnings", async ({ page }) => {
  await open(page, "clean", "/hr/production-payroll/weekly");
  const generate = page.getByTestId("pcp-generate-open");
  if (await generate.isEnabled()) {
    await generate.click();
    const dialog = '[data-testid="pcp-generate-dialog"]';
    await expect(page.locator(dialog)).toBeVisible();
    const note = `${dialog} [class~="bg-amber-50/60"]`;
    expect(isBluish(await colourOf(page, note, "border-top-color"))).toBe(true);
    expect(await styleOf(page, dialog, ["backdrop-filter", "background-image"])).toEqual({
      "backdrop-filter": "none",
      "background-image": "none",
    });
  }
  await open(page, "clean", `/hr/payroll/details/${ashaPayrollId}`);
  // the section bar: underlined tabs, the open one in the brand colour
  expect(
    await styleOf(page, '[data-testid="pd-nav-attendance"]', [
      "border-bottom-width",
      "border-bottom-color",
      "border-top-left-radius",
      "background-color",
    ]),
  ).toEqual({
    "border-bottom-width": "2px",
    "border-bottom-color": "rgb(29, 86, 179)",
    "border-top-left-radius": "0px",
    "background-color": "rgba(0, 0, 0, 0)",
  });
  expect(await styleOf(page, '[data-testid="pd-header-bar"]', ["height", "background-color"])).toEqual({
    height: "3px",
    "background-color": "rgb(29, 86, 179)",
  });
});

test("Bonus has one brand colour for its icon squares and the title icon", async ({ page }) => {
  await open(page, "clean", "/hr/bonus");
  await expect(page.locator('[data-ui-area="payroll"] [data-slot="card"]').first()).toBeVisible();
  const squares = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll('[data-ui-area="payroll"] [data-slot="card"] [class~="p-1.5"][class~="rounded-lg"]'),
    ).map((el) => getComputedStyle(el).backgroundColor),
  );
  expect(squares).toHaveLength(3);
  expect(new Set(squares)).toEqual(new Set(["rgb(29, 86, 179)"]));
  expect(isBlue(await colourOf(page, '[data-ui-area="payroll"] h2 > svg', "color"))).toBe(true);
});

/** WCAG contrast ratio of two [r, g, b] colours. */
function contrast(a: number[], b: number[]) {
  const lum = ([r, g, bl]: number[]) =>
    [r, g, bl]
      .map((v) => v / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** A colour with an alpha, laid over a solid one. */
function over([r, g, b, a]: number[], [br, bg, bb]: number[]) {
  return [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a)];
}

// ── the default theme keeps its look ────────────────────────────────────────────────────────────────────────────────────

test("the same pages in the default theme keep the look they always had", async ({ page }) => {
  await open(page, "default", FEB);
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("default");
  // a pastel figure tile (on the production page, which keeps its dashboard): 16px corners, no border, not white
  await open(page, "default", "/hr/production-payroll/weekly");
  expect(
    await styleOf(page, '[data-testid="pcp-dash-kpi-gross"]', ["border-top-width", "border-top-left-radius"]),
  ).toEqual({
    "border-top-width": "0px",
    "border-top-left-radius": "16px",
  });
  expect(isWhite(await colourOf(page, '[data-testid="pcp-dash-kpi-gross"]', "background-color"))).toBe(false);
  await open(page, "default", FEB);
  // the green Export button
  expect(isGreen(await colourOf(page, '[data-testid="staff-export"]', "color"))).toBe(true);
  expect(isGreen(await colourOf(page, '[data-testid="staff-export"]', "border-top-color"))).toBe(true);
  // the capsule view switch, 16px, with its 4px padding, and the pill layout switch
  expect(await styleOf(page, '[data-testid="view-switch"]', ["border-top-left-radius", "padding-left"])).toEqual({
    "border-top-left-radius": "16px",
    "padding-left": "4px",
  });
  expect(
    (await styleOf(page, '[data-testid="payroll-record-layout-cards"]', ["border-top-left-radius"]))[
      "border-top-left-radius"
    ],
  ).toBe("10px");
  // the coloured initials avatars (six colours) with 12px corners
  expect(
    (await styleOf(page, 'article span[aria-hidden="true"][style*="width"]', ["border-top-left-radius"]))[
      "border-top-left-radius"
    ],
  ).toBe("12px");
  const avatars = await page.evaluate(() =>
    Array.from(document.querySelectorAll('article span[aria-hidden="true"][style*="width"]')).map(
      (el) => getComputedStyle(el).backgroundColor,
    ),
  );
  expect(new Set(avatars).size).toBeGreaterThan(1);

  await open(page, "default", "/hr/settlement");
  expect(await styleOf(page, '[data-testid="stat-pending"]', ["border-top-width", "border-top-left-radius"])).toEqual({
    "border-top-width": "0px",
    "border-top-left-radius": "16px",
  });
  // the table keeps the 8px cell padding
  expect(await styleOf(page, '[data-testid="advances-table"] th', ["padding-left"])).toEqual({ "padding-left": "8px" });
  expect(await styleOf(page, '[data-testid="advances-table"] td', ["padding-left"])).toEqual({ "padding-left": "8px" });

  await open(page, "default", "/hr/bonus");
  const square = await page.evaluate(() => {
    const el = document.querySelector('[data-slot="card"] [class~="p-1.5"][class~="rounded-lg"]')!;
    return getComputedStyle(el).backgroundColor;
  });
  // blue, green and purple squares: not all the brand colour
  const all = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-slot="card"] [class~="p-1.5"][class~="rounded-lg"]')).map(
      (el) => getComputedStyle(el).backgroundColor,
    ),
  );
  expect(square).toBeTruthy();
  expect(new Set(all).size).toBe(3);

  await open(page, "default", "/hr/production-payroll/weekly");
  // the amber cycle badge
  expect(isBlue(await colourOf(page, '[data-testid="pcp-cycle-badge"]', "color"))).toBe(false);
  // a capsule (rounded-full computes to a huge radius)
  const radius = (await styleOf(page, '[data-testid="pcp-cycle-badge"]', ["border-top-left-radius"]))[
    "border-top-left-radius"
  ];
  expect(parseFloat(radius)).toBeGreaterThan(1000);
});
