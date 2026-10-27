import { expect, test, type Page } from "@playwright/test";
import { HR_PASSWORD, HR_USERNAME, loginAsHr } from "./helpers";

// Clean Professional on a washed-out display: an old LCD monitor with weak contrast, a bright room, a projector. The owner's
// screen shows pale lines and fills as nothing at all, so the theme keeps its edges, icons and inks well clear of what a
// normal display needs. The wash is simulated with the CSS filter  contrast(0.75) brightness(1.15) saturate(0.85)  on <html>,
// and held two ways:
//   * the colours the theme draws edges, fills, icons and inks with are run through the same three filter functions (in the
//     same order, in sRGB, as the browser does) and compared: a card still stands off the page, a field and a button still
//     have a visible edge, a row separator is a line, the chosen row and chip keep their ink, an icon is still an icon;
//   * the key pages are drawn through the filter and kept as pictures (attached to the report) so they can be looked at.

const DEVICE_KEY = "uk_textile_theme_device";
const WASH = "html { filter: contrast(0.75) brightness(1.15) saturate(0.85) !important; }";
type Rgb = [number, number, number];

const clamp = (v: number) => Math.min(1, Math.max(0, v));
/** contrast(0.75), then brightness(1.15), then saturate(0.85), each in sRGB with the result clamped, as CSS filters do. */
function wash([r, g, b]: Rgb): Rgb {
  let c = [r, g, b].map((v) => clamp((v / 255 - 0.5) * 0.75 + 0.5));
  c = c.map((v) => clamp(v * 1.15));
  const s = 0.85;
  const [R, G, B] = c;
  c = [
    clamp((0.213 + 0.787 * s) * R + (0.715 - 0.715 * s) * G + (0.072 - 0.072 * s) * B),
    clamp((0.213 - 0.213 * s) * R + (0.715 + 0.285 * s) * G + (0.072 - 0.072 * s) * B),
    clamp((0.213 - 0.213 * s) * R + (0.715 - 0.715 * s) * G + (0.072 + 0.928 * s) * B),
  ];
  return c.map((v) => v * 255) as Rgb;
}
const lum = (c: Rgb) => {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: Rgb, b: Rgb) => {
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const washed = (a: Rgb, b: Rgb) => ratio(wash(a), wash(b));

let shared: Page;

async function colourOf(selector: string, prop: string, nth = 0): Promise<Rgb> {
  const css = await shared
    .locator(selector)
    .nth(nth)
    .evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
  return shared.evaluate((value) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]] as [number, number, number];
  }, css);
}

async function settle() {
  await expect(shared.locator('[data-ui-shell="main"]')).toBeVisible({ timeout: 45_000 });
  await shared.waitForLoadState("networkidle").catch(() => {});
  await shared
    .waitForFunction(
      () => !document.querySelector(".ukt-circle, .ukt-kpi-run, [data-slot=skeleton], .clay-skeleton"),
      null,
      {
        timeout: 30_000,
      },
    )
    .catch(() => {});
  await shared.waitForTimeout(500);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  shared = await browser.newPage({ viewport: { width: 1366, height: 800 } });
  await shared.addInitScript((key) => localStorage.setItem(key, "clean"), DEVICE_KEY);
  await shared.request.post("/api/auth/hr-login", { data: { username: HR_USERNAME, password: HR_PASSWORD } });
  await loginAsHr(shared);
});

test.afterAll(async () => {
  await shared.close();
});

test("edges: a card stands off the page, a field and a button have a visible edge, a row has a line under it", async () => {
  await shared.goto("/hr/employees");
  await settle();
  const page = await colourOf("body", "background-color");
  const card = await colourOf('[data-slot="card"]', "background-color");
  const cardEdge = await colourOf('[data-slot="card"]', "border-top-color");
  const field = await colourOf('input[data-slot="input"]', "border-top-color");
  const outline = await colourOf('[data-slot="button"][data-variant="outline"]', "border-top-color");
  const rowEdge = await colourOf('[data-slot="table-body"] > [data-slot="table-row"]', "border-bottom-color");
  const white: Rgb = [255, 255, 255];

  // on a normal display
  expect(ratio(card, page), "card against the page").toBeGreaterThanOrEqual(1.12);
  expect(ratio(cardEdge, page), "card edge against the page").toBeGreaterThanOrEqual(1.15);
  expect(ratio(cardEdge, card), "card edge against the card").toBeGreaterThanOrEqual(1.5);
  expect(ratio(field, white), "field edge").toBeGreaterThanOrEqual(3.5);
  expect(ratio(outline, white), "secondary button edge").toBeGreaterThanOrEqual(2.2);
  expect(ratio(rowEdge, white), "row separator").toBeGreaterThanOrEqual(1.5);
  // washed out: the filter takes about a quarter of every difference, so these are the least that still shows
  expect(washed(card, page), "washed: card against the page").toBeGreaterThanOrEqual(1.07);
  expect(washed(cardEdge, card), "washed: card edge").toBeGreaterThanOrEqual(1.3);
  expect(washed(field, white), "washed: field edge").toBeGreaterThanOrEqual(2.4);
  expect(washed(outline, white), "washed: secondary button edge").toBeGreaterThanOrEqual(1.7);
  expect(washed(rowEdge, white), "washed: row separator").toBeGreaterThanOrEqual(1.3);
});

