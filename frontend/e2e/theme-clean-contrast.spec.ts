import { expect, test, type Page } from "@playwright/test";
import { HR_PASSWORD, HR_USERNAME, loginAsHr } from "./helpers";

// "Invisible text and icons" audit of the Clean Professional theme (src/themes/clean/). On the key pages of every area, in the
// states that used to go wrong (a hovered row, a ticked row, a unit band, the menu open and collapsed, an open dialog), it
// walks every visible piece of text and every icon, works out the colour it is drawn in and the colour it is drawn on (the
// ancestors' fills laid over one another, with their alpha), and fails when the text has less than 4.5:1 (3:1 for large text)
// or an icon less than 3:1. A background that is a gradient or a picture cannot be worked out and is skipped, as are disabled
// controls (they are exempt), charts (their colours are data) and the off-screen export sheets.
// Data: the e2e seed plus a few late arrivals made here (employees "CC-..") and removed again.

const DEVICE_KEY = "uk_textile_theme_device";
const DAY = "2026-08-03";
const MIN_TEXT = 4.5;
const MIN_LARGE_TEXT = 3;
const MIN_ICON = 3;

type Offender = { kind: "text" | "icon"; where: string; sample: string; fg: string; bg: string; ratio: number };
type Result = { checked: number; offenders: Offender[] };

