import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { HR_PASSWORD, HR_USERNAME } from "./helpers";

// On-Duty Geo-Tracking, the HR portal side (Geo Attendance -> Journey History, Live Map, Tracking Settings, Punch Verifications).
// Everything is made through the API the way the phone and the portal do it: an employee signs in, accepts the tracking notice,
// submits an On-Duty request (the track starts there, before any approval), and uploads a synthetic route to POST /api/tracking/batch
// (a leg, a six-minute stop, a leg, eight minutes with the location switched off, a leg). The rules of the pipeline (what is a stop or
// a gap, the units, the idempotence, the late uploads) are backend tests; this spec is the portal showing them: the list and its
// filters, one journey (summary, map, timeline, phone, export, rebuild), the Live Map, the rules card, the two photos of a punch,
// View only, and the two themes.
//
// Data: the seed's Meena (E2E003) as the employee, one role + login for View only; all removed (and the rules put back) at the end.
// The server sets the track's start when the request is submitted, and a route cannot take half an hour in a test. A position
// recorded before the track started is refused (a little slack for the phone's clock apart), so the route is uploaded with
// times in the half hour AFTER now: the server accepts up to a day ahead and only marks such points "suspect clock".

const FAKE_WACLIENT = "http://127.0.0.1:8190";
const EMPLOYEE_CODE = "E2E003";
const EMPLOYEE_NAME = "Meena Nosalary";
// The password auth.spec.ts and approval-screens.spec.ts also set for this employee: whichever spec activates the account first.
const EMPLOYEE_PASSWORD = "employee-pass-1";
const DEVICE_ID = "e2e-geo-device-1";
const DEVICE_KEY = "uk_textile_theme_device";
const DESTINATION = "E2E Tirupur buyer visit";

type Reply = { status: number; body: any };

async function api(
  request: APIRequestContext,
  token: string,
  method: string,
  url: string,
  data?: unknown,
): Promise<Reply> {
  const res = await request.fetch(url, { method, headers: { Authorization: `Bearer ${token}` }, data });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: res.status(), body };
}

async function hrToken(request: APIRequestContext): Promise<string> {
  const res = await request.post("/api/auth/hr-login", { data: { username: HR_USERNAME, password: HR_PASSWORD } });
  expect(res.status()).toBe(200);
  return (await res.json()).token as string;
}

// The employee's own token: the account is activated with the code the fake WAClient receives (as auth.spec.ts does), or simply
// signed in when it was already activated.
async function employeeToken(request: APIRequestContext): Promise<string> {
  await request.post(`${FAKE_WACLIENT}/reset`);
  const ask = await request.post("/api/auth/otp/request", {
    data: { employeeCode: EMPLOYEE_CODE, purpose: "activate" },
  });
  if (ask.status() === 200) {
    const sent = await (await request.get(`${FAKE_WACLIENT}/messages`)).json();
    const otp = sent[0].message.match(/\b(\d{6})\b/)![1];
    const activate = await request.post("/api/auth/otp/activate", {
      data: { employeeCode: EMPLOYEE_CODE, otp, password: EMPLOYEE_PASSWORD },
    });
    expect(activate.status()).toBe(200);
  } else {
    expect(ask.status()).toBe(409); // already activated
  }
  const login = await request.post("/api/auth/employee-login", {
    data: { identifier: EMPLOYEE_CODE, password: EMPLOYEE_PASSWORD },
  });
  expect(login.status()).toBe(200);
  return (await login.json()).token as string;
}

/** The phone's first call: the tracking notice must be accepted before a track records. */
async function acceptNotice(request: APIRequestContext, emp: string) {
  const state = await api(request, emp, "GET", "/api/tracking/state");
  expect(state.status, JSON.stringify(state.body)).toBe(200);
  if (state.body.consentRequired) {
    const consent = await api(request, emp, "POST", "/api/tracking/consent", {
      deviceId: DEVICE_ID,
      noticeVersion: state.body.noticeVersion,
    });
    expect(consent.status, JSON.stringify(consent.body)).toBeLessThan(300);
  }
}

type Point = Record<string, unknown>;

// The phone's counter is device-wide: every route continues it, so a second route never repeats the first one's numbers (the
// server rightly treats a repeated seq of the same device as the same row and ignores it).
let deviceSeq = 0;

/**
 * A route that starts a second from now: a 10-minute leg, a 6-minute stop, a 5-minute leg, 8 minutes with the location switched
 * off (the next position is 700 m away), a 2-minute leg. Positions every 30 s.
 */
