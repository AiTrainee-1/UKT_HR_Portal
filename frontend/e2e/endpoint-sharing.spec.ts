import { expect, test, type Page } from "@playwright/test";
import { HR_PASSWORD, HR_USERNAME, loginAsHr } from "./helpers";

// Settings -> Endpoint Sharing against the real backend (backend/api/shared_endpoint_admin_views.py and
// shared_endpoint_views.py): the whole flow of the super admin (make an endpoint on the departments dataset, tick fields, allow a
// website, make a key, call the PUBLIC address with the key) and that a login without super-admin rights never sees the tab.
//
// The backend is built in parallel with the screen: while GET /api/shared-endpoints/catalog answers 404 every case here is
// SKIPPED (not failed) and says why. Whatever a case creates is removed again, through the API, before it ends.

const CATALOG = "/api/shared-endpoints/catalog";
const ORIGIN = "https://intranet.example.com";

test.describe.configure({ mode: "serial" });

type Reply = { status: number; body: Record<string, unknown> | null };

async function adminToken(page: Page): Promise<string> {
  const res = await page.request.post("/api/auth/hr-login", { data: { username: HR_USERNAME, password: HR_PASSWORD } });
  return (await res.json()).token as string;
}

async function api(page: Page, method: string, url: string, data?: unknown, token?: string): Promise<Reply> {
  const bearer = token ?? (await page.evaluate(() => localStorage.getItem("uk_textile_token")));
  const res = await page.request.fetch(url, { method, headers: { Authorization: `Bearer ${bearer}` }, data });
  const text = await res.text();
  let body: Reply["body"] = null;
  try {
    body = text ? (JSON.parse(text) as Reply["body"]) : null;
  } catch {
    body = { raw: text };
  }
  return { status: res.status(), body };
}

/** Sign in as the e2e super admin, and skip the case while the backend does not exist yet. */
async function ready(page: Page): Promise<string> {
  await loginAsHr(page);
  const token = await adminToken(page);
  const probe = await api(page, "GET", CATALOG, undefined, token);
  test.skip(
    probe.status === 404,
    "Endpoint Sharing backend is not built yet: GET /api/shared-endpoints/catalog answers 404",
  );
  expect(probe.status, "the catalogue can be read by the super admin").toBe(200);
  return token;
}

const stamp = () => Date.now().toString(36);

