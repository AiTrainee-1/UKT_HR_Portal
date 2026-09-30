import { expect, test, type Page } from "@playwright/test";
import { loginAsHr } from "./helpers";

// No email ever leaves this stack: the SMTP account these tests save points at 127.0.0.1:9, where nothing
// listens, so a "send" fails with connection refused. The successful send (SMTP conversation, attachments,
// stamping) is covered against a mocked smtplib in backend/api/tests_email_control.py.
// playwright.config.ts sets EMAIL_ALLOW_SENDING=true because this is a dev-mode (DEBUG) backend.

const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });

async function hrToken(page: Page) {
  return page.evaluate(() => localStorage.getItem("uk_textile_token"));
}

async function sendTest(page: Page, to: string) {
  await page.getByLabel("Send the test to").fill(to);
  await page.getByRole("button", { name: "Send test email" }).click();
}

test.describe.configure({ mode: "serial" });

test("the Gmail Control API needs a login", async ({ request }) => {
  for (const path of ["overview", "messages", "employees", "settings", "templates"]) {
    expect((await request.get(`/api/gmail-control/${path}`)).status(), path).toBe(401);
  }
  expect((await request.put("/api/gmail-control/settings", { data: { emailsEnabled: false } })).status()).toBe(401);
  expect((await request.post("/api/gmail-control/test-email", { data: { toEmail: "a@b.test" } })).status()).toBe(401);
});

test("HR finds Gmail Control in the sidebar and sees all six tabs", async ({ page }) => {
  await loginAsHr(page);
  await expect(page.getByRole("link", { name: "Gmail Control" })).toBeVisible();
  await page.getByRole("link", { name: "Gmail Control" }).click();
  await expect(page).toHaveURL(/\/hr\/gmail-control/);
  await expect(page.getByRole("heading", { name: "Gmail Control" })).toBeVisible();
  for (const name of ["Overview", "Messages", "Employees", "Feature Controls", "Message Text", "Configuration"]) {
    await expect(tab(page, name)).toBeVisible();
  }
  // Exactly one Refresh button, in the title row (the page has its own).
  await expect(page.getByRole("button", { name: /^\s*Refresh( this page)?\s*$/ })).toHaveCount(1);
  await expect(page.getByTestId("page-refresh-bar")).toHaveCount(0);
});

test("before Gmail is set up the page says so, and a test email explains why it wasn't sent", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/gmail-control");
  await expect(page.getByTestId("not-configured-banner")).toContainText("SMTP settings not configured");

  await tab(page, "Configuration").click();
  await expect(page.getByText("The Gmail account is saved in Settings")).toBeVisible();
  await expect(page.getByText("Can't send")).toBeVisible();

  await sendTest(page, "hr@example.test");
  const result = page.getByTestId("test-email-result");
  await expect(result).toContainText("Not sent");
  await expect(result).toContainText("SMTP settings not configured");

  // Nothing was attempted against a mail server, but the attempt is on record.
  await tab(page, "Messages").click();
  const row = page.getByTestId("gmail-message-row").first();
  await expect(row).toContainText("Test Email");
  await expect(row).toContainText("hr@example.test");
  await expect(row).toContainText("Not sent");
});

