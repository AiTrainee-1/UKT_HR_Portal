import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-client/custom-fetch";
import type {
  HodPending,
  HodPreviewMessage,
  HodReminderSettings,
  HodRun,
  HodRunPage,
} from "@/lib/api-client/custom-hooks";
import { lockMutatingControls } from "@/lib/view-only-lock";
import { DEFAULT_TEMPLATE, HOD_PENDING, RUN_DONE, SETTINGS } from "../fixtures";
import NotifyTab, { PREVIEW_DEBOUNCE_MS } from "./NotifyTab";

// Notify in jsdom with the data hooks mocked (the server shapes come from ../fixtures): the schedule (times, days), the
// channels with their notes, the message (placeholders, reset, problems), what a save sends, the preview, Send now (who gets
// what, then the run followed until it is over), the run history, and the read-only page of a view-only or branch login.

type Query<T> = { data: T | undefined; isError: boolean; error: unknown; isFetching: boolean; refetch: () => void };
const query = <T,>(data: T | undefined): Query<T> => ({
  data,
  isError: false,
  error: null,
  isFetching: false,
  refetch: vi.fn(),
});

const h = vi.hoisted(() => ({
  settings: null as unknown as Query<HodReminderSettings>,
  preview: null as unknown as Query<HodPreviewMessage[]>,
  previewArgs: [] as (string | null)[],
  pending: null as unknown as Query<HodPending>,
  runs: null as unknown as Query<HodRunPage>,
  runById: new Map<number, HodRun>(),
  update: vi.fn(),
  send: vi.fn(),
  toast: vi.fn(),
  user: null as null | { role: string; employeeId: null; permissions: Record<string, string> },
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/contexts/AuthContext", async (original) => ({
  ...(await original<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ token: "t", user: h.user }),
}));
vi.mock("@/lib/api-client/custom-hooks/hod-reminders", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-hooks/hod-reminders")>()),
  useHodReminderSettings: () => h.settings,
  useUpdateHodReminderSettings: () => ({ mutateAsync: h.update, isPending: false }),
  useSendHodReminders: () => ({ mutateAsync: h.send, isPending: false }),
  useHodReminderPreview: (template: string | null) => {
    h.previewArgs.push(template);
    return h.preview;
  },
  useHodPending: () => h.pending,
  useHodReminderRuns: () => h.runs,
  useHodReminderRun: (id: number | null) => query(id === null ? undefined : (h.runById.get(id) ?? null)),
}));

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

const MESSAGES: HodPreviewMessage[] = [
  { managerId: 1, name: "Ravi Shankar", pending: 4, text: "Dear Ravi Shankar,\n• Leave Requests: 2" },
  { managerId: 2, name: "Meena Rani", pending: 1, text: "Dear Meena Rani,\n• Casual Leave Requests: 1" },
];

let root: Root | null = null;
let host: HTMLElement | null = null;
let client: QueryClient;

beforeEach(() => {
  vi.clearAllMocks();
  h.settings = query(SETTINGS);
  h.preview = query(MESSAGES);
  h.previewArgs = [];
  h.pending = query(HOD_PENDING);
  h.runs = query({ items: [RUN_DONE], total: 1, page: 1, pageSize: 8 });
  h.runById = new Map([[RUN_DONE.id, { ...RUN_DONE, deliveries: [] }]]);
  h.user = null;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

const page = () => createElement(QueryClientProvider, { client }, createElement(NotifyTab));
function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(page()));
}
const rerender = () => act(() => root!.render(page()));

const q = (id: string) => document.body.querySelector(`[data-testid="${id}"]`);
const btn = (id: string) => q(id) as HTMLButtonElement;
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const click = (el: Element | null) => act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const flush = () => act(async () => {});
function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const times = () => [...document.body.querySelectorAll('[data-testid="notify-times"] li')].map(text);
const addTime = (t: string) => {
  typeInto(q("notify-time-input") as HTMLInputElement, t);
  click(q("notify-add-time"));
};

