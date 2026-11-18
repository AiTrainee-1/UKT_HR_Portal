import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { renderMdPage, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import TestTab from "./TestTab";
import { SURYA, TYPES, limitedOptions } from "./test-fixtures";

// WhatsApp Control -> Send a test. Pick a type and a recipient (on a limited machine the allowed employee is picked for
// you), Preview (a dry run: POST with dryRun true, nothing sent), optionally edit the text, then Send, which asks in the page
// first and only then POSTs without dryRun. The answer is shown as it came: sent (WAClient's id), failed (its error, HTTP
// status and raw answer) or blocked (this machine's reason). Nothing here reaches a network: the fixtures answer.

const PREVIEW_TEXT = "Dear SURYA M,\nA new *Leave* request is waiting for your approval.";

type Post = Record<string, unknown>;

function server(opts: { get?: (params: URLSearchParams) => unknown; send?: Record<string, unknown> } = {}) {
  const posts: Post[] = [];
  const gets: string[] = [];
  const fixture = (params: URLSearchParams, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Post;
      posts.push(body);
      const head = {
        documentType: body.documentType,
        to: "••••9103",
        employee: SURYA,
        text: typeof body.text === "string" ? body.text : PREVIEW_TEXT,
      };
      if (body.dryRun === true) return { ...head, status: "preview", blockReason: null };
      return { ...head, ...(opts.send ?? { status: "sent", logId: 812, providerMessageId: "3EB0ABC123" }) };
    }
    gets.push(params.toString());
    return opts.get ? opts.get(params) : limitedOptions();
  };
  return { posts, gets, fixtures: { "/api/whatsapp-control/test-message": fixture } };
}

let page: RenderedPage | undefined;
afterEach(() => {
  page?.unmount();
  page = undefined;
});

const open = async (s: ReturnType<typeof server>, viewOnly = false) => {
  page = await renderMdPage(() => <TestTab viewOnly={viewOnly} />, s.fixtures, { path: "/hr/whatsapp-control" });
  return page;
};
const el = (id: string) => page!.container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const text = (id: string) => (el(id)?.textContent ?? "").replace(/\s+/g, " ").trim();
const disabled = (id: string) => (el(id) as HTMLButtonElement).disabled;

async function pickType(value: string) {
  const select = el("wa-test-type") as HTMLSelectElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page!.settle();
}

async function previewIt(s: ReturnType<typeof server>, type = "hod_request_waiting") {
  await pickType(type);
  await page!.click('[data-testid="wa-test-preview"]');
  expect(s.posts.at(-1)).toEqual({ documentType: type, employeeId: SURYA.id, dryRun: true });
}

describe("Send a test: choosing", () => {
  it("states the rules, groups the types by module and picks the only employee a limited machine may message", async () => {
    const s = server();
    await open(s);
    expect(text("wa-test-rules")).toContain("ignores the switches, quiet hours and the sending limits");
    expect(text("wa-test-rules")).toContain("never skips this machine's own safety rules");
    expect(text("wa-test-rules")).toContain("Documents are tried as their text only");
    const groups = [...(el("wa-test-type") as HTMLSelectElement).querySelectorAll("optgroup")].map((g) => g.label);
    expect(groups).toEqual(["Documents", "Department Heads"]);
    // limited to 30020: SURYA is picked, and why he is the only one is said
    expect(text("wa-test-limited")).toContain("This machine may only message employee 30020");
    expect(text("wa-test-limited")).toContain("the only one");
    expect(el(`wa-test-recipient-${SURYA.id}`)!.getAttribute("aria-pressed")).toBe("true");
    expect(el("wa-test-search")).toBeNull();
    // nothing to send before a preview, and nothing was posted
    expect(el("wa-test-send")).toBeNull();
    expect(s.posts).toEqual([]);
  });

  it("searches by name or code when the machine may message anyone", async () => {
    const s = server({
      get: (params) => ({
        blockReason: null,
        limitedTo: null,
        recipients: params.get("search")
          ? [
              SURYA,
              {
                ...SURYA,
                id: 72,
                code: "30021",
                name: "SURESH K",
                phone: null,
                hasPhone: false,
                blockedReason: "No phone number on file",
              },
            ]
          : [],
        types: TYPES,
      }),
    });
    await open(s);
    expect(el("wa-test-limited")).toBeNull();
    await page!.type('[data-testid="wa-test-search"]', "sur");
    await new Promise((r) => setTimeout(r, 400));
    await page!.settle();
    expect(s.gets).toContain("search=sur");
    expect(text("wa-test-hits")).toContain("SURYA M");
    // an employee without a phone can't be picked, and says why
    expect(disabled("wa-test-recipient-72")).toBe(true);
    expect(text("wa-test-recipient-72")).toContain("No phone number on file");
    await page!.click(`[data-testid="wa-test-recipient-${SURYA.id}"]`);
    expect(el(`wa-test-recipient-${SURYA.id}`)!.getAttribute("aria-pressed")).toBe("true");
    expect(el("wa-test-change-recipient")).not.toBeNull();
  });
});

