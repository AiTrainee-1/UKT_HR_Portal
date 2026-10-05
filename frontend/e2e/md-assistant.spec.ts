import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { HR_PASSWORD, HR_USERNAME } from "./helpers";

// The Managing Director's identity (made from Account Management) and the MD's AI assistant, end to end: the REAL backend
// (tools, privacy, explanation, read-only database) against the e2e database, with Google's Gemini replaced by a local
// script (e2e/fake-gemini.mjs) so nothing leaves the machine. Everything made here is called md_* and is removed again.
//
// The server throttles sign-ins (10 a minute), so each role signs in ONCE and every test starts from that token.

const FAKE = "http://127.0.0.1:8191";
const MD_PASSWORD = "Passw0rd!md";

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

type Account = { id: number; username: string; isMd?: boolean };
const accounts = async (request: APIRequestContext) =>
  (await api(request, adminToken, "GET", "/api/hr-users")).body as Account[];

async function cleanUp(request: APIRequestContext) {
  for (const u of (await accounts(request)).filter((u) => u.username.startsWith("md_"))) {
    await api(request, adminToken, "DELETE", `/api/hr-users/${u.id}`);
  }
}

async function makeMd(request: APIRequestContext, username = "md_sir") {
  const res = await api(request, adminToken, "POST", "/api/hr-users", {
    username,
    password: MD_PASSWORD,
    fullName: "Murugan Raj",
    isMd: true,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as Account;
}

/** Open the app already signed in with this token (no sign-in, so no throttle). */
async function startAs(page: Page, token: string, path: string) {
  await page.addInitScript((t) => localStorage.setItem("uk_textile_token", t), token);
  await goto(page, path);
}

/** page.goto, retried when the dev server's hot reload aborts the navigation (it reloads the page when files change). */
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

// the page renders both a table and phone cards: scope to the table (as the other Account Management specs do)
const row = (page: Page, username: string) => page.getByTestId("accounts-table").getByTestId(`account-row-${username}`);

const geminiRequests = async (request: APIRequestContext) =>
  (await (await request.get(`${FAKE}/requests`)).json()) as { model: string; key: string | null; body: any }[];

async function ask(page: Page, question: string) {
  await page.getByTestId("assistant-input").fill(question);
  await page.getByTestId("assistant-send").click();
}

async function openAssistant(page: Page) {
  await page.getByTestId("assistant-launcher").click();
  await expect(page.getByTestId("assistant-panel")).toHaveAttribute("data-open", "true");
}

const lastReply = (page: Page) => page.getByTestId("assistant-reply").last();

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  adminToken = await signIn(request, HR_USERNAME, HR_PASSWORD);
  await cleanUp(request);
  // The assistant paces itself at 8 requests a minute (the free tier's limit). These tests ask a question every few
  // seconds, so the pacing would make later ones wait; the pacing itself is the engine tests' job.
  await api(request, adminToken, "PUT", "/api/hr-users/md-assistant", { requestsPerMinute: 60 });
});

test.afterAll(async ({ request }) => {
  await api(request, adminToken, "PUT", "/api/hr-users/md-assistant", { requestsPerMinute: 8 });
  await cleanUp(request);
});

test.beforeEach(async ({ request }) => {
  await request.post(`${FAKE}/reset`);
});

// ─── the identity ────────────────────────────────────────────────────────────────────────────────────────────────

