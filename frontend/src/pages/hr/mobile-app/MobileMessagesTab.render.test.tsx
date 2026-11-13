import { act, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { renderMdPage, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import { useAuth } from "@/contexts/AuthContext";
import MobileMessagesTab from "./MobileMessagesTab";

// Mobile App Login -> Mobile Messages: the overview, the switches over what is pushed to phones, the message log, the phones
// list and sending one message. Nothing touches a network: every request is answered from a fixture.

const COUNTS = { total: 5, sent: 3, noDevice: 1, failed: 1, off: 0 };
const overview = (over: Record<string, unknown> = {}) => ({
  pushEnabled: true,
  switchedOff: 0,
  devices: { employees: 40, withDevice: 31, withoutDevice: 9, tokens: 33, lastRegisteredAt: "2026-10-30T09:00:00Z" },
  today: COUNTS,
  week: { ...COUNTS, total: 30, sent: 24 },
  month: { ...COUNTS, total: 120, sent: 100 },
  readRate: 61.5,
  byKind: [{ label: "Late Attendance Alert", count: 12 }],
  byDay: Array.from({ length: 14 }, (_, i) => ({
    date: `2026-10-${String(17 + i).padStart(2, "0")}`,
    total: i,
    sent: i,
  })),
  ...over,
});

const control = (key: string, label: string, group: string, enabled = true, kind = "message") => ({
  key,
  label,
  description: `About ${label}`,
  group,
  groupLabel: group === "attendance" ? "Attendance" : "Approvals by workflow",
  kind,
  enabled,
});
const controls = (pushEnabled = true) => ({
  pushEnabled,
  controls: [
    control("late_alert", "Late Attendance Alert", "attendance"),
    control("approval:leave", "Leave", "approval_workflows", true, "workflow"),
  ],
  updatedBy: null,
  updatedAt: null,
});

const row = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  employeeId: 7,
  employeeName: "Asha Kumar",
  employeeCode: "E7",
  title: "⏰ Late Attendance",
  message: "Hi Asha, your attendance has been marked as Late today.",
  type: "attendance",
  kind: "Late Attendance Alert",
  source: "late_alert",
  pushStatus: "delivered",
  pushStatusLabel: "Delivered to the phone",
  pushError: null,
  isRead: false,
  createdAt: "2026-10-30T09:30:00Z",
  pushedAt: "2026-10-30T09:30:01Z",
  ...over,
});
const paged = (items: unknown[]) => ({ items, total: items.length, page: 1, pageSize: 20 });

// The sections follow the role's Mobile App Login keys (an HR login with none set sees none of them), so the page is opened
// by an HR login that may edit Mobile App Login unless a test says otherwise.
const signedIn = (permissions: Record<string, string>) => ({
  role: "hr",
  employeeId: null,
  name: "Test HR",
  isSuperAdmin: false,
  permissions,
});