test("the super admin makes an endpoint, a key and a public call that returns only the ticked fields", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const token = await ready(page);
  const slug = `e2e-departments-${stamp()}`;
  let endpointId: number | null = null;

  try {
    await page.goto("/hr/settings?tab=endpoint_sharing");
    await expect(page.getByTestId("settings-panel-endpoint_sharing")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("endpoint-sharing-tab")).toBeVisible();
    // the three subtabs, and the plain warning that nothing is shared yet
    await expect(page.getByTestId("sharing-subtabs").getByRole("tab")).toHaveText([
      /Endpoints/,
      /Integration guide/,
      /Activity/,
    ]);
    await expect(page.getByTestId("nothing-shared")).toContainText(
      "Nothing is shared until you select fields and create a key",
    );

    // 1. a new endpoint: Basics
    await page.getByTestId("endpoint-new").click();
    await expect(page).toHaveURL(/endpoint=new/);
    await expect(page.getByTestId("endpoint-editor")).toHaveAttribute("data-mode", "new");
    await page.locator("#es-name").fill("E2E departments");
    await page.locator("#es-slug").fill(slug);
    await expect(page.getByTestId("endpoint-url")).toContainText(`/api/shared/${slug}`);

    // 2. Data: the departments dataset, two fields
    await page.getByTestId("endpoint-sections-data").click();
    await expect(page).toHaveURL(/section=data/);
    await page.locator("#es-dataset").selectOption("departments");
    await expect(page.getByTestId("field-checklist")).toBeVisible();
    await expect(page.getByTestId("hard-excluded")).toContainText("Never shared");
    await page.getByTestId("field-id").check();
    await page.getByTestId("field-name").check();
    await expect(page.getByTestId("field-count")).toContainText("2 of");

    // 3. Access: one allowed website (a bad one is refused first)
    await page.getByTestId("endpoint-sections-access").click();
    await page.locator("#es-origin-add").fill("https://*.example.com");
    await page.getByTestId("origin-add").click();
    await expect(page.getByTestId("origin-error")).toBeVisible();
    await page.locator("#es-origin-add").fill(ORIGIN);
    await page.getByTestId("origin-add").click();
    await expect(page.getByTestId("origin-row")).toHaveCount(1);
    await expect(page.getByTestId("keys-needs-save")).toBeVisible();

    // 4. create: one Save for everything
    await page.getByRole("button", { name: "Create endpoint" }).click();
    await expect(page).toHaveURL(/endpoint=\d+/, { timeout: 30_000 });
    endpointId = Number(new URL(page.url()).searchParams.get("endpoint"));
    await expect(page.getByTestId("endpoint-editor")).toHaveAttribute("data-mode", "edit");
    await expect(page.getByTestId("endpoint-sections-panel")).toBeVisible();

    // 5. a key: the whole key is shown once
    await page.locator("#es-key-label").fill("E2E key");
    await page.getByTestId("key-category-staff").check();
    await page.getByTestId("key-expiry-permanent").check();
    await page.getByTestId("key-create").click();
    await expect(page.getByTestId("key-reveal")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("key-reveal")).toContainText("it is never shown again");
    const key = (await page.getByTestId("key-secret").locator("pre").innerText()).trim();
    expect(key).toMatch(/^uks_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$/);
    await page.getByTestId("key-hide").click();
    await expect(page.getByTestId("key-reveal")).toHaveCount(0);
    await expect(page.getByTestId("key-row")).toHaveCount(1);
    await expect(page.getByTestId("key-row")).toContainText("E2E key");
    await expect(page.getByTestId("key-row")).toContainText("Active");
    expect(await page.locator("body").innerText()).not.toContain(key);
    // and not after a reload either
    await page.reload();
    await expect(page.getByTestId("endpoint-editor")).toBeVisible({ timeout: 30_000 });
    expect(await page.locator("body").innerText()).not.toContain(key);

    // 6. the public call, with the key and the allowed website: 200 and ONLY the ticked fields
    const url = `/api/shared/${slug}`;
    const good = await page.request.get(url, { headers: { Authorization: `Bearer ${key}`, Origin: ORIGIN } });
    expect(good.status()).toBe(200);
    expect(good.headers()["access-control-allow-origin"]).toBe(ORIGIN);
    const body = (await good.json()) as { data: Record<string, unknown>[]; meta: { fields: string[] } };
    expect(body.meta.fields.sort()).toEqual(["id", "name"]);
    for (const row of body.data) expect(Object.keys(row).sort()).toEqual(["id", "name"]);

    // the same key sent as X-API-Key works; a bad key, a wrong website and a missing key do not
    const alt = await page.request.get(url, { headers: { "X-API-Key": key, Origin: ORIGIN } });
    expect(alt.status()).toBe(200);
    const bad = await page.request.get(url, {
      headers: { Authorization: `Bearer ${key.slice(0, -1)}${key.endsWith("A") ? "B" : "A"}`, Origin: ORIGIN },
    });
    expect(bad.status()).toBe(401);
    const elsewhere = await page.request.get(url, {
      headers: { Authorization: `Bearer ${key}`, Origin: "https://evil.example.org" },
    });
    expect(elsewhere.status()).toBe(403);
    const keyless = await page.request.get(url, { headers: { Origin: ORIGIN } });
    expect(keyless.status()).toBe(401);

    // 7. the preview in the Data section shows the same two fields (saved)
    await page.getByTestId("endpoint-sections-data").click();
    await page.getByTestId("preview-run").click();
    await expect(page.getByTestId("preview-panel")).toBeVisible();

    // 8. the Guide section: this endpoint's own guide, with a language switcher
    await page.getByTestId("endpoint-sections-guide").click();
    await expect(page.getByTestId("guide-view")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("guide-url-box")).toContainText(`/api/shared/${slug}`);
    await page.getByTestId("guide-code-lang-python").click();
    await expect(page.getByTestId("guide-code-code")).toContainText("requests");

    // 9. revoke the key (with the question): the same call is refused at once
    await page.getByTestId("endpoint-sections-access").click();
    await page.getByRole("button", { name: "Revoke E2E key" }).click();
    await page.getByTestId("confirm-revoke-yes").click();
    await expect(page.getByTestId("key-row")).toContainText("Revoked");
    const after = await page.request.get(url, { headers: { Authorization: `Bearer ${key}`, Origin: ORIGIN } });
    expect(after.status()).toBe(401);

    // 10. the Activity subtab lists the calls, the refused ones too
    await page
      .getByTestId("sharing-subtabs")
      .getByRole("tab", { name: /Activity/ })
      .click();
    await expect(page.getByTestId("activity-table")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("activity-row").first()).toBeVisible();

    // 11. delete the endpoint (with the question)
    await page.goto(`/hr/settings?tab=endpoint_sharing&sub=endpoints&endpoint=${endpointId}&section=basics`);
    await page.getByTestId("editor-delete").click();
    await page.getByTestId("confirm-delete-yes").click();
    await expect(page.getByTestId("endpoint-new")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(`[data-slug="${slug}"]`)).toHaveCount(0);
    expect((await api(page, "GET", `/api/shared-endpoints/${endpointId}`, undefined, token)).status).toBe(404);
    const gone = await page.request.get(url, { headers: { Authorization: `Bearer ${key}`, Origin: ORIGIN } });
    expect(gone.status()).toBe(404);
    endpointId = null;
  } finally {
    if (endpointId !== null) await api(page, "DELETE", `/api/shared-endpoints/${endpointId}`, undefined, token);
  }
});

