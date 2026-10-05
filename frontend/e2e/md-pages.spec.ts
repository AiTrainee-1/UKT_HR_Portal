import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { HR_PASSWORD, HR_USERNAME } from "./helpers";

// Every page of the MD portal opens, on a laptop and on a phone, with the assistant closed and open: the page title is
// there, nothing on the page is wider than the screen, no request to the server fails (5xx) and the browser logs no
// error. The database is the e2e fixture company (small, and some pages are empty), so this is about the pages holding
// together, not about the numbers: those are the backend and component tests' job.
//
// The server throttles sign-ins (10 a minute), so the MD signs in ONCE and every test starts from that token.

const MD_PASSWORD = "Passw0rd!md";
const PAGES = [
  "/md/dashboard",
  "/md/attendance",
  "/md/employees",
  "/md/visitors",
  "/md/tea-break",
  "/md/payroll",
  "/md/reports",
  "/md/recruitment",
  "/md/activity",
];

let adminToken = "";
let mdToken = "";

async function signIn(request: APIRequestContext, username: string, password: string) {
  const res = await request.post("/api/auth/hr-login", { data: { username, password } });
  expect(res.status(), `sign in as ${username}`).toBe(200);
  return (await res.json()).token as string;
}

async function api(request: APIRequestContext, token: string, method: string, url: string, data?: unknown) {
  const res = await request.fetch(url, { method, headers: { Authorization: `Bearer ${token}` }, data });
  const text = await res.text();
  return { status: res.status(), body: text ? JSON.parse(text) : null };
}

async function cleanUp(request: APIRequestContext) {
  const list = (await api(request, adminToken, "GET", "/api/hr-users")).body as { id: number; username: string }[];
  for (const u of list.filter((u) => u.username.startsWith("md_"))) {
    await api(request, adminToken, "DELETE", `/api/hr-users/${u.id}`);
  }
}

/** page.goto, retried when the dev server's hot reload aborts the navigation. */
async function goto(page: Page, path: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      await page.goto(path);
      return;
    } catch (error) {
      if (attempt >= 3 || !String(error).includes("ERR_ABORTED")) throw error;
    }
  }
}

/** What went wrong on the page while it loaded: server errors, script errors and anything the console logged as an error. */
function watch(page: Page) {
  const problems: string[] = [];
  page.on("response", (res) => {
    if (res.url().includes("/api/") && res.status() >= 500) problems.push(`${res.status()} ${res.url()}`);
  });
  page.on("pageerror", (error) => problems.push(`script error: ${error.message}`));
  page.on("console", (message) => {
    // a 4xx the page handled is reported by the browser as a failed resource; it is not a bug in the page
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) {
      problems.push(`console: ${message.text().slice(0, 200)}`);
    }
  });
  return problems;
}

/** Nothing on the page sticks out past the screen (the page itself, or the scrolling content area). */
async function expectFitsScreen(page: Page, label: string) {
  const overflow = await page.evaluate(() => {
    const main = document.querySelector("main");
    return {
      page: document.documentElement.scrollWidth - window.innerWidth,
      main: main ? main.scrollWidth - main.clientWidth : 0,
    };
  });
  if (overflow.page > 1 || overflow.main > 1) {
    // say WHAT sticks out: the elements past the right edge that are not inside something that scrolls sideways
    const culprits = await page.evaluate(() => {
      const main = document.querySelector("main");
      const edge = main ? main.getBoundingClientRect().right : window.innerWidth;
      const scrolls = (el: Element | null) => {
        for (let node = el; node && node !== main; node = node.parentElement) {
          const x = getComputedStyle(node).overflowX;
          if (x === "auto" || x === "scroll" || x === "hidden") return true;
        }
        return false;
      };
      return Array.from((main ?? document.body).querySelectorAll("*"))
        .filter((el) => el.getBoundingClientRect().right > edge + 1 && !scrolls(el.parentElement))
        .slice(0, 6)
        .map(
          (el) =>
            `${el.tagName.toLowerCase()}[${el.getAttribute("data-testid") ?? ""}] .${String(el.className).slice(0, 80)}`,
        );
    });
    expect(culprits, `${label}: what sticks out`).toEqual([]);
  }
  expect(overflow.page, `${label}: page wider than the screen`).toBeLessThanOrEqual(1);
  expect(overflow.main, `${label}: content wider than its area`).toBeLessThanOrEqual(1);
}

async function openPage(page: Page, path: string) {
  await goto(page, path);
  await expect(page.getByTestId("md-page-title")).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(600); // let the charts finish drawing
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  adminToken = await signIn(request, HR_USERNAME, HR_PASSWORD);
  await cleanUp(request);
  const made = await api(request, adminToken, "POST", "/api/hr-users", {
    username: "md_pages",
    password: MD_PASSWORD,
    fullName: "Pages Tester",
    isMd: true,
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  mdToken = await signIn(request, "md_pages", MD_PASSWORD);
});

test.afterAll(async ({ request }) => {
  await cleanUp(request);
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript((t) => localStorage.setItem("uk_textile_token", t), mdToken);
});

for (const [name, size] of [
  ["a laptop", { width: 1366, height: 800 }],
  ["a phone", { width: 375, height: 812 }],
] as const) {
  test.describe(`on ${name}`, () => {
    test.use({ viewport: size });

    for (const path of PAGES) {
      test(`${path} opens and fits the screen`, async ({ page }) => {
        const problems = watch(page);
        await openPage(page, path);
        await expectFitsScreen(page, path);
        expect(problems, `trouble on ${path}`).toEqual([]);
      });
    }
  });
}

test.describe("with the assistant open beside the page", () => {
  test.use({ viewport: { width: 1366, height: 800 } });

  for (const path of PAGES) {
    test(`${path} still fits`, async ({ page }) => {
      const problems = watch(page);
      await openPage(page, path);
      await page.getByTestId("assistant-launcher").click();
      await expect(page.getByTestId("assistant-panel")).toHaveAttribute("data-open", "true");
      await page.waitForTimeout(500); // the page makes room for the panel
      await expectFitsScreen(page, `${path} with the assistant`);
      expect(problems, `trouble on ${path}`).toEqual([]);
    });
  }
});
