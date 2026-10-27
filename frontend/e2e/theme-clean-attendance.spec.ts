import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { HR_PASSWORD, HR_USERNAME } from "./helpers";

// The attendance area of the "Clean Professional" theme (src/themes/clean/areas/attendance.css): Staff and Production
// Attendance, Attendance Search, Punch View, Manual Punch Import, Report Log, Geo Attendance, Missing Punch, Leave & Holiday,
// Casual Leave, Requests, Manage Shifts, Compensation and Outpass / Visitors / Tea Break, with their tabs.
// What is held here:
//   * every page and tab of the area, at a laptop and a phone width, is flat: nothing sticks out sideways, no frosted blur, no
//     drop shadow outside a floating layer, no gradient fill (allowances: the map's own tiles and pins are pictures, not
//     fills; the Report Log's off-screen export sheets are documents and are checked on their own, below);
//   * the pieces this file restyles: a long tab strip scrolls instead of printing its labels over each other, the "on" chip
//     of Attendance Search is readable, the Staff / Production capsule is a flat segmented control, the downloads are
//     neutral buttons, the three steps of "late by" stay three steps, a past holiday is a quiet card with full-strength text;
//   * the sheets behind the PDF and the picture (Report Log) come out the same whichever theme is on;
//   * the same pages in the default theme keep the look they always had (the values below were read from the application
//     before the area file existed).
// Data: the seed (Asha, Ravi, Meena) plus what is made here through the API (two shifts, two holidays, a leave request and a
// permission, all named "AT ...") and removed again.

const DEVICE_KEY = "uk_textile_theme_device";
const WIDTHS = [1366, 390] as const;

let token = "";
const made = { shifts: [] as number[], holidays: [] as number[], leaves: [] as number[], permissions: [] as number[] };

const isoDay = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

async function api(request: APIRequestContext, method: string, url: string, data?: unknown) {
  const res = await request.fetch(url, { method, headers: { Authorization: `Bearer ${token}` }, data });
  const text = await res.text();
  return { status: res.status(), body: text ? JSON.parse(text) : null };
}

async function purge(request: APIRequestContext) {
  for (const s of ((await api(request, "GET", "/api/shifts")).body ?? []) as { id: number; name: string }[]) {
    if (s.name.startsWith("AT ")) await api(request, "DELETE", `/api/shifts/${s.id}`);
  }
  const year = new Date().getFullYear();
  for (const h of ((await api(request, "GET", `/api/holidays?year=${year}`)).body ?? []) as {
    id: number;
    name: string;
  }[]) {
    if (h.name.startsWith("AT ")) await api(request, "DELETE", `/api/holidays/${h.id}`);
  }
  for (const l of ((await api(request, "GET", "/api/leave-requests")).body ?? []) as { id: number; reason: string }[]) {
    if ((l.reason ?? "").startsWith("AT ")) await api(request, "DELETE", `/api/leave-requests/${l.id}`);
  }
  for (const p of ((await api(request, "GET", "/api/permissions")).body ?? []) as { id: number; reason: string }[]) {
    if ((p.reason ?? "").startsWith("AT ")) await api(request, "DELETE", `/api/permissions/${p.id}`);
  }
}

