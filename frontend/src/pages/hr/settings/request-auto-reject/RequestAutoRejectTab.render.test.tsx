import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderMdPage, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import type { AutoRejectConfig, AutoRejectHistoryPage } from "@/lib/api-client/custom-hooks";
import RequestAutoRejectTab from "../RequestAutoRejectTab";

// jsdom render checks of Settings -> Auto-Reject Requests with a fake server: the rule in words, the switch and the days
// (validation, what a save sends, the preview of a number not saved yet), Run now behind an in-page confirm that says how
// many will be rejected, who may change or run it, and the history list.

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }), toast }));

const HR = { role: "hr", employeeId: null, name: "Meena", isSuperAdmin: true, permissions: {} };

const KINDS = [
  { key: "leave", label: "Leave" },
  { key: "permission", label: "Permission" },
  { key: "missing_punch", label: "Missing Punch" },
  { key: "on_duty", label: "On-Duty" },
  { key: "on_duty_punch", label: "On-Duty punches" },
];

const dueItem = (kind: string, kindLabel: string, id: number, what: string, daysWaiting: number, extra = {}) => ({
  key: `${kind}-${id}`,
  kind,
  kindLabel,
  id,
  employee: { id: 7, code: "30077", name: "Kavin S", branch: "Unit 1" },
  what,
  summary: "2026-09-22 at 09:00 · Morning Check-In",
  submittedAt: "2026-09-23T06:00:00Z",
  submittedOn: "2026-09-23",
  daysWaiting,
  ...extra,
});

function config(overrides: Partial<AutoRejectConfig> = {}): AutoRejectConfig {
  return {
    enabled: true,
    days: 45,
    limits: { min: 7, max: 365, default: 45 },
    runAt: "01:30",
    lastRunAt: null,
    lastRunBy: null,
    lastRun: null,
    updatedBy: null,
    updatedAt: null,
    canChange: true,
    canRun: true,
    branchScoped: false,
    kinds: KINDS,
    neverRejected: [{ key: "resignation", label: "Resignation" }],
    due: {
      total: 3,
      byKind: { missing_punch: 1, on_duty: 1, on_duty_punch: 1 },
      items: [
        dueItem("missing_punch", "Missing Punch", 17, "Missing Punch · Morning Check-In", 62),
        dueItem("on_duty", "On-Duty", 64, "On-Duty", 60),
        dueItem("on_duty_punch", "On-Duty punches", 58, "On-Duty punch 4 (Out)", 60, {
          voidedWith: { kind: "on_duty", id: 64 },
        }),
      ],
      truncated: false,
      days: 45,
      saved: true,
    },
    ...overrides,
  };
}

const EMPTY_HISTORY: AutoRejectHistoryPage = { items: [], page: 1, pageSize: 25, total: 0, pages: 1 };

const HISTORY: AutoRejectHistoryPage = {
  items: [
    {
      id: 2,
      kind: "on_duty",
      kindLabel: "On-Duty",
      requestId: 64,
      employee: { id: 9, code: "2937", name: "Arun P" },
      what: "On-Duty",
      summary: "National printing",
      submittedAt: "2026-09-25T05:00:00Z",
      daysWaited: 60,
      daysSetting: 45,
      remark: "Automatically rejected: no decision within 45 days of being submitted (submitted 25 Sep 2026).",
      rejectedAt: "2026-11-23T20:00:10Z",
      trigger: "nightly",
      runBy: null,
      by: "Nightly run",
      effects: { voidedPunches: 1 },
      effectsText: ["1 waiting On-Duty punch voided", "Geo tracking ended"],
    },
    {
      id: 1,
      kind: "permission",
      kindLabel: "Permission",
      requestId: 44,
      employee: { id: 3, code: "2958", name: "Devi R" },
      what: "Permission · Type not set",
      summary: "2026-09-14 at 10:00",
      submittedAt: "2026-09-14T05:00:00Z",
      daysWaited: 71,
      daysSetting: 45,
      remark: "Automatically rejected",
      rejectedAt: "2026-11-24T09:12:00Z",
      trigger: "run_now",
      runBy: "Meena",
      by: "Run now by Meena",
      effects: {},
      effectsText: [],
    },
  ],
  page: 1,
  pageSize: 25,
  total: 2,
  pages: 1,
};