/** Like the app's ProtectedRoute: the page is drawn once the login is known. */
function SignedIn({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  return user ? <>{children}</> : null;
}

let page: RenderedPage | undefined;
afterEach(() => {
  page?.unmount();
  page = undefined;
});

const open = async (fixtures: Record<string, unknown> = {}) => {
  page = await renderMdPage(
    () => (
      <SignedIn>
        <MobileMessagesTab />
      </SignedIn>
    ),
    {
      "/api/auth/me": signedIn({ mobile_app_login: "edit" }),
      "/api/mobile-app/messages/overview": overview(),
      "/api/mobile-app/messages/controls": controls(),
      "/api/mobile-app/messages/log": paged([
        row(1),
        row(2, {
          pushStatus: "no_device",
          pushStatusLabel: "No phone registered",
          title: "❌ Request Rejected",
          kind: "Approval - Rejected: Leave",
        }),
      ]),
      "/api/mobile-app/messages/devices": paged([
        {
          id: 7,
          name: "Asha Kumar",
          employeeCode: "E7",
          employmentType: "staff",
          phone: "9000000001",
          devices: 1,
          lastRegisteredAt: "2026-10-30T09:00:00Z",
        },
        {
          id: 8,
          name: "Ravi Nair",
          employeeCode: "E8",
          employmentType: "production",
          phone: null,
          devices: 0,
          lastRegisteredAt: null,
        },
      ]),
      ...fixtures,
    } as never,
    { path: "/hr/mobile-app-login" },
  );
  return page;
};

const body = (init?: RequestInit) => JSON.parse(String(init?.body ?? "{}"));

/** Press the tab whose words match (the sections are PillTabs buttons). */
const go = async (label: string) => {
  const button = [...page!.container.querySelectorAll("button")].find((b) => b.textContent?.includes(label));
  if (!button)
    throw new Error(`No "${label}" tab. The page shows:
${page!.text()}`);
  await act(async () => {
    button.click();
  });
  await page!.settle();
};

describe("Mobile Messages", () => {
  it("opens on the overview: phones ready, what was pushed, and the kinds of message", async () => {
    await open();
    const text = page!.text();
    for (const needle of [
      "31 / 40",
      "No phone yet",
      "61.5%",
      "Late Attendance Alert",
      "Today",
      "Last 7 days",
      "3 sent to phones",
      "1 failed",
    ]) {
      expect(text, needle).toContain(needle);
    }
    expect(text).not.toContain("switched OFF");
  });

  it("offers only the sections the role may see, opens the first of them and asks nothing for a hidden one", async () => {
    await open({
      "/api/auth/me": signedIn({
        mobile_app_login: "edit",
        "mobile_app_login.messages.overview": "hidden",
        "mobile_app_login.messages.send": "hidden",
      }),
    });
    expect(page!.container.querySelector('[data-testid="mm-controls"]')).not.toBeNull();
    expect(page!.container.querySelector('[data-testid="mm-overview"]')).toBeNull();
    const labels = [...page!.container.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(labels.some((l) => l.includes("Send a message"))).toBe(false);
    expect(labels.some((l) => l.includes("Overview"))).toBe(false);
    expect(page!.requests().some((r) => r.startsWith("/api/mobile-app/messages/overview"))).toBe(false);
  });

  it("says so when no section is open to the role", async () => {
    await open({
      "/api/auth/me": signedIn({ mobile_app_login: "edit", "mobile_app_login.messages": "hidden" }),
    });
    expect(page!.container.querySelector('[data-testid="mobile-messages-nothing-open"]')).not.toBeNull();
    expect(page!.requests().some((r) => r.startsWith("/api/mobile-app/messages"))).toBe(false);
  });

  it("marks a View-only section of an editable page, and only that one", async () => {
    await open({
      "/api/auth/me": signedIn({ mobile_app_login: "edit", "mobile_app_login.messages.send": "view" }),
    });
    expect(page!.container.querySelector('[data-testid="tab-view-only"]')).toBeNull();
    await go("Send a message");
    expect(page!.container.querySelector('[data-testid="tab-view-only"]')).not.toBeNull();
  });

  it("does not offer the overview's shortcut to Controls when Controls is hidden", async () => {
    await open({
      "/api/auth/me": signedIn({ mobile_app_login: "edit", "mobile_app_login.messages.controls": "hidden" }),
      "/api/mobile-app/messages/overview": overview({ pushEnabled: false }),
    });
    expect(page!.text()).toContain("Phone notifications are switched OFF");
    expect(page!.text()).not.toContain("Switch them on");
  });

  it("explains on the overview when no phone has registered at all", async () => {
    await open({
      "/api/mobile-app/messages/overview": overview({
        devices: { employees: 40, withDevice: 0, withoutDevice: 40, tokens: 0, lastRegisteredAt: null },
      }),
    });
    expect(page!.text()).toContain("No phone has registered for notifications yet");
    expect(page!.text()).toContain("Firebase");
  });

  it("warns on the overview when phone notifications are switched off", async () => {
    await open({ "/api/mobile-app/messages/overview": overview({ pushEnabled: false }) });
    expect(page!.text()).toContain("Phone notifications are switched OFF");
  });

  it("the controls explain that only the push stops, and switch one kind or everything off", async () => {
    const sent: unknown[] = [];
    await open({
      "/api/mobile-app/messages/controls": (_p: URLSearchParams, init?: RequestInit) => {
        if (init?.method === "PUT") {
          sent.push(body(init));
          return controls(!("pushEnabled" in body(init)));
        }
        return controls();
      },
    });
    await go("Controls");
    const text = page!.text();
    expect(text).toContain("only stop the push to the phone");
    expect(text).toContain("never sent this way");
    for (const label of ["Late Attendance Alert", "Leave", "Approvals by workflow"])
      expect(text, label).toContain(label);
    await page!.click('[data-testid="mm-toggle-late_alert"]');
    await page!.click('[data-testid="mm-toggle-approval:leave"]');
    await page!.click('[data-testid="mm-master"]');
    expect(sent).toEqual([
      { types: { late_alert: false } },
      { types: { "approval:leave": false } },
      { pushEnabled: false },
    ]);
  });

  it("the messages list shows each push result and filters through the server", async () => {
    await open();
    await go("Messages");
    const text = page!.text();
    for (const needle of [
      "Asha Kumar",
      "(E7)",
      "Late Attendance Alert",
      "Delivered to the phone",
      "No phone registered",
      "Not opened",
      "Approval - Rejected: Leave",
    ]) {
      expect(text, needle).toContain(needle);
    }
    const select = page!.container.querySelector<HTMLSelectElement>('select[aria-label="Push result"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "no_device");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page!.settle();
    expect(page!.requests().some((r) => r.includes("/log?") && r.includes("status=no_device"))).toBe(true);
  });

  it("the phones list says who has a phone registered and who has none", async () => {
    await open();
    await go("Phones");
    const text = page!.text();
    expect(text).toContain("1 phone");
    expect(text).toContain("No phone yet");
    expect(text).toContain("Production");
  });

  it("sends one message to one chosen employee", async () => {
    const posted: unknown[] = [];
    await open({
      "/api/mobile-app/messages/send": (_p: URLSearchParams, init?: RequestInit) => {
        posted.push(body(init));
        return row(9, { title: "Test", message: "Does this reach?", kind: "Message from HR" });
      },
    });
    await go("Send a message");
    const send = () => page!.container.querySelector<HTMLButtonElement>('[data-testid="mm-send-button"]')!;
    expect(send().disabled).toBe(true);
    await page!.click('[data-testid="mm-pick-E7"]');
    expect(page!.text()).toContain("To Asha Kumar");
    await page!.type('[data-testid="mm-title"]', "Test");
    await page!.type('[data-testid="mm-message"]', "Does this reach?");
    expect(send().disabled).toBe(false);
    await page!.click('[data-testid="mm-send-button"]');
    expect(posted).toEqual([{ employeeId: 7, title: "Test", message: "Does this reach?" }]);
  });

  it("a person with no phone is told the message will only be in the app", async () => {
    await open();
    await go("Send a message");
    await page!.click('[data-testid="mm-pick-E8"]');
    expect(page!.text()).toContain("only be in the app");
  });
});