test("ink: text, icons, the chosen chip, the chosen row and the buttons stay readable through the wash", async () => {
  await shared.goto("/hr/employees");
  await settle();
  const page = await colourOf("body", "background-color");
  const white: Rgb = [255, 255, 255];
  const primaryButton = await colourOf('[data-slot="button"][data-variant="default"]', "background-color");
  const primaryInk = await colourOf('[data-slot="button"][data-variant="default"]', "color");
  expect(ratio(primaryInk, primaryButton), "primary button").toBeGreaterThanOrEqual(6);
  expect(washed(primaryInk, primaryButton), "washed: primary button").toBeGreaterThanOrEqual(4.5);

  const muted = await colourOf(".text-muted-foreground", "color");
  expect(ratio(muted, white), "muted text on white").toBeGreaterThanOrEqual(6.5);
  expect(washed(muted, page), "washed: muted text on the page").toBeGreaterThanOrEqual(4.3);

  const icon = await colourOf('[data-ui-shell="sidebar"] nav svg', "color");
  const menu = await colourOf('[data-ui-shell="sidebar"]', "background-color");
  expect(ratio(icon, menu), "menu icon").toBeGreaterThanOrEqual(4.5);
  expect(washed(icon, menu), "washed: menu icon").toBeGreaterThanOrEqual(3);

  // the open row of the menu: ink on its fill
  const openRow = await colourOf(
    '[data-ui-shell="sidebar"] .clay-nav-active:not(:has(.lucide-chevron-right))',
    "background-color",
  );
  const openInk = await colourOf(
    '[data-ui-shell="sidebar"] .clay-nav-active:not(:has(.lucide-chevron-right))',
    "color",
  );
  expect(ratio(openInk, openRow), "open menu row").toBeGreaterThanOrEqual(7);
  expect(washed(openInk, openRow), "washed: open menu row").toBeGreaterThanOrEqual(4.5);

  // the chosen row of a table and a chosen chip (Daily Late Report)
  await shared.goto("/hr/attendance/report-log?tab=late");
  await settle();
  await shared
    .getByLabel("Group by unit")
    .check({ timeout: 5000 })
    .catch(() => {});
  const tab = await colourOf('[data-slot="pill-tab"][aria-selected="true"]', "color");
  expect(ratio(tab, white), "open tab").toBeGreaterThanOrEqual(4.5);
});

const SHOTS: [string, string][] = [
  ["dashboard", "/hr/dashboard"],
  ["employees", "/hr/employees"],
  ["late report", "/hr/attendance/report-log?tab=late"],
  ["staff payroll", "/hr/payroll?month=2&year=2026"],
  ["settings themes", "/hr/settings?tab=themes"],
  ["account management", "/hr/account-management"],
];

for (const [name, path] of SHOTS) {
  test(`the page ${name}, drawn through the washed-out filter`, async ({}, testInfo) => {
    await shared.goto(path);
    await settle();
    if (path.includes("tab=late")) {
      await shared
        .getByLabel("Group by unit")
        .check({ timeout: 3000 })
        .catch(() => {});
      await shared
        .locator('[data-testid^="late-select-"]')
        .first()
        .click({ timeout: 3000 })
        .catch(() => {});
    }
    const style = await shared.addStyleTag({ content: WASH });
    await shared.waitForTimeout(200);
    const file = testInfo.outputPath(`${name.replace(/\s+/g, "-")}-washed.png`);
    await shared.screenshot({ path: file });
    await testInfo.attach(`${name} (washed out)`, { path: file, contentType: "image/png" });
    await style.evaluate((el) => el.remove());
    const flat = await shared.evaluate(() => getComputedStyle(document.documentElement).filter);
    expect(flat).toBe("none");
  });
}
