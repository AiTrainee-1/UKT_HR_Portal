import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { auditPage, ready, type Offender } from "./clean-audit";
import { HR_PASSWORD, HR_USERNAME } from "./helpers";

// Clean Professional in a browser that cannot draw what Tailwind's colour mixes need.
//
// The owner's screen drew every tint of the theme as the solid brand blue (a unit band, the Unit badges, a hovered row, the
// menu's collapse button), and the text on them vanished. Tailwind writes every colour mix as "the solid colour, then the mix
// inside a nested @supports", so a browser that does not apply the mix keeps the solid colour. That happens in two cases:
//   * Chrome / Edge 110 and older (Windows 7 and 8.1 stop at 109): no color-mix(), no oklab, and no CSS nesting;
//   * Chrome 111 to 119, Firefox 113 to 116 and Safari 16.4 to 17.1 on the Vite DEV server: color-mix() works, but the dev CSS
//     is nested and these browsers drop a rule nested inside a rule, so only the solid fallback is left.
// The page's own style sheets are rewritten as such a browser would read them, before the application runs:
//   rename  every color-mix( / oklch( / oklab( / lab( / lch( becomes an unknown function (what Chrome 109 does);
//   nested  every @supports block written inside a style rule (at any depth) is removed (what Chrome 111 to 119 does with the dev CSS);
//   both    the two together.
// and then the same text >= 4.5:1 / icon >= 3:1 audit as theme-clean-contrast.spec.ts runs on the pages where the symptoms
// were, with the four owner symptoms asserted one by one. Nothing leaves this machine: every request that is not to
// localhost / 127.0.0.1 is aborted (and the spec fails if the application asks for one other than the web fonts).
// Data: the e2e seed plus a few late arrivals ("OB-..") made here and removed again.

const DEVICE_KEY = "uk_textile_theme_device";
const DAY = "2026-08-03";
const MODES = ["rename", "nested", "both"] as const;
type Mode = (typeof MODES)[number];

/** Runs in the page before the application: rewrites each <style> the way an old browser reads it. */
const SIMULATION = `(() => {
  const MODE = "__MODE__";
  const rename = (css) => css.replace(/\\b(color-mix|oklch|oklab|lab|lch)\\(/g, "x-$1(");
  // The style sheet is parsed by this browser (which knows CSS nesting) and written out again without the @supports blocks
  // that sit inside a style rule, at any depth: an old browser drops a rule nested in a rule, and with it the colour mix.
  const stripNestedSupports = (css) => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    const kids = (rule, inStyle) => Array.from(rule.cssRules).map((r) => write(r, inStyle)).join("");
    const write = (rule, inStyle) => {
      if (rule instanceof CSSSupportsRule) return inStyle ? "" : "@supports " + rule.conditionText + "{" + kids(rule, false) + "}";
      if (rule instanceof CSSStyleRule) return rule.selectorText + "{" + rule.style.cssText + kids(rule, true) + "}";
      if (rule instanceof CSSMediaRule) return "@media " + rule.media.mediaText + "{" + kids(rule, inStyle) + "}";
      if (rule instanceof CSSLayerBlockRule) return "@layer " + rule.name + "{" + kids(rule, inStyle) + "}";
      return rule.cssText;
    };
    return Array.from(sheet.cssRules).map((r) => write(r, false)).join("\\n");
  };
  const transform = (css) => {
    let out = css;
    if (MODE === "nested" || MODE === "both") out = stripNestedSupports(out);
    if (MODE === "rename" || MODE === "both") out = rename(out);
    return out;
  };
  const handle = (node) => {
    if (!(node instanceof HTMLStyleElement) || node.__old) return;
    node.__old = true;
    const before = node.textContent || "";
    const after = transform(before);
    if (after !== before) node.textContent = after;
  };
  new MutationObserver((records) => {
    for (const r of records) {
      r.addedNodes.forEach((added) => handle(added));
      if (r.target instanceof HTMLStyleElement) handle(r.target);
    }
  }).observe(document, { childList: true, subtree: true });
  document.querySelectorAll("style").forEach(handle);
})();`;

