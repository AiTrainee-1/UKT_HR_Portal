import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { HR_PASSWORD, HR_USERNAME } from "./helpers";

// The settings-reports area of the "Clean Professional" theme (src/themes/clean/areas/settings-reports.css): Settings (every tab),
// Report Center, the recruitment pages, Interviews and the ID card generator.
// What is held here:
//   * every page of the area, at a laptop and a phone width, is flat: nothing sticks out sideways, no frosted blur, no drop
//     shadow outside a floating layer, no gradient fill. Left as designed on purpose: the drawings of a letter, a salary slip,
//     an e-mail, a WhatsApp message and an ID card (they show what the paper or the message looks like), which are SVG or sit
//     inside [data-testid="idcard-faces"] / [data-testid^="id-card-"] (the card's dotted pattern is a radial gradient);
//   * the details that were still glass-and-clay or off the palette: the Settings menu text, the switch thumb, the 8px panels,
//     the option cards that had no edge, the hand-built radio of PF and ESI, the recruitment count tiles, the report category
//     chips and dots, the quick date ranges, the download buttons, the filter drop-downs, the New Joinees row buttons;
//   * the same pages in the default theme keep the look they always had (the values below were read from the application before
//     the area file existed).
// Data: the e2e seed (Asha, Ravi, Meena) plus one new joiner made here through the API and removed again.

const DEVICE_KEY = "uk_textile_theme_device";
const WIDTHS = [1366, 390] as const;

let token = "";
let joinerId = 0;

async function api(request: APIRequestContext, method: string, url: string, data?: unknown) {
  const res = await request.fetch(url, { method, headers: { Authorization: `Bearer ${token}` }, data });
  const text = await res.text();
  return { status: res.status(), body: text ? JSON.parse(text) : null };
}

test.beforeAll(async ({ request }) => {
  const login = await request.post("/api/auth/hr-login", { data: { username: HR_USERNAME, password: HR_PASSWORD } });
  token = (await login.json()).token as string;
  // a joiner of today, so New Joinees has a row and its buttons
  const branches = (await api(request, "GET", "/api/branches")).body as { id: number }[];
  const today = new Date().toISOString().slice(0, 10);
  const made = await api(request, "POST", "/api/employees", {
    employeeCode: "E2ETHSR1",
    firstName: "Theme",
    lastName: "Joiner",
    employmentType: "staff",
    joinDate: today,
    phone: "9111100001",
    salaryType: "monthly",
    salaryAmount: "20000",
    branchId: branches[0]?.id,
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  joinerId = made.body.id;
});

test.afterAll(async ({ request }) => {
  if (joinerId) await api(request, "DELETE", `/api/employees/${joinerId}`);
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
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(700);
}

const styleOf = (page: Page, selector: string, props: string[]) =>
  page
    .locator(selector)
    .first()
    .evaluate((el, ps) => Object.fromEntries(ps.map((p) => [p, getComputedStyle(el).getPropertyValue(p)])), props);

/** A computed colour (rgb(), oklab(), a color-mix result ...) as [r, g, b, alpha 0-1]: the browser's canvas converts it. */
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
const isGreen = ([r, g, b]: number[]) => g > r + 20 && g > b;
const isRed = ([r, g, b]: number[]) => r > g + 40 && r > b + 40;
const isWhite = ([r, g, b, a]: number[]) => r === 255 && g === 255 && b === 255 && a === 1;
/** A pale blue wash: opaque, bluer than it is red, but not white. */
const isBlueWash = ([r, , b, a]: number[]) => a === 1 && b > r + 5;

/** What a flat page may not have: sideways overflow, a blur, a drop shadow outside a floating layer, a gradient fill. */
async function flatnessOf(page: Page) {
  return page.evaluate(() => {
    const FLOATING =
      '[data-slot="popover-panel"],[data-slot="dropdown-content"],[data-slot="select-content"],[data-slot="dialog-content"],[data-slot="alert-dialog-content"],[data-slot="sheet-content"],[data-slot="toast"],[role="tooltip"],[data-radix-popper-content-wrapper],.recharts-tooltip-wrapper,.settings-dock';
    // the drawings of a document or a card show what the paper looks like: their own colours and patterns stay
    const DOCUMENT = 'svg,[data-testid="idcard-faces"],[data-testid^="id-card-"],[data-testid="whatsapp-bubble"]';
    const splitShadows = (value: string) => {
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
      return parts;
    };
    const isDropShadow = (part: string) => {
      if (/inset/.test(part)) return false;
      if (/^rgba\(0, 0, 0, 0\)/.test(part) || /\/ 0\)/.test(part)) return false;
      const [x, y, blur] = (part.replace(/^[a-z]+\([^)]*\)/, "").match(/-?[\d.]+px/g) ?? []).map(parseFloat);
      return x !== 0 || y !== 0 || blur !== 0;
    };
    const name = (el: Element) =>
      `${el.tagName.toLowerCase()}.${String(el.getAttribute("class") ?? "")
        .split(/\s+/)
        .slice(0, 4)
        .join(".")}`;
    const blurred: string[] = [];
    const shadowed: string[] = [];
    const gradient: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.backdropFilter !== "none") blurred.push(name(el));
      const drop = cs.boxShadow !== "none" && splitShadows(cs.boxShadow).some(isDropShadow);
      if (drop && !el.closest(FLOATING)) shadowed.push(`${name(el)} => ${cs.boxShadow}`);
      if (cs.backgroundImage.includes("gradient") && !el.closest(DOCUMENT)) gradient.push(name(el));
    }
    return { overflow: document.documentElement.scrollWidth - window.innerWidth, blurred, shadowed, gradient };
  });
}