function syntheticRoute() {
  const base = Date.now() + 1000;
  const iso = (offsetS: number) => new Date(base + offsetS * 1000).toISOString();
  const points: Point[] = [];
  const add = (offsetS: number, latitude: number, longitude: number, moving: boolean) =>
    points.push({
      seq: ++deviceSeq,
      recordedAt: iso(offsetS),
      latitude,
      longitude,
      accuracy: 8,
      speed: moving ? 5 : 0,
      bearing: 45,
      altitude: 420,
      activity: moving ? "vehicle" : "still",
      battery: 70,
      charging: false,
      network: "cell",
      provider: "gps",
      isMocked: false,
    });
  for (let t = 0; t <= 600; t += 30) add(t, 11.0 + 0.02 * (t / 600), 77.0 + 0.02 * (t / 600), true); // leg 1
  for (let t = 630, i = 0; t <= 990; t += 30, i++) add(t, 11.02 + (i % 2 ? 0.00002 : -0.00002), 77.02, false); // the stop
  for (let t = 1020; t <= 1320; t += 30)
    add(t, 11.02 + 0.02 * ((t - 1020) / 300), 77.02 + 0.02 * ((t - 1020) / 300), true); // leg 2
  for (let t = 1830; t <= 1950; t += 30) add(t, 11.045 + 0.0002 * ((t - 1830) / 30), 77.045, true); // leg 3, after the gap
  const events = [
    { seq: ++deviceSeq, kind: "GPS_OFF", startedAt: iso(1335), latitude: 11.04, longitude: 77.04 },
    { seq: ++deviceSeq, kind: "GPS_ON", startedAt: iso(1825) },
    {
      seq: ++deviceSeq,
      kind: "PERMISSION_CHANGED",
      startedAt: iso(1832),
      latitude: 11.045,
      longitude: 77.045,
      meta: { from: "always", to: "while_using" },
    },
  ];
  return { points, events };
}

const batchBody = (route: ReturnType<typeof syntheticRoute>) => ({
  deviceId: DEVICE_ID,
  app: { version: "e2e-1.0", os: "android", osVersion: "14", model: "E2E Phone" },
  health: {
    permission: "always",
    locationEnabled: true,
    backgroundRestricted: false,
    batteryOptimised: false,
    powerSave: false,
    batteryPct: 70,
    charging: false,
    network: "cell",
  },
  points: route.points,
  events: route.events,
});

// a real (1 x 1 pixel) PNG: the server checks that a photo is an image
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let hr = "";
let emp = "";
let sessionId = 0;
let trackId = 0;
let settingsBefore: Record<string, unknown> = {};
const madeUsers: { userId: number; roleId: number }[] = [];

/** Signs the browser in with a token (skipping the login screen) before the page starts. */
async function openAs(
  page: Page,
  token: string,
  path: string,
  opts: { theme?: "clean" | "default"; width?: number } = {},
) {
  await page.setViewportSize({ width: opts.width ?? 1366, height: (opts.width ?? 1366) < 500 ? 844 : 900 });
  await page.addInitScript(
    ([key, theme, t]) => {
      localStorage.setItem("uk_textile_token", t as string);
      if (theme === "clean") localStorage.setItem(key as string, "clean");
      else localStorage.removeItem(key as string);
    },
    [DEVICE_KEY, opts.theme ?? "default", token] as const,
  );
  await page.goto(path);
  // the dev server rebuilds a file now and then and the app answers with its "was just updated" screen: reload
  for (let attempt = 0; attempt < 3 && (await page.locator("h1.ss-title").count()) > 0; attempt++) await page.reload();
}

const tab = (page: Page, name: string) => page.getByRole("tab", { name: new RegExp(name, "i") }).first();
const journeyRow = (page: Page) => page.getByTestId("journey-row").filter({ hasText: DESTINATION });
const num = async (page: Page, testId: string) =>
  Number((await page.getByTestId(testId).innerText()).replace(/[^\d.]/g, ""));

/** The numbers of a flat page: sideways overflow, blur, a drop shadow outside a floating layer, a gradient. */
async function flatness(page: Page) {
  return page.evaluate(() => {
    const FLOATING =
      '[data-slot="popover-panel"],[data-slot="dropdown-content"],[data-slot="select-content"],[data-slot="dialog-content"],[data-slot="alert-dialog-content"],[data-slot="sheet-content"],[data-slot="toast"],[role="tooltip"],[data-radix-popper-content-wrapper],.leaflet-container';
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
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.right < 0) continue;
      const cs = getComputedStyle(el);
      if (cs.backdropFilter !== "none") blurred.push(name(el));
      if (hasDropShadow(cs.boxShadow) && !el.closest(FLOATING)) shadowed.push(`${name(el)} => ${cs.boxShadow}`);
      if (cs.backgroundImage.includes("gradient") && !el.closest("svg") && !el.closest(FLOATING))
        gradient.push(name(el));
    }
    return { overflow: document.documentElement.scrollWidth - window.innerWidth, blurred, shadowed, gradient };
  });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  hr = await hrToken(request);
  emp = await employeeToken(request);
  settingsBefore = (await api(request, hr, "GET", "/api/tracking/settings")).body;
  // a session left by an earlier run would answer "already in progress": finish it
  await api(request, emp, "POST", "/api/on-duty-sessions/complete");
});