type Reply = { status: number; body: any };
let token = "";
const blocked = new Set<string>();

async function api(page: Page, method: string, url: string, data?: unknown): Promise<Reply> {
  const res = await page.request.fetch(url, { method, headers: { Authorization: `Bearer ${token}` }, data });
  const text = await res.text();
  return { status: res.status(), body: text ? JSON.parse(text) : null };
}

async function purge(page: Page) {
  const list = async (url: string) => ((await api(page, "GET", url)).body ?? []) as any[];
  for (const e of (await list("/api/employees")).filter((e) => String(e.employeeCode).startsWith("OB-"))) {
    await api(page, "DELETE", `/api/employees/${e.id}`);
  }
  for (const s of (await list("/api/shifts")).filter((s) => String(s.name).startsWith("OB "))) {
    await api(page, "DELETE", `/api/shifts/${s.id}`);
  }
  for (const d of (await list("/api/departments")).filter((d) => String(d.name).startsWith("OB "))) {
    await api(page, "DELETE", `/api/departments/${d.id}`);
  }
  for (const b of (await list("/api/branches")).filter((b) => String(b.name).startsWith("OB "))) {
    await api(page, "DELETE", `/api/branches/${b.id}`);
  }
}

test.describe.configure({ mode: "serial" });

let seedPage: Page;

test.beforeAll(async ({ browser }) => {
  seedPage = await browser.newPage();
  const login = await seedPage.request.post("/api/auth/hr-login", {
    data: { username: HR_USERNAME, password: HR_PASSWORD },
  });
  token = (await login.json()).token as string;
  await purge(seedPage);
  const make = async (url: string, data: object) => {
    const r = await api(seedPage, "POST", url, data);
    expect(r.status, `${url}: ${JSON.stringify(r.body)}`).toBe(201);
    return r.body.id as number;
  };
  const head = ((await api(seedPage, "GET", "/api/branches")).body as any[]).find((b) => b.isHeadOffice);
  const unitNo = 100 + Math.floor(Math.random() * 899);
  const unit = await make("/api/branches", { name: "OB Unit", code: `Unit${unitNo}` });
  const dept = await make("/api/departments", { name: "OB Admin", branchId: head.id });
  const deptUnit = await make("/api/departments", { name: "OB Floor", branchId: unit });
  const des = await make("/api/designations", { title: "OB Clerk", departmentId: dept });
  const desUnit = await make("/api/designations", { title: "OB Operator", departmentId: deptUnit });
  const shift = await make("/api/shifts", {
    name: "OB General",
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
      phone: "9000000055",
      gender: "male",
      employmentType: "staff",
      branchId,
      departmentId,
      designationId,
      salaryType: "monthly",
      salaryAmount: 24000,
    });
  const ids = [
    await employee("OB-01", "Tejus", head.id, dept, des),
    await employee("OB-02", "Pandi", head.id, dept, des),
    await employee("OB-03", "Babu", unit, deptUnit, desUnit),
  ];
  const assign = await api(seedPage, "POST", "/api/shift-assignments/apply", {
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
      const r = await api(seedPage, "POST", "/api/attendance/manual", {
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
  await purge(seedPage);
  await seedPage.close();
});

/** A page in an old browser: the simulation runs first, and nothing but this machine can be reached. */
async function oldBrowser(context: BrowserContext, page: Page, mode: Mode) {
  await page.setViewportSize({ width: 1366, height: 800 });
  await context.addInitScript(([key]) => localStorage.setItem(key, "clean"), [DEVICE_KEY]);
  await page.addInitScript({ content: SIMULATION.replace("__MODE__", mode) });
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.protocol === "data:" ||
      url.protocol === "blob:"
    ) {
      return route.continue();
    }
    blocked.add(url.hostname);
    // the web fonts are answered with an empty style sheet (the page waits for them before it animates its words in)
    if (url.hostname === "fonts.googleapis.com")
      return route.fulfill({ status: 200, contentType: "text/css", body: "" });
    return route.abort();
  });
}

async function signIn(page: Page) {
  await page.goto("/hr-login");
  await page.getByTestId("input-username").fill(HR_USERNAME);
  await page.getByTestId("input-password").fill(HR_PASSWORD);
  await page.getByTestId("button-submit").click();
  await expect(page).toHaveURL(/\/hr\/dashboard/);
}

/** No fill left over a text or an icon that is the full brand colour, and none of what a mixed colour should have been. */
const solidBrand = (page: Page, selector: string, nth = 0) =>
  page
    .locator(selector)
    .nth(nth)
    .evaluate((el) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      const paint = (css: string) => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = css;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        return [d[0], d[1], d[2], d[3] / 255];
      };
      const probe = document.createElement("div");
      probe.style.color = "hsl(var(--primary))";
      document.body.appendChild(probe);
      const brand = paint(getComputedStyle(probe).color);
      probe.remove();
      const bg = paint(getComputedStyle(el).backgroundColor);
      const near = Math.abs(bg[0] - brand[0]) + Math.abs(bg[1] - brand[1]) + Math.abs(bg[2] - brand[2]) < 24;
      return { solid: near && bg[3] > 0.85, bg: getComputedStyle(el).backgroundColor };
    });