let page: RenderedPage | undefined;
let puts: Record<string, unknown>[];
let runs: number;
let configRequests: string[];

beforeEach(() => {
  puts = [];
  runs = 0;
  configRequests = [];
  toast.mockClear();
});
afterEach(() => {
  page?.unmount();
  page = undefined;
});

async function open({
  saved = config(),
  history = EMPTY_HISTORY,
  readOnly = false,
}: { saved?: AutoRejectConfig; history?: AutoRejectHistoryPage; readOnly?: boolean } = {}) {
  let current = saved;
  page = await renderMdPage(
    () => <RequestAutoRejectTab readOnly={readOnly} />,
    {
      "/api/auth/me": HR,
      "/api/request-auto-reject/config": (params, init) => {
        configRequests.push(params.toString());
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          puts.push(body);
          current = { ...current, ...body, updatedBy: "Meena", updatedAt: "2026-11-24T06:00:00Z" };
          return current;
        }
        const days = params.get("days");
        if (days) {
          const n = Number(days);
          return {
            ...current,
            due: { ...current.due, total: 9, byKind: { missing_punch: 9 }, days: n, saved: false },
          };
        }
        return current;
      },
      "/api/request-auto-reject/history": history,
      "/api/request-auto-reject/run-now": () => {
        runs += 1;
        const summary = {
          ran: true,
          at: "2026-11-24T09:12:00Z",
          day: "2026-11-24",
          days: 45,
          trigger: "run_now",
          runBy: "Meena",
          branchId: null,
          rejected: 3,
          byKind: { missing_punch: 1, on_duty: 1, on_duty_punch: 1 },
          skipped: 0,
          attendanceSkipped: 0,
          failed: 0,
          failures: [],
        };
        current = {
          ...current,
          lastRun: summary as AutoRejectConfig["lastRun"],
          lastRunAt: summary.at,
          lastRunBy: "Meena",
          due: { ...current.due, total: 0, byKind: {}, items: [] },
        };
        return { summary, config: current };
      },
    },
    { path: "/hr/settings?tab=request_auto_reject" },
  );
  return page;
}

const q = <T extends Element = HTMLElement>(selector: string) => page!.container.querySelector<T>(selector);
const button = (testId: string) => q<HTMLButtonElement>(`[data-testid="${testId}"]`)!;
const saveButton = () =>
  [...page!.container.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    b.textContent?.includes("Save Auto-Reject Settings"),
  )!;

async function press(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
  await page!.settle();
}

async function typeDays(value: string) {
  await page!.type("#ar-days-input", value);
  // the due list for a number not saved yet is asked for once typing stops
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
  await page!.settle();
}