describe("Send a test: preview, edit, confirm, send", () => {
  it("previews with dryRun true and shows the message as a WhatsApp bubble", async () => {
    const s = server();
    await open(s);
    expect(disabled("wa-test-preview")).toBe(true);
    await previewIt(s);
    expect(text("wa-test-bubble")).toContain("A new Leave request is waiting");
    // *Leave* is drawn bold, as WhatsApp does
    expect(el("wa-test-bubble")!.querySelector("b")!.textContent).toBe("Leave");
    expect(el("wa-test-chat")!.dataset.state).toBe("preview");
  });

  it("asks in the page before sending, and sends nothing until confirmed", async () => {
    const s = server();
    await open(s);
    await previewIt(s);
    await page!.click('[data-testid="wa-test-send"]');
    expect(text("wa-test-confirm-box")).toContain("Send this to SURYA M (••••9103) now?");
    expect(s.posts).toHaveLength(1); // the preview only
    await page!.click('[data-testid="wa-test-cancel"]');
    expect(el("wa-test-confirm-box")).toBeNull();
    expect(s.posts).toHaveLength(1);
    await page!.click('[data-testid="wa-test-send"]');
    await page!.click('[data-testid="wa-test-confirm"]');
    // the message's own wording: no text, no dryRun
    expect(s.posts.at(-1)).toEqual({ documentType: "hod_request_waiting", employeeId: SURYA.id });
  });

  it("sends the edited text when the text was edited", async () => {
    const s = server();
    await open(s);
    await previewIt(s);
    await page!.click('[data-testid="wa-test-edit"]');
    await page!.type('[data-testid="wa-test-text"]', "Test from HR, please ignore.");
    expect(text("wa-test-bubble")).toContain("Test from HR, please ignore.");
    await page!.click('[data-testid="wa-test-send"]');
    expect(text("wa-test-confirm-box")).toContain("with your edited text");
    await page!.click('[data-testid="wa-test-confirm"]');
    expect(s.posts.at(-1)).toEqual({
      documentType: "hod_request_waiting",
      employeeId: SURYA.id,
      text: "Test from HR, please ignore.",
    });
  });

  it("won't send an emptied text, and turning Edit text off goes back to the real wording", async () => {
    const s = server();
    await open(s);
    await previewIt(s);
    await page!.click('[data-testid="wa-test-edit"]');
    await page!.type('[data-testid="wa-test-text"]', "   ");
    expect(disabled("wa-test-send")).toBe(true);
    expect(text("wa-test-why")).toBe("The message cannot be empty.");
    await page!.click('[data-testid="wa-test-edit"]');
    expect(el("wa-test-text")).toBeNull();
    expect(disabled("wa-test-send")).toBe(false);
    expect(text("wa-test-bubble")).toContain("waiting for your approval");
  });
});