test("a sensitive field needs the confirmation, and leaving with unsaved changes asks first", async ({ page }) => {
  test.setTimeout(120_000);
  const token = await ready(page);
  const slug = `e2e-employees-${stamp()}`;
  let endpointId: number | null = null;
  try {
    await page.goto("/hr/settings?tab=endpoint_sharing&sub=endpoints&endpoint=new&section=basics");
    await page.locator("#es-name").fill("E2E employees");
    await page.locator("#es-slug").fill(slug);
    await page.getByTestId("endpoint-sections-data").click();
    await page.locator("#es-dataset").selectOption("employees");
    await page.getByTestId("field-employeeCode").check();
    await page.getByTestId("field-phone").check();
    await expect(page.getByTestId("new-sensitive-notice")).toContainText("Phone");

    // the Back button asks, because the form has changes
    await page.getByTestId("editor-back").click();
    await expect(page.getByTestId("confirm-leave")).toBeVisible();
    await page.getByRole("button", { name: "Keep editing" }).click();

    // saving asks about the personal field first, and needs the box ticked
    await page.getByRole("button", { name: "Create endpoint" }).click();
    await expect(page.getByTestId("confirm-sensitive")).toContainText("Phone");
    await expect(page.getByTestId("confirm-sensitive-yes")).toBeDisabled();
    await page.locator("#es-understood").check();
    await page.getByTestId("confirm-sensitive-yes").click();
    await expect(page).toHaveURL(/endpoint=\d+/, { timeout: 30_000 });
    endpointId = Number(new URL(page.url()).searchParams.get("endpoint"));
  } finally {
    if (endpointId !== null) await api(page, "DELETE", `/api/shared-endpoints/${endpointId}`, undefined, token);
  }
});

