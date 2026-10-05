import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { closeAssistant, openAssistant } from "@/lib/md/assistant-store";
import { renderMdPage, type Fixtures, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import AssistantHost from "./AssistantHost";

let page: RenderedPage | undefined;
afterEach(() => {
  page?.unmount();
  page = undefined;
  closeAssistant();
});

const status = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  configured: true,
  ready: true,
  model: "gemini-3.5-flash-lite",
  privacyMode: true,
  usage: { requests: 3, limitHit: false, resetsAt: "12:30 PM IST" },
  voice: { serverTranscription: true },
  limits: { questionChars: 2000 },
  ...over,
});

const answer = {
  id: 12,
  conversationId: 5,
  role: "assistant",
  status: "done",
  content: "**91.8%** attendance over the last 30 days.\n\n- Stitching is lowest at 84%.",
  payload: {
    spokenSummary: "Attendance was ninety one point eight percent.",
    confidence: "medium",
    confidenceReason: "Based on 1 lookup of the company's own records. Some figures carry caveats (see Data used).",
    steps: [
      {
        tool: "attendance_summary",
        title: "Attendance summary",
        summary: "x",
        ok: true,
        error: null,
        ms: 42,
        rows: 1200,
        period: "Last 30 days",
        scope: "All units · all departments · staff and production",
        args: {},
      },
    ],
    dataUsed: [
      {
        title: "Attendance %",
        dataset: "Attendance day records",
        definition: "Days present out of scheduled days.",
        formula: "present ÷ scheduled",
        rows: 1200,
        filters: [],
        caveats: ["Today is provisional."],
        period: "Last 30 days",
        scope: null,
        from: "Attendance summary",
      },
    ],
    assumptions: ["Staff and production together."],
    reasoning: ["I looked at attendance."],
    suggestedPages: [
      { id: "attendance", title: "Attendance Analytics", path: "/md/attendance", reason: "See the detailed breakdown" },
    ],
    followUps: ["And last month?"],
    privacy: { enabled: true, tokens: 0 },
    usage: { requests: 2, promptTokens: 900, outputTokens: 80 },
    model: "gemini-3.5-flash-lite",
  },
  error: null,
  inputMode: "text",
  language: null,
  createdAt: "2026-10-05T10:42:00",
  finishedAt: "2026-10-05T10:42:06",
};

function fixtures(over: Fixtures = {}): Fixtures {
  let polls = 0;
  return {
    "/api/md/assistant/status": status(),
    "/api/md/assistant/ask": { conversationId: 5, userMessageId: 11, messageId: 12 },
    "/api/md/assistant/messages/12": () => {
      polls += 1;
      return polls < 2
        ? {
            ...answer,
            status: "running",
            content: "",
            payload: { progress: [{ label: "Looking at attendance summary…", state: "running" }] },
          }
        : answer;
    },
    ...over,
  };
}

const wait = (ms: number) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));

describe("AssistantHost: who sees it", () => {
  it("shows nothing at all to anyone who is not the MD", async () => {
    page = await renderMdPage(
      AssistantHost,
      fixtures({ "/api/auth/me": { role: "hr", name: "Clerk", isMd: false, permissions: {} } }),
    );
    expect(page.container.querySelector('[data-testid="assistant-launcher"]')).toBeNull();
    expect(page.container.querySelector('[data-testid="assistant-panel"]')).toBeNull();
    expect(page.requests().some((r) => r.includes("/assistant/"))).toBe(false); // not even a status request
  });

  it("shows nothing to the MD outside the MD pages", async () => {
    page = await renderMdPage(AssistantHost, fixtures(), { path: "/hr/dashboard" });
    expect(page.container.querySelector('[data-testid="assistant-launcher"]')).toBeNull();
    expect(page.container.querySelector('[data-testid="assistant-panel"]')).toBeNull();
  });

  it("offers the MD a launcher on an MD page, and the panel opens from it", async () => {
    page = await renderMdPage(AssistantHost, fixtures(), { path: "/md/payroll" });
    expect(page.container.querySelector('[data-testid="assistant-launcher"]')).not.toBeNull();
    await page.click('[data-testid="assistant-launcher"]');
    expect(page.container.querySelector('[data-testid="assistant-panel"]')?.getAttribute("data-open")).toBe("true");
    expect(page.text()).toContain("Good morning, Test");
    expect(page.container.querySelector('[data-testid="assistant-launcher"]')).toBeNull();
  });
});

