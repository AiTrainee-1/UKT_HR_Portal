import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-client/custom-fetch";
import {
  readNotifyAutomation,
  readNotifyOverview,
  readNotifyPreview,
  type NotifyAutomation,
  type NotifyAutomationInput,
  type NotifyChannel,
} from "@/lib/api-client/custom-hooks/attendance-notify";
import AutomationForm from "./AutomationForm";

// The automation form against stand-in hooks: the steps and their checks, the times, each channel's recipients (WhatsApp
// numbers, Gmail addresses, chat channels), the preview of the draft and what a save sends.

const h = vi.hoisted(() => ({
  save: vi.fn(),
  preview: vi.fn(),
  previewData: undefined as unknown,
  pdf: vi.fn(),
  toast: vi.fn(),
  saveList: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/contexts/AuthContext", async (original) => ({
  ...(await original<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ token: "t", user: { role: "hr", permissions: {} } }),
}));
vi.mock("@/lib/api-client/custom-hooks", async (original) => {
  const real = await original<typeof import("@/lib/api-client/custom-hooks")>();
  const mutation = (fn: (...a: unknown[]) => unknown) => ({ mutateAsync: fn, mutate: fn, isPending: false });
  return {
    ...real,
    useSaveAttendanceNotifyAutomation: () => mutation(h.save),
    useAttendanceNotifyPreview: () => ({ mutate: h.preview, data: h.previewData, isPending: false, isError: false }),
    downloadAttendanceNotifyPreviewPdf: h.pdf,
    useAttendanceNotifyRecipientLists: (channel: string) => ({
      data:
        channel === "whatsapp"
          ? [
              real.readNotifyRecipientList({
                id: 5,
                name: "HR team",
                channel: "whatsapp",
                items: [{ value: "+919000000001" }],
              }),
            ]
          : [],
      isLoading: false,
      isError: false,
    }),
    useSaveAttendanceNotifyRecipientList: () => mutation(h.saveList),
    useDeleteAttendanceNotifyRecipientList: () => mutation(vi.fn()),
    useAttendanceNotifyWhatsAppGroups: (enabled: boolean) => ({
      data: enabled
        ? { supported: false, groups: [], note: "Groups need the WhatsApp Web link.", fetchedAt: null }
        : undefined,
      isLoading: false,
      isError: false,
    }),
    useRefreshAttendanceNotifyWhatsAppGroups: () => mutation(vi.fn()),
    useAttendanceNotifyChatChannels: () => ({
      data: real.readNotifyChatChannels({
        items: [
          { id: 1, type: "company", name: "Unit 1", branch: "Unit 1", members: 120 },
          { id: 7, type: "department", name: "Stitching", branch: "Unit 1", members: 30 },
        ],
      }),
      isLoading: false,
      isError: false,
    }),
  };
});

const OVERVIEW = readNotifyOverview({
  channels: { whatsapp: { available: true }, email: { available: true }, chat: { available: true } },
  settings: { connectedNumber: "+919876543210" },
});

let root: Root | null = null;
let host: HTMLElement | null = null;
const onClose = vi.fn();

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
});

beforeEach(() => {
  vi.clearAllMocks();
  h.previewData = undefined;
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  root = null;
  host = null;
});

function open(automation: NotifyAutomation | null, channel: NotifyChannel | null) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient();
  act(() =>
    root!.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(AutomationForm, { automation, channel, overview: OVERVIEW, onClose }),
      ),
    ),
  );
}