test.beforeAll(async ({ request }) => {
  const login = await request.post("/api/auth/hr-login", { data: { username: HR_USERNAME, password: HR_PASSWORD } });
  token = (await login.json()).token as string;
  await purge(request);
  for (const [name, type, start, end] of [
    ["AT Office", "staff", "09:00", "18:00"],
    ["AT Line", "production", "08:30", "17:30"],
  ] as const) {
    const shift = await api(request, "POST", "/api/shifts", {
      name,
      shiftType: type,
      startTime: start,
      endTime: end,
      genderRule: "all",
      gracePeriodMinutes: 10,
    });
    expect(shift.status, JSON.stringify(shift.body)).toBe(201);
    made.shifts.push(shift.body.id);
  }
  // one holiday ahead and one that is past: the page fades a past one
  for (const [name, offset] of [
    ["AT Next Day", 3],
    ["AT Past Day", -20],
  ] as const) {
    const holiday = await api(request, "POST", "/api/holidays", {
      name,
      date: isoDay(offset),
      holidayType: "national",
    });
    expect(holiday.status, JSON.stringify(holiday.body)).toBe(201);
    made.holidays.push(holiday.body.id);
  }
  const employees = ((await api(request, "GET", "/api/employees")).body ?? []) as {
    id: number;
    employeeCode: string;
  }[];
  const asha = employees.find((e) => e.employeeCode === "E2E001")!;
  const leave = await api(request, "POST", "/api/leave-requests", {
    employeeId: asha.id,
    startDate: isoDay(0),
    endDate: isoDay(0),
    type: "casual",
    reason: "AT leave",
  });
  expect(leave.status, JSON.stringify(leave.body)).toBe(201);
  made.leaves.push(leave.body.id);
  const permission = await api(request, "POST", "/api/permissions", {
    employeeId: asha.id,
    date: isoDay(0),
    type: "Late In",
    permissionTime: "09:30",
    reason: "AT permission",
  });
  expect(permission.status, JSON.stringify(permission.body)).toBe(201);
  made.permissions.push(permission.body.id);
});

test.afterAll(async ({ request }) => {
  await purge(request);
});

async function openWith(page: Page, theme: "clean" | "default", path: string, width: number = 1366) {
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
  // the dev server rebuilds a file under the page now and then, and the app answers with its "was just updated" screen: reload
  for (let attempt = 0; attempt < 3 && (await page.locator("h1.ss-title").count()) > 0; attempt++) {
    await page.reload();
    await page.waitForLoadState("networkidle").catch(() => undefined);
  }
  await page.waitForTimeout(700);
}

const open = (page: Page, path: string, width: number = 1366) => openWith(page, "clean", path, width);

/** The dev server reloads the page when a source file changes under it; a read that lands in that reload is simply repeated. */
async function steady<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (attempt >= 3 || !/context was destroyed|navigation/i.test(String(error))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
}

const tab = (page: Page, name: string) => page.getByRole("tab", { name: new RegExp(name, "i") }).first();

const styleOf = (page: Page, selector: string, props: string[], nth = 0) =>
  page
    .locator(selector)
    .nth(nth)
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

/** The corner radius in px of the first match (a pill is millions of px: the browser reports 3.35544e+07px). */
const radiusOf = async (page: Page, selector: string) =>
  parseFloat((await styleOf(page, selector, ["border-top-left-radius"]))["border-top-left-radius"]);

const lum = ([r, g, b]: number[]) => {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a: number[], b: number[]) => {
  const [hi, lo] = [Math.max(lum(a), lum(b)), Math.min(lum(a), lum(b))];
  return (hi + 0.05) / (lo + 0.05);
};
/** No colour: the three channels are close (a white, a grey, a slate): nothing green, red or blue about it. */
const isNeutral = ([r, g, b]: number[]) => Math.abs(r - b) < 40 && Math.abs(g - r) < 40;
const isRed = ([r, g, b]: number[]) => r > g + 60 && r > b + 60;

/** What a flat page may not have: sideways overflow, a blur, a drop shadow outside a floating layer, a gradient fill. */
const flatnessOf = (page: Page) => steady(() => flatness(page));