describe("AssistantHost: asking", () => {
  it("shows starter questions for the page, and asking one produces an explained answer", async () => {
    page = await renderMdPage(AssistantHost, fixtures(), { path: "/md/payroll" });
    await act(async () => openAssistant());
    await page.settle();
    expect(page.text()).toContain("Why did payroll change compared with last month?"); // a payroll-page suggestion

    await page.click('[data-testid="assistant-suggestion"]');
    expect(page.container.querySelector('[data-testid="assistant-user-message"]')?.textContent).toContain(
      "Why did payroll change",
    );
    expect(page.container.querySelector('[data-testid="assistant-progress"]')).not.toBeNull(); // working…

    await wait(1800);
    await page.settle();
    const reply = page.container.querySelector('[data-testid="assistant-reply"]');
    expect(reply?.getAttribute("data-status")).toBe("done");
    expect(reply?.textContent).toContain("91.8%");
    expect(reply?.querySelector("strong")?.textContent).toBe("91.8%"); // markdown rendered, not shown raw
    expect(page.container.querySelector('[data-testid="assistant-confidence"]')?.textContent).toBe("Medium confidence");
    expect(page.container.querySelector('[data-testid="assistant-page-attendance"]')?.textContent).toContain(
      "Attendance Analytics",
    );
    expect(page.container.querySelector('[data-testid="assistant-followups"]')?.textContent).toContain(
      "And last month?",
    );

    // the question went out with what the MD is looking at
    expect(page.requests().filter((r) => r === "/api/md/assistant/ask")).toHaveLength(1);

    // "How I got this"
    await page.click('[data-testid="assistant-explain-toggle"]');
    expect(page.container.querySelector('[data-testid="explain-steps"]')?.textContent).toContain("Attendance summary");
    expect(page.container.querySelector('[data-testid="explain-steps"]')?.textContent).toContain("1,200 records");
    await page.click('[data-testid="explain-tab-data"]');
    expect(page.container.querySelector('[data-testid="explain-data"]')?.textContent).toContain("present ÷ scheduled");
    expect(page.container.querySelector('[data-testid="explain-data"]')?.textContent).toContain(
      "Today is provisional.",
    );
    await page.click('[data-testid="explain-tab-assume"]');
    expect(page.container.querySelector('[data-testid="explain-assumptions"]')?.textContent).toContain(
      "names were replaced",
    );
  });

  it("sends what is typed with Enter and clears the box", async () => {
    page = await renderMdPage(AssistantHost, fixtures(), { path: "/md/dashboard" });
    await act(async () => openAssistant());
    await page.settle();
    await page.type('[data-testid="assistant-input"]', "How is attendance?");
    const input = page.container.querySelector<HTMLTextAreaElement>('[data-testid="assistant-input"]')!;
    expect(input.value).toBe("How is attendance?");
    await page.click('[data-testid="assistant-send"]');
    expect(page.requests()).toContain("/api/md/assistant/ask");
    expect(page.container.querySelector<HTMLTextAreaElement>('[data-testid="assistant-input"]')?.value).toBe("");
  });
});