test.describe("the Managing Director identity", () => {
  test.afterEach(async ({ request }) => {
    await cleanUp(request);
  });

  test("the super admin creates the MD from Account Management, and moving the identity needs a confirmation", async ({
    page,
    request,
  }) => {
    await startAs(page, adminToken, "/hr/account-management");
    await page.getByTestId("create-account").click();
    await page.getByTestId("acct-username").fill("md_sir");
    await page.getByTestId("acct-fullname").fill("Murugan Raj");
    await page.getByTestId("acct-password").fill(MD_PASSWORD);
    await page.getByTestId("acct-md").click();
    await expect(page.getByTestId("acct-md")).toHaveAttribute("aria-checked", "true");
    await page.getByTestId("acct-save").click();

    await expect(row(page, "md_sir").getByTestId("md-chip")).toBeVisible();
    await expect(row(page, "md_sir")).toContainText("MD portal only");
    expect((await accounts(request)).filter((a) => a.isMd).map((a) => a.username)).toEqual(["md_sir"]);

    // a second account asked to be the MD: nothing changes until the replacement is confirmed
    await api(request, adminToken, "POST", "/api/hr-users", { username: "md_other", password: MD_PASSWORD });
    await page.reload();
    await row(page, "md_other").getByTestId("account-edit-md_other").click();
    await page.getByTestId("acct-md").click();
    await expect(page.getByTestId("acct-md-replace")).toContainText("Murugan Raj");
    await page.getByTestId("acct-save").click();
    expect((await accounts(request)).filter((a) => a.isMd).map((a) => a.username)).toEqual(["md_sir"]);

    await page.getByTestId("acct-md-replace-check").check();
    await page.getByTestId("acct-save").click();
    await expect(row(page, "md_other").getByTestId("md-chip")).toBeVisible();
    await expect(row(page, "md_sir").getByTestId("md-chip")).toHaveCount(0);
    expect((await accounts(request)).filter((a) => a.isMd).map((a) => a.username)).toEqual(["md_other"]);

    // the MD profile tab names the current MD and can take the identity away again
    await page.getByRole("tab", { name: /MD profile/ }).click();
    await expect(page.getByTestId("md-current")).toContainText("md_other");
    await page.getByTestId("md-remove").click();
    await expect(page.getByTestId("md-none")).toBeVisible();
    expect((await accounts(request)).filter((a) => a.isMd)).toEqual([]);
  });

  test("an administrator cannot be the MD, and only the MD reaches the MD portal", async ({
    page,
    request,
    browser,
  }) => {
    const md = await makeMd(request);
    expect(md.isMd).toBe(true);

    // the administrator is refused by the API and sent back to the HR portal by the page
    expect((await api(request, adminToken, "GET", "/api/md/me")).status).toBe(403);
    expect((await api(request, adminToken, "GET", "/api/md/assistant/status")).status).toBe(403);
    await startAs(page, adminToken, "/md/dashboard");
    await expect(page).toHaveURL(/\/hr\/dashboard/);
    await goto(page, "/hr/account-management");
    await row(page, "e2e_admin").getByTestId("account-edit-e2e_admin").click();
    await expect(page.getByTestId("acct-md")).toBeDisabled();

    // the MD signs in at the usual page, lands on the MD portal and sees the MD's pages in the MD's own sidebar
    const context = await browser.newContext();
    const mdPage = await context.newPage();
    await goto(mdPage, "/hr-login");
    await mdPage.getByTestId("input-username").fill("md_sir");
    await mdPage.getByTestId("input-password").fill(MD_PASSWORD);
    await mdPage.getByTestId("button-submit").click();
    await expect(mdPage).toHaveURL(/\/md\/dashboard/);
    await expect(mdPage.getByTestId("md-identity")).toContainText("Managing Director");
    for (const id of [
      "dashboard",
      "attendance",
      "employees",
      "visitors",
      "tea-break",
      "payroll",
      "reports",
      "recruitment",
      "activity",
    ]) {
      await expect(mdPage.getByTestId(`md-nav-${id}`)).toBeVisible();
    }
    await expect(mdPage.getByText("Account Management")).toHaveCount(0);

    // taking the identity away closes the door on the very next request
    const token = (await mdPage.evaluate(() => localStorage.getItem("uk_textile_token")))!;
    expect((await api(request, token, "GET", "/api/md/me")).status).toBe(200);
    await api(request, adminToken, "PUT", `/api/hr-users/${md.id}`, { isMd: false });
    expect((await api(request, token, "GET", "/api/md/me")).status).toBe(403);
    await context.close();
  });
});

// ─── the assistant ───────────────────────────────────────────────────────────────────────────────────────────────