const lines = (offenders: Offender[]) =>
  offenders.map((o) => `${o.kind} ${o.ratio}:1 ${o.fg} on ${o.bg} "${o.sample}" ${o.where}`);

async function audit(page: Page, label: string) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  await page.waitForTimeout(200);
  const result = await auditPage(page);
  expect(result.checked, `${label}: something was checked`).toBeGreaterThan(20);
  expect(lines(result.offenders), `${label}: ${result.checked} checked`).toEqual([]);
}

async function simulationIsOn(page: Page, mode: Mode) {
  const texts = await page.evaluate(() =>
    Array.from(document.querySelectorAll("style")).map((s) => s.textContent ?? ""),
  );
  const all = texts.join("\n");
  expect(all.length, "the style sheets are in the page").toBeGreaterThan(50_000);
  if (mode !== "nested")
    expect(/(?<![-\w])(color-mix|oklch|oklab|lab|lch)\(/.test(all), "no colour function is left").toBe(false);
  // an @supports written inside a style rule (CSS nesting: what Tailwind's dev CSS is made of)
  const nested = await page.evaluate(() => {
    const walk = (rules: CSSRuleList): number => {
      let n = 0;
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSStyleRule)
          n += Array.from(rule.cssRules).filter((r) => r instanceof CSSSupportsRule).length;
        else if ("cssRules" in rule) n += walk((rule as CSSGroupingRule).cssRules);
      }
      return n;
    };
    return Array.from(document.styleSheets).reduce((n, sheet) => {
      try {
        return n + walk(sheet.cssRules);
      } catch {
        return n; // a style sheet from another origin cannot be read
      }
    }, 0);
  });
  if (mode === "rename")
    expect(nested, "the page's CSS has nested @supports blocks (Tailwind's colour mixes)").toBeGreaterThan(20);
  else expect(nested, "no nested @supports is left").toBe(0);
}

