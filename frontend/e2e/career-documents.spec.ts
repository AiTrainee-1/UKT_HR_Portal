import { expect, test, type Page } from "@playwright/test";
import { loginAsHr } from "./helpers";

// Promotion, Salary Increment and Documents (the "career" pages): the summary cards, finding people, the before / after
// checks on the forms, applying a promotion / increment, the history lists with their search and filters, the "due"
// lists, and the document tracker with uploads. Everything made here is called CAR-* (employees), "CAR Dept" and
// "CAR *" (designations) and is removed again, so the other specs only ever see the seed data.

async function api(page: Page, method: string, url: string, data?: unknown) {
  const token = await page.evaluate(() => localStorage.getItem("uk_textile_token"));
  const res = await page.request.fetch(url, { method, headers: { Authorization: `Bearer ${token}` }, data });
  const text = await res.text();
  return { status: res.status(), body: text ? JSON.parse(text) : null };
}

type Emp = {
  id: number;
  employeeCode: string;
  designationTitle?: string | null;
  salaryAmount?: number | null;
};

const employees = async (page: Page, search: string) =>
  (await api(page, "GET", `/api/employees?search=${encodeURIComponent(search)}`)).body as Emp[];

async function cleanUp(page: Page) {
  for (const e of (await employees(page, "CAR-")).filter((x) => x.employeeCode.startsWith("CAR-"))) {
    await api(page, "DELETE", `/api/employees/${e.id}`);
  }
  const designations = (await api(page, "GET", "/api/designations")).body as { id: number; title: string }[];
  for (const d of designations.filter((x) => x.title.startsWith("CAR "))) {
    await api(page, "DELETE", `/api/designations/${d.id}`);
  }
  const departments = (await api(page, "GET", "/api/departments")).body as { id: number; name: string }[];
  for (const d of departments.filter((x) => x.name === "CAR Dept")) {
    await api(page, "DELETE", `/api/departments/${d.id}`);
  }
}

/** Two staff employees who joined years ago (so they are due for review) and one production employee. */
async function seed(page: Page) {
  const branches = (await api(page, "GET", "/api/branches")).body as { id: number }[];
  const branchId = branches[0].id;
  const dept = (await api(page, "POST", "/api/departments", { name: "CAR Dept", branchId })).body;
  const operator = (await api(page, "POST", "/api/designations", { title: "CAR Operator", departmentId: dept.id }))
    .body;
  const supervisor = (await api(page, "POST", "/api/designations", { title: "CAR Supervisor", departmentId: dept.id }))
    .body;
  for (const [code, first, kind, joinDate] of [
    ["CAR-S1", "Carla", "staff", "2020-01-01"],
    ["CAR-S2", "Devika", "staff", "2021-06-01"],
    ["CAR-P1", "Pia", "production", "2023-03-01"],
  ]) {
    const res = await api(page, "POST", "/api/employees", {
      employeeCode: code,
      firstName: first,
      lastName: "Career",
      phone: "9000000077",
      employmentType: kind,
      branchId,
      departmentId: dept.id,
      designationId: operator.id,
      salaryType: "monthly",
      joinDate,
      ...(kind === "staff" ? { salaryAmount: 20000 } : { salaryPerShift: 400 }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  }
  return {
    operator: operator as { id: number },
    supervisor: supervisor as { id: number },
    dept: dept as { id: number },
  };
}

/** Picks an employee in the portal's search-and-select box by typing their code. */
async function pickEmployee(page: Page, testId: string, code: string) {
  await page.getByTestId(testId).click();
  await page.getByPlaceholder("Employee code or name…").fill(code);
  await page.getByRole("button", { name: new RegExp(code) }).click();
}

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await loginAsHr(page);
  await cleanUp(page);
  await seed(page);
});

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await loginAsHr(page);
  await cleanUp(page);
  await page.close();
});