test.afterAll(async ({ request }) => {
  // the rules back as they were, nothing of this spec left pending or running, the View only login removed
  await api(request, hr, "PUT", "/api/tracking/settings", {
    stopSeconds: settingsBefore.stopSeconds,
    ondutyPunchPhotos: settingsBefore.ondutyPunchPhotos,
  });
  await api(request, emp, "POST", "/api/on-duty-sessions/complete");
  const sessions = await api(request, hr, "GET", "/api/on-duty-sessions?status=pending");
  for (const s of (sessions.body ?? []).filter((x: { destination: string }) => x.destination.startsWith("E2E "))) {
    await api(request, hr, "PATCH", `/api/on-duty-sessions/${s.id}/status`, {
      status: "rejected",
      comment: "e2e cleanup",
    });
  }
  for (const { userId, roleId } of madeUsers) {
    await api(request, hr, "DELETE", `/api/hr-users/${userId}`);
    await api(request, hr, "DELETE", `/api/roles/${roleId}`);
  }
});

test("submitting an On-Duty request starts a track at once, before any approval, and the route is stored", async ({
  request,
}) => {
  await acceptNotice(request, emp);
  const asked = await api(request, emp, "POST", "/api/on-duty-sessions/request", { destination: DESTINATION });
  expect(asked.status, JSON.stringify(asked.body)).toBe(201);
  sessionId = asked.body.sessionId;

  const live = await api(request, hr, "GET", "/api/tracking/journeys?status=active");
  expect(live.status).toBe(200);
  const mine = live.body.results.find((j: { sessionId: number }) => j.sessionId === sessionId);
  expect(mine, "the track exists as soon as the request is submitted").toBeTruthy();
  trackId = mine.id;
  expect(mine.status).toBe("active");
  expect(mine.approvalStatus).toMatch(/pending/);

  const route = syntheticRoute();
  const sent = await api(request, emp, "POST", "/api/tracking/batch", batchBody(route));
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  expect(sent.body).toMatchObject({ ok: true, rejected: 0, trackActive: true });
  expect(sent.body.accepted).toBeGreaterThanOrEqual(route.points.length);
  // resending the same batch is harmless: nothing is stored twice
  const again = await api(request, emp, "POST", "/api/tracking/batch", batchBody(route));
  expect(again.body.duplicates).toBeGreaterThanOrEqual(route.points.length);
  expect(again.body.accepted).toBe(0);

  // the journey is recomputed from the raw points (the pipeline also does it by itself, a little later)
  const rebuilt = await api(request, hr, "POST", `/api/tracking/journeys/${trackId}/rebuild`);
  expect(rebuilt.status, JSON.stringify(rebuilt.body)).toBeLessThan(300);
  const detail = await api(request, hr, "GET", `/api/tracking/journeys/${trackId}`);
  const segments = detail.body.segments as { kind: string; durationS: number; cause?: string }[];
  expect(
    segments.some((s) => s.kind === "stop" && s.durationS >= 300),
    "a stop of about six minutes",
  ).toBe(true);
  expect(
    segments.some((s) => s.kind === "gap" && s.cause === "gps_off"),
    "a gap caused by the location being off",
  ).toBe(true);
  expect(detail.body.summary.distanceM).toBeGreaterThan(4000);
});

test("Journey History lists the journey with its figures, a Live badge and its approval, and filters it", async ({
  page,
}) => {
  await openAs(page, hr, "/hr/geo-attendance");
  await tab(page, "Journey History").click();
  await expect(page).toHaveURL(/tab=journeys/);
  const row = journeyRow(page);
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(EMPLOYEE_NAME);
  await expect(row.getByTestId("live-badge")).toBeVisible();
  await expect(row.getByTestId("approval-chip")).toContainText(/Awaiting|pending/i);
  await expect(row).toContainText(/\d+(\.\d+)? (km|m)/); // distance
  await expect(page.getByTestId("journey-list")).toContainText("Times are India time (IST)");

  // status: only ended journeys, then only active ones
  await page.locator("#journey-status").selectOption("ended");
  await expect(journeyRow(page)).toHaveCount(0);
  await expect(page.getByTestId("journey-empty")).toBeVisible();
  await page.locator("#journey-status").selectOption("active");
  await expect(journeyRow(page)).toHaveCount(1);

  // employee: search by name, choose, and a chip with the choice
  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.getByTestId("employee-filter-input").fill("Meena");
  await page.getByTestId("employee-filter-options").getByRole("button", { name: /Meena/ }).click();
  await expect(page.getByTestId("employee-filter-chosen")).toContainText("Meena Nosalary");
  await expect(journeyRow(page)).toHaveCount(1);
  await page.getByLabel("Clear the employee filter").click();

  // a range that ends before it starts is refused in words
  await page.locator("#journey-from").fill("2030-01-02");
  await page.locator("#journey-to").fill("2030-01-01");
  await expect(page.getByTestId("range-error")).toContainText('"From" date is after the "To" date');
});

