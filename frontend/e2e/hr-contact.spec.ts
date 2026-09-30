import { expect, test, type Page } from "@playwright/test";
import { loginAsHr } from "./helpers";

// Settings -> HR Contact, and what the people it is for get to see: the sign-in page and the server-down screen.

const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });
const box = (page: Page, key: string) => page.getByTestId(`input-${key}`);

async function hrToken(page: Page) {
  return page.evaluate(() => localStorage.getItem("uk_textile_token"));
}

async function openHrContact(page: Page) {
  await page.goto("/hr/settings");
  await tab(page, "HR Contact").click();
  await expect(page.getByText("HR & Software Support Contacts")).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test("HR Contact is a Settings sub-tab right after Company, and Company keeps its own form", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/settings");
  await expect(tab(page, "Company")).toBeVisible();
  // A tab's label is drawn twice (the hover animation repeats it), so read each name from its first half.
  const names = await page.getByRole("tab").evaluateAll((els) =>
    els.map((el) => {
      const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      const half = text.length / 2;
      return text.slice(0, half) === text.slice(half) ? text.slice(0, half) : text;
    }),
  );
  expect(names).toContain("HR Contact");
  expect(names.indexOf("HR Contact")).toBe(names.indexOf("Company") + 1);
  await tab(page, "Company").click();
  await expect(page.getByText("Company Profile", { exact: true })).toBeVisible();
  await expect(page.getByText("HR & Software Support Contacts")).toHaveCount(0);
});

test("the public endpoint needs no login and starts out saying nothing is set", async ({ request }) => {
  const r = await request.get("/api/support-contact");
  expect(r.status()).toBe(200);
  const body = await r.json();
  expect(body.configured).toBe(false);
  expect(body.hr.label).toBe("HR Department");
  // A stale token must not turn it into a 401 (the apps sign out on any 401).
  expect(
    (await request.get("/api/support-contact", { headers: { Authorization: "Bearer stale.token.value" } })).status(),
  ).toBe(200);
});

test("HR fills in the contacts: typos are caught, the preview follows, and it saves", async ({ page }) => {
  await loginAsHr(page);
  await openHrContact(page);

  // Nothing set yet: the preview shows the plain sentences, and there is nothing to save.
  const preview = page.getByTestId("hr-contact-preview");
  await expect(preview.getByText("Please contact your HR department.")).toBeVisible();
  await expect(preview.getByText("Please contact your software support team.")).toBeVisible();
  const save = page.getByRole("button", { name: "Save HR Contact" });
  await expect(save).toBeDisabled();

  // A bad number and a bad address are flagged on the field, and block Save.
  await box(page, "hrContactPhone").fill("call me maybe");
  await expect(page.getByRole("alert").filter({ hasText: "must be one phone number" })).toBeVisible();
  await box(page, "hrContactEmail").fill("not-an-email");
  await expect(page.getByRole("alert").filter({ hasText: "valid email" })).toBeVisible();
  await expect(save).toBeDisabled();

  await box(page, "hrContactName").fill("People Team");
  await box(page, "hrContactPhone").fill("0421 430 0800");
  await box(page, "hrContactWhatsapp").fill("98765 43210");
  await box(page, "hrContactEmail").fill("hr@uktex.net");
  await box(page, "hrContactHours").fill("Mon-Sat, 9:00 AM - 6:00 PM");
  await box(page, "contactNote").fill("HR office is on the first floor.");
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  // The preview shows what employees will get; with no support contact of its own, HR is shown for a server problem.
  const hrCard = preview.locator('[data-situation="hr"]');
  await expect(hrCard).toContainText("People Team");
  await expect(hrCard.getByTestId("support-call")).toContainText("0421 430 0800");
  await expect(hrCard.getByTestId("support-whatsapp")).toContainText("98765 43210");
  await expect(hrCard.getByTestId("support-email")).toContainText("hr@uktex.net");
  await expect(hrCard).toContainText("HR office is on the first floor.");
  await expect(preview.locator('[data-situation="server"]')).toContainText("no separate support contact is set");

  await box(page, "supportContactName").fill("IT Desk");
  await box(page, "supportContactPhone").fill("98765 11111");
  await expect(preview.locator('[data-situation="server"]')).toContainText("IT Desk");
  await expect(preview.locator('[data-situation="server"]').getByTestId("support-call")).toContainText("98765 11111");

  await save.click();
  await expect(page.getByText("HR contact details saved").first()).toBeVisible();
  await expect(page.getByText("Unsaved changes")).toHaveCount(0);

  // It is really stored: a reload shows it, and so does the public endpoint the apps read.
  await page.reload();
  await tab(page, "HR Contact").click();
  await expect(box(page, "hrContactPhone")).toHaveValue("0421 430 0800");
  await expect(box(page, "supportContactName")).toHaveValue("IT Desk");
  const body = await (await page.request.get("/api/support-contact")).json();
  expect(body.configured).toBe(true);
  expect(body.hr).toMatchObject({ label: "People Team", phone: "0421 430 0800", phoneDial: "04214300800" });
  expect(body.hr.whatsappNumber).toBe("919876543210");
  expect(body.support).toMatchObject({ label: "IT Desk", phoneDial: "9876511111", usesHrFallback: false });
  expect(body.note).toBe("HR office is on the first floor.");

  // The server refuses what the form let through if someone bypasses it.
  const token = await hrToken(page);
  const bad = await page.request.put("/api/payroll-settings", {
    headers: { Authorization: `Bearer ${token}` },
    data: { hrContactPhone: "12", hrContactName: "Should not stick" },
  });
  expect(bad.status()).toBe(400);
  expect((await (await page.request.get("/api/support-contact")).json()).hr.label).toBe("People Team");
});