test.describe("the AI assistant", () => {
  test.beforeAll(async ({ request }) => {
    await makeMd(request);
    mdToken = await signIn(request, "md_sir", MD_PASSWORD);
  });
  test.afterAll(async ({ request }) => {
    await cleanUp(request);
  });
  test.beforeEach(async ({ page }) => {
    await startAs(page, mdToken, "/md/dashboard");
    await expect(page.getByTestId("md-identity")).toBeVisible();
  });

  test("it opens from the launcher, answers from the real data and shows how it got there", async ({ page }) => {
    await openAssistant(page);
    await expect(page.getByTestId("assistant-empty")).toContainText("Murugan");

    await ask(page, "How many employees are active?");
    await expect(page.getByTestId("assistant-user-message")).toContainText("How many employees are active?");
    await expect(lastReply(page)).toHaveAttribute("data-status", "done", { timeout: 20_000 });
    await expect(lastReply(page)).toContainText("records match");
    await expect(lastReply(page).locator("strong").first()).toHaveText(/^\d+$/);
    await expect(page.getByTestId("assistant-confidence")).toBeVisible();

    // "how I got this": the steps, the data and the assumptions come from what the server really did
    await page.getByTestId("assistant-explain-toggle").click();
    await expect(page.getByTestId("explain-steps")).toContainText("Custom data query");
    await expect(page.getByTestId("explain-steps")).toContainText("status = active");
    await page.getByTestId("explain-tab-data").click();
    await expect(page.getByTestId("explain-data")).toContainText("Employees (custom query)");
    await page.getByTestId("explain-tab-assume").click();
    await expect(page.getByTestId("explain-assumptions")).toContainText("names were replaced");

    // a navigation suggestion opens the page and the conversation stays
    await page.getByTestId("assistant-page-employees").click();
    await expect(page).toHaveURL(/\/md\/employees/);
    await expect(page.getByTestId("assistant-panel")).toHaveAttribute("data-open", "true");
    await expect(page.getByTestId("assistant-reply")).toHaveCount(1);

    // and a follow-up question can be asked from its chip
    await page.getByTestId("assistant-followups").getByRole("button", { name: "And by department?" }).click();
    await expect(page.getByTestId("assistant-reply")).toHaveCount(2);
    await expect(lastReply(page)).toHaveAttribute("data-status", "done", { timeout: 20_000 });
  });

  test("what is sent to Gemini is read-only, structured and carries no names", async ({ page, request }) => {
    await openAssistant(page);
    await ask(page, "How is Asha Kumar doing in attendance?");
    await expect(lastReply(page)).toHaveAttribute("data-status", "done", { timeout: 20_000 });
    // the MD reads the real name...
    await expect(page.getByTestId("assistant-user-message")).toContainText("Asha Kumar");
    await expect(lastReply(page)).toContainText("Asha Kumar");

    // ...but Gemini never saw it
    const sent = await geminiRequests(request);
    expect(sent.length).toBeGreaterThan(0);
    const everything = JSON.stringify(sent);
    expect(everything).not.toContain("Asha");
    expect(everything).not.toContain("9000000001");
    expect(everything).toContain("@emp-");

    for (const call of sent) {
      expect(call.key).toBe("e2e-fake-gemini-key");
      const tools: string[] = call.body.tools[0].functionDeclarations.map((t: { name: string }) => t.name);
      expect(tools).toEqual(expect.arrayContaining(["query_data", "submit_answer"]));
      expect(call.body.toolConfig.functionCallingConfig.mode).toBe("ANY");
      for (const forbidden of ["temperature", "topP", "topK", "candidateCount"])
        expect(call.body.generationConfig).not.toHaveProperty(forbidden);
      // nothing in the tool list can change data
      expect(tools.filter((n) => /^(create|update|delete|set|write|save|approve|reject|send|import)_/.test(n))).toEqual(
        [],
      );
    }
    expect(sent[0].body.systemInstruction.parts[0].text).toContain("READ-ONLY");
  });

  test("it will not change anything: it says so and the data is untouched", async ({ page, request }) => {
    const employees = async () => ((await api(request, adminToken, "GET", "/api/employees")).body as unknown[]).length;
    const before = await employees();
    // the MD's own login has no way to the HR endpoints at all
    expect((await api(request, mdToken, "GET", "/api/hr-users")).status).toBe(403);
    await openAssistant(page);
    await ask(page, "Please write a new salary for Asha");
    await expect(lastReply(page)).toHaveAttribute("data-status", "done", { timeout: 20_000 });
    await expect(lastReply(page)).toContainText("cannot change anything");
    await expect(page.getByTestId("assistant-confidence")).toHaveText("Low confidence");
    expect(await employees()).toBe(before);
  });

  test("a lookup the data cannot support is explained, not faked", async ({ page }) => {
    await openAssistant(page);
    await ask(page, "run an invalid lookup");
    await expect(lastReply(page)).toHaveAttribute("data-status", "done", { timeout: 20_000 });
    await expect(lastReply(page)).toContainText("Unknown dataset");
    await page.getByTestId("assistant-explain-toggle").click();
    await expect(page.getByTestId("explain-steps")).toContainText("could not be completed");
  });

  test("when Gemini's free daily allowance is used up it says so plainly, with when it resets", async ({
    page,
    request,
  }) => {
    for (let i = 0; i < 3; i++) await request.post(`${FAKE}/fail-next`, { data: { status: 429, daily: true } });
    await openAssistant(page);
    await ask(page, "How many employees are active?");
    await expect(page.getByTestId("assistant-error")).toContainText("used today's free Gemini allowance", {
      timeout: 20_000,
    });
    await expect(page.getByTestId("assistant-error")).toContainText(/resets at about \d{1,2}:\d{2} [AP]M IST/);
    // and the next question works again
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(lastReply(page)).toHaveAttribute("data-status", "done", { timeout: 20_000 });
  });

  test("history keeps conversations, and a new one starts clean", async ({ page }) => {
    await openAssistant(page);
    await ask(page, "How many employees are active?");
    await expect(lastReply(page)).toHaveAttribute("data-status", "done", { timeout: 20_000 });
    await page.getByTestId("assistant-new").click();
    await expect(page.getByTestId("assistant-empty")).toBeVisible();
    await page.getByTestId("assistant-history").click();
    await expect(page.getByTestId("assistant-history-list")).toContainText("How many employees are active?");
    await page
      .getByTestId("assistant-history-list")
      .getByRole("button", { name: /How many employees are active/ })
      .first()
      .click();
    await expect(page.getByTestId("assistant-reply")).toHaveCount(1);
  });

  test("keyboard: Ctrl+J opens and closes it, Escape closes it", async ({ page }) => {
    await page.keyboard.press("Control+j");
    await expect(page.getByTestId("assistant-panel")).toHaveAttribute("data-open", "true");
    await page.keyboard.press("Control+j");
    await expect(page.getByTestId("assistant-panel")).toHaveAttribute("data-open", "false");
    await page.getByTestId("md-ask-ai").click();
    await expect(page.getByTestId("assistant-panel")).toHaveAttribute("data-open", "true");
    await page.getByTestId("assistant-input").focus();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("assistant-panel")).toHaveAttribute("data-open", "false");
  });

  test("on a phone the panel fills the screen and nothing scrolls sideways", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await goto(page, "/md/dashboard");
    await page.getByTestId("assistant-launcher").click();
    const panel = page.getByTestId("assistant-panel");
    await expect(panel).toHaveAttribute("data-open", "true");
    const box = (await panel.boundingBox())!;
    expect(Math.round(box.width)).toBe(375);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});