for (const mode of MODES) {
  test.describe(`an old browser (${mode})`, () => {
    test("sign-in page, dashboard, the menu's collapse button, a hovered menu item and Sign out", async ({
      context,
      page,
    }) => {
      await oldBrowser(context, page, mode);
      await page.goto("/hr-login");
      await expect(page.getByTestId("input-username")).toBeVisible();
      await page.waitForTimeout(4000); // the brand panel types and fades its words in
      await simulationIsOn(page, mode);
      await audit(page, "sign-in page");
      await page.getByTestId("input-username").fill(HR_USERNAME);
      await page.getByTestId("input-password").fill(HR_PASSWORD);
      await page.getByTestId("button-submit").click();
      await expect(page).toHaveURL(/\/hr\/dashboard/);
      await ready(page);
      await audit(page, "dashboard");

      // owner symptom 4: the menu's collapse button is a solid blue square with no icon
      const toggle = '[data-ui-shell="sidebar"] .ukt-sbt-switch';
      await expect(page.locator(toggle).first()).toBeVisible();
      expect((await solidBrand(page, toggle)).solid, "the collapse button is not the solid brand colour").toBe(false);
      const icon = await page
        .locator(`${toggle} .ukt-sbt-svg path`)
        .first()
        .evaluate((el) => getComputedStyle(el).fill);
      const bg = await page
        .locator(toggle)
        .first()
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(icon, "the collapse button's icon is not drawn in its own fill colour").not.toBe(bg);

      // a hovered menu item and the Sign out button
      await page.locator('[data-ui-shell="sidebar"]').getByText("Leave & Holiday").first().hover({ timeout: 5000 });
      await page.waitForTimeout(300);
      await audit(page, "a hovered menu item");
      const signOut = page.locator('[data-ui-shell="sidebar"]').getByText("Sign Out");
      await signOut.hover();
      await page.waitForTimeout(300);
      await audit(page, "Sign out hovered");
      expect(
        [...blocked].filter((host) => !/^fonts\.(googleapis|gstatic)\.com$/.test(host)),
        "nothing but local requests (and the web fonts) was asked for",
      ).toEqual([]);
    });

    test("Daily Late Report grouped by unit: the unit band, the Unit badges, a ticked row and a hovered row", async ({
      context,
      page,
    }) => {
      await oldBrowser(context, page, mode);
      await signIn(page);
      await page.goto("/hr/attendance/report-log?tab=late");
      await ready(page);
      await page.getByTestId("daily-date").fill(DAY);
      await page.waitForTimeout(1500);
      await simulationIsOn(page, mode);
      await page.getByLabel("Group by unit").check();
      const band = page
        .locator(
          '[data-testid^="late-group-"]:not([data-testid*="select"]):not([data-testid*="label"]):not([data-testid*="count"])',
        )
        .first();
      await expect(band).toBeVisible();
      await page.locator('[data-testid^="late-select-"]').first().click();
      await page.locator('[data-testid^="late-row-"]').nth(1).hover();
      await page.waitForTimeout(400);

      // owner symptoms 1 to 3: a solid blue band with no label, solid blue Unit badges, a solid blue row
      expect(
        (
          await solidBrand(
            page,
            '[data-testid^="late-group-"]:not([data-testid*="select"]):not([data-testid*="label"]):not([data-testid*="count"])',
          )
        ).solid,
        "the unit band is not solid brand",
      ).toBe(false);
      await expect(page.locator('[data-testid^="late-group-label-"]').first()).toBeVisible();
      expect(
        (await solidBrand(page, '[data-testid^="late-unit-"] span')).solid,
        "a Unit badge is not solid brand",
      ).toBe(false);
      expect((await solidBrand(page, '[data-testid^="late-row-"]', 0)).solid, "a ticked row is not solid brand").toBe(
        false,
      );
      expect((await solidBrand(page, '[data-testid^="late-row-"]', 1)).solid, "a hovered row is not solid brand").toBe(
        false,
      );
      await audit(page, "late report, grouped, a unit and a row ticked, a row hovered");
    });

    test("Staff Payroll and Settlement: the figure tiles", async ({ context, page }) => {
      await oldBrowser(context, page, mode);
      await signIn(page);
      for (const [label, path] of [
        ["staff payroll", "/hr/payroll?month=2&year=2026"],
        ["settlement", "/hr/settlement"],
        ["employees", "/hr/employees"],
        ["attendance search", "/hr/attendance/search"],
        ["settings themes", "/hr/settings?tab=themes"],
      ] as const) {
        await page.goto(path);
        await ready(page);
        await simulationIsOn(page, mode);
        if (label === "staff payroll") {
          const tile = '[data-testid="staff-dash-kpis"] [data-testid^="staff-dash-kpi-"] > [class~="bg-white/60"]';
          expect((await solidBrand(page, tile)).solid, "a KPI tile's icon chip is not solid brand").toBe(false);
        }
        const row = page.locator("tbody tr").first();
        if (await row.count()) {
          await row.hover({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(500);
        }
        await audit(page, label);
      }
    });
  });
}