test("one journey: summary, map with a route, a stop, a gap and events, the timeline, the phone", async ({ page }) => {
  await openAs(page, hr, `/hr/geo-attendance?tab=journeys&journey=${trackId}`);
  const detail = page.getByTestId("journey-detail");
  await expect(detail).toContainText(EMPLOYEE_NAME);
  await expect(detail).toContainText(`"${DESTINATION}"`);
  await expect(page.getByTestId("live-badge")).toBeVisible();
  await expect(page.getByTestId("live-note")).toContainText("every 30 seconds");

  // summary
  expect(await num(page, "card-distance-value")).toBeGreaterThan(0);
  expect(await num(page, "card-stops-value")).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId("card-gap-value")).not.toHaveText("0 s");
  expect(await num(page, "card-points-value")).toBeGreaterThan(40);
  expect(await num(page, "card-events-value")).toBeGreaterThanOrEqual(3);

  // the journey as a story: it starts with "Journey started", has a break with its place and length, and (still live) ends "On duty now"
  const story = page.getByTestId("activity-timeline");
  await expect(story.locator('[data-testid="activity-item"]').first()).toContainText("Journey started");
  await expect(story.locator('[data-testid="activity-item"][data-kind="break"]').first()).toContainText("Break taken");
  await expect(story.locator('[data-testid="activity-item"]').last()).toContainText("On duty now");
  await expect(page.getByTestId("stat-breaks")).toContainText("1");
  await story.locator('[data-testid="activity-head"]').nth(1).click();
  await expect(story.getByTestId("activity-details").first()).toBeVisible();

  // the map: a real Leaflet map with the route solid, the gap dashed, a numbered stop pin and an event pin
  const map = page.getByTestId("journey-map-canvas");
  await expect(map.locator(".leaflet-container")).toBeVisible();
  expect(await map.locator("path.leaflet-interactive").count()).toBeGreaterThanOrEqual(2);
  expect(await map.locator('path[stroke-dasharray="4 8"]').count(), "the gap is dashed").toBeGreaterThanOrEqual(1);
  expect(await map.locator('[data-pin="stop"]').count()).toBeGreaterThanOrEqual(1);
  expect(await map.locator('[data-pin="event"]').count()).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId("map-legend")).toContainText("Gap (no location)");

  // the timeline: a stop as "Stationary" with its length and a waiting chip, the gap with its cause, the events
  const stop = page.locator('[data-testid="timeline-row"][data-type="stop"]').first();
  await expect(stop).toContainText("Stationary");
  await expect(stop.getByTestId("stop-kind")).toHaveText("waiting");
  await expect(stop).toContainText(/[3-9] min/);
  const gap = page.locator('[data-testid="timeline-row"][data-type="gap"]').first();
  await expect(gap).toContainText("Location services were off");
  await expect(
    page.locator('[data-testid="timeline-row"][data-type="event"]').filter({ hasText: "Location services turned off" }),
  ).toHaveCount(1);
  await expect(page.locator('[data-testid="timeline-row"]').filter({ hasText: "Always to While using" })).toHaveCount(
    1,
  );

  // picking a row highlights it on the map
  const travel = page.locator('[data-testid="timeline-row"][data-type="travel"]').first();
  await travel.click();
  await expect(travel).toHaveAttribute("data-selected", "true");
  await expect(map.locator('path[stroke-width="8"]')).toHaveCount(1);
  await stop.click();
  await expect(stop).toHaveAttribute("data-selected", "true");
  await expect(map.locator('path[stroke-width="8"]')).toHaveCount(0);

  // the timeline can be narrowed
  await page.getByTestId("timeline-show-gap").click();
  await expect(page.locator('[data-testid="timeline-row"][data-type="gap"]').first()).toBeVisible();
  await expect(page.locator('[data-testid="timeline-row"]:not([data-type="gap"])')).toHaveCount(0);
  await page.getByTestId("timeline-show-all").click();

  // the phone that uploaded
  const device = page.getByTestId("device-card");
  await expect(device).toContainText("E2E Phone");
  await expect(device).toContainText("e2e-1.0");
  await expect(device).toContainText("Allow all the time");
});