type PageSpec = { name: string; path: string; ready: string; click?: string };

const SETTINGS_TABS = [
  "company",
  "hr_contact",
  "themes",
  "attendance",
  "production_shifts",
  "late_detection",
  "compensation",
  "devices",
  "payroll",
  "production_payroll",
  "pf_esi",
  "salary-slip",
  "documents",
  "idcard",
  "smtp",
  "whatsapp",
  "endpoint_sharing",
  "backup",
];
const SETTINGS_PAGES: PageSpec[] = [
  ...SETTINGS_TABS.map((id) => ({
    name: `settings: ${id}`,
    path: `/hr/settings?tab=${id}`,
    ready: `[data-testid="settings-panel-${id}"]`,
  })),
  {
    name: "settings: endpoint sharing guide",
    path: "/hr/settings?tab=endpoint_sharing&sub=guide",
    ready: '[data-testid="endpoint-sharing-tab"]',
  },
  {
    name: "settings: endpoint sharing activity",
    path: "/hr/settings?tab=endpoint_sharing&sub=activity",
    ready: '[data-testid="endpoint-sharing-tab"]',
  },
  {
    name: "settings: late detection, production",
    path: "/hr/settings?tab=late_detection",
    ready: '[data-testid="settings-panel-late_detection"]',
    click: '[data-slot="pill-tab"]:has-text("Production")',
  },
];

const heading = (text: string) => `main :is(h1, h2):has-text("${text}")`;
const OTHER_PAGES: PageSpec[] = [
  { name: "reports: catalog", path: "/hr/reports", ready: 'a[href*="?report="]' },
  {
    name: "reports: employee master",
    path: "/hr/reports?report=employee-master&run=1",
    ready: '[data-testid="report-show"]',
  },
  {
    name: "reports: audit log (date ranges)",
    path: "/hr/reports?report=audit-log",
    ready: '[data-testid="report-show"]',
  },
  { name: "recruitment dashboard", path: "/hr/recruitment/dashboard", ready: heading("Recruitment Dashboard") },
  { name: "new joinees", path: "/hr/recruitment/new-joinees", ready: heading("New Joinees") },
  { name: "resignations", path: "/hr/recruitment/resignations", ready: heading("Resignations") },
  { name: "required roles", path: "/hr/recruitment/required-roles", ready: heading("Required Roles") },
  { name: "resume screening", path: "/hr/recruitment/resume-screening", ready: heading("Resume Screening") },
  {
    name: "resume screening: rules",
    path: "/hr/recruitment/resume-screening",
    ready: heading("Resume Screening"),
    click: '[role="tab"]:has-text("Company Rules")',
  },
  { name: "recruitment documents", path: "/hr/recruitment/documents", ready: heading("Documents") },
  { name: "interviews", path: "/hr/interviews", ready: heading("Interviews") },
  { name: "id cards", path: "/hr/id-cards", ready: heading("ID Card Generator") },
];