describe("Settings -> Auto-Reject Requests", () => {
  it("says the rule in plain words and lists what is due at the next run", async () => {
    await open();
    expect(q('[data-testid="ar-sentence"]')!.textContent).toBe(
      "Requests nobody decided within 45 days of being submitted are rejected automatically every night. Resignations are never rejected automatically.",
    );
    expect(q<HTMLButtonElement>("#ar-switch-toggle")!.getAttribute("aria-checked")).toBe("true");
    expect(q<HTMLInputElement>("#ar-days-input")!.value).toBe("45");
    expect(q('[data-testid="ar-due-count"]')!.textContent).toBe("3 requests are due");
    const rows = page!.container.querySelectorAll('[data-testid="ar-due-row"]');
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain("Missing Punch · Morning Check-In");
    expect(rows[0].textContent).toContain("Kavin S");
    expect(rows[0].textContent).toContain("23 Sep 2026");
    expect(rows[0].textContent).toContain("62 days");
    expect(q('[data-testid="ar-due-voided-with"]')).not.toBeNull();
    expect(q('[data-testid="ar-kinds"]')!.textContent).toContain("Never: Resignation.");
    expect(q('[data-testid="ar-history-empty"]')!.textContent).toBe("No request has been rejected automatically yet.");
    expect(saveButton().disabled).toBe(true);
  });

  it("asks before Run now, saying how many will be rejected, and runs only when confirmed", async () => {
    await open();
    await press(button("ar-run-now"));
    const confirm = q('[data-testid="ar-run-confirm"]')!;
    expect(confirm.textContent).toContain("Reject 3 waiting requests now?");
    expect(confirm.textContent).toContain("Missing Punch 1 · On-Duty 1 · On-Duty punches 1");
    expect(confirm.textContent).toContain("no WhatsApp message is sent");
    await press(button("ar-run-cancel"));
    expect(q('[data-testid="ar-run-confirm"]')).toBeNull();
    expect(runs).toBe(0);

    await press(button("ar-run-now"));
    expect(button("ar-run-confirm-button").textContent).toBe("Reject 3 requests");
    await press(button("ar-run-confirm-button"));
    expect(runs).toBe(1);
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "3 requests rejected",
        description: expect.stringContaining("Run now by Meena"),
      }),
    );
    expect(q('[data-testid="ar-run-confirm"]')).toBeNull();
    expect(q('[data-testid="ar-due-empty"]')).not.toBeNull();
    expect(q('[data-testid="ar-last-run"]')!.textContent).toContain("3 requests rejected");
    expect(button("ar-run-now").disabled).toBe(true);
  });

  it("previews another number of days before it is saved, then saves only what changed", async () => {
    await open();
    await typeDays("30");
    expect(configRequests).toContain("days=30");
    expect(q('[data-testid="ar-due"]')!.textContent).toContain("With 30 days (not saved yet)");
    expect(q('[data-testid="ar-due-count"]')!.textContent).toBe("9 requests are due");
    expect(q('[data-testid="ar-sentence"]')!.textContent).toContain("within 30 days");
    // Run now uses the saved number: not while a change is unsaved
    expect(button("ar-run-now").disabled).toBe(true);
    expect(saveButton().disabled).toBe(false);
    await press(saveButton());
    expect(puts).toEqual([{ days: 30 }]);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Auto-reject settings saved" }));
  });

  it("refuses a number of days out of range before any request", async () => {
    await open();
    await typeDays("5");
    expect(page!.text()).toContain("Between 7 and 365 days.");
    expect(saveButton().disabled).toBe(true);
    expect(configRequests.some((p) => p.includes("days="))).toBe(false);
  });

  it("switches it off and says so", async () => {
    await open();
    await press(q<HTMLButtonElement>("#ar-switch-toggle")!);
    expect(q('[data-testid="ar-sentence"]')!.textContent).toMatch(/^Switched off: nothing is rejected automatically/);
    await press(saveButton());
    expect(puts).toEqual([{ enabled: false }]);
  });

  it("is read-only for a login that may only look", async () => {
    await open({ readOnly: true });
    expect(q<HTMLButtonElement>("#ar-switch-toggle")!.disabled).toBe(true);
    expect(q<HTMLInputElement>("#ar-days-input")!.disabled).toBe(true);
    expect(button("ar-run-now").disabled).toBe(true);
    expect(saveButton().disabled).toBe(true);
  });

  it("lets a branch login run for its unit but not change the company-wide rule", async () => {
    await open({ saved: config({ canChange: false, canRun: true, branchScoped: true }) });
    expect(q('[data-testid="ar-company-wide-notice"]')).not.toBeNull();
    expect(q<HTMLInputElement>("#ar-days-input")!.disabled).toBe(true);
    expect(button("ar-run-now").disabled).toBe(false);
    expect(page!.text()).toContain("Only your unit's requests are listed.");
  });

  it("lists what was rejected automatically, by which run", async () => {
    await open({ history: HISTORY });
    const rows = page!.container.querySelectorAll('[data-testid="ar-history-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Arun P (2937)");
    expect(rows[0].textContent).toContain("1 waiting On-Duty punch voided");
    expect(rows[0].textContent).toContain("Rejected 24 Nov 2026, 01:30");
    expect(rows[0].querySelector('[data-testid="ar-history-by"]')!.textContent).toBe("Nightly run");
    expect(rows[1].querySelector('[data-testid="ar-history-by"]')!.textContent).toBe("Run now by Meena");
    expect(q('[data-testid="ar-history-total"]')!.textContent).toBe("2 requests rejected automatically so far");
  });
});
