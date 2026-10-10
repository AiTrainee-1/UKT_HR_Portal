import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { HR_PASSWORD, HR_USERNAME } from "./helpers";

// TEMPORARY (delete when the MD re-skin is finished): screenshots of every MD page, for design review.
//   THEME_SHOTS = output directory   THEME_ONLY = comma list of page ids to shoot (default: all)   THEME_MOBILE=1 adds 390px
const OUT = process.env.THEME_SHOTS ?? "shots";
const ONLY = (process.env.THEME_ONLY ?? "").split(",").filter(Boolean);
const MOBILE = process.env.THEME_MOBILE === "1";
const PASSWORD = "Passw0rd!mdthm";
// THEME_DEMO=1: the demo company (seed_md_demo) on the isolated stack; sign in as its MD instead of making an account
const DEMO = process.env.THEME_DEMO === "1";

const PAGES: [string, string][] = [
  ["dashboard", "/md/dashboard"],
  ["employees", "/md/employees"],
  ["employees-insights", "/md/employees#insights"],
  ["branches", "/md/branches"],
  ["attendance-staff", "/md/attendance/staff"],
  ["attendance-production", "/md/attendance/production"],
  ["geo-attendance", "/md/geo-attendance"],
  ["geo-attendance-insights", "/md/geo-attendance#insights"],
  ["attendance-search", "/md/attendance/search"],
  ["report-log", "/md/attendance/report-log"],
  ["report-log-insights", "/md/attendance/report-log#insights"],
  ["outpass", "/md/outpass-visitors/outpass"],
  ["visitors", "/md/outpass-visitors/visitors"],
  ["tea-break", "/md/outpass-visitors/tea-break"],
  ["shifts", "/md/shifts"],
  ["leave", "/md/leave"],
  ["requests", "/md/requests"],
  ["payroll", "/md/payroll"],
  ["reports", "/md/reports"],
  ["recruitment", "/md/recruitment"],
  ["activity", "/md/activity"],
  ["employees-new", "/md/employees/new"],
  ["assistant-open", "/md/payroll#assistant"],
  ["dialog-add-branch", "/md/branches#dialog"],
];

async function signIn(request: APIRequestContext, username: string, password: string) {
  const res = await request.post("/api/auth/hr-login", { data: { username, password } });
  expect(res.status()).toBe(200);
  return (await res.json()).token as string;
}

async function shoot(page: Page, id: string, path: string, suffix: string, slices: number) {
  const [route, hash] = path.split("#");
  await page.goto(route);
  await expect(page.getByTestId("md-shell")).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  if (hash === "insights") {
    await page.getByTestId("md-tab-insights").click();
    await expect(page.getByTestId("md-frame-insights")).toBeVisible();
  }
  if (hash === "assistant") {
    await page.getByTestId("assistant-launcher").click();
    await expect(page.getByTestId("assistant-panel")).toHaveAttribute("data-open", "true");
  }
  if (hash === "dialog") {
    await page
      .getByRole("button", { name: /Add Branch/ })
      .first()
      .click();
    await page
      .getByRole("dialog")
      .waitFor({ timeout: 10_000 })
      .catch(() => {});
  }
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${OUT}/${id}${suffix}.png` });
  // a long page scrolls inside <main>: take up to `slices` more screenshots further down
  const view = page.viewportSize()!.height;
  const total = await page.evaluate(() => document.querySelector("main")?.scrollHeight ?? 0);
  for (let i = 1; i <= slices && total > view * (0.8 + i * 0.7); i++) {
    await page.evaluate((top) => document.querySelector("main")?.scrollTo(0, top), Math.round(view * 0.8 * i));
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${OUT}/${id}${suffix}-${i + 1}.png` });
  }
}

test("theme screenshots", async ({ page, request }) => {
  test.setTimeout(900_000);
  let token = "";
  let cleanup = async () => {};
  if (DEMO) {
    token = await signIn(request, "md_demo", "MdDemo#2026");
  } else {
    const admin = await signIn(request, HR_USERNAME, HR_PASSWORD);
    const api = (method: string, url: string, data?: unknown) =>
      request.fetch(url, { method, headers: { Authorization: `Bearer ${admin}` }, data });
    cleanup = async () => {
      const list = (await (await api("GET", "/api/hr-users")).json()) as { id: number; username: string }[];
      for (const u of list.filter((u) => u.username.startsWith("md_thm"))) await api("DELETE", `/api/hr-users/${u.id}`);
    };
    await cleanup();
    expect(
      (
        await api("POST", "/api/hr-users", {
          username: "md_thm",
          password: PASSWORD,
          fullName: "Murugan Raj",
          isMd: true,
        })
      ).status(),
    ).toBe(201);
    await api("PUT", "/api/hr-users/md-assistant", { requestsPerMinute: 60 });
    token = await signIn(request, "md_thm", PASSWORD);
  }
  try {
    await page.addInitScript((t) => localStorage.setItem("uk_textile_token", t), token);
    const chosen = PAGES.filter(([id]) => ONLY.length === 0 || ONLY.includes(id));
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const [id, path] of chosen) await shoot(page, id, path, "", 2);
    if (MOBILE) {
      await page.setViewportSize({ width: 390, height: 844 });
      for (const [id, path] of chosen) await shoot(page, id, path, "-m", 1);
    }
  } finally {
    await cleanup();
  }
});
