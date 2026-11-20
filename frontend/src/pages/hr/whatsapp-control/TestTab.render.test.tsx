import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { renderMdPage, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import TestTab from "./TestTab";

// WhatsApp Control -> Send a test, on the Meta Cloud API. Pick a type and a recipient (on a limited machine the allowed
// employee is picked for you), Preview (a dry run: the Meta template, its parameters and the text, nothing sent), then
// Send, which asks in the page first and only then POSTs without dryRun. Meta's answer is shown as it came: sent (its
// wamid), failed (its error code and sentence, with what the code means) or blocked (this machine's reason). There is no
// free text any more: with Meta the wording is the approved template. Nothing here reaches a network.

const SURYA = { id: 71, code: "30020", name: "SURYA M", phone: "••••9103", hasPhone: true, blockedReason: null };

// The server nests the template a type goes out as (whatsapp_test_views._template_json).
const SALARY_TEMPLATE = {
  name: "hrms_salary_slip",
  language: "en",
  status: "APPROVED",
  category: "UTILITY",
  approved: true,
  problem: null,
  header: "document",
};

const TYPES = [
  {
    documentType: "salary_slip",
    label: "Salary Slip",
    module: "documents",
    moduleLabel: "Documents",
    kind: "document",
    variables: [{ name: "month_year", sample: "August 2026" }],
    template: SALARY_TEMPLATE,
  },
  {
    documentType: "hod_request_waiting",
    label: "New request waiting for approval",
    module: "hod",
    moduleLabel: "Department Heads",
    kind: "automatic",
    variables: [],
  },
];

const limitedOptions = () => ({ blockReason: null, limitedTo: ["30020"], recipients: [SURYA], types: TYPES });

const PREVIEW = {
  status: "preview",
  to: "••••9103",
  employee: SURYA,
  text: "Dear SURYA M,\nYour salary slip for *August 2026* is attached.\n\n- UK Textiles HR",
  template: SALARY_TEMPLATE,
  header: "document",
  // the server sends the parameters as an object: variable name -> value
  params: { employee_name: "SURYA M", month_year: "August 2026" },
  blockReason: null,
};

type Post = Record<string, unknown>;

function server(opts: { options?: unknown; send?: Record<string, unknown> } = {}) {
  const posts: Post[] = [];
  const fixture = (_params: URLSearchParams, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Post;
      posts.push(body);
      if (body.dryRun === true) return { ...PREVIEW, documentType: body.documentType };
      return {
        documentType: body.documentType,
        to: "••••9103",
        employee: SURYA,
        text: PREVIEW.text,
        template: SALARY_TEMPLATE,
        ...(opts.send ?? {
          status: "sent",
          logId: 812,
          providerMessageId: "wamid.HBgMOTE5ODc2NTQzMjEwFQIAERgS",
          providerResponse: { messaging_product: "whatsapp", messages: [{ id: "wamid.HBgMOTE5ODc2NTQzMjEwFQIAERgS" }] },
        }),
      };
    }
    return opts.options ?? limitedOptions();
  };
  return { posts, fixtures: { "/api/whatsapp-control/test-message": fixture } };
}

let page: RenderedPage | undefined;
afterEach(() => {
  page?.unmount();
  page = undefined;
});

const open = async (s: ReturnType<typeof server>, viewOnly = false) => {
  page = await renderMdPage(() => <TestTab viewOnly={viewOnly} />, s.fixtures, {
    path: "/hr/whatsapp-control?tab=test",
  });
  return page;
};
const el = (id: string) => page!.container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const text = (id: string) => (el(id)?.textContent ?? "").replace(/\s+/g, " ").trim();

async function pickType(value: string) {
  const select = el("wa-test-type") as HTMLSelectElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page!.settle();
}

async function previewIt(s: ReturnType<typeof server>) {
  await pickType("salary_slip");
  await page!.click('[data-testid="wa-test-preview"]');
  expect(s.posts.at(-1)).toEqual({ documentType: "salary_slip", employeeId: SURYA.id, dryRun: true });
}