async function flatness(page: Page) {
  return page.evaluate(() => {
    // floating layers keep the one light shadow: dialogs, sheets, menus, toasts, the chart's tooltip and the box that opens over
    // a cell of the attendance grid
    const FLOATING =
      '[data-slot="popover-panel"],[data-slot="dropdown-content"],[data-slot="select-content"],[data-slot="dialog-content"],[data-slot="alert-dialog-content"],[data-slot="sheet-content"],[data-slot="toast"],[data-slot="tooltip-panel"],[role="tooltip"],[data-radix-popper-content-wrapper],.recharts-tooltip-wrapper,.recharts-default-tooltip,.att-tooltip-content';
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
    const name = (el: Element) =>
      `${el.tagName.toLowerCase()}.${String(el.getAttribute("class") ?? "")
        .split(/\s+/)
        .slice(0, 4)
        .join(".")}`;
    const blurred: string[] = [];
    const shadowed: string[] = [];
    const gradient: string[] = [];
    const sticks: string[] = [];
    const main = document.querySelector('[data-ui-shell="main"]') ?? document.body;
    const viewWidth = document.documentElement.clientWidth;
    // a box wider than the screen that no scrolling box of its own holds (the page's main area scrolls up and down only)
    const held = (el: Element) => {
      for (let n = el.parentElement; n && n !== main && n !== document.documentElement; n = n.parentElement) {
        if (
          /(auto|scroll|hidden|clip)/.test(getComputedStyle(n).overflowX) &&
          n.getBoundingClientRect().right <= viewWidth + 1
        )
          return true;
      }
      return false;
    };
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.backdropFilter !== "none") blurred.push(name(el));
      // the Report Log's off-screen copies of its lists (left: -99999px) are documents, not part of the page
      if (r.right < 0) continue;
      if (hasDropShadow(cs.boxShadow) && !el.closest(FLOATING)) shadowed.push(`${name(el)} => ${cs.boxShadow}`);
      if (cs.backgroundImage.includes("gradient") && !el.closest("svg")) gradient.push(name(el));
      if (
        main.contains(el) &&
        r.right > viewWidth + 1 &&
        cs.position !== "absolute" &&
        cs.position !== "fixed" &&
        !held(el) &&
        !(
          el.parentElement &&
          el.parentElement !== main &&
          el.parentElement.getBoundingClientRect().right > viewWidth + 1 &&
          !held(el.parentElement)
        )
      ) {
        sticks.push(`${name(el)} right=${Math.round(r.right)}`);
      }
    }
    return { overflow: document.documentElement.scrollWidth - window.innerWidth, blurred, shadowed, gradient, sticks };
  });
}

type View = { name: string; path: string; heading: string | RegExp; tabs?: string[] };
const VIEWS: View[] = [
  { name: "staff attendance", path: "/hr/attendance", heading: "Staff Attendance" },
  { name: "production attendance", path: "/hr/attendance/production", heading: "Production Attendance" },
  { name: "attendance search", path: "/hr/attendance/search", heading: "Attendance Search" },
  { name: "punch view", path: "/hr/attendance/punch-view", heading: "Punch View" },
  { name: "manual import", path: "/hr/attendance/manual-import", heading: "Manual Punch Import" },
  {
    name: "report log",
    path: "/hr/attendance/report-log",
    heading: "Report Log",
    tabs: ["Daily Leave Report", "Daily Late Report"],
  },
  {
    name: "geo attendance",
    path: "/hr/geo-attendance",
    heading: "Geo Attendance",
    tabs: ["Punch Verifications", "Live Map", "On-Duty Map", "Tracking Settings"],
  },
  { name: "missing punch", path: "/hr/missing-punch", heading: "Missing Punch" },
  {
    name: "leave and holiday",
    path: "/hr/leave",
    heading: "Leave & Holiday",
    tabs: ["Half-Day Leave", "Permissions", "Calendar", "Holidays", "Balances"],
  },
  {
    name: "casual leave",
    path: "/hr/casual-leave",
    heading: "Casual Leave (CL)",
    tabs: ["^Eligible", "Not eligible", "Requests"],
  },
  { name: "requests", path: "/hr/requests", heading: "Requests", tabs: ["^Leave"] },
  { name: "manage shifts", path: "/hr/shifts", heading: "Manage Shifts", tabs: ["^Assign", "Unassigned"] },
  { name: "ctc breakdown", path: "/hr/compensation/ctc-breakdown", heading: "CTC Breakdown" },
  { name: "ot detection 1", path: "/hr/compensation/ot-detection/type-1", heading: "OT Detection" },
  { name: "ot detection 2", path: "/hr/compensation/ot-detection/type-2", heading: "OT Detection" },
  { name: "ot detection earlier", path: "/hr/compensation/ot-detection/earlier", heading: "OT Detection" },
  {
    name: "compensation leave a",
    path: "/hr/compensation/compensation-leave/announcements",
    heading: "Compensation Leave",
  },
  {
    name: "compensation leave b",
    path: "/hr/compensation/compensation-leave/holiday-work",
    heading: "Compensation Leave",
  },
  {
    name: "compensation leave c",
    path: "/hr/compensation/compensation-leave/birthdays",
    heading: "Compensation Leave",
  },
  { name: "compensation history", path: "/hr/compensation/history", heading: "History" },
  { name: "compensation reports", path: "/hr/compensation/reports", heading: "Reports" },
  { name: "outpass overview", path: "/hr/outpass-visitors/outpass", heading: "Outpass" },
  { name: "outpass requests", path: "/hr/outpass-visitors/outpass/requests", heading: "Outpass" },
  { name: "outpass in / out", path: "/hr/outpass-visitors/outpass/in-out", heading: "Outpass" },
  { name: "outpass gate qr", path: "/hr/outpass-visitors/outpass/overview/qr-submissions", heading: "Outpass" },
  { name: "visitors", path: "/hr/outpass-visitors/visitors", heading: "Visitors" },
  { name: "tea break", path: "/hr/outpass-visitors/tea-break", heading: "Tea Break" },
  { name: "tea break rule", path: "/hr/outpass-visitors/tea-break/rule", heading: "Tea Break" },
];