const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const click = (id: string) => {
  const el = q(id);
  if (!el) throw new Error(`no ${id}`);
  act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
};
const type = (id: string, value: string) => {
  const el = q(id) as HTMLInputElement;
  if (!el) throw new Error(`no ${id}`);
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const enter = (id: string) =>
  act(() => q(id)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
const lastSaved = () => h.save.mock.calls.at(-1)?.[0] as { id: number | null; body: NotifyAutomationInput };

describe("a new WhatsApp automation, step by step", () => {
  it("shows a step's problems once it is left, and Save goes back to the first step with one", async () => {
    open(null, "whatsapp");
    expect(text(q("an-form"))).toContain("New WhatsApp automation");
    expect(q("an-form-save")).toBeNull(); // a new one is saved from the last step
    click("an-form-next");
    expect(q("an-step-schedule")).not.toBeNull();
    expect(q("an-form-step-report")?.textContent).toContain("!");
    expect(text(q("an-form-problems"))).toContain("Give the automation a name.");
    click("an-form-next");
    click("an-form-next");
    expect(q("an-preview")).not.toBeNull();
    click("an-form-save");
    await settle();
    expect(h.save).not.toHaveBeenCalled();
    expect(q("an-step-report")).not.toBeNull();
  });

  it("fills every step, previews the draft and saves exactly what applies", async () => {
    h.save.mockImplementation(async ({ body }: { body: NotifyAutomationInput }) =>
      readNotifyAutomation({ ...body, id: 9, nextRunAt: null }),
    );
    h.previewData = readNotifyPreview({
      dates: ["2026-11-17"],
      counts: { absent: 2, cl: 1 },
      total: 300,
      employees: 3,
      messages: [
        { kind: "text", text: "*Absent today*: 2" },
        { kind: "document", filename: "attendance.pdf" },
      ],
      rows: [{ name: "Asha Kumar", code: "E1", category: "absent", detail: "No punch" }],
      warnings: ["2 numbers are not on WhatsApp"],
    });
    open(null, "whatsapp");

    // Report
    type("an-name", "Morning absentees");
    click("an-category-compensation"); // off
    click("an-employee-type-staff");
    click("an-report-day-yesterday");
    click("an-photos");
    click("an-form-next");

    // Schedule: Mondays and Wednesdays, 9:30 (already) and 1 PM typed as "1:00 pm"
    click("an-frequency-weekly");
    for (const d of [1, 2, 3, 4, 5]) click(`an-day-${d}`); // leaves Monday on
    click("an-day-2");
    type("an-time-input", "13:00");
    click("an-time-add");
    type("an-time-input", "13:00");
    click("an-time-add");
    expect(text(q("an-times"))).toContain("1:00 PM is already on the list.");
    expect(text(q("an-times-list"))).toBe("9:30 AM1:00 PM");
    expect(text(q("an-next-sends"))).not.toContain("None");
    click("an-form-next");

    // Recipients: the connected number, a typed number, a saved list
    click("an-connected");
    type("an-number-input", "12345");
    click("an-number-add");
    expect(text(q("an-numbers"))).toContain("is not a WhatsApp number");
    type("an-number-input", "98765 43211");
    type("an-number-label", "HR Manager");
    enter("an-number-input");
    expect(q("an-number-+919876543211")).not.toBeNull();
    click("an-list-5");
    click("an-groups-load");
    expect(text(q("an-groups-unsupported"))).toContain("Groups need the WhatsApp Web link.");
    expect(q("an-groups-picker")).toBeNull();
    click("an-form-next");

    // Preview
    expect(h.preview).toHaveBeenCalledTimes(1);
    expect(h.preview.mock.calls[0][0]).toMatchObject({ name: "Morning absentees", channel: "whatsapp" });
    expect(text(q("an-preview-whatsapp"))).toContain("Absent today: 2");
    expect(q("an-preview-bubble")?.querySelector("b")?.textContent).toBe("Absent today");
    expect(text(q("an-preview-whatsapp"))).toContain("attendance.pdf");
    expect(text(q("an-preview-warnings"))).toContain("2 numbers are not on WhatsApp");
    expect(text(q("an-preview-rows"))).toContain("Asha Kumar");
    click("an-preview-pdf");
    await settle();
    expect(h.pdf).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Morning absentees" }),
      expect.stringMatching(/^attendance-report-morning-absentees-\d{4}-\d{2}-\d{2}\.pdf$/),
    );

    click("an-form-save");
    await settle();
    const { id, body } = lastSaved();
    expect(id).toBeNull();
    expect(body).toEqual({
      name: "Morning absentees",
      channel: "whatsapp",
      isActive: true,
      reportType: "daily",
      reportDay: "yesterday",
      dateFrom: null,
      dateTo: null,
      categories: ["absent", "cl", "on_leave", "on_duty", "permission"],
      employeeType: "staff",
      frequency: "weekly",
      days: [0, 2],
      runOn: null,
      times: ["09:30", "13:00"],
      content: "both",
      includePhotos: true,
      emailFormat: "html",
      attachPdf: false,
      subject: "",
      skipWhenEmpty: false,
      recipients: {
        connected: true,
        numbers: [{ value: "+919876543211", label: "HR Manager" }],
        groups: [],
        listIds: [5],
      },
    });
    expect(onClose).toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "“Morning absentees” created" }));
  });

  it("a custom report checks its range of at most 31 days", () => {
    open(null, "whatsapp");
    type("an-name", "October");
    click("an-report-type-custom");
    type("an-date-from", "2026-10-01");
    type("an-date-to", "2026-11-09");
    expect(text(q("an-step-report"))).toContain("40 days (at most 31)");
    click("an-form-next");
    click("an-form-step-report");
    expect(text(q("an-step-report"))).toContain("A custom report covers at most 31 days (this one is 40).");
  });
});