test("the journey map has a layer switch: street map first, satellite and satellite with names on request, and the pick is remembered", async ({
  page,
}) => {
  // the tile servers are never really called: any tile is answered with a 1 x 1 picture, and the requests are counted
  const onePixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
  const asked = { street: 0, satellite: 0, names: 0 };
  await page.route(/tile\.openstreetmap\.org/, (route) => {
    asked.street++;
    return route.fulfill({ status: 200, contentType: "image/png", body: onePixel });
  });
  await page.route(/server\.arcgisonline\.com/, (route) => {
    asked.satellite++;
    if (/\/Reference\//.test(route.request().url())) asked.names++;
    return route.fulfill({ status: 200, contentType: "image/png", body: onePixel });
  });

  await openAs(page, hr, `/hr/geo-attendance?tab=journeys&journey=${trackId}`);
  const map = page.getByTestId("journey-map-canvas");
  await expect(map.locator(".leaflet-container")).toBeVisible();

  // the street map is on, the satellite view has not been asked for
  const street = map.locator('img.leaflet-tile[src*="openstreetmap.org"]');
  const satellite = map.locator('img.leaflet-tile[src*="World_Imagery"]');
  await expect(street.first()).toBeAttached();
  expect(await satellite.count()).toBe(0);
  expect(asked.satellite).toBe(0);
  await expect(map.locator(".leaflet-control-attribution")).toContainText("OpenStreetMap");

  // open the switch (a hover on a mouse, a tap on a phone) and pick the satellite view
  const control = map.locator(".leaflet-control-layers");
  await control.hover();
  const options = control.locator("label");
  await expect(options).toHaveText([/Street map/, /^\s*Satellite\s*$/, /Satellite \+ names/]);
  await expect(control.locator("input").first()).toBeChecked();
  await options.filter({ hasText: /^\s*Satellite\s*$/ }).click();

  await expect(satellite.first()).toBeAttached();
  await expect(street).toHaveCount(0);
  await expect(map.locator(".leaflet-control-attribution")).toContainText("Esri");
  // the route and the pins stay on top of the new base map
  expect(await map.locator("path.leaflet-interactive").count()).toBeGreaterThanOrEqual(2);
  expect(await map.locator('[data-pin="stop"]').count()).toBeGreaterThanOrEqual(1);
  expect(asked.satellite).toBeGreaterThan(0);
  expect(asked.names, "plain satellite writes no names").toBe(0);

  // the satellite view with names: the same imagery, with road and area names asked for on top
  await control.hover();
  await options.filter({ hasText: "Satellite + names" }).click();
  await expect(satellite.first()).toBeAttached();
  await expect.poll(() => asked.names, { message: "road / area name tiles were asked for" }).toBeGreaterThan(0);
  await expect(map.locator('img.leaflet-tile[src*="/Reference/"]').first()).toBeAttached();
  await expect(street).toHaveCount(0);

  // the next map opens on the satellite view: the pick was remembered in this browser
  await page.reload();
  await expect(map.locator(".leaflet-container")).toBeVisible();
  await expect(satellite.first()).toBeAttached();
  await expect(street).toHaveCount(0);

  // and back to the street map
  await map.locator(".leaflet-control-layers").hover();
  await map.locator(".leaflet-control-layers label").filter({ hasText: "Street map" }).click();
  await expect(street.first()).toBeAttached();
  await expect(satellite).toHaveCount(0);
});

test("the journey map shows every recorded position: pick a dot, a stop and a gap for their details, Google Maps links and Google's view", async ({
  page,
}) => {
  // Google is never really called: its embed gets a stub page, and the requests are counted
  const google = { asked: 0 };
  await page.route(/google\.com\/maps\?/, (route) => {
    google.asked++;
    return route.fulfill({ status: 200, contentType: "text/html", body: "<p>stub of Google Maps</p>" });
  });

  await openAs(page, hr, `/hr/geo-attendance?tab=journeys&journey=${trackId}`);
  const map = page.getByTestId("journey-map-canvas");
  await expect(map.locator(".leaflet-container")).toBeVisible();
  await expect(page.locator('[data-testid="trail-controls"][data-trail="ready"]')).toBeVisible();

  // every stored position is counted, and the complete route is drawn as thin lines under the travel
  expect(await num(page, "trail-count")).toBeGreaterThan(40);
  await expect(page.getByTestId("trail-count")).toContainText("positions recorded");
  await expect(map.locator('path[stroke="#1e3a8a"]').first()).toBeAttached();

  // the whole map must be on screen: the browser scrolls a half-hidden map into view on mouse-down, which would move the dot from under the pointer
  await map.scrollIntoViewIfNeeded();
  // the dots are drawn on one canvas: find a travelling position (filled with the travel colour) inside the visible map, not under a pin
  const dotSpot = () =>
    map.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
      const { width, height } = canvas;
      const rect = canvas.getBoundingClientRect();
      const view = canvas.closest(".leaflet-container")!.getBoundingClientRect();
      const data = canvas.getContext("2d")!.getImageData(0, 0, width, height).data;
      const ratio = width / rect.width;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          if (data[i] === 0 && data[i + 1] === 100 && data[i + 2] === 150 && data[i + 3] === 255) {
            const at = { x: rect.left + x / ratio, y: rect.top + y / ratio };
            // the canvas is wider than the map (padding): only a dot that can really be clicked counts
            const inside =
              at.x > view.left + 50 && at.x < view.right - 50 && at.y > view.top + 50 && at.y < view.bottom - 50;
            const top = document.elementFromPoint(at.x, at.y);
            const covered = !top || top.closest(".leaflet-marker-icon, .leaflet-popup, .leaflet-control") !== null;
            if (inside && !covered) return at;
          }
        }
      }
      return null;
    });
  // the map is still moving into place when the first dot appears: take the spot once it has stopped moving
  const settledSpot = async () => {
    const first = await dotSpot();
    if (!first) return null;
    await page.waitForTimeout(700);
    const second = await dotSpot();
    return second && Math.abs(second.x - first.x) < 1 && Math.abs(second.y - first.y) < 1 ? second : null;
  };
  await expect.poll(settledSpot, { timeout: 20_000, message: "a recorded position on the map" }).not.toBeNull();
  const spot = (await settledSpot())!;
  await page.mouse.click(spot.x, spot.y);
  const place = page.getByTestId("place-details");
  // picking something moves the map to it: fit the whole route again before reaching for a pin
  const pickFirstStop = async () => {
    await page.waitForTimeout(900); // Leaflet ignores a new zoom while it is still animating the last one (picking something zooms to it)
    await page.getByTestId("journey-fit").click();
    // the whole map on screen (a pin below the fold cannot be pressed: scrolling a pin into view scrolls the map, not the page)
    await map.scrollIntoViewIfNeeded();
    await page.waitForTimeout(900); // the map animates to the whole route: a pin pressed while it moves is no longer under the pointer when the button comes up
    await map.locator('[data-pin="stop"]').first().click();
  };
  await expect(place).toHaveAttribute("data-kind", "picked");
  await expect(page.getByTestId("place-heading")).toHaveText("Recorded position");
  await expect(page.getByTestId("place-facts")).toContainText("Accuracy");
  await expect(page.getByTestId("place-facts")).toContainText("Battery");
  await expect(map.locator(".leaflet-popup")).toContainText("Recorded position");
  await expect(place.getByTestId("open-google-maps")).toHaveAttribute(
    "href",
    /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=-?\d+\.\d{6},-?\d+\.\d{6}$/,
  );

  // a stop: its pin opens the same panel with its times and the links
  await pickFirstStop();
  await expect(page.getByTestId("place-heading")).toContainText("Stop 1");
  await expect(page.getByTestId("place-facts")).toContainText("Stayed");
  await expect(place.getByTestId("google-directions")).toHaveAttribute(
    "href",
    /google\.com\/maps\/dir\/\?api=1&destination=/,
  );

  // a gap: the two ends of the dashed line, each with its links
  await page.locator('[data-testid="timeline-row"][data-type="gap"]').first().click();
  await expect(page.getByTestId("place-heading")).toHaveText("Gap (no location)");
  expect(await place.getByTestId("place-end").count()).toBeGreaterThanOrEqual(1);

  // Google's own map of the picked place: nothing is asked from Google until it is turned on
  await pickFirstStop();
  expect(google.asked).toBe(0);
  await expect(page.getByTestId("google-view-frame")).toHaveCount(0);
  await page.getByTestId("google-view-toggle").click();
  await expect(page.getByTestId("google-view-frame")).toHaveAttribute(
    "src",
    /google\.com\/maps\?q=-?\d+\.\d{6},-?\d+\.\d{6}&z=18&output=embed/,
  );
  await expect.poll(() => google.asked).toBeGreaterThan(0);
  await page.getByTestId("google-view-toggle").click();
  await expect(page.getByTestId("google-view-frame")).toHaveCount(0);

  // the dots can be switched off, and then nothing is left on the canvas to click
  await page.getByTestId("trail-show-points").uncheck();
  await expect.poll(dotSpot, { timeout: 10_000 }).toBeNull();
});