test("employees see the HR contact on the sign-in page", async ({ page }) => {
  await page.goto("/employee-login");
  const card = page.getByTestId("support-contact-card");
  await expect(card).toContainText("Can't sign in? Contact HR");
  await expect(card.getByTestId("support-call")).toHaveAttribute("href", "tel:04214300800");
  await expect(card.getByTestId("support-whatsapp")).toHaveAttribute("href", "https://wa.me/919876543210");
  await expect(card.getByTestId("support-email")).toHaveAttribute("href", "mailto:hr@uktex.net");
});

test("when the server can't be reached the screen shows the Software Support contact, kept from an earlier visit", async ({
  page,
}) => {
  await loginAsHr(page);
  // The contact is fetched whenever the portal is open, so this device already holds a copy...
  await expect
    .poll(async () => page.evaluate(() => localStorage.getItem("uktex_support_contact_v1")))
    .toContain("IT Desk");

  // ...and the server then goes away: every API call fails.
  await page.route("**/api/**", (route) => route.abort("connectionrefused"));
  await page.goto("/hr/settings").catch(() => undefined);
  const overlay = page.getByRole("alertdialog");
  await expect(overlay).toBeVisible({ timeout: 20_000 });
  await expect(overlay).toContainText("Can't Reach the Server");

  // Software Support (not HR) is who to call about a dead server, and it is the configured number, not a placeholder.
  const card = overlay.getByTestId("support-contact-card");
  await expect(card).toHaveAttribute("data-situation", "server");
  await expect(card).toContainText("IT Desk");
  await expect(card.getByTestId("support-call")).toHaveAttribute("href", "tel:9876511111");
  await expect(overlay.locator('a[href*="9876543210"]')).toHaveCount(0);
});

test("HR can clear the contacts again and the apps go back to plain wording", async ({ page }) => {
  await loginAsHr(page);
  await openHrContact(page);
  for (const key of [
    "hrContactPhone",
    "hrContactWhatsapp",
    "hrContactEmail",
    "hrContactHours",
    "supportContactPhone",
    "contactNote",
  ]) {
    await box(page, key).fill("");
  }
  await page.getByRole("button", { name: "Save HR Contact" }).click();
  await expect(page.getByText("HR contact details saved").first()).toBeVisible();
  const body = await (await page.request.get("/api/support-contact")).json();
  expect(body.configured).toBe(false);
  expect(body.note).toBe("");
});