for (const [label, pages] of [
  ["every Settings tab", SETTINGS_PAGES],
  ["Report Center, recruitment, interviews and ID cards", OTHER_PAGES],
] as const) {
  for (const width of WIDTHS) {
    test(`${label} is flat at ${width}px: no overflow, no blur, no drop shadow, no gradient`, async ({ page }) => {
      test.setTimeout(300_000);
      for (const spec of pages) {
        await open(page, "clean", spec.path, width);
        expect(await page.evaluate(() => document.documentElement.dataset.theme), spec.name).toBe("clean");
        await expect(page.locator(spec.ready).first(), `${spec.name} did not open`).toBeVisible();
        if (spec.click) {
          await page.locator(spec.click).first().click();
          await page.waitForTimeout(400);
        }
        const flat = await flatnessOf(page);
        expect(flat.overflow, `${spec.name} sticks out sideways`).toBeLessThanOrEqual(1);
        expect(flat.blurred, `${spec.name} has a backdrop blur`).toEqual([]);
        expect(flat.shadowed, `${spec.name} has a drop shadow`).toEqual([]);
        expect(flat.gradient, `${spec.name} has a gradient`).toEqual([]);
      }
    });
  }
}

// ── Settings ────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("Settings: the menu text, the switch thumb, the panels and the buttons are the theme's, not settings-skin.css's own", async ({
  page,
}) => {
  await open(page, "clean", "/hr/settings?tab=attendance");
  await expect(page.locator('[data-testid="settings-panel-attendance"]')).toBeVisible();
  // the menu: the neutral ramp's 700 (it was a fixed #475569), the open tab in the brand blue on its soft wash
  expect((await styleOf(page, '.settings-skin .settings-nav-item[aria-selected="false"]', ["color"])).color).toBe(
    "rgb(54, 65, 82)",
  );
  expect((await styleOf(page, '.settings-skin .settings-nav-item[aria-selected="true"]', ["color"])).color).toBe(
    "rgb(29, 86, 179)",
  );
  // the panels inside a card are 8px (they were 10px)
  expect(
    (await styleOf(page, ".settings-skin .settings-clay-inset", ["border-top-left-radius"]))["border-top-left-radius"],
  ).toBe("8px");
  // the option cards: the one that is not chosen has an edge to click (an outline over the border Tailwind hides), the chosen one a wash
  const idle = await styleOf(page, '[data-testid="attendance-mode-simple"]', [
    "outline-style",
    "outline-width",
    "outline-color",
  ]);
  expect(idle["outline-style"]).toBe("solid");
  expect(idle["outline-width"]).toBe("1px");
  expect(idle["outline-color"]).toBe("rgb(158, 170, 186)");
  const chosen = '[data-testid="attendance-mode-strict"]';
  await expect(page.locator(chosen)).toHaveAttribute("aria-checked", "true");
  expect(isBlue(await colourOf(page, chosen, "border-top-color"))).toBe(true);
  expect(isBlueWash(await colourOf(page, chosen, "background-color"))).toBe(true);
  expect(isWhite(await colourOf(page, '[data-testid="attendance-mode-simple"]', "background-color"))).toBe(true);

  // the kit's switch: a flat white thumb
  await open(page, "clean", "/hr/settings?tab=compensation");
  await expect(page.locator('[data-testid="settings-panel-compensation"]')).toBeVisible();
  expect((await styleOf(page, ".settings-skin .settings-switch > span", ["box-shadow"]))["box-shadow"]).toBe("none");

  // the secondary buttons: the neutral ramp's 700 on white with the secondary line
  await open(page, "clean", "/hr/settings?tab=devices");
  const addDevice = page.getByRole("button", { name: "Add Device" });
  await expect(addDevice).toBeVisible();
  expect(
    await addDevice.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { color: cs.color, background: cs.backgroundColor, border: cs.borderTopColor, shadow: cs.boxShadow };
    }),
  ).toEqual({
    color: "rgb(54, 65, 82)",
    background: "rgb(255, 255, 255)",
    border: "rgb(158, 170, 186)",
    shadow: "none",
  });
});