test("Export downloads the workbook and Rebuild asks first", async ({ page }) => {
  await openAs(page, hr, `/hr/geo-attendance?tab=journeys&journey=${trackId}`);
  await expect(page.getByTestId("journey-detail")).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("journey-export").click()]);
  expect(download.suggestedFilename()).toMatch(/\.(xlsx|csv)$/);

  await page.getByTestId("journey-rebuild").click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Rebuild this journey?");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByTestId("journey-rebuild").click();
  await page.getByRole("button", { name: "Rebuild journey" }).click();
  await expect(page.getByText("Journey rebuilt", { exact: true })).toBeVisible();
  await expect(page.getByTestId("journey-detail")).toBeVisible();
  // the figures are still there after the recompute
  expect(await num(page, "card-stops-value")).toBeGreaterThanOrEqual(1);
});

test("the Live Map lists the active track with its state and approval, and Open journey leads to it", async ({
  page,
}) => {
  await openAs(page, hr, "/hr/geo-attendance?tab=map");
  const row = page.getByTestId("live-track").filter({ hasText: EMPLOYEE_NAME });
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("live-state")).toHaveText(
    /Moving|Stationary|Offline|Location off|Waiting for first location/,
  );
  await expect(row.getByTestId("live-approval")).toContainText(/Awaiting|pending/i);
  await expect(row.getByTestId("live-last-seen")).toContainText("Last seen");
  await expect(row.getByTestId("live-battery")).toContainText("70%");
  await expect(row.getByTestId("live-since")).toContainText("tracking since");
  await expect(page.getByTestId("live-tracks")).toContainText("On-Duty tracks");
  // the old board is still there
  await expect(page.getByText("Tracking-Enabled Employees")).toBeVisible();
  // the pin is on the map
  await expect(page.locator('.leaflet-marker-icon [data-pin="person"]').first()).toBeVisible();

  await row.getByTestId("open-journey").click();
  await expect(page).toHaveURL(new RegExp(`tab=journeys&journey=${trackId}`));
  await expect(page.getByTestId("journey-detail")).toContainText(EMPLOYEE_NAME);
});