describe("AssistantHost: when it cannot answer", () => {
  it("explains a missing key and does not let the MD ask", async () => {
    page = await renderMdPage(
      AssistantHost,
      fixtures({ "/api/md/assistant/status": status({ configured: false, ready: false }) }),
      { path: "/md/dashboard" },
    );
    await act(async () => openAssistant());
    await page.settle();
    expect(page.container.querySelector('[data-testid="assistant-setup"]')?.textContent).toContain("GEMINI_API_KEY");
    expect(page.container.querySelector<HTMLTextAreaElement>('[data-testid="assistant-input"]')?.disabled).toBe(true);
  });

  it("warns when the day's free allowance is used up", async () => {
    page = await renderMdPage(
      AssistantHost,
      fixtures({
        "/api/md/assistant/status": status({ usage: { requests: 400, limitHit: true, resetsAt: "12:30 PM IST" } }),
      }),
      { path: "/md/dashboard" },
    );
    await act(async () => openAssistant());
    await page.settle();
    expect(page.container.querySelector('[data-testid="assistant-setup"]')?.textContent).toContain("12:30 PM IST");
  });

  it("shows a failed answer in words, with a way to try again", async () => {
    page = await renderMdPage(
      AssistantHost,
      fixtures({
        "/api/md/assistant/messages/12": {
          ...answer,
          status: "error",
          content: "",
          error: "Gemini is very busy right now. Please try again in a minute.",
          payload: { errorKind: "overloaded" },
        },
      }),
      { path: "/md/dashboard" },
    );
    await act(async () => openAssistant("How is attendance?"));
    await page.settle();
    await wait(1200);
    await page.settle();
    expect(page.container.querySelector('[data-testid="assistant-error"]')?.textContent).toContain("very busy");
    expect(page.text()).toContain("Try again");
  });

  it("reports a refused question (409) as an error in the conversation", async () => {
    page = await renderMdPage(
      AssistantHost,
      fixtures({
        "/api/md/assistant/ask": { status: 409, body: { error: "I am still working on your previous question." } },
      }),
      { path: "/md/dashboard" },
    );
    await act(async () => openAssistant("Anything"));
    await page.settle();
    expect(page.container.querySelector('[data-testid="assistant-error"]')?.textContent).toContain("still working");
  });
});

describe("AssistantHost: stopping an answer", () => {
  it("offers Stop while it works, and ends the answer as stopped", async () => {
    page = await renderMdPage(
      AssistantHost,
      fixtures({
        "/api/md/assistant/messages/12": { ...answer, status: "running", content: "", payload: { progress: [] } },
        "/api/md/assistant/messages/12/cancel": {
          ...answer,
          status: "error",
          content: "",
          error: "Stopped.",
          payload: { errorKind: "cancelled" },
          stopped: true,
        },
      }),
      { path: "/md/dashboard" },
    );
    await act(async () => openAssistant("How many employees are active?"));
    await page.settle();
    await wait(700); // the first poll replaces the placeholder's id with the real one
    expect(page.container.querySelector('[data-testid="assistant-stop"]')).not.toBeNull();
    expect(page.container.querySelector<HTMLButtonElement>('[data-testid="assistant-send"]')?.disabled).toBe(true);

    await page.click('[data-testid="assistant-stop"]');
    expect(page.requests().some((r) => r.endsWith("/messages/12/cancel"))).toBe(true);
    expect(page.container.querySelector('[data-testid="assistant-stopped"]')?.textContent).toContain(
      "You stopped this answer",
    );
    expect(page.container.querySelector('[data-testid="assistant-stop"]')).toBeNull(); // free again
    expect(page.container.querySelector('[data-testid="assistant-error"]')).toBeNull(); // not shown as a failure
  });
});

describe("AssistantHost: a question handed over from a page", () => {
  it("asks it as soon as the panel is open", async () => {
    page = await renderMdPage(AssistantHost, fixtures(), { path: "/md/attendance" });
    await act(async () => openAssistant("Why is absenteeism high in Stitching?"));
    await page.settle();
    expect(page.container.querySelector('[data-testid="assistant-user-message"]')?.textContent).toContain(
      "Why is absenteeism high in Stitching?",
    );
    expect(page.requests()).toContain("/api/md/assistant/ask");
  });
});