// ─── voice ───────────────────────────────────────────────────────────────────────────────────────────────────────

test.describe("voice", () => {
  test.beforeAll(async ({ request }) => {
    await makeMd(request);
    mdToken = await signIn(request, "md_sir", MD_PASSWORD);
  });
  test.afterAll(async ({ request }) => {
    await cleanUp(request);
  });
  test.beforeEach(async ({ page }) => {
    // The browser's recogniser and voices cannot run in a test: stand-ins that behave like the real ones.
    await page.addInitScript(() => {
      const w = window as any;
      w.__recognitionLangs = [];
      w.__spoken = [];
      class FakeRecognition {
        lang = "";
        interimResults = false;
        continuous = false;
        maxAlternatives = 1;
        onstart: any;
        onaudiostart: any;
        onspeechstart: any;
        onspeechend: any;
        onresult: any;
        onerror: any;
        onend: any;
        start() {
          w.__recognitionLangs.push(this.lang);
          setTimeout(() => this.onstart?.(), 10);
          setTimeout(() => this.onaudiostart?.(), 20);
          setTimeout(() => this.onspeechstart?.(), 40);
          setTimeout(
            () =>
              this.onresult?.({
                resultIndex: 0,
                results: { length: 1, 0: { isFinal: false, length: 1, 0: { transcript: "how many", confidence: 0 } } },
              }),
            80,
          );
          setTimeout(
            () =>
              this.onresult?.({
                resultIndex: 0,
                results: {
                  length: 1,
                  0: { isFinal: true, length: 1, 0: { transcript: "how many employees are active", confidence: 0.93 } },
                },
              }),
            400,
          );
          setTimeout(() => this.onspeechend?.(), 420);
          setTimeout(() => this.onend?.(), 450);
        }
        stop() {}
        abort() {}
      }
      w.webkitSpeechRecognition = FakeRecognition;
      w.SpeechRecognition = FakeRecognition;
      class FakeUtterance {
        text: string;
        lang = "";
        voice: any = null;
        rate = 1;
        onend: any;
        onerror: any;
        constructor(text: string) {
          this.text = text;
        }
      }
      w.SpeechSynthesisUtterance = FakeUtterance;
      const synth = {
        speaking: false,
        getVoices: () => [{ name: "Fake India", lang: "en-IN", localService: true }],
        addEventListener() {},
        removeEventListener() {},
        cancel() {},
        speak(u: any) {
          if (u.text) w.__spoken.push(u.text);
          setTimeout(() => u.onend?.(), 15);
        },
      };
      Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
    });
    await startAs(page, mdToken, "/md/dashboard");
    await expect(page.getByTestId("md-identity")).toBeVisible();
  });

  test("asking by voice: the words appear live, a confident question is sent at once and the answer is spoken", async ({
    page,
  }) => {
    await openAssistant(page);
    await page.getByTestId("assistant-mic").click();
    await expect(page.getByTestId("assistant-listening")).toBeVisible();
    await expect(page.getByTestId("assistant-waveform")).toBeVisible();
    await expect(page.getByTestId("assistant-user-message")).toContainText("how many employees are active", {
      timeout: 10_000,
    });
    await expect(page.getByTestId("assistant-user-message").locator("svg[aria-label='Asked by voice']")).toBeVisible();
    // the voice analysis: the language heard, how sure the recogniser was, and which engine did the listening
    await expect(page.getByTestId("assistant-heard")).toHaveText(
      "Heard in English · 93% sure · browser speech recognition",
    );
    await expect(lastReply(page)).toHaveAttribute("data-status", "done", { timeout: 20_000 });
    // a spoken question gets a spoken answer: the short summary, not the whole text
    await expect
      .poll(() => page.evaluate(() => (window as any).__spoken))
      .toEqual([expect.stringMatching(/^\d+ records match\.$/)]);
  });

  test("with no recogniser in the browser the voice is recorded and transcribed by the server", async ({
    page,
    context,
  }) => {
    // a microphone the test can use (Chromium's built-in fake device) and no Web Speech API, as in Firefox
    await context.grantPermissions(["microphone"]);
    await page.addInitScript(() => {
      delete (window as any).webkitSpeechRecognition;
      delete (window as any).SpeechRecognition;
    });
    await page.reload();
    await openAssistant(page);
    await page.getByTestId("assistant-mic").click();
    await expect(page.getByTestId("assistant-listening")).toContainText("sent for transcription when you stop");
    await page.waitForTimeout(800); // a moment of "speech"
    await page.getByTestId("assistant-mic").click(); // stop: the recording goes to the server
    await expect(page.getByTestId("assistant-user-message")).toContainText("how many employees are active", {
      timeout: 15_000,
    });
    await expect(page.getByTestId("assistant-heard")).toHaveText("Heard in English · transcribed by Gemini");
    await expect(lastReply(page)).toHaveAttribute("data-status", "done", { timeout: 20_000 });
  });

  test("the listening language is remembered and used by the recogniser", async ({ page }) => {
    await openAssistant(page);
    await page.getByTestId("assistant-language").click();
    await page.getByTestId("assistant-language-ta-IN").click();
    await page.getByTestId("assistant-mic").click();
    await expect.poll(() => page.evaluate(() => (window as any).__recognitionLangs)).toEqual(["ta-IN"]);
    await page.reload();
    await openAssistant(page);
    await expect(page.getByTestId("assistant-language")).toContainText("த");
  });

  test("'Reading aloud' speaks the answer to a typed question too, and Listen speaks any answer on demand", async ({
    page,
  }) => {
    await openAssistant(page);
    await ask(page, "How many employees are active?");
    await expect(lastReply(page)).toHaveAttribute("data-status", "done", { timeout: 20_000 });
    expect(await page.evaluate(() => (window as any).__spoken)).toEqual([]); // silent by default
    await page.getByTestId("assistant-listen").click();
    await expect.poll(() => page.evaluate(() => (window as any).__spoken.length)).toBe(1);
    await page.getByTestId("assistant-speak-toggle").click();
    await ask(page, "What is the headcount?");
    await expect.poll(() => page.evaluate(() => (window as any).__spoken.length)).toBe(2);
  });
});