test("with an account saved, a failed send is recorded with its reason; the password never reaches the browser", async ({
  page,
}) => {
  await loginAsHr(page);
  const auth = { Authorization: `Bearer ${await hrToken(page)}` };
  const saved = await page.request.put("/api/payroll-settings", {
    headers: auth,
    data: {
      smtpHost: "127.0.0.1",
      smtpPort: 9,
      smtpUsername: "e2e-sender@example.test",
      smtpPassword: "e2e-app-password-SECRET",
      smtpFromEmail: "e2e-sender@example.test",
    },
  });
  expect(saved.ok()).toBeTruthy();

  // Nothing on the Gmail Control API contains the password.
  for (const path of ["overview", "settings", "templates", "messages"]) {
    const body = await (await page.request.get(`/api/gmail-control/${path}`, { headers: auth })).text();
    expect(body, path).not.toContain("e2e-app-password-SECRET");
  }

  await page.goto("/hr/gmail-control");
  await expect(page.getByTestId("not-configured-banner")).toHaveCount(0);
  await tab(page, "Configuration").click();
  await expect(page.getByText("Ready to send")).toBeVisible();
  await expect(page.getByText("Saved (hidden)")).toBeVisible();
  await expect(page.getByText("e2•••@example.test").first()).toBeVisible();

  await sendTest(page, "me@example.test");
  const result = page.getByTestId("test-email-result");
  await expect(result).toContainText("Failed");
  await expect(result).toContainText(/refused/i);

  // Messages tab: filter to failures, open the row, read the reason and the text that would have gone out.
  await tab(page, "Messages").click();
  await page.getByRole("tab", { name: "Failed", exact: true }).click();
  const rows = page.getByTestId("gmail-message-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("me@example.test");
  await rows.first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Failure reason");
  await expect(dialog).toContainText(/refused/i);
  await expect(dialog).toContainText("This is a test email");
  await expect(dialog).toContainText("Subject");
  await page.keyboard.press("Escape");

  // Overview counts it, and "View all failures" jumps to the same filtered list.
  await tab(page, "Overview").click();
  await expect(page.getByTestId("period-today")).toContainText("Failed");
  await expect(page.getByText("me@example.test · Test Email")).toBeVisible();
  await page.getByRole("button", { name: "View all failures" }).click();
  await expect(tab(page, "Messages")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("gmail-message-row")).toHaveCount(1);
});

test("the master switch holds every email back and the Messages tab shows why", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/gmail-control");
  await tab(page, "Feature Controls").click();
  const master = page.getByTestId("toggle-emailsEnabled");
  await expect(master).toBeChecked();
  await master.click();
  await expect(page.getByText("Gmail – Send emails: OFF").first()).toBeVisible();
  await expect(master).not.toBeChecked();

  await tab(page, "Configuration").click();
  await sendTest(page, "held@example.test");
  const result = page.getByTestId("test-email-result");
  await expect(result).toContainText("Not sent");
  await expect(result).toContainText("All emails are switched off");

  await tab(page, "Messages").click();
  await page.getByRole("tab", { name: "Not sent", exact: true }).click();
  await expect(page.getByTestId("gmail-message-row").first()).toContainText("held@example.test");

  // Back on, and it stays on after a reload.
  await tab(page, "Feature Controls").click();
  await page.getByTestId("toggle-emailsEnabled").click();
  await expect(page.getByText("Gmail – Send emails: ON").first()).toBeVisible();
  await page.reload();
  await tab(page, "Feature Controls").click();
  await expect(page.getByTestId("toggle-emailsEnabled")).toBeChecked();
  for (const key of ["documentEmailsEnabled", "visitorEmailsEnabled", "recruitmentEmailsEnabled"]) {
    await expect(page.getByTestId(`toggle-${key}`)).toBeChecked();
  }
});

test("the daily limit can be set, is validated, and holds back the rest of the day", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/gmail-control");
  await tab(page, "Feature Controls").click();
  const limit = page.getByLabel("Daily email limit (0 = no limit)");
  await expect(limit).toHaveValue("0");

  await limit.fill("99999");
  await page.getByRole("button", { name: "Save limit" }).click();
  await expect(page.getByText("Couldn't save the limit").first()).toBeVisible();

  await limit.fill("5");
  await page.getByRole("button", { name: "Save limit" }).click();
  await expect(page.getByText("Limit saved").first()).toBeVisible();
  await page.reload();
  await tab(page, "Feature Controls").click();
  await expect(page.getByLabel("Daily email limit (0 = no limit)")).toHaveValue("5");

  await tab(page, "Overview").click();
  await expect(page.getByTestId("daily-limit")).toContainText("of your limit of 5");

  // Put it back for the tests that follow.
  await tab(page, "Feature Controls").click();
  await page.getByLabel("Daily email limit (0 = no limit)").fill("0");
  await page.getByRole("button", { name: "Save limit" }).click();
  await expect(page.getByText("Limit saved").first()).toBeVisible();
});