test.describe("Promotion", () => {
  test("the summary, the tabs and an empty state before anyone is promoted", async ({ page }) => {
    await page.goto("/hr/promotion");
    await expect(page.getByRole("heading", { name: "Promotion" })).toBeVisible();
    await expect(page.getByTestId("stat-this-year")).toBeVisible();
    await expect(page.getByTestId("stat-due-value")).not.toHaveText("");
    await expect(page.getByTestId("promote-empty")).toBeVisible();
  });

  test("promoting shows a before / after, asks to confirm, and records the move", async ({ page }) => {
    await page.goto("/hr/promotion");
    await pickEmployee(page, "promotion-employee-select", "CAR-S1");
    await expect(page.getByTestId("current-position")).toContainText("CAR Operator");
    await expect(page.getByTestId("no-previous-promotions")).toBeVisible();
    await expect(page.getByTestId("promote-submit")).toBeDisabled();

    await page.getByTestId("promo-designation").click();
    await page.getByRole("option", { name: /CAR Supervisor/ }).click();
    await expect(page.getByTestId("before-after")).toContainText("CAR Supervisor");
    await expect(page.getByTestId("before-after")).toContainText("new");
    await expect(page.getByTestId("promote-submit")).toBeEnabled();

    await page.getByTestId("promo-notes").fill("CAR annual review");
    await page.getByTestId("promote-submit").click();
    await expect(page.getByTestId("promote-confirm")).toContainText("CAR Supervisor");
    await page.getByTestId("promote-confirm-cancel").click();
    // cancelling changes nothing
    const unchanged = await employees(page, "CAR-S1");
    expect(unchanged[0].designationTitle).toBe("CAR Operator");

    await page.getByTestId("promote-submit").click();
    await page.getByTestId("promote-confirm-yes").click();
    await expect(page.getByTestId("promotion-timeline")).toContainText("CAR Supervisor");
    const after = await employees(page, "CAR-S1");
    expect(after[0].designationTitle).toBe("CAR Supervisor");
  });

  test("a promotion that changes nothing is explained and cannot be submitted", async ({ page }) => {
    await page.goto("/hr/promotion");
    await pickEmployee(page, "promotion-employee-select", "CAR-S2");
    await page.getByTestId("promo-designation").click();
    await page.getByRole("option", { name: /^CAR Operator/ }).click();
    await expect(page.getByTestId("promo-errors")).toContainText("already hold");
    await expect(page.getByTestId("promote-submit")).toBeDisabled();
    // a date in the future is allowed, with a warning that the profile still changes at once
    await page.getByTestId("promo-designation").click();
    await page.getByRole("option", { name: /CAR Supervisor/ }).click();
    await page.getByTestId("promo-date").fill("2099-01-01");
    await expect(page.getByTestId("promo-warning")).toContainText("future");
    await expect(page.getByTestId("promote-submit")).toBeEnabled();
  });

  test("the history can be searched and filtered, and a record deleted without undoing the promotion", async ({
    page,
  }) => {
    const { supervisor } = await (async () => {
      const designations = (await api(page, "GET", "/api/designations")).body as { id: number; title: string }[];
      return { supervisor: designations.find((d) => d.title === "CAR Supervisor")! };
    })();
    const s1 = (await employees(page, "CAR-S1"))[0];
    const s2 = (await employees(page, "CAR-S2"))[0];
    for (const emp of [s1, s2]) {
      const res = await api(page, "POST", "/api/promotions", {
        employeeId: emp.id,
        newDesignationId: supervisor.id,
        effectiveDate: "2026-02-01",
        notes: emp === s1 ? "CAR first" : "CAR second",
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
    await page.goto("/hr/promotion");
    await page.getByRole("tab", { name: /^History/ }).click();
    await expect(page.getByTestId("promotion-count")).toBeVisible();
    await page.getByTestId("promotion-search").fill("CAR-S1");
    await expect(page.getByTestId("promotion-table").getByText("Carla")).toBeVisible();
    await expect(page.getByTestId("promotion-table").getByText("Devika")).toHaveCount(0);
    await page.getByTestId("promotion-search").fill("zzzz-nobody");
    await expect(page.getByTestId("promotion-no-match")).toBeVisible();
    await page.getByTestId("promotion-count-clear").click();
    await page.getByTestId("promotion-search").fill("CAR second");
    await expect(page.getByTestId("promotion-table").getByText("Devika")).toBeVisible();

    // deleting the record asks first, removes the history entry only, and leaves the employee's designation as it is
    await page.getByRole("button", { name: /Delete the promotion record of Devika/ }).click();
    await expect(page.getByTestId("confirm-delete")).toContainText("only removes the history entry");
    await page.getByTestId("confirm-delete-yes").click();
    await expect(page.getByTestId("promotion-no-match").or(page.getByTestId("promotion-history-empty"))).toBeVisible();
    expect((await employees(page, "CAR-S2"))[0].designationTitle).toBe("CAR Supervisor");
  });

  test("the due list names people who have not been promoted for a long time", async ({ page }) => {
    await page.goto("/hr/promotion");
    await page.getByRole("tab", { name: /^Due for review/ }).click();
    await expect(page.getByTestId("due-note")).toBeVisible();
    await page.getByTestId("due-search").fill("CAR-S1");
    await expect(page.getByTestId("due-row-CAR-S1")).toContainText("Never promoted");
    await page.locator('[data-testid="due-promote-CAR-S1"]:visible').click();
    // the Review button opens the form with that employee already chosen
    await expect(page.getByTestId("current-position")).toContainText("Carla");
  });
});

test.describe("Salary Increment", () => {
  test("applying an increment previews the exact new salary, confirms, and updates the salary", async ({ page }) => {
    await page.goto("/hr/increment");
    await expect(page.getByRole("heading", { name: "Salary Increment" })).toBeVisible();
    await pickEmployee(page, "increment-employee-select", "CAR-S1");
    await expect(page.getByTestId("emp-current")).toContainText("₹20,000");
    await expect(page.getByTestId("increment-submit")).toBeDisabled();

    await page.getByTestId("quick-10").click();
    await expect(page.getByTestId("preview-new-salary")).toContainText("₹22,000");
    await expect(page.getByTestId("preview-increase")).toContainText("₹2,000");

    // a custom value with decimals is worked out to the paisa, like the server does it
    await page.getByTestId("custom-percent").fill("7.5");
    await expect(page.getByTestId("preview-new-salary")).toContainText("₹21,500");

    // a nonsense value is explained, not previewed
    await page.getByTestId("custom-percent").fill("0");
    await expect(page.getByTestId("inc-errors")).toContainText("more than 0");
    await expect(page.getByTestId("increment-submit")).toBeDisabled();

    await page.getByTestId("quick-10").click();
    await page.getByTestId("inc-notes").fill("CAR appraisal");
    await page.getByTestId("increment-submit").click();
    await expect(page.getByTestId("increment-confirm")).toContainText("₹22,000");
    await page.getByTestId("increment-confirm-yes").click();
    await expect(page.getByTestId("salary-timeline")).toContainText("₹22,000");
    expect((await employees(page, "CAR-S1"))[0].salaryAmount).toBe(22000);
  });

  test("the history lists, filters and exports; the due list drops the person who just had one", async ({ page }) => {
    const s1 = (await employees(page, "CAR-S1"))[0];
    const res = await api(page, "POST", "/api/increments", {
      employeeId: s1.id,
      percent: 10,
      effectiveDate: "2026-09-01",
      notes: "CAR hist",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    await page.goto("/hr/increment");
    await page.getByRole("tab", { name: /^History/ }).click();
    await page.getByTestId("increment-search").fill("CAR hist");
    await expect(page.getByTestId("increment-table")).toContainText("Carla");
    await expect(page.getByTestId("increment-count")).toContainText("Showing 1 of");
    const download = page.waitForEvent("download");
    await page.getByTestId("increment-export").click();
    expect((await download).suggestedFilename()).toMatch(/^salary-increments-.*\.xlsx$/);

    await page.getByTestId("increment-search").fill("zzzz-nobody");
    await expect(page.getByTestId("increment-no-match")).toBeVisible();

    await page.getByRole("tab", { name: /^Due for increment/ }).click();
    await page.getByTestId("due-search").fill("CAR-");
    await expect(page.getByTestId("due-row-CAR-S2")).toContainText("Never had one");
    await expect(page.getByTestId("due-row-CAR-S1")).toHaveCount(0);
  });

  test("insights show the department breakdown once there is data", async ({ page }) => {
    const s1 = (await employees(page, "CAR-S1"))[0];
    await api(page, "POST", "/api/increments", { employeeId: s1.id, percent: 5, effectiveDate: "2026-09-01" });
    await page.goto("/hr/increment");
    await page.getByRole("tab", { name: /^Insights/ }).click();
    await expect(page.getByTestId("insights-departments")).toContainText("CAR Dept");
    await expect(page.getByTestId("insights-trend")).toBeVisible();
  });
});

test.describe("Documents", () => {
  test("the tracker lists who still owes documents, with search and filters", async ({ page }) => {
    await page.goto("/hr/recruitment/documents");
    await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();
    await expect(page.getByTestId("stat-pending-value")).not.toHaveText("");
    await page.getByTestId("documents-search").fill("CAR-S");
    await expect(page.getByTestId("tracker-row-CAR-S1")).toContainText("0 of 6");
    await expect(page.getByTestId("tracker-row-CAR-S2")).toBeVisible();
    // the production employee is on the other tab
    await expect(page.getByTestId("tracker-row-CAR-P1")).toHaveCount(0);
    await page.getByTestId("documents-search").fill("zzzz-nobody");
    await expect(page.getByTestId("documents-no-match")).toBeVisible();
    await page.getByTestId("documents-count-clear").click();
    await page.getByRole("tab", { name: "Production" }).click();
    await page.getByTestId("documents-search").fill("CAR-P1");
    await expect(page.getByTestId("tracker-row-CAR-P1")).toBeVisible();
  });

  test("uploading a document moves the figures, a wrong file is explained, and a delete asks first", async ({
    page,
  }) => {
    await page.goto("/hr/recruitment/documents");
    await page.getByTestId("documents-search").fill("CAR-S1");
    await page.getByTestId("open-CAR-S1").click();
    await expect(page.getByTestId("employee-view")).toContainText("Carla");
    await expect(page.getByTestId("employee-completion")).toContainText("0 of 6");
    await page.getByRole("tab", { name: /Extra Documents/ }).click();
    await expect(page.getByTestId("docs-missing")).toContainText("PAN Card");

    await page.getByTestId("category-pan_card").click();
    await expect(page.getByTestId("category-empty")).toBeVisible();
    // a Word file is refused before it is sent
    await page
      .getByTestId("upload-input")
      .setInputFiles({ name: "cv.docx", mimeType: "application/msword", buffer: Buffer.from("x") });
    await expect(page.getByTestId("upload-problems")).toContainText("not a PDF, JPG or PNG");
    // a real PDF goes through
    await page
      .getByTestId("upload-input")
      .setInputFiles({ name: "pan.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 test") });
    await expect(page.locator('[data-testid^="doc-"]', { hasText: "pan.pdf" })).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByTestId("employee-completion")).toContainText("1 of 6");

    await page.getByTestId("category-pan_card").click();
    await page.getByRole("button", { name: /Delete pan.pdf/ }).click();
    await expect(page.getByTestId("delete-doc-confirm")).toContainText("cannot be undone");
    await page.getByTestId("delete-doc-yes").click();
    await expect(page.getByTestId("category-empty")).toBeVisible();
  });

  test("the letters tab blocks the experience letter until a last working day is chosen", async ({ page }) => {
    await page.goto("/hr/recruitment/documents");
    await page.getByTestId("documents-search").fill("CAR-S2");
    await page.getByTestId("open-CAR-S2").click();
    await page.getByRole("tab", { name: "Letters" }).click();
    await expect(page.getByTestId("letters-tab")).toBeVisible();
    await page.getByTestId("last-working-day").fill("");
    await expect(page.getByTestId("experience-preview")).toBeDisabled();
    await expect(page.getByTestId("experience-whatsapp")).toBeDisabled();
    // there is no approved resignation, so that letter is explained and disabled
    await expect(page.getByTestId("resignation-preview")).toBeDisabled();
    await page.getByTestId("last-working-day").fill("2000-01-01");
    await expect(page.getByTestId("before-joining-warning")).toBeVisible();
  });

  test("on a phone the tracker is a list of cards, not a clipped table", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto("/hr/recruitment/documents");
    await page.getByTestId("documents-search").fill("CAR-S1");
    await expect(page.getByTestId("tracker-card-CAR-S1")).toBeVisible();
    await expect(page.getByTestId("documents-table")).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