test("the employee marks the duty Done: the journey ends with that reason and can be found by it", async ({
  page,
  request,
}) => {
  const done = await api(request, emp, "POST", "/api/on-duty-sessions/complete");
  expect(done.status, JSON.stringify(done.body)).toBeLessThan(300);

  await openAs(page, hr, "/hr/geo-attendance?tab=journeys");
  const row = journeyRow(page);
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("live-badge")).toHaveCount(0);
  await expect(row).toContainText("Marked done by the employee");
  await page.locator("#journey-reason").selectOption("manual");
  await expect(journeyRow(page)).toHaveCount(1);
  await page.locator("#journey-reason").selectOption("rejected");
  await expect(journeyRow(page)).toHaveCount(0);
  await page.locator("#journey-reason").selectOption("");

  await row.click();
  await expect(page.getByTestId("journey-times")).toContainText("Marked done by the employee");
  await expect(page.getByTestId("live-badge")).toHaveCount(0);
  // everything recorded is kept
  expect(await num(page, "card-points-value")).toBeGreaterThan(40);
});

test("a rejected request stops tracking, keeps what was recorded, and the employee can start again", async ({
  page,
  request,
}) => {
  await acceptNotice(request, emp);
  const asked = await api(request, emp, "POST", "/api/on-duty-sessions/request", {
    destination: "E2E Rejected errand",
  });
  expect(asked.status, JSON.stringify(asked.body)).toBe(201);
  const route = syntheticRoute();
  const first = { ...batchBody(route), points: route.points.slice(0, 6), events: [] };
  expect((await api(request, emp, "POST", "/api/tracking/batch", first)).body.trackActive).toBe(true);

  const rejected = await api(request, hr, "PATCH", `/api/on-duty-sessions/${asked.body.sessionId}/status`, {
    status: "rejected",
    comment: "not needed",
  });
  expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);

  const state = await api(request, emp, "GET", "/api/tracking/state");
  expect(state.body.active).toBe(false);
  const journeys = await api(request, hr, "GET", "/api/tracking/journeys?endReason=rejected");
  const mine = journeys.body.results.find((j: { sessionId: number }) => j.sessionId === asked.body.sessionId);
  expect(mine).toMatchObject({ status: "ended", endReason: "rejected" });
  expect(mine.pointsCount).toBe(6); // the points recorded until then are kept

  await openAs(page, hr, `/hr/geo-attendance?tab=journeys&journey=${mine.id}`);
  await expect(page.getByTestId("rejected-note")).toContainText("tracking stopped");
  await expect(page.getByTestId("journey-times")).toContainText("Request rejected");
  await page.getByTestId("journey-back").click();
  await page.locator("#journey-reason").selectOption("rejected");
  await expect(page.getByTestId("journey-row").filter({ hasText: "E2E Rejected errand" })).toHaveCount(1);
  await expect(page.getByTestId("journey-row").filter({ hasText: DESTINATION })).toHaveCount(0);

  // after it ended, a new request is accepted
  const again = await api(request, emp, "POST", "/api/on-duty-sessions/request", { destination: "E2E Photos errand" });
  expect(again.status, JSON.stringify(again.body)).toBe(201);
  sessionId = again.body.sessionId;
});