test("Settings: the PF and ESI scope picker is the brand blue, not the old UKT blue", async ({ page }) => {
  await open(page, "clean", "/hr/settings?tab=pf_esi");
  const chosen = '[data-testid="pf-esi-scope-global"]';
  await expect(page.locator(chosen)).toHaveAttribute("aria-checked", "true");
  expect((await styleOf(page, chosen, ["border-top-color"]))["border-top-color"]).toBe("rgb(29, 86, 179)");
  const wash = await colourOf(page, chosen, "background-color");
  expect(isBlueWash(wash)).toBe(true);
  expect(wash.slice(0, 3)).not.toEqual([239, 246, 251]); // #eff6fb, the old UKT wash
});

// ── Report Center ───────────────────────────────────────────────────────────────────────────────────────────────────────

test("Report Center: one brand tile for every category, grey dots, flat tags", async ({ page }) => {
  await open(page, "clean", "/hr/reports");
  await expect(page.locator('a[href*="?report="]').first()).toBeVisible();
  // the category chips on the tiles and on the headings were one colour per category: all of them are the brand's soft tile
  const chips = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll(
        'a[href*="?report="] > span[class~="ring-1"], section[id^="cat-"] > div > span[class~="ring-1"]',
      ),
    ).map((el) => `${getComputedStyle(el).backgroundColor}|${getComputedStyle(el).color}`),
  );
  expect(chips.length).toBeGreaterThan(8);
  expect(new Set(chips).size).toBe(1);
  expect(isBlue(await colourOf(page, 'a[href*="?report="] > span[class~="ring-1"]', "color"))).toBe(true);
  // the dots beside a category name: one grey
  const dots = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href^="#cat-"] > span[class~="rounded-full"]')).map(
      (el) => getComputedStyle(el).backgroundColor,
    ),
  );
  expect(dots.length).toBeGreaterThan(4);
  expect(new Set(dots)).toEqual(new Set(["rgb(90, 102, 118)"]));
  // the category tags are 6px tags, not capsules
  expect(await styleOf(page, 'a[href^="#cat-"]', ["border-top-left-radius", "box-shadow"])).toEqual({
    "border-top-left-radius": "6px",
    "box-shadow": "none",
  });
});

test("Report Center: the downloads are neutral buttons, the quick ranges small chips, the drop-downs wear the field's border", async ({
  page,
}) => {
  await open(page, "clean", "/hr/reports?report=audit-log");
  await expect(page.getByTestId("report-show")).toBeVisible();
  for (const id of ["report-download-pdf", "report-download-xlsx"]) {
    const button = `[data-testid="${id}"]`;
    // (the buttons are disabled until a report has rows: their text is the flat grey then; the tint is what must be gone)
    const background = await colourOf(page, button, "background-color");
    expect(isRed(background) || isGreen(background), `${id} is not tinted`).toBe(false);
  }
  // the quick date ranges: 6px chips, the chosen one the soft brand fill with dark brand ink and a brand line (the theme's one
  // chosen-chip look, primitives.css: oklab is how the browser writes a mixed colour)
  const presets = 'button[aria-pressed][class~="rounded-full"][class~="h-7"]';
  expect(await page.locator(presets).count()).toBeGreaterThan(4);
  expect((await styleOf(page, presets, ["border-top-left-radius"]))["border-top-left-radius"]).toBe("6px");
  const chosen = `${presets}[aria-pressed="true"]`;
  await expect(page.locator(chosen).first()).toBeVisible();
  expect(await styleOf(page, chosen, ["background-color", "border-top-color", "color"])).toEqual({
    "background-color": "oklab(0.894506 -0.00550343 -0.0313921)",
    "border-top-color": "rgb(29, 86, 179)",
    color: "oklab(0.340239 -0.0199436 -0.113069)",
  });
  // a searchable drop-down (an outline Button with role=combobox) has the same border as the Select beside it
  const combo = '[data-slot="button"][data-variant="outline"][role="combobox"]';
  await expect(page.locator(combo).first()).toBeVisible();
  expect(await styleOf(page, combo, ["border-top-color", "background-color"])).toEqual({
    "border-top-color": "rgb(114, 128, 150)",
    "background-color": "rgb(255, 255, 255)",
  });
  expect((await styleOf(page, '[data-slot="select-trigger"]', ["border-top-color"]))["border-top-color"]).toBe(
    "rgb(114, 128, 150)",
  );
});