test("HR edits an email's subject and text with a live preview, and typos are refused", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/gmail-control");
  await tab(page, "Message Text").click();

  // Every email type is listed under its module.
  for (const id of ["salary_slip", "offer_letter", "id_card", "resignation_letter", "visitor_arrival"]) {
    await expect(page.getByTestId(`template-${id}`)).toBeVisible();
  }
  await expect(page.getByTestId("template-salary_slip")).toContainText("Default");

  await page.getByTestId("template-salary_slip").getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("template-preview-subject")).toContainText("Salary Slip – August 2026");

  await dialog.getByLabel("Subject").fill("Your payslip for {{month_year}}");
  await dialog.getByLabel("Email text").fill("Hi **{{employee_name}}**,\n\nYour payslip is attached.");
  await expect(dialog.getByTestId("template-preview-subject")).toContainText("Your payslip for August 2026");
  const preview = dialog.frameLocator('iframe[data-testid="template-preview"]');
  await expect(preview.getByText("Hi Asha Kumar,")).toBeVisible();
  await expect(preview.getByText("Your payslip is attached.")).toBeVisible();

  // A variable inserts at the cursor of the box last used.
  await dialog.getByLabel("Email text").click();
  await dialog.getByRole("button", { name: "{{net_salary}}" }).click();
  await expect(dialog.getByLabel("Email text")).toHaveValue(/\{\{net_salary\}\}/);

  // A typo would send a blank: the preview flags it and Save is refused.
  await dialog.getByLabel("Email text").fill("Hello {{nmae}}");
  await expect(dialog.getByRole("alert")).toContainText("Unknown placeholder {{nmae}}");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Couldn't save").first()).toBeVisible();
  await expect(dialog).toBeVisible();

  // Fix it and save.
  await dialog.getByLabel("Email text").fill("Hi **{{employee_name}}**,\n\nYour payslip is attached.");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Salary Slip email saved").first()).toBeVisible();
  await expect(page.getByTestId("template-salary_slip")).toContainText("Customised");

  // The saved wording survives a reload; "Use defaults" clears it again.
  await page.reload();
  await tab(page, "Message Text").click();
  await expect(page.getByTestId("template-salary_slip")).toContainText("Customised");
  await page.getByTestId("template-salary_slip").getByRole("button", { name: "Edit" }).click();
  await expect(page.getByRole("dialog").getByLabel("Subject")).toHaveValue("Your payslip for {{month_year}}");
  await page.getByRole("dialog").getByRole("button", { name: "Use defaults" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("template-salary_slip")).toContainText("Default");
});

test("a per-email switch and the details-table token work in the editor", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/gmail-control");
  await tab(page, "Message Text").click();
  await page.getByTestId("template-visitor_arrival").getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog");

  // This email has a fixed details table, and the editor says where it can go.
  await expect(dialog).toContainText("Phone, Purpose");
  await expect(dialog.getByRole("button", { name: "{{details}}" })).toBeVisible();

  await dialog.getByRole("switch", { name: "Send this email" }).click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("template-visitor_arrival")).toContainText("Disabled");

  // Turn it back on.
  await page.getByTestId("template-visitor_arrival").getByRole("button", { name: "Edit" }).click();
  await page.getByRole("dialog").getByRole("switch", { name: "Send this email" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("template-visitor_arrival")).toContainText("Active");
});

test("the Employees tab starts empty, and Overview lists modules that open the Messages tab", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/gmail-control");
  await tab(page, "Employees").click();
  await expect(page.getByText("No employee has been emailed yet.")).toBeVisible();

  await tab(page, "Overview").click();
  await expect(page.getByText("By module")).toBeVisible();
  await page.getByRole("button", { name: /^Other/ }).click();
  await expect(tab(page, "Messages")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("gmail-message-row").first()).toContainText("Test Email");
});