/** Runs inside the page: no imports, nothing from the test file. */
async function auditPage(page: Page): Promise<Result> {
  return page.evaluate(
    ({ minText, minLarge, minIcon }) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      type Rgba = [number, number, number, number];
      const cache = new Map<string, Rgba | null>();
      const parse = (css: string): Rgba | null => {
        const hit = cache.get(css);
        if (hit !== undefined) return hit;
        let out: Rgba | null = null;
        if (css && !/url\(|gradient/.test(css)) {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = "#010203";
          ctx.fillStyle = css;
          if (ctx.fillStyle !== "#010203" || /1, 2, 3|#010203/.test(css)) {
            ctx.fillRect(0, 0, 1, 1);
            const d = ctx.getImageData(0, 0, 1, 1).data;
            out = [d[0], d[1], d[2], d[3] / 255];
          }
        }
        cache.set(css, out);
        return out;
      };
      const over = (top: Rgba, under: [number, number, number]): [number, number, number] => [
        top[0] * top[3] + under[0] * (1 - top[3]),
        top[1] * top[3] + under[1] * (1 - top[3]),
        top[2] * top[3] + under[2] * (1 - top[3]),
      ];
      const lum = (c: [number, number, number]) => {
        const [r, g, b] = c.map((v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const ratio = (a: [number, number, number], b: [number, number, number]) => {
        const x = lum(a);
        const y = lum(b);
        return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
      };
      const hex = (c: [number, number, number]) => `rgb(${c.map((v) => Math.round(v)).join(",")})`;

      /** What an element is drawn on: its ancestors' fills laid over one another. null = a gradient or picture: unknown. */
      const backdropCache = new WeakMap<Element, [number, number, number] | null>();
      const backdrop = (el: Element): [number, number, number] | null => {
        if (backdropCache.has(el)) return backdropCache.get(el)!;
        const cs = getComputedStyle(el);
        let out: [number, number, number] | null;
        if (cs.backgroundImage !== "none") out = null;
        else {
          const c = parse(cs.backgroundColor);
          if (c && c[3] >= 0.999) out = [c[0], c[1], c[2]];
          else {
            const under: [number, number, number] | null = el.parentElement
              ? backdrop(el.parentElement)
              : [255, 255, 255];
            out = under === null ? null : c && c[3] > 0 ? over(c, under) : under;
          }
        }
        backdropCache.set(el, out);
        return out;
      };
      const opacityCache = new WeakMap<Element, number>();
      const opacityOf = (el: Element): number => {
        const hit = opacityCache.get(el);
        if (hit !== undefined) return hit;
        const o = Number(getComputedStyle(el).opacity) * (el.parentElement ? opacityOf(el.parentElement) : 1);
        opacityCache.set(el, o);
        return o;
      };
      const where = (el: Element) => {
        const bits: string[] = [];
        for (let n: Element | null = el, i = 0; n && i < 4 && n !== document.body; n = n.parentElement, i++) {
          const id = n.getAttribute("data-testid") ?? n.getAttribute("data-slot") ?? n.getAttribute("role");
          const cls =
            typeof n.className === "string" ? n.className.split(/\s+/).filter(Boolean).slice(0, 3).join(".") : "";
          bits.push(`${n.tagName.toLowerCase()}${id ? `[${id}]` : ""}${cls ? `.${cls}` : ""}`);
        }
        return bits.join(" < ");
      };
      const shown = (el: Element) => {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1 || r.right < 0 || r.bottom < 0 || r.left > window.innerWidth + 2000)
          return false;
        if (r.left < -1000 || r.top < -1000) return false;
        return (el as HTMLElement).checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? true;
      };
      const skipped = (el: Element) =>
        !!el.closest(
          ':disabled, [aria-disabled="true"], [data-disabled], .recharts-wrapper, [aria-hidden="true"][style*="-99999px"], option, script, style, noscript, [data-radix-focus-guard]',
        );

      const offenders: Offender[] = [];
      const seen = new Set<string>();
      let checked = 0;
      const report = (o: Offender) => {
        const key = `${o.kind}|${o.where}|${o.fg}|${o.bg}`;
        if (!seen.has(key)) {
          seen.add(key);
          offenders.push(o);
        }
      };

      // text
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const done = new Set<Element>();
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const el = node.parentElement;
        if (!el || done.has(el) || !/[\p{L}\p{N}]/u.test(node.textContent ?? "") || skipped(el) || !shown(el)) continue;
        done.add(el);
        // text that is animating (a typed cursor, letters sliding in) is half transparent for a moment: not a resting state
        if (el.getAnimations().some((a) => a.playState === "running")) continue;
        const cs = getComputedStyle(el);
        const fg = parse(cs.webkitTextFillColor || cs.color);
        const bg = backdrop(el);
        if (!fg || !bg || fg[3] === 0) continue;
        const fgc = over([fg[0], fg[1], fg[2], fg[3] * opacityOf(el)], bg);
        const r = ratio(fgc, bg);
        const size = parseFloat(cs.fontSize);
        const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
        checked++;
        if (r < (large ? minLarge : minText)) {
          report({
            kind: "text",
            where: where(el),
            sample: (node.textContent ?? "").trim().slice(0, 40),
            fg: hex(fgc),
            bg: hex(bg),
            ratio: Math.round(r * 100) / 100,
          });
        }
      }

      // icons: the outermost svg of an icon (a lucide icon, a small inline drawing), not a chart
      for (const svg of Array.from(document.querySelectorAll("svg"))) {
        if (svg.parentElement?.closest("svg") || skipped(svg) || !shown(svg)) continue;
        const rect = svg.getBoundingClientRect();
        if (rect.width < 8 || rect.width > 48) continue;
        const cs = getComputedStyle(svg);
        let paint = cs.stroke !== "none" && parseFloat(cs.strokeWidth) > 0 ? cs.stroke : cs.fill;
        if (paint === "none") continue;
        // a drawing with its own coloured parts (the UKT mark, a logo) is not an icon in one colour
        if (
          svg.querySelector(
            "[fill]:not([fill='none']):not([fill='currentColor']), [stroke]:not([stroke='none']):not([stroke='currentColor'])",
          )
        ) {
          const mixed = new Set(
            Array.from(svg.querySelectorAll("*")).map((n) => getComputedStyle(n).fill + getComputedStyle(n).stroke),
          );
          if (mixed.size > 2) continue;
        }
        paint = paint.trim();
        const fg = parse(paint);
        const bg = backdrop(svg);
        if (!fg || !bg || fg[3] === 0) continue;
        const fgc = over([fg[0], fg[1], fg[2], fg[3] * opacityOf(svg)], bg);
        const r = ratio(fgc, bg);
        checked++;
        if (r < minIcon) {
          report({
            kind: "icon",
            where: where(svg),
            sample:
              svg
                .getAttribute("class")
                ?.split(/\s+/)
                .find((c) => c.startsWith("lucide-")) ?? "svg",
            fg: hex(fgc),
            bg: hex(bg),
            ratio: Math.round(r * 100) / 100,
          });
        }
      }
      return { checked, offenders };
    },
    { minText: MIN_TEXT, minLarge: MIN_LARGE_TEXT, minIcon: MIN_ICON },
  );
}

async function ready(page: Page) {
  await expect(page.locator('[data-ui-shell="main"], .ss-root, form')).not.toHaveCount(0, { timeout: 45_000 });
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
  await page.waitForTimeout(400);
}

let token = "";
const made = {
  employees: [] as number[],
  shifts: [] as number[],
  branches: [] as number[],
  departments: [] as number[],
};

async function api(page: Page, method: string, url: string, data?: unknown) {
  const res = await page.request.fetch(url, { method, headers: { Authorization: `Bearer ${token}` }, data });
  const text = await res.text();
  return { status: res.status(), body: text ? JSON.parse(text) : null };
}

async function purge(page: Page) {
  const list = async (url: string) => ((await api(page, "GET", url)).body ?? []) as any[];
  for (const e of (await list("/api/employees")).filter((e) => String(e.employeeCode).startsWith("CC-"))) {
    await api(page, "DELETE", `/api/employees/${e.id}`);
  }
  for (const s of (await list("/api/shifts")).filter((s) => String(s.name).startsWith("CC "))) {
    await api(page, "DELETE", `/api/shifts/${s.id}`);
  }
  for (const d of (await list("/api/departments")).filter((d) => String(d.name).startsWith("CC "))) {
    await api(page, "DELETE", `/api/departments/${d.id}`);
  }
  for (const b of (await list("/api/branches")).filter((b) => String(b.name).startsWith("CC "))) {
    await api(page, "DELETE", `/api/branches/${b.id}`);
  }
}

test.describe.configure({ mode: "serial" });

let shared: Page;

test.beforeAll(async ({ browser }) => {
  shared = await browser.newPage({ viewport: { width: 1366, height: 800 } });
  await shared.addInitScript((key) => localStorage.setItem(key, "clean"), DEVICE_KEY);
  const login = await shared.request.post("/api/auth/hr-login", {
    data: { username: HR_USERNAME, password: HR_PASSWORD },
  });
  token = (await login.json()).token as string;
  await purge(shared);
  const make = async (url: string, data: object) => {
    const r = await api(shared, "POST", url, data);
    expect(r.status, `${url}: ${JSON.stringify(r.body)}`).toBe(201);
    return r.body.id as number;
  };
  const head = ((await api(shared, "GET", "/api/branches")).body as any[]).find((b) => b.isHeadOffice);
  const unitNo = 100 + Math.floor(Math.random() * 899);
  const unit = await make("/api/branches", { name: "CC Unit", code: `Unit${unitNo}` });
  const dept = await make("/api/departments", { name: "CC Admin", branchId: head.id });
  const deptUnit = await make("/api/departments", { name: "CC Floor", branchId: unit });
  const des = await make("/api/designations", { title: "CC Clerk", departmentId: dept });
  const desUnit = await make("/api/designations", { title: "CC Operator", departmentId: deptUnit });
  const shift = await make("/api/shifts", {
    name: "CC General",
    shiftType: "staff",
    startTime: "09:00",
    endTime: "18:00",
    gracePeriodMinutes: 15,
  });
  const employee = (code: string, first: string, branchId: number, departmentId: number, designationId: number) =>
    make("/api/employees", {
      employeeCode: code,
      firstName: first,
      lastName: "Latecomer",
      phone: "9000000077",
      gender: "male",
      employmentType: "staff",
      branchId,
      departmentId,
      designationId,
      salaryType: "monthly",
      salaryAmount: 24000,
    });
  const ids = [
    await employee("CC-01", "Tejus", head.id, dept, des),
    await employee("CC-02", "Pandi", head.id, dept, des),
    await employee("CC-03", "Babu", unit, deptUnit, desUnit),
  ];
  made.employees.push(...ids);
  const assign = await api(shared, "POST", "/api/shift-assignments/apply", {
    shiftId: shift,
    effectiveFrom: "2026-01-01",
    selection: { employees: { include: ids } },
  });
  expect(assign.status, JSON.stringify(assign.body)).toBe(201);
  for (const [id, time] of [
    [ids[0], "09:21"],
    [ids[1], "09:34"],
    [ids[2], "10:00"],
  ] as const) {
    for (const [t, type] of [
      [time, "IN"],
      ["18:00", "OUT"],
    ] as const) {
      const r = await api(shared, "POST", "/api/attendance/manual", {
        employeeId: id,
        date: DAY,
        punchTime: t,
        punchType: type,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
  }
});

test.afterAll(async () => {
  await purge(shared);
  await shared.close();
});

const all: { page: string; result: Result }[] = [];
const report: string[] = [];

async function check(label: string) {
  // a dialog or a menu that is still fading in is half transparent: wait until every finite animation has finished
  await shared.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  await shared.waitForTimeout(150);
  const result = await auditPage(shared);
  all.push({ page: label, result });
  const lines = result.offenders.map((o) => `  ${o.kind} ${o.ratio}:1  ${o.fg} on ${o.bg}  "${o.sample}"  ${o.where}`);
  if (lines.length) report.push(`${label}: ${result.checked} checked\n${lines.join("\n")}`);
}

async function open(path: string, width = 1366) {
  await shared.setViewportSize({ width, height: width === 1366 ? 800 : 844 });
  await shared.goto(path);
  await ready(shared);
}

const PAGES: [string, string][] = [
  ["dashboard", "/hr/dashboard"],
  ["employees", "/hr/employees"],
  ["new employee", "/hr/employees/new"],
  ["production employees", "/hr/employees/productionEmployee"],
  ["bulk upload", "/hr/employees/bulk-upload"],
  ["departments", "/hr/departments"],
  ["designations", "/hr/designations"],
  ["branches", "/hr/branches"],
  ["attendance", "/hr/attendance"],
  ["attendance production", "/hr/attendance/production"],
  ["attendance search", "/hr/attendance/search"],
  ["punch view", "/hr/attendance/punch-view"],
  ["report log monthly", "/hr/attendance/report-log"],
  ["leave & holiday", "/hr/leave"],
  ["casual leave", "/hr/casual-leave"],
  ["requests", "/hr/requests"],
  ["shifts", "/hr/shifts"],
  ["compensation", "/hr/compensation/ot-detection/type-1"],
  ["staff payroll", "/hr/payroll?month=2&year=2026"],
  ["production payroll", "/hr/production-payroll/weekly"],
  ["bonus", "/hr/bonus"],
  ["settlement", "/hr/settlement"],
  ["promotion", "/hr/promotion"],
  ["increment", "/hr/increment"],
  ["reports", "/hr/reports"],
  ["settings themes", "/hr/settings?tab=themes"],
  ["settings payroll", "/hr/settings?tab=payroll"],
  ["settings attendance", "/hr/settings?tab=attendance"],
  ["settings pf esi", "/hr/settings?tab=pf_esi"],
  ["recruitment", "/hr/recruitment/dashboard"],
  ["id cards", "/hr/id-cards"],
  ["whatsapp control", "/hr/whatsapp-control"],
  ["sms control", "/hr/sms-control/overview"],
  ["gmail control", "/hr/gmail-control"],
  ["account management", "/hr/account-management"],
  ["user management", "/hr/user-management"],
  ["activity logs", "/hr/activity-logs"],
  ["device status", "/hr/Biometric-Connectors/device-status"],
  ["notifications", "/hr/notifications"],
];

test("the HR sign-in page and the 404 page", async () => {
  await shared.context().clearCookies();
  await shared.evaluate(() => localStorage.removeItem("uk_textile_token")).catch(() => {});
  await shared.goto("/hr-login");
  await expect(shared.getByTestId("input-username")).toBeVisible();
  await shared.waitForTimeout(500);
  await check("hr sign-in");
  await shared.goto("/no-such-page-here");
  await shared.waitForTimeout(800);
  await check("404");
  await loginAsHr(shared);
});

for (const [label, path] of PAGES) {
  test(`page: ${label}`, async () => {
    await open(path);
    await check(label);
    // the pointer over the first row of a list
    const row = shared.locator("tbody tr").first();
    if (await row.count()) {
      await row.hover({ timeout: 3000 }).catch(() => {});
      await shared.waitForTimeout(600);
      await check(`${label} (a row hovered)`);
    }
  });
}

test("Daily Late Report: group by unit, a ticked row, a hovered row", async () => {
  await open("/hr/attendance/report-log?tab=late");
  await shared.getByTestId("daily-date").fill(DAY);
  await shared.waitForTimeout(1500);
  await check("late report");
  await shared.getByLabel("Group by unit").check();
  await shared.waitForTimeout(500);
  await expect(shared.locator('[data-testid^="late-group-"]').first()).toBeVisible();
  await check("late report, grouped by unit");
  await shared.locator('[data-testid^="late-select-"]').first().click();
  await shared.locator('[data-testid^="late-group-select-"]').first().click();
  await shared.locator('[data-testid^="late-row-"]').nth(1).hover();
  await check("late report, grouped, a unit and a row ticked, a row hovered");
  await open("/hr/attendance/report-log?tab=late", 390);
  await shared.getByTestId("daily-date").fill(DAY);
  await shared.waitForTimeout(1500);
  await check("late report at 390");
});

test("the menu open, collapsed and the phone's drawer", async () => {
  await open("/hr/dashboard");
  await check("menu open");
  await shared.evaluate(() => localStorage.setItem("hr_sidebar_collapsed", "1"));
  await shared.reload();
  await ready(shared);
  await check("menu collapsed");
  await shared.locator('[data-ui-shell="sidebar"] nav .cursor-pointer').first().hover();
  await check("menu collapsed, an item hovered");
  await shared.evaluate(() => localStorage.removeItem("hr_sidebar_collapsed"));
  await open("/hr/dashboard", 390);
  await check("phone");
  await shared.locator('[data-ui-shell="topbar"] button').first().click();
  await shared.waitForTimeout(500);
  await check("phone, the drawer open");
});

test("dialogs: add a department, add a shift, an employee picker's popover", async () => {
  await open("/hr/departments");
  await shared
    .getByRole("button", { name: /add department|new department/i })
    .first()
    .click();
  await expect(shared.getByRole("dialog")).toBeVisible();
  await check("add department dialog");
  await shared.keyboard.press("Escape");
  await open("/hr/shifts");
  const add = shared.getByRole("button", { name: /add shift|new shift|create shift/i }).first();
  if (await add.count()) {
    await add.click();
    await expect(shared.getByRole("dialog")).toBeVisible();
    await check("add shift dialog");
    await shared.keyboard.press("Escape");
  }
  await open("/hr/attendance/search");
  await check("attendance search");
});

test("the audit found no text or icon that cannot be read", () => {
  const checked = all.reduce((n, a) => n + a.result.checked, 0);
  console.log(
    `contrast audit: ${all.length} page states, ${checked} text and icon elements checked, ${report.length} page states with offenders`,
  );
  expect(report.join("\n\n")).toBe("");
});

test.afterAll(() => {
  const pages = all.length;
  const checked = all.reduce((n, a) => n + a.result.checked, 0);
  const offenders = all.reduce((n, a) => n + a.result.offenders.length, 0);
  console.log(
    `contrast audit: ${pages} page states, ${checked} text and icon elements checked, ${offenders} offenders`,
  );
});