test("Report Center: a report with rows has neutral download buttons", async ({ page }) => {
  await open(page, "clean", "/hr/reports?report=employee-master&run=1");
  await expect(page.locator('[data-slot="table-row"], tbody tr').first()).toBeVisible();
  for (const id of ["report-download-pdf", "report-download-xlsx"]) {
    await expect(page.getByTestId(id)).toBeEnabled();
    expect(await styleOf(page, `[data-testid="${id}"]`, ["background-color", "border-top-color", "color"]), id).toEqual(
      {
        "background-color": "rgb(255, 255, 255)",
        "border-top-color": "rgb(158, 170, 186)",
        color: "rgb(54, 65, 82)",
      },
    );
  }
});

// ── Recruitment ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test("Recruitment dashboard: one brand tile for the counts, equal cards in a row", async ({ page }) => {
  await open(page, "clean", "/hr/recruitment/dashboard");
  await expect(page.locator(heading("Recruitment Dashboard"))).toBeVisible();
  const tile = 'button.w-full > [data-slot="card"] > div > div[class~="p-2.5"][class~="shrink-0"]';
  expect(await page.locator(tile).count()).toBe(7);
  // seven counts, seven colours became one: the same wash and the same icon colour on every tile
  const looks = await page.evaluate((sel) => {
    return Array.from(document.querySelectorAll(sel)).map((el) => {
      const svg = el.querySelector("svg");
      return `${getComputedStyle(el).backgroundColor}|${svg ? getComputedStyle(svg).color : ""}`;
    });
  }, tile);
  expect(new Set(looks).size).toBe(1);
  expect(isBlue(await colourOf(page, `${tile} > svg`, "color"))).toBe(true);
  // the cards of a row are as tall as the row (a <button> centres what it holds, so they floated at different levels)
  const rows = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('button.w-full > [data-slot="card"]'));
    return cards.map((c) => ({
      top: Math.round(c.getBoundingClientRect().top),
      height: Math.round(c.getBoundingClientRect().height),
    }));
  });
  const byRow = new Map<number, Set<number>>();
  for (const r of rows) byRow.set(r.top, (byRow.get(r.top) ?? new Set()).add(r.height));
  expect(
    Array.from(byRow.values()).every((heights) => heights.size === 1),
    JSON.stringify(rows),
  ).toBe(true);
});

test("New Joinees: the row buttons are one secondary button, and the title icon is the brand blue", async ({
  page,
}) => {
  await open(page, "clean", "/hr/recruitment/new-joinees");
  const rowButtons = 'table button[class~="px-2.5"][class~="py-1.5"][class~="text-xs"][class~="rounded-lg"]';
  await expect(page.locator(rowButtons).first()).toBeVisible();
  const looks = await page.evaluate((sel) => {
    return Array.from(document.querySelectorAll(sel)).map((el) => {
      const cs = getComputedStyle(el);
      return `${cs.backgroundColor}|${cs.borderTopColor}|${cs.color}`;
    });
  }, rowButtons);
  expect(looks.length).toBeGreaterThanOrEqual(4);
  expect(new Set(looks)).toEqual(new Set(["rgb(255, 255, 255)|rgb(158, 170, 186)|rgb(54, 65, 82)"]));
  expect(isBlue(await colourOf(page, "main h2 > svg", "color"))).toBe(true);
});