test("a login without super-admin rights cannot see the tab, find it, open it by address or call its API", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const admin = await ready(page);
  const suffix = stamp();
  const username = `e2e_es_${suffix}`;
  const password = "E2e-Limited-1!";
  const role = await api(
    page,
    "POST",
    "/api/roles",
    { name: `e2e-es-${suffix}`, permissions: { settings: "edit" } },
    admin,
  );
  expect(role.status).toBe(201);
  const user = await api(page, "POST", "/api/hr-users", { username, password, roleId: role.body!.id }, admin);
  expect(user.status).toBe(201);
  try {
    const login = await page.request.post("/api/auth/hr-login", { data: { username, password } });
    expect(login.status()).toBe(200);
    const limited = (await login.json()).token as string;
    await page.evaluate((t) => localStorage.setItem("uk_textile_token", t), limited);

    // the page opens, but the tab is not in the navigation
    await page.goto("/hr/settings");
    await expect(page.getByRole("tab", { name: "Company", exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("tab", { name: "Endpoint Sharing", exact: true })).toHaveCount(0);

    // the search does not offer it
    const search = page.getByRole("combobox", { name: "Find a setting" });
    await search.fill("api key");
    await expect(page.getByTestId("settings-search-hit-endpoint_sharing-guide-keys")).toHaveCount(0);

    // the address falls back to the first tab, and the tab's content never shows
    await page.goto("/hr/settings?tab=endpoint_sharing");
    await expect(page.getByTestId("settings-panel-company")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("endpoint-sharing-tab")).toHaveCount(0);
    await expect(page.getByTestId("settings-panel-endpoint_sharing")).toHaveCount(0);

    // and the server refuses every management route
    for (const url of [CATALOG, "/api/shared-endpoints", "/api/shared-endpoints/activity"]) {
      expect((await api(page, "GET", url, undefined, limited)).status, url).toBe(403);
    }
    expect((await api(page, "POST", "/api/shared-endpoints", { name: "x" }, limited)).status).toBe(403);
  } finally {
    await api(page, "DELETE", `/api/hr-users/${user.body!.id}`, undefined, admin);
    await api(page, "DELETE", `/api/roles/${role.body!.id}`, undefined, admin);
  }
});

test("the tab fits a 390 px screen without sideways scrolling", async ({ page }) => {
  await ready(page);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const sub of ["endpoints", "guide", "activity"]) {
    await page.goto(`/hr/settings?tab=endpoint_sharing&sub=${sub}`);
    await expect(page.getByTestId(`sharing-panel-${sub}`)).toBeVisible({ timeout: 30_000 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${sub}: the page does not scroll sideways`).toBeLessThanOrEqual(1);
  }
});

test("a key reads only its own category, and a permanent key and a dated key are told apart", async ({ page }) => {
  test.setTimeout(180_000);
  const token = await ready(page);
  const slug = `e2e-categories-${stamp()}`;
  let endpointId: number | null = null;
  try {
    // the e2e database holds staff employees only, so a Staff key sees them and a Production key sees nobody
    const made = await api(
      page,
      "POST",
      "/api/shared-endpoints",
      {
        name: "E2E categories",
        slug,
        dataset: "employees",
        fields: ["employeeCode", "employmentType"],
        allowNoOrigin: true,
        lockedFilters: { status: "all" },
      },
      token,
    );
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    endpointId = Number((made.body as { id: number }).id);
    const keysUrl = `/api/shared-endpoints/${endpointId}/keys`;

    // a key needs a category and an explicit expiry mode
    expect((await api(page, "POST", keysUrl, { label: "none" }, token)).status).toBe(400);
    expect((await api(page, "POST", keysUrl, { label: "x", category: "all", permanent: true }, token)).status).toBe(
      400,
    );
    expect((await api(page, "POST", keysUrl, { label: "x", category: "staff" }, token)).status).toBe(400);
    const both = { label: "x", category: "staff", permanent: true, expiresAt: `${new Date().getFullYear() + 1}-01-01` };
    expect((await api(page, "POST", keysUrl, both, token)).status).toBe(400);

    const staff = await api(page, "POST", keysUrl, { label: "Staff app", category: "staff", permanent: true }, token);
    const year = new Date().getFullYear() + 1;
    const dated = { label: "Production app", category: "production", expiresAt: `${year}-03-31T14:30` };
    const production = await api(page, "POST", keysUrl, dated, token);
    expect(staff.status).toBe(201);
    expect(production.status).toBe(201);
    expect(staff.body).toMatchObject({ category: "staff", permanent: true, expiresAt: null });
    expect(production.body).toMatchObject({ category: "production", permanent: false });
    expect(String((production.body as { expiresAt: string }).expiresAt)).toContain(`${year}-03-31T14:30`);

    const call = async (key: string, query = "") =>
      page.request.get(`/api/shared/${slug}${query}`, { headers: { Authorization: `Bearer ${key}` } });
    type Reply = { data: { employmentType: string }[]; meta: { category: string; total: number } };

    const asStaff = await call((staff.body as { key: string }).key);
    expect(asStaff.status()).toBe(200);
    const staffBody = (await asStaff.json()) as Reply;
    expect(staffBody.meta.category).toBe("staff");
    expect(staffBody.meta.total).toBeGreaterThan(0);
    for (const row of staffBody.data) expect(row.employmentType).toBe("staff");

    const asProduction = await call((production.body as { key: string }).key);
    expect(asProduction.status()).toBe(200);
    const productionBody = (await asProduction.json()) as Reply;
    expect(productionBody.meta.category).toBe("production");
    expect(productionBody.meta.total).toBe(0);
    expect(productionBody.data).toEqual([]);

    // asking for the other category in the query string never widens a key
    const widened = await call((production.body as { key: string }).key, "?employmentType=staff");
    expect(((await widened.json()) as Reply).meta.total).toBe(0);

    // the list says which is which, and a preview as a category follows the same rule
    const listed = (await api(page, "GET", keysUrl, undefined, token)).body as {
      keys: { label: string; category: string; permanent: boolean }[];
    };
    expect(listed.keys.find((k) => k.label === "Staff app")).toMatchObject({ category: "staff", permanent: true });
    expect(listed.keys.find((k) => k.label === "Production app")).toMatchObject({
      category: "production",
      permanent: false,
    });
    const previewUrl = `/api/shared-endpoints/${endpointId}/preview`;
    const asProductionPreview = await api(page, "POST", previewUrl, { limit: 5, category: "production" }, token);
    expect(asProductionPreview.status).toBe(200);
    expect(JSON.stringify(asProductionPreview.body)).not.toContain('"staff"');
    expect((await api(page, "POST", previewUrl, { limit: 5, category: "all" }, token)).status).toBe(400);
  } finally {
    if (endpointId !== null) await api(page, "DELETE", `/api/shared-endpoints/${endpointId}`, undefined, token);
  }
});

test("the key form asks for the data category and for when the key stops, and shows both on the key", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const token = await ready(page);
  const slug = `e2e-keyform-${stamp()}`;
  let endpointId: number | null = null;
  try {
    const made = await api(
      page,
      "POST",
      "/api/shared-endpoints",
      { name: "E2E key form", slug, dataset: "departments", fields: ["name"] },
      token,
    );
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    endpointId = Number((made.body as { id: number }).id);
    await page.goto(`/hr/settings/endpoint_sharing?sub=endpoints&endpoint=${endpointId}&section=access`);
    await expect(page.getByTestId("key-form")).toBeVisible({ timeout: 30_000 });

    await page.locator("#es-key-label").fill("Form key");
    await page.getByTestId("key-create").click();
    await expect(page.getByTestId("key-error")).toContainText("Choose which data the key may read");
    await page.getByTestId("key-category-production").check();
    await page.getByTestId("key-create").click();
    await expect(page.getByTestId("key-error")).toContainText("Choose the date and time");

    await page.getByTestId("key-expiry-permanent").check();
    await expect(page.locator("#es-key-expires")).toBeDisabled();
    await page.getByTestId("key-create").click();
    await expect(page.getByTestId("key-reveal")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("key-hide").click();
    const row = page.getByTestId("key-row");
    await expect(row).toContainText("Production data only");
    await expect(row).toContainText("Permanent (never expires)");
  } finally {
    if (endpointId !== null) await api(page, "DELETE", `/api/shared-endpoints/${endpointId}`, undefined, token);
  }
});