describe("the other channels", () => {
  it("Gmail: To / CC chips with checks, format, PDF and subject", async () => {
    h.save.mockImplementation(async ({ body }: { body: NotifyAutomationInput }) =>
      readNotifyAutomation({ ...body, id: 3 }),
    );
    open(null, "email");
    type("an-name", "Daily mail");
    click("an-form-step-recipients");
    type("an-email-to", "hr@uktextiles.in, oops");
    enter("an-email-to");
    expect(document.body.querySelectorAll('[data-testid="an-email-to-chip"]')).toHaveLength(1);
    expect(text(q("an-email-to-field"))).toContain("Not an email address: oops.");
    expect((q("an-email-to") as HTMLInputElement).value).toBe("oops");
    type("an-email-cc", "HR@uktextiles.in md@uktextiles.in");
    enter("an-email-cc");
    expect(text(q("an-email-cc-field"))).toContain("Already added: hr@uktextiles.in.");
    click("an-email-format-text");
    click("an-attach-pdf");
    type("an-subject", "  Attendance today ");
    click("an-form-step-preview");
    click("an-form-save");
    await settle();
    expect(lastSaved().body).toMatchObject({
      channel: "email",
      emailFormat: "text",
      attachPdf: true,
      subject: "Attendance today",
      recipients: { to: ["hr@uktextiles.in"], cc: ["md@uktextiles.in"], bcc: [], listIds: [] },
    });
  });

  it("Internal Chat: warns who reads a channel, and picks channels", async () => {
    h.save.mockImplementation(async ({ body }: { body: NotifyAutomationInput }) =>
      readNotifyAutomation({ ...body, id: 4 }),
    );
    open(null, "chat");
    type("an-name", "Stitching board");
    click("an-form-step-recipients");
    expect(text(q("an-chat-warning"))).toContain("A company channel is read by every employee of that branch");
    expect(text(q("an-recipients-chat"))).toContain("read by 120 people");
    click("an-chat-channel-7");
    click("an-form-step-preview");
    click("an-form-save");
    await settle();
    expect(lastSaved().body.recipients).toEqual({ channelIds: [7] });
  });

  it("from Automation Management the channel is asked for, and it changes the recipients step", () => {
    open(null, null);
    expect(text(q("an-form"))).toContain("New automation");
    click("an-channel-pick-chat");
    click("an-form-step-recipients");
    expect(q("an-recipients-chat")).not.toBeNull();
  });
});

describe("editing", () => {
  it("keeps the channel, can save from any step, and a refused field opens its step", async () => {
    const a = readNotifyAutomation({
      id: 7,
      name: "Morning absentees",
      channel: "whatsapp",
      categories: ["absent"],
      times: ["09:30"],
      recipients: { connected: true },
    })!;
    h.save.mockRejectedValue(
      new ApiError(
        new Response("{}", { status: 400 }),
        { error: "09:30 clashes with another automation.", field: "times" },
        {
          method: "PUT",
          url: "/api/attendance/notify/automations/7",
        },
      ),
    );
    open(a, "whatsapp");
    expect(text(q("an-form"))).toContain("Edit “Morning absentees”");
    expect(q("an-channel-pick")).toBeNull();
    click("an-form-save");
    await settle();
    expect(lastSaved().id).toBe(7);
    expect(q("an-step-schedule")).not.toBeNull();
    expect(text(q("an-form-server-error"))).toContain("09:30 clashes with another automation.");
    expect(onClose).not.toHaveBeenCalled();
  });
});