async function checkFlat(page: Page, view: View, width: number, where: string) {
  const flat = await flatnessOf(page);
  expect(flat.overflow, `${where} sticks out sideways (${width}px)`).toBeLessThanOrEqual(1);
  expect(flat.sticks, `${where}: something is wider than the screen (${width}px)`).toEqual([]);
  expect(flat.blurred, `${where} has a backdrop blur`).toEqual([]);
  expect(flat.shadowed, `${where} has a drop shadow`).toEqual([]);
  // Allowed: nothing (the map's tiles and pins are pictures, not fills).
  expect(flat.gradient, `${where} has a gradient`).toEqual([]);
  expect(view.name).toBeTruthy();
}

test.describe.configure({ mode: "serial" });

for (const width of WIDTHS) {
  for (const [label, from, to] of [
    ["attendance, report log, geo, leave and casual leave", 0, 11],
    ["requests, shifts, compensation and the gate pages", 11, VIEWS.length],
  ] as const) {
    test(`${label}: flat at ${width}px, no overflow, no blur, no drop shadow, no gradient`, async ({ page }) => {
      for (const view of VIEWS.slice(from, to)) {
        await open(page, view.path, width);
        expect(await steady(() => page.evaluate(() => document.documentElement.dataset.theme)), view.name).toBe(
          "clean",
        );
        await expect(page.locator("main h1, main h2").first(), view.name).toContainText(view.heading);
        await checkFlat(page, view, width, view.name);
        for (const name of view.tabs ?? []) {
          await tab(page, name).click();
          await page.waitForTimeout(900);
          await checkFlat(page, view, width, `${view.name} > ${name}`);
        }
      }
    });
  }
}