describe("Send a test", () => {
  it("states the rules, names each type's template, and picks the only employee a limited machine may message", async () => {
    const s = server();
    await open(s);
    expect(text("wa-test-rules")).toContain("approved by Meta");
    expect(text("wa-test-rules")).not.toMatch(/wa ?client/i);
    const groups = [...(el("wa-test-type") as HTMLSelectElement).querySelectorAll("optgroup")].map((g) => g.label);
    expect(groups).toEqual(["Documents", "Department Heads"]);
    expect(text("wa-test-limited")).toContain("This machine may only message employee 30020");
    expect(el(`wa-test-recipient-${SURYA.id}`)!.getAttribute("aria-pressed")).toBe("true");
    await pickType("salary_slip");
    expect(text("wa-test-type-template")).toContain("hrms_salary_slip");
    expect(text("wa-test-type-template")).toContain("Approved");
    expect(s.posts).toEqual([]);
    expect(el("wa-test-send")).toBeNull();
  });

  it("previews the template, its parameters and the text, with no way to type free text", async () => {
    const s = server();
    await open(s);
    await previewIt(s);
    expect(text("wa-test-template-name")).toBe("hrms_salary_slip");
    expect(text("wa-test-template")).toContain("Document (PDF)");
    expect(text("wa-test-params")).toContain("{{month_year}}August 2026");
    expect(text("wa-test-bubble-body")).toContain("Your salary slip for August 2026 is attached.");
    expect(page!.container.querySelector("textarea")).toBeNull();
    expect(el("wa-test-edit")).toBeNull();
  });

  it("sends only after the in-page confirmation, and shows Meta's message id and answer", async () => {
    const s = server();
    await open(s);
    await previewIt(s);
    await page!.click('[data-testid="wa-test-send"]');
    expect(s.posts).toHaveLength(1);
    expect(text("wa-test-confirm-box")).toContain("Send this to SURYA M (••••9103) now?");
    expect(text("wa-test-confirm-box")).toContain("hrms_salary_slip");
    await page!.click('[data-testid="wa-test-confirm"]');
    expect(s.posts.at(-1)).toEqual({ documentType: "salary_slip", employeeId: SURYA.id });
    expect(el("wa-test-result")!.dataset.status).toBe("sent");
    expect(text("wa-test-result")).toContain("Meta accepted it");
    expect(text("wa-test-provider-id")).toBe("wamid.HBgMOTE5ODc2NTQzMjEwFQIAERgS");
    expect(text("wa-test-result")).toContain("(#812)");
    expect(el("wa-test-provider-response")).not.toBeNull();
    expect(el("wa-test-code-sent")).toBeNull(); // not a code type
  });

  it("shows the random code a test of a code type sent", async () => {
    const s = server({ send: { status: "sent", logId: 813, providerMessageId: "wamid.CODE", testCode: "482913" } });
    await open(s);
    await previewIt(s);
    await page!.click('[data-testid="wa-test-send"]');
    await page!.click('[data-testid="wa-test-confirm"]');
    expect(text("wa-test-code-sent")).toContain("482913");
  });

  it("shows Meta's refusal with its code and what the code means", async () => {
    const s = server({
      send: {
        status: "failed",
        error: "Template name does not exist in the translation",
        code: 132001, // the server's key for Meta's error code
        httpStatus: 404,
      },
    });
    await open(s);
    await previewIt(s);
    await page!.click('[data-testid="wa-test-send"]');
    await page!.click('[data-testid="wa-test-confirm"]');
    expect(el("wa-test-result")!.dataset.status).toBe("failed");
    expect(text("wa-test-error")).toBe("Template name does not exist in the translation");
    expect(text("wa-test-code")).toBe("Meta error 132001 · HTTP 404");
    expect(text("wa-test-help")).toContain("not approved in this language");
  });

  it("shows a held-back test as blocked, not as Meta's failure", async () => {
    const s = server({
      send: { status: "blocked", error: "Not sent: employee 30021 is not on the development list." },
    });
    await open(s);
    await previewIt(s);
    await page!.click('[data-testid="wa-test-send"]');
    await page!.click('[data-testid="wa-test-confirm"]');
    expect(el("wa-test-result")!.dataset.status).toBe("blocked");
    expect(text("wa-test-result")).toContain("held back before it reached Meta");
  });

  it("lets a View-only role preview but not send, and says why", async () => {
    const s = server();
    await open(s, true);
    await previewIt(s);
    expect((el("wa-test-send") as HTMLButtonElement).disabled).toBe(true);
    expect(text("wa-test-why")).toContain("View only");
  });

  it("says when nothing can be sent from this machine at all", async () => {
    const s = server({
      options: { ...limitedOptions(), blockReason: "WhatsApp sending is off on a development machine." },
    });
    await open(s);
    expect(text("wa-test-block")).toContain("development machine");
  });
});