describe("Send a test: the answer", () => {
  const sendWith = async (send: Record<string, unknown>) => {
    const s = server({ send });
    await open(s);
    await previewIt(s);
    await page!.click('[data-testid="wa-test-send"]');
    await page!.click('[data-testid="wa-test-confirm"]');
    return s;
  };

  it("sent: green, with WAClient's message id and when it should arrive", async () => {
    await sendWith({
      status: "sent",
      logId: 812,
      providerMessageId: "3EB0ABC123",
      providerResponse: { status: "success" },
    });
    expect(el("wa-test-result")!.dataset.status).toBe("sent");
    expect(el("wa-test-result")!.querySelector('[data-tone="good"]')).not.toBeNull();
    expect(text("wa-test-result")).toContain("Sent to SURYA M (••••9103)");
    expect(text("wa-test-provider-id")).toBe("3EB0ABC123");
    expect(text("wa-test-result")).toContain("should arrive in a few seconds");
    expect(text("wa-test-result")).toContain("#812");
    expect(el("wa-test-chat")!.dataset.state).toBe("sent");
  });

  it("failed: red, with WAClient's own error, the HTTP status and its answer folded away", async () => {
    await sendWith({
      status: "failed",
      logId: 813,
      error: "WAClient error: Instance not connected",
      httpStatus: 401,
      providerResponse: { status: "error", message: "Instance not connected" },
    });
    expect(el("wa-test-result")!.dataset.status).toBe("failed");
    expect(el("wa-test-result")!.querySelector('[data-tone="bad"]')).not.toBeNull();
    expect(text("wa-test-error")).toBe("WAClient error: Instance not connected");
    expect(text("wa-test-http")).toBe("HTTP 401");
    const raw = el("wa-test-provider-response") as HTMLDetailsElement;
    expect(raw.open).toBe(false);
    expect(raw.querySelector("pre")!.textContent).toContain('"message": "Instance not connected"');
  });

  it("blocked: amber, with this machine's reason", async () => {
    await sendWith({
      status: "blocked",
      error:
        "Not sent (development safety): this machine may only message employee 30020 (WHATSAPP_ONLY_TO_EMPLOYEES).",
      httpStatus: null,
      providerResponse: null,
    });
    expect(el("wa-test-result")!.dataset.status).toBe("blocked");
    expect(el("wa-test-result")!.querySelector('[data-tone="warn"]')).not.toBeNull();
    expect(text("wa-test-result")).toContain("development safety");
    expect(el("wa-test-provider-response")).toBeNull();
  });

  it("shows a refusal (a bad type, an inactive employee) in words", async () => {
    const s = server();
    s.fixtures["/api/whatsapp-control/test-message"] = (params: URLSearchParams, init?: RequestInit) =>
      init?.method === "POST"
        ? { status: 400, body: { error: "Choose a message type that has text." } }
        : limitedOptions();
    await open(s);
    await pickType("salary_slip");
    await page!.click('[data-testid="wa-test-preview"]');
    expect(text("wa-test-problem")).toContain("Choose a message type that has text.");
  });
});

describe("Send a test: when it can't send", () => {
  it("shows this machine's block prominently and never offers to send", async () => {
    const reason = "WhatsApp sending is switched off on this machine because it is a development setup.";
    const s = server({ get: () => limitedOptions({ blockReason: reason }) });
    await open(s);
    expect(text("wa-test-block")).toContain(reason);
    expect(el("wa-test-block")!.dataset.tone).toBe("bad");
    await previewIt(s);
    expect(disabled("wa-test-send")).toBe(true);
    expect(text("wa-test-why")).toContain("Nothing can be sent");
  });

  it("View only: previews, but sending stays off with the reason", async () => {
    const s = server();
    await open(s, true);
    await previewIt(s);
    expect(text("wa-test-bubble")).toContain("waiting for your approval");
    expect(disabled("wa-test-send")).toBe(true);
    expect(text("wa-test-why")).toBe("View only: you can preview a test, but your role can't send one.");
    expect(s.posts.every((p) => p.dryRun === true)).toBe(true);
  });

  it("View only: says plainly why when the server refuses the preview", async () => {
    const s = server();
    s.fixtures["/api/whatsapp-control/test-message"] = (_params: URLSearchParams, init?: RequestInit) =>
      init?.method === "POST"
        ? { status: 403, body: { error: "permission_denied", message: "You do not have access to this section." } }
        : limitedOptions();
    await open(s, true);
    await pickType("hod_request_waiting");
    await page!.click('[data-testid="wa-test-preview"]');
    expect(text("wa-test-problem")).toContain("counts a preview as a change");
    expect(text("wa-test-problem")).not.toContain("permission_denied");
  });
});
