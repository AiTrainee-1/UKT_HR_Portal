import { expect, test } from "@playwright/test";
import { loginAsHr } from "./helpers";

// Mobile App Login -> Mobile Messages: HR switches what is pushed to phones, reads the message log, and sends one message.
// An e2e employee has no phone registered, so a pushed message is recorded as "No phone registered" and still saved in the app.

test("the controls switch a kind of message off and on, and HR can send one message that shows in the log", async ({
  page,
}) => {
  await loginAsHr(page);
  const token = await page.evaluate(() => localStorage.getItem("uk_textile_token"));
  const headers = { Authorization: `Bearer ${token}` };
  const controls = async () =>
    (await (await page.request.get("/api/mobile-app/messages/controls", { headers })).json()) as {
      pushEnabled: boolean;
      controls: { key: string; enabled: boolean }[];
    };

  try {
    await page.goto("/hr/mobile-app-login");
    await page.getByRole("tab", { name: "Mobile Messages" }).click();
    await expect(page.getByTestId("mobile-messages")).toBeVisible();
    await expect(page.getByTestId("mm-overview")).toBeVisible();
    await expect(page.getByTestId("mm-overview")).toContainText("Phones ready");

    // controls: one kind off, then on again
    await page.getByRole("tab", { name: "Controls" }).click();
    await expect(page.getByTestId("mm-controls")).toContainText("only stop the push to the phone");
    await page.getByTestId("mm-toggle-late_alert").click();
    await expect.poll(async () => (await controls()).controls.find((c) => c.key === "late_alert")!.enabled).toBe(false);
    await page.getByTestId("mm-toggle-late_alert").click();
    await expect.poll(async () => (await controls()).controls.find((c) => c.key === "late_alert")!.enabled).toBe(true);
    // a login code can never be switched: it is not even listed
    expect((await controls()).controls.some((c) => c.key.startsWith("otp_"))).toBe(false);

    // send one message to one employee
    await page.getByRole("tab", { name: "Send a message" }).click();
    await page.getByLabel("Find the employee").fill("E2E001");
    await page.getByTestId("mm-pick-E2E001").click();
    await expect(page.getByTestId("mm-picked")).toContainText("E2E001");
    await expect(page.getByTestId("mm-send-button")).toBeDisabled();
    await page.getByTestId("mm-title").fill("Phone test");
    await page.getByTestId("mm-message").fill("Does this reach your phone?");
    await page.getByTestId("mm-send-button").click();
    await expect(page.getByText("Message saved in the app", { exact: true })).toBeVisible();

    // and it is in the log, with what happened to the push
    await page.getByRole("tab", { name: "Messages", exact: true }).click();
    const row = page
      .getByTestId("mm-log")
      .locator('[data-testid^="mm-row-"]')
      .filter({ hasText: "Phone test" })
      .first();
    await expect(row).toContainText("Message from HR");
    await expect(row).toContainText("No phone registered");
    await expect(row).toContainText("Not opened");
  } finally {
    // leave the shared e2e database as we found it
    await page.request.put("/api/mobile-app/messages/controls", {
      headers,
      data: { pushEnabled: true, types: { late_alert: true } },
    });
  }
});