test("Punch Verifications shows both photos of a punch, each labelled, and enlarges one", async ({ page, request }) => {
  // two photos in one punch (the rule is still one photo: the second is kept when it is sent)
  const punch = await request.post("/api/on-duty-sessions/punch", {
    headers: { Authorization: `Bearer ${emp}` },
    multipart: {
      latitude: "11.02",
      longitude: "77.02",
      accuracy: "9",
      isMocked: "false",
      punchNumber: "1",
      photo: { name: "photo1.png", mimeType: "image/png", buffer: PNG },
      photo2: { name: "photo2.png", mimeType: "image/png", buffer: PNG },
    },
  });
  expect(punch.status(), await punch.text()).toBeLessThan(300);

  await openAs(page, hr, "/hr/geo-attendance?tab=verifications");
  await expect(tab(page, "Punch Verifications")).toHaveAttribute("aria-selected", "true");
  const photos = page.getByRole("button", { name: "Photos (2)" });
  await expect(photos).toHaveCount(1);
  await photos.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("punch-photo")).toHaveCount(2);
  await expect(dialog.getByText("Photo 1", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Photo 2", { exact: true })).toBeVisible();
  // both images really loaded from the server (with the person's token)
  await expect
    .poll(() =>
      dialog.locator("img").evaluateAll((imgs) => imgs.filter((i) => (i as HTMLImageElement).naturalWidth > 0).length),
    )
    .toBe(2);
  // a click enlarges one
  await dialog.getByLabel("Enlarge Photo 2").click();
  await expect(dialog.getByTestId("punch-photo")).toHaveCount(1);
  await dialog.getByTestId("photos-back").click();
  await expect(dialog.getByTestId("punch-photo")).toHaveCount(2);
});

test("Tracking Settings: the geo-tracking rules are read, checked in words and saved (only what changed)", async ({
  page,
  request,
}) => {
  await openAs(page, hr, "/hr/geo-attendance?tab=tracking");
  const card = page.getByTestId("rules-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Geo-tracking rules");
  await expect(page.locator("#rule-day-end")).toHaveValue(String(settingsBefore.dayEndTime).slice(0, 5));
  await expect(page.getByTestId("photos-rollout-note")).toContainText("only after everybody has the new app");
  await expect(page.getByTestId("geocoder-privacy")).toContainText("coordinates");

  // a value outside its range is refused in words and cannot be saved
  await page.locator("#rule-stop-minutes").fill("0");
  await expect(card.getByRole("alert").first()).toContainText("must be between 1 and 60 minutes");
  await expect(page.getByRole("button", { name: "Save tracking rules" })).toBeDisabled();

  // a valid change saves, and the server holds it in seconds
  await page.locator("#rule-stop-minutes").fill("4");
  await expect(page.getByTestId("save-bar")).toHaveAttribute("data-dirty", "true");
  await page.getByRole("button", { name: "Save tracking rules" }).click();
  await expect(page.getByText("Tracking rules saved", { exact: true })).toBeVisible();
  await expect(page.getByTestId("save-bar")).toHaveAttribute("data-dirty", "false");
  const saved = await api(request, hr, "GET", "/api/tracking/settings");
  expect(saved.body.stopSeconds).toBe(240);
  expect(saved.body.stopRadiusM).toBe(settingsBefore.stopRadiusM); // untouched

  // and back
  await page.locator("#rule-stop-minutes").fill(String(Number(settingsBefore.stopSeconds) / 60));
  await page.getByRole("button", { name: "Save tracking rules" }).click();
  await expect(page.getByTestId("save-bar")).toHaveAttribute("data-dirty", "false");
  expect((await api(request, hr, "GET", "/api/tracking/settings")).body.stopSeconds).toBe(settingsBefore.stopSeconds);
});

test("a role with View only reads journeys, exports and reads the rules, but cannot rebuild or change them", async ({
  page,
  request,
}) => {
  const stamp = Date.now().toString(36);
  const role = await api(request, hr, "POST", "/api/roles", {
    name: `e2e-geo-viewer-${stamp}`,
    permissions: { geo_attendance: "view", "settings.attendance": "view" },
  });
  expect(role.status, JSON.stringify(role.body)).toBe(201);
  const username = `e2e_geo_${stamp}`;
  const password = "E2e-Limited-1!";
  const user = await api(request, hr, "POST", "/api/hr-users", { username, password, roleId: role.body.id });
  expect(user.status, JSON.stringify(user.body)).toBe(201);
  madeUsers.push({ userId: user.body.id, roleId: role.body.id });
  const login = await request.post("/api/auth/hr-login", { data: { username, password } });
  expect(login.status()).toBe(200);
  const viewer = (await login.json()).token as string;

  // the API: reading is allowed, changing is not
  expect((await api(request, viewer, "GET", "/api/tracking/journeys")).status).toBe(200);
  expect((await api(request, viewer, "PUT", "/api/tracking/settings", { stopSeconds: 200 })).status).toBe(403);
  expect((await api(request, viewer, "POST", `/api/tracking/journeys/${trackId}/rebuild`)).status).toBe(403);

  // the page: the journey and its export are there, Rebuild is not
  await openAs(page, viewer, `/hr/geo-attendance?tab=journeys&journey=${trackId}`);
  await expect(page.getByTestId("journey-detail")).toBeVisible();
  await expect(page.getByTestId("journey-rebuild")).toHaveCount(0);
  await expect(page.getByTestId("journey-export")).toBeEnabled();

  // the rules: readable, not editable
  await page.goto("/hr/geo-attendance?tab=tracking");
  await expect(page.getByTestId("rules-view-only")).toBeVisible();
  await expect(page.locator("#rule-stop-minutes")).toBeDisabled();
  await expect(page.getByTestId("save-bar")).toHaveCount(0);
});

for (const theme of ["default", "clean"] as const) {
  for (const width of [1366, 390] as const) {
    test(`Journey History is flat and fits the screen: ${theme} theme at ${width}px`, async ({ page }) => {
      await openAs(page, hr, "/hr/geo-attendance?tab=journeys", { theme, width });
      await expect(page.getByTestId("journey-row").first()).toBeVisible();
      if (theme === "clean") expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("clean");
      const list = await flatness(page);
      expect(list.overflow, `the list sticks out sideways at ${width}px`).toBeLessThanOrEqual(1);

      await page.getByTestId("journey-row").first().click();
      await expect(page.getByTestId("journey-detail")).toBeVisible();
      await expect(page.getByTestId("journey-map-canvas").locator(".leaflet-container")).toBeVisible();
      await page.waitForTimeout(500);
      const detail = await flatness(page);
      expect(detail.overflow, `the journey sticks out sideways at ${width}px`).toBeLessThanOrEqual(1);
      if (theme === "clean") {
        for (const [where, f] of [
          ["list", list],
          ["journey", detail],
        ] as const) {
          expect(f.blurred, `${where} has a backdrop blur`).toEqual([]);
          expect(f.shadowed, `${where} has a drop shadow`).toEqual([]);
          expect(f.gradient, `${where} has a gradient`).toEqual([]);
        }
      }
    });
  }
}