test("a long tab strip scrolls inside its own box: no tab shrinks, no label runs into the next", async ({ page }) => {
  // the Requests hub has eleven tabs, Leave & Holiday six: on a phone they cannot all be shown
  for (const [path, strip] of [
    ["/hr/requests", '[data-testid="requests-tabs"] [data-slot="pill-tabs"]'],
    ["/hr/leave", '[data-slot="pill-tabs"]'],
  ] as const) {
    await open(page, path, 390);
    await expect(page.locator(strip).first()).toBeVisible();
    const strips = await page
      .locator(strip)
      .first()
      .evaluate((el) => {
        const tabs = Array.from(el.querySelectorAll('[data-slot="pill-tab"]')).map((t) => {
          const r = t.getBoundingClientRect();
          return {
            left: r.left,
            right: r.right,
            shrink: getComputedStyle(t).flexShrink,
            text: (t.textContent ?? "").trim(),
          };
        });
        return { tabs, scrolls: el.scrollWidth > el.clientWidth, overflowX: getComputedStyle(el).overflowX };
      });
    expect(strips.overflowX, path).toBe("auto");
    expect(strips.scrolls, `${path}: the strip scrolls`).toBe(true);
    for (let i = 0; i < strips.tabs.length; i++) {
      expect(strips.tabs[i].shrink, `${path}: ${strips.tabs[i].text} does not shrink`).toBe("0");
      if (i > 0)
        expect(
          strips.tabs[i].left,
          `${path}: ${strips.tabs[i].text} starts after the one before`,
        ).toBeGreaterThanOrEqual(strips.tabs[i - 1].right - 1);
    }
  }
});

test("Attendance Search: the chips are 6px controls and the chosen one is a readable soft brand chip, not a dark pill", async ({
  page,
}) => {
  await open(page, "/hr/attendance/search");
  const chips = '[aria-label="Quick ranges"] button';
  await expect(page.locator(chips).first()).toBeVisible();
  const count = await page.locator(chips).count();
  expect(count).toBeGreaterThanOrEqual(5);
  for (let i = 0; i < count; i++) {
    expect((await styleOf(page, chips, ["border-top-left-radius"], i))["border-top-left-radius"], `chip ${i}`).toBe(
      "6px",
    );
  }
  const on = '[aria-label="Quick ranges"] button[aria-pressed="true"]';
  await expect(page.locator(on)).toHaveCount(1);
  const wash = await colourOf(page, on, "background-color");
  const writing = await colourOf(page, on, "color");
  // a brand wash (a fifth of the brand colour: visible on a weak display) with dark brand writing (the page paints it
  // near-black with white writing); the wash is the primary at 20%, so it is laid over the white page of the chip to compare
  const background = wash.slice(0, 3).map((v) => v * wash[3] + 255 * (1 - wash[3]));
  expect(wash[3]).toBeGreaterThan(0.1);
  expect(lum(background)).toBeGreaterThan(0.6);
  expect(background[2]).toBeGreaterThan(background[0]);
  expect(contrast(writing, background), "the chosen chip's writing").toBeGreaterThanOrEqual(7);
  const off = await colourOf(page, '[aria-label="Quick ranges"] button[aria-pressed="false"]', "background-color");
  expect(off).toEqual([255, 255, 255, 1]);
});

test("Manage Shifts: the Staff / Production / All group is a flat segmented control", async ({ page }) => {
  await open(page, "/hr/shifts");
  const group = '[role="group"][aria-label="Filter by employee type"]';
  await expect(page.locator(group).first()).toBeVisible();
  expect(await styleOf(page, group, ["border-top-left-radius", "border-top-width", "background-color"])).toEqual({
    "border-top-left-radius": "6px",
    "border-top-width": "1px",
    "background-color": "rgb(230, 235, 241)",
  });
  const chosen = '[data-testid="type-chip-all"]';
  expect(await styleOf(page, chosen, ["border-top-left-radius", "background-color"])).toEqual({
    "border-top-left-radius": "4px",
    "background-color": "rgb(255, 255, 255)",
  });
  const idle = await styleOf(page, '[data-testid="type-chip-staff"]', ["background-color", "color"]);
  expect(idle["background-color"]).toBe("rgba(0, 0, 0, 0)");
  expect(
    contrast(await colourOf(page, '[data-testid="type-chip-staff"]', "color"), [230, 235, 241]),
  ).toBeGreaterThanOrEqual(4.5);
});