describe("the schedule", () => {
  it("shows what is saved: on, the times, Mon-Sat, the next and the last run", () => {
    mount();
    expect((q("notify-enabled") as HTMLElement).getAttribute("aria-checked")).toBe("true");
    expect(times()).toEqual(["10:00 AM", "4:00 PM"]);
    expect(text(q("notify-schedule-text"))).toBe("Mon–Sat at 10:00 AM and 4:00 PM (India time)");
    const days = [...document.body.querySelectorAll('[data-testid="notify-days"] button')].map(
      (b) => `${text(b)}:${b.getAttribute("aria-pressed")}`,
    );
    expect(days).toEqual(["Mon:true", "Tue:true", "Wed:true", "Thu:true", "Fri:true", "Sat:true", "Sun:false"]);
    expect(text(q("notify-next-run"))).toBe("Wed, 04 Nov, 4:00 PM");
    expect(text(q("notify-last-run"))).toContain("Scheduled · 10:00 AM");
    expect(q("notify-read-only")).toBeNull();
    expect(q("notify-save-dock")?.getAttribute("data-dirty")).toBe("false");
  });

  it("adds a time in order, refuses a repeat, removes one, and stops at six", () => {
    mount();
    addTime("09:30");
    expect(times()).toEqual(["9:30 AM", "10:00 AM", "4:00 PM"]);
    addTime("10:00");
    expect(document.body.querySelector("#notify-time-error")?.textContent).toBe("10:00 AM is already on the list.");
    click(q("notify-remove-09:30"));
    expect(times()).toEqual(["10:00 AM", "4:00 PM"]);
    for (const t of ["11:00", "12:00", "13:00", "14:00"]) addTime(t);
    expect(times()).toHaveLength(6);
    expect(btn("notify-add-time").disabled).toBe(true);
    expect((q("notify-time-input") as HTMLInputElement).disabled).toBe(true);
    expect(q("notify-save-dock")?.getAttribute("data-dirty")).toBe("true");
  });

  it("toggles a day, and the summary and next run follow before saving", () => {
    mount();
    click(q("notify-day-6"));
    expect(q("notify-day-6")?.getAttribute("aria-pressed")).toBe("true");
    expect(text(q("notify-schedule-text"))).toBe("Every day at 10:00 AM and 4:00 PM (India time)");
    expect(text(q("notify-next-run"))).toContain("(after you save)");
  });

  it("saves only what changed, and follows the saved settings", async () => {
    const next = { ...SETTINGS, times: ["09:30", "10:00", "16:00"], channels: { ...SETTINGS.channels, push: false } };
    h.update.mockResolvedValue(next);
    mount();
    addTime("09:30");
    click(q("notify-channel-push-switch"));
    await act(async () => {
      btn("notify-save").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(h.update).toHaveBeenCalledWith({
      times: ["09:30", "10:00", "16:00"],
      channels: { whatsapp: true, email: true, push: false },
    });
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Reminder settings saved" }));
    h.settings = query(next);
    rerender();
    expect(q("notify-save-dock")?.getAttribute("data-dirty")).toBe("false");
    expect(times()).toEqual(["9:30 AM", "10:00 AM", "4:00 PM"]);
  });

  it("will not save reminders that are on with no time, and Discard puts the form back", () => {
    mount();
    click(q("notify-remove-10:00"));
    click(q("notify-remove-16:00"));
    expect(q("notify-no-times")).not.toBeNull();
    expect(btn("notify-save").disabled).toBe(true);
    expect(text(q("notify-save-dock"))).toContain("Add at least one time, or switch the reminders off.");
    click(q("notify-discard"));
    expect(times()).toEqual(["10:00 AM", "4:00 PM"]);
  });
});

describe("channels and the message", () => {
  it("shows each channel's note, a warning when it cannot deliver", () => {
    mount();
    expect(text(q("notify-channel-email-note"))).toBe("SMTP is not set up in Settings: emails will be skipped");
    expect(q("notify-channel-email-note")?.className).toContain("text-amber-700");
    expect(text(q("notify-channel-whatsapp-note"))).toBe("Sent through the WhatsApp Business number");
  });

  it("inserts a placeholder at the caret, flags a broken message, and resets to the default", () => {
    mount();
    const area = q("notify-template-text") as HTMLTextAreaElement;
    typeInto(area, "Hello ");
    area.setSelectionRange(6, 6);
    click(q("notify-insert-name"));
    expect(area.value).toBe("Hello {{name}}");
    expect(text(q("notify-template-problem"))).toContain("{{pendingList}}");
    expect(btn("notify-save").disabled).toBe(true);
    click(q("notify-template-reset"));
    expect(area.value).toBe(DEFAULT_TEMPLATE);
    expect(q("notify-template-problem")).toBeNull();
    expect(btn("notify-template-reset").disabled).toBe(true);
  });

  it("previews what each HoD would get, and asks again for an edited message once the typing stops", () => {
    vi.useFakeTimers();
    mount();
    expect(text(q("notify-preview-count"))).toBe("2 HoDs would get a reminder now");
    expect(text(q("notify-preview-text"))).toContain("Dear Ravi Shankar,");
    expect(h.previewArgs.at(-1)).toBeNull();
    const edited = `${DEFAULT_TEMPLATE}\nThanks`;
    typeInto(q("notify-template-text") as HTMLTextAreaElement, edited);
    act(() => vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS + 10));
    expect(h.previewArgs.at(-1)).toBe(edited);
    expect(text(q("notify-preview"))).toContain("not saved yet");
  });
});

describe("Send now", () => {
  it("lists who gets what, sends the ticked HoDs, then follows the run until it is done", async () => {
    const running: HodRun = { ...RUN_DONE, id: 21, trigger: "manual", slot: null, sentBy: "Meena", status: "running" };
    h.send.mockResolvedValue(running);
    h.runById.set(21, running);
    mount();
    click(q("notify-send-now"));
    expect(q("notify-send-dialog")).not.toBeNull();
    expect(
      [...document.body.querySelectorAll('[data-testid="notify-send-list"] > li')].map((li) =>
        li.getAttribute("data-testid"),
      ),
    ).toEqual(["notify-send-1", "notify-send-2"]);
    // Ravi: WhatsApp and push go, email does not (SMTP is not set up); Meena has no phone number
    expect(q("notify-send-1-whatsapp")?.getAttribute("data-goes")).toBe("true");
    expect(q("notify-send-1-email")?.getAttribute("data-goes")).toBe("false");
    expect(text(q("notify-send-2-whatsapp"))).toContain("No phone number");
    expect(text(q("notify-send-counts"))).toContain("WhatsApp to 1 · Email to 0 · Mobile push to 1");
    expect(text(q("notify-send-counts"))).toContain("1 HoD cannot be reached on any channel");
    click(document.body.querySelector("#notify-send-2"));
    expect(text(q("notify-send-confirm"))).toBe("Send to 1 HoD");
    await act(async () => {
      btn("notify-send-confirm").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(h.send).toHaveBeenCalledWith({ managerIds: [1], channels: { whatsapp: true, email: true, push: true } });
    expect(q("notify-send-dialog")).toBeNull();
    expect(text(q("notify-live-run"))).toContain("Sending…");
    expect(btn("notify-send-now").disabled).toBe(true);
    // the run is over
    h.runById.set(21, { ...running, status: "done" });
    rerender();
    await flush();
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Reminders sent" }));
    expect(q("notify-live-run")).toBeNull();
  });

  it("follows the run already going when the server says one is", async () => {
    const busy = { ...RUN_DONE, id: 30, status: "running" as const };
    h.runById.set(30, busy);
    h.send.mockRejectedValue(
      new ApiError(
        new Response("{}", { status: 409 }),
        { code: "run_in_progress", run: busy },
        { method: "POST", url: "/send" },
      ),
    );
    mount();
    click(q("notify-send-now"));
    await act(async () => {
      btn("notify-send-confirm").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "A reminder run is already being sent" }));
    expect(q("notify-live-run")).not.toBeNull();
  });

  it("says when nobody has anything pending", () => {
    h.pending = query({ ...HOD_PENDING, hods: HOD_PENDING.hods.filter((r) => r.pending === 0) });
    mount();
    click(q("notify-send-now"));
    expect(q("notify-send-nobody")).not.toBeNull();
    expect(btn("notify-send-confirm").disabled).toBe(true);
  });
});

describe("the run history", () => {
  it("lists the runs and opens one to show every HoD's channels", () => {
    h.runById.set(RUN_DONE.id, {
      ...RUN_DONE,
      deliveries: [
        {
          managerId: 1,
          name: "Ravi Shankar",
          pending: 4,
          byCategory: {},
          text: "Dear Ravi",
          whatsapp: { status: "sent", note: "" },
          email: { status: "skipped", note: "No email address" },
          push: { status: "failed", note: "Token expired" },
        },
      ],
    });
    mount();
    const run = q(`notify-run-${RUN_DONE.id}`)!;
    expect(text(run)).toContain("WhatsApp: 1 sent · 1 skipped");
    const toggle = run.querySelector("button[aria-expanded]")!;
    click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(q("notify-delivery-1-email")?.getAttribute("data-status")).toBe("skipped");
    expect(text(q("notify-delivery-1"))).toContain("Email: No email address");
    expect(text(q("notify-delivery-1"))).toContain("Mobile push: Token expired");
  });

  it("says when nothing has gone out yet", () => {
    h.runs = query({ items: [], total: 0, page: 1, pageSize: 8 });
    mount();
    expect(q("notify-history-empty")).not.toBeNull();
  });
});

describe("read-only", () => {
  const disabledControls = () =>
    [
      "notify-enabled",
      "notify-add-time",
      "notify-remove-10:00",
      "notify-day-0",
      "notify-channel-whatsapp-switch",
      "notify-insert-name",
      "notify-send-now",
    ].filter((id) => !(q(id) as HTMLButtonElement | null)?.disabled);

  it("a branch-limited login (canEdit false) sees everything, changes nothing, with a plain note", () => {
    h.settings = query({ ...SETTINGS, canEdit: false });
    mount();
    expect(text(q("notify-read-only"))).toContain("company-wide");
    expect(disabledControls()).toEqual([]);
    expect((q("notify-template-text") as HTMLTextAreaElement).readOnly).toBe(true);
    expect(q("notify-save-dock")).toBeNull();
    // the preview is of the saved message
    expect(h.previewArgs.every((t) => t === null)).toBe(true);
  });

  it("a View Only role is read-only too, and the portal's lock agrees", () => {
    h.user = { role: "hr", employeeId: null, permissions: { requests: "view" } };
    mount();
    expect(text(q("notify-read-only"))).toContain("View only");
    expect(disabledControls()).toEqual([]);
    lockMutatingControls(document.body);
    expect(btn("notify-send-now").disabled).toBe(true);
  });

  it("turns read-only when the server refuses a save as company-wide", async () => {
    h.update.mockRejectedValue(
      new ApiError(
        new Response("{}", { status: 403 }),
        { error: "The reminder schedule is company-wide.", code: "company_wide_rule" },
        { method: "PUT", url: "/settings" },
      ),
    );
    mount();
    click(q("notify-day-6"));
    await act(async () => {
      btn("notify-save").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(text(q("notify-read-only"))).toBe("The reminder schedule is company-wide.");
    expect(btn("notify-send-now").disabled).toBe(true);
  });

  it("says plainly when the server does not have the reminders yet", () => {
    h.settings = {
      ...query<HodReminderSettings>(undefined),
      isError: true,
      error: new ApiError(new Response("{}", { status: 404 }), {}, { method: "GET", url: "/settings" }),
    };
    mount();
    expect(text(q("notify-unavailable"))).toContain("not available on this server yet");
  });
});