test("Resignations: the status tiles keep their status colours, on the theme's ramps", async ({ page }) => {
  await open(page, "clean", "/hr/recruitment/resignations");
  await expect(page.locator(heading("Resignations"))).toBeVisible();
  const tile = '[data-slot="card"] > div > div[class~="p-2"][class~="rounded-xl"][class~="shrink-0"]';
  expect(await page.locator(tile).count()).toBe(4);
  const icon = (n: number) => colourOf(page, `${tile} > svg`, "color", n);
  expect(await icon(0)).toEqual([151, 88, 0, 1]); // waiting: amber 600 of the warning ramp
  expect(isBlue(await icon(1))).toBe(true); // HR can decide: the brand
  expect(isGreen(await icon(2))).toBe(true); // approved
  expect(isRed(await icon(3))).toBe(true); // rejected
});

// ── the default theme keeps its look ────────────────────────────────────────────────────────────────────────────────────

test("the same pages in the default theme keep the look they always had", async ({ page }) => {
  await open(page, "default", "/hr/settings?tab=attendance");
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("default");
  expect((await styleOf(page, '.settings-skin .settings-nav-item[aria-selected="false"]', ["color"])).color).toBe(
    "rgb(71, 85, 105)",
  );
  expect(
    (await styleOf(page, ".settings-skin .settings-clay-inset", ["border-top-left-radius"]))["border-top-left-radius"],
  ).toBe("10px");
  expect((await styleOf(page, '[data-testid="attendance-mode-simple"]', ["outline-style"]))["outline-style"]).toBe(
    "none",
  );

  await open(page, "default", "/hr/settings?tab=compensation");
  expect((await styleOf(page, ".settings-skin .settings-switch > span", ["box-shadow"]))["box-shadow"]).not.toBe(
    "none",
  );

  await open(page, "default", "/hr/reports");
  await expect(page.locator('a[href*="?report="]').first()).toBeVisible();
  const chips = await page.evaluate(() =>
    Array.from(document.querySelectorAll('section[id^="cat-"] > div > span[class~="ring-1"]')).map(
      (el) => getComputedStyle(el).backgroundColor,
    ),
  );
  expect(new Set(chips).size).toBeGreaterThan(1); // a colour per category
  // a capsule: the corner is as big as a corner can be
  expect(
    parseFloat((await styleOf(page, 'a[href^="#cat-"]', ["border-top-left-radius"]))["border-top-left-radius"]),
  ).toBeGreaterThan(1000);

  await open(page, "default", "/hr/reports?report=audit-log");
  await expect(page.getByTestId("report-show")).toBeVisible();
  expect(
    parseFloat(
      (await styleOf(page, 'button[aria-pressed][class~="rounded-full"][class~="h-7"]', ["border-top-left-radius"]))[
        "border-top-left-radius"
      ],
    ),
  ).toBeGreaterThan(1000);
  // the red-tinted Download PDF button and the green-tinted Download Excel one
  expect(isRed(await colourOf(page, '[data-testid="report-download-pdf"]', "border-top-color"))).toBe(true);
  expect(isGreen(await colourOf(page, '[data-testid="report-download-xlsx"]', "border-top-color"))).toBe(true);

  await open(page, "default", "/hr/recruitment/dashboard");
  await expect(page.locator(heading("Recruitment Dashboard"))).toBeVisible();
  const tiles = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll('button.w-full > [data-slot="card"] > div > div[class~="p-2.5"][class~="shrink-0"]'),
    ).map((el) => getComputedStyle(el).backgroundColor),
  );
  expect(new Set(tiles).size).toBe(7); // seven counts, seven colours
});