test("Report Log: the downloads are neutral buttons and the three steps of 'late by' stay three steps", async ({
  page,
}) => {
  await open(page, "/hr/attendance/report-log");
  for (const name of ["Daily Leave Report", "Daily Late Report"]) {
    await tab(page, name).click();
    await page.waitForTimeout(1500);
    for (const id of ["export-excel", "export-pdf"]) {
      const button = `[data-testid="${id}"]`;
      await expect(page.locator(button), `${name}: ${id}`).toBeVisible();
      for (const prop of ["color", "background-color", "border-top-color"]) {
        expect(isNeutral(await colourOf(page, button, prop)), `${name}: ${id} ${prop} is not green, red or blue`).toBe(
          true,
        );
      }
    }
  }
  // the legend of the Daily Late Report: low, middle and high are three different fills (the page's two ambers were one ramp)
  const fills = await page
    .locator('[data-testid="severity-legend"] > span')
    .evaluateAll((els) => els.slice(1).map((el) => getComputedStyle(el).backgroundColor));
  expect(fills).toHaveLength(3);
  expect(new Set(fills).size, "three different fills").toBe(3);
  expect(fills[1]).toBe("rgb(249, 200, 90)");
  expect(fills[2]).toBe("rgb(246, 189, 184)");
});

test("a holiday that is past is a quiet card with full-strength text, not a faded one", async ({ page }) => {
  await open(page, "/hr/leave");
  await tab(page, "Holidays").click();
  await expect(page.getByText("AT Past Day")).toBeVisible();
  const past = page.locator('[data-testid="hol-list"] [data-testid^="holiday-"]', { hasText: "AT Past Day" }).first();
  const card = await past.evaluate((el) => {
    // the card is the nearest ancestor (or the element itself) with a card's border
    let n: Element | null = el;
    while (n && !n.classList.contains("clay-card") && n.getAttribute("data-slot") !== "card") n = n.parentElement;
    const target = n ?? el;
    const cs = getComputedStyle(target);
    return { opacity: cs.opacity, background: cs.backgroundColor };
  });
  expect(card.opacity).toBe("1");
  expect(card.background).toBe("rgb(248, 250, 252)");
  const next = page.locator('[data-testid="hol-list"] [data-testid^="holiday-"]', { hasText: "AT Next Day" }).first();
  await expect(next).toBeVisible();
});

test("Staff Attendance: the trend charts fit their cards on a phone, and the year box shows its four digits", async ({
  page,
}) => {
  await open(page, "/hr/attendance", 390);
  const box = await page
    .locator('[class~="aspect-video"]')
    .first()
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { right: r.right, width: r.width, view: document.documentElement.clientWidth };
    });
  expect(box.right).toBeLessThanOrEqual(box.view);
  expect(box.width).toBeLessThanOrEqual(324);
  // the six buttons and the date field are under the title on a phone, not squeezed beside it
  const header = await page.locator('main h2:has-text("Staff Attendance")').evaluate((h) => {
    const row = h.closest("div.items-start") as HTMLElement | null;
    return row ? getComputedStyle(row).flexWrap : "";
  });
  expect(header).toBe("wrap");
  await open(page, "/hr/attendance");
  const year = page.locator('main input[type="number"]').first();
  await expect(year).toBeVisible();
  const clipped = await year.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(clipped, "the year box is not clipped").toBeLessThanOrEqual(1);
});

test("the sheets behind the PDF and the picture come out the same in both themes", async ({ browser }) => {
  const metrics = async (theme: "clean" | "default") => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const out: Record<string, unknown> = {};
    await openWith(page, theme, "/hr/attendance/report-log");
    for (const name of ["Daily Leave Report", "Daily Late Report"]) {
      await tab(page, name).click();
      await page.waitForTimeout(1800);
      out[name] = await page.evaluate(() => {
        const host = Array.from(document.querySelectorAll('[aria-hidden="true"]')).find(
          (e) => (e as HTMLElement).style.left === "-99999px",
        );
        const sheet = host?.firstElementChild as HTMLElement | undefined;
        if (!sheet) return null;
        const pick = (el: Element | null) => {
          if (!el) return null;
          const cs = getComputedStyle(el);
          return [
            cs.fontSize,
            cs.lineHeight,
            cs.color,
            cs.backgroundColor,
            cs.fontVariantNumeric,
            cs.textRendering,
          ].join(" | ");
        };
        const r = sheet.getBoundingClientRect();
        return {
          width: Math.round(r.width),
          height: Math.round(r.height),
          sheet: pick(sheet),
          th: pick(sheet.querySelector("th")),
          td: pick(sheet.querySelector("td")),
          cell: pick(sheet.querySelector("td div, td span")),
          title: pick(sheet.querySelector("div")),
        };
      });
    }
    await context.close();
    return out;
  };
  const was = await metrics("default");
  const now = await metrics("clean");
  expect(was["Daily Leave Report"], "the sheet is there").not.toBeNull();
  expect(now).toEqual(was);
});

test("the same pages in the default theme keep the look they always had", async ({ page }) => {
  const asDefault = (path: string, width = 1366) => openWith(page, "default", path, width);
  await asDefault("/hr/requests", 390);
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("default");
  const strip = '[data-testid="requests-tabs"] [data-slot="pill-tabs"]';
  expect(await styleOf(page, strip, ["background-color", "overflow-x"])).toEqual({
    "background-color": "rgb(243, 244, 246)",
    "overflow-x": "visible",
  });
  expect(await radiusOf(page, strip), "the strip is a pill").toBeGreaterThan(1000);
  expect((await styleOf(page, `${strip} [data-slot="pill-tab"]`, ["flex-shrink"]))["flex-shrink"]).toBe("1");

  await asDefault("/hr/attendance/search");
  const on = '[aria-label="Quick ranges"] button[aria-pressed="true"]';
  expect(await radiusOf(page, on), "the chip is a pill").toBeGreaterThan(1000);
  expect(await colourOf(page, on, "color")).toEqual([255, 255, 255, 1]);
  expect(lum(await colourOf(page, on, "background-color"))).toBeLessThan(0.02);

  await asDefault("/hr/shifts");
  const group = '[role="group"][aria-label="Filter by employee type"]';
  expect(await radiusOf(page, group), "the capsule is a pill").toBeGreaterThan(1000);
  expect((await styleOf(page, group, ["border-top-width"]))["border-top-width"]).toBe("0px");

  await asDefault("/hr/attendance/report-log");
  await tab(page, "Daily Late Report").click();
  await page.waitForTimeout(1500);
  // the PDF button is red, the Excel one green
  expect(isRed(await colourOf(page, '[data-testid="export-pdf"]', "color"))).toBe(true);
  const excel = await colourOf(page, '[data-testid="export-excel"]', "color");
  expect(excel[1]).toBeGreaterThan(excel[0] + 30);
  const fills = await page
    .locator('[data-testid="severity-legend"] > span')
    .evaluateAll((els) => els.slice(1).map((el) => getComputedStyle(el).backgroundColor));
  expect(fills).toHaveLength(3);

  await asDefault("/hr/leave");
  await tab(page, "Holidays").click();
  await expect(page.getByText("AT Past Day")).toBeVisible();
  const past = page.locator('[data-testid="hol-list"] [data-testid^="holiday-"]', { hasText: "AT Past Day" }).first();
  const opacity = await past.evaluate((el) => {
    let n: Element | null = el;
    while (n && !n.classList.contains("clay-card") && n.getAttribute("data-slot") !== "card") n = n.parentElement;
    return getComputedStyle(n ?? el).opacity;
  });
  expect(opacity).toBe("0.7");

  await asDefault("/hr/attendance", 390);
  const chart = await page
    .locator('[class~="aspect-video"]')
    .first()
    .evaluate((el) => getComputedStyle(el).maxWidth);
  expect(chart).toBe("none");
  const columns = await page.evaluate(
    () => getComputedStyle(document.querySelector('div.grid[class*="lg:grid-cols-2"]')!).gridTemplateColumns,
  );
  expect(columns.split(" ")).toHaveLength(1);
  expect(columns).not.toBe("none");
});
