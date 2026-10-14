import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  click,
  freezeClock,
  here,
  installBrowserStubs,
  installWorld,
  mountPage,
  params,
  q,
  tab,
  text,
  unmountPage,
  waitFor,
  type World,
} from "./harness";

// The page itself in jsdom, with a fake server behind customFetch: the four tabs, what lives in the address, the switch-off
// notice of the master switch, and the CTC Breakdown tab, which the overhaul left exactly as it was.

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  toast: vi.fn(),
  user: { current: null as { branchId?: number | null } | null },
}));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ token: "t", user: h.user.current }) }));
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));

let world: World;

beforeAll(installBrowserStubs);

beforeEach(() => {
  vi.clearAllMocks();
  freezeClock();
  h.user.current = null;
  world = installWorld(h.fetch);
});

afterEach(async () => {
  expect(world.unexpected).toEqual([]);
  unmountPage();
  vi.useRealTimers();
  // the CTC Breakdown tab (unchanged) leaves a 300 ms search debounce running; let it fire before the next test
  await new Promise((resolve) => setTimeout(resolve, 320));
});

const TABS = ["CTC Breakdown", "OT Detection", "Compensation Leave", "History & Reports"];

describe("the four tabs", () => {
  it("opens on CTC Breakdown with the four tabs in the owner's order", async () => {
    mountPage("/hr/compensation");
    // (the tab row draws each label twice, once for its hover animation)
    const shown = [...document.body.querySelectorAll('[role="tab"]')].map(text);
    expect(shown).toHaveLength(4);
    shown.forEach((label, i) => expect(label.startsWith(TABS[i])).toBe(true));
    expect(tab("CTC Breakdown").getAttribute("aria-selected")).toBe("true");
    for (const name of TABS.slice(1)) expect(tab(name).getAttribute("aria-selected")).toBe("false");
    await waitFor(() => !!q("ctc-row-E11"), "the CTC rows");
    expect(text(q("ctc-summary"))).toContain("1 employee");
  });

  it("has one heading named Compensation", () => {
    mountPage("/hr/compensation");
    const headings = [...document.body.querySelectorAll("h2")].map(text);
    expect(headings).toEqual(["Compensation"]);
  });

  it("switches tab and keeps it in the address; the first tab leaves the address clean", async () => {
    mountPage("/hr/compensation");
    await waitFor(() => !!q("ctc-row-E11"), "the CTC rows");
    click(tab("OT Detection"));
    expect(params()).toEqual({ tab: "ot" });
    await waitFor(() => !!q("ot-kpis"), "OT Detection");
    click(tab("Compensation Leave"));
    expect(params()).toEqual({ tab: "leave" });
    await waitFor(() => !!q("windows-part"), "Compensation Leave");
    click(tab("History & Reports"));
    expect(params()).toEqual({ tab: "history" });
    await waitFor(() => !!q("history-kpis"), "History & Reports");
    click(tab("CTC Breakdown"));
    expect(here()).toBe("/hr/compensation");
  });

  it("opens the tab and the part named in the address, and falls back to the first for one it does not know", async () => {
    mountPage("/hr/compensation?tab=leave&sub=birthdays");
    await waitFor(() => !!q("birthdays-part"), "the Birthdays part");
    expect(tab("Compensation Leave").getAttribute("aria-selected")).toBe("true");
    unmountPage();

    mountPage("/hr/compensation?tab=nonsense");
    expect(tab("CTC Breakdown").getAttribute("aria-selected")).toBe("true");
    await waitFor(() => !!q("ctc-row-E11"), "the CTC rows");
  });

  it("opens Sunday / holiday work from the Requests hub link (?tab=leave&sub=holiday-work)", async () => {
    mountPage("/hr/compensation?tab=leave&sub=holiday-work");
    await waitFor(() => !!q("holiday-part"), "the Sunday / holiday work part");
    expect(tab("Compensation Leave").getAttribute("aria-selected")).toBe("true");
    expect(q("claim-form")).not.toBeNull();
    expect(q("balance-part")).not.toBeNull();
    expect(q("windows-part")).toBeNull();
    // the part's own tab says where we are, and the address keeps it
    const parts = [...document.body.querySelectorAll('[role="tab"]')].filter((t) =>
      /^B\. Work on Sundays/.test(text(t)),
    );
    expect(parts).toHaveLength(1);
    expect(parts[0].getAttribute("aria-selected")).toBe("true");
    expect(params()).toEqual({ tab: "leave", sub: "holiday-work" });
  });

  it("reads the other spellings of a part, and opens A for one it does not know", async () => {
    mountPage("/hr/compensation?tab=leave&sub=holiday");
    await waitFor(() => !!q("holiday-part"), "the Sunday / holiday work part");
    unmountPage();
    mountPage("/hr/compensation?tab=leave&sub=nonsense");
    await waitFor(() => !!q("windows-part"), "the first part");
  });

  it("keeps the filters of one tab when another is visited", async () => {
    mountPage("/hr/compensation?tab=history&period=week");
    await waitFor(() => !!q("history-kpis"), "History");
    click(tab("OT Detection"));
    await waitFor(() => !!q("ot-kpis"), "OT");
    click(tab("History & Reports"));
    await waitFor(() => !!q("history-kpis"), "History again");
    expect(params().period).toBe("week");
  });
});

describe("the master switch", () => {
  it("shows no notice while the features are on", async () => {
    mountPage("/hr/compensation");
    await waitFor(() => !!q("ctc-row-E11"), "the page");
    expect(q("compensation-features-off")).toBeNull();
  });

  it("says what is paused and links to the switch, while everything stays readable", async () => {
    world.settings.compensationFeatureEnabled = false;
    mountPage("/hr/compensation");
    await waitFor(() => !!q("compensation-features-off"), "the notice");
    const notice = q("compensation-features-off")!;
    expect(text(notice)).toContain("The OT and Compensation features are switched off");
    expect(text(notice)).toContain("This page and every record on it stay available");
    expect(text(notice)).toContain(
      "assigning OT, announcing, raising Sunday / holiday claims and redeeming the balance are paused",
    );
    expect(notice.querySelector("a")!.getAttribute("href")).toBe("/hr/settings?tab=payroll#compensation-features");
    // the tabs still open
    for (const name of TABS.slice(1)) {
      click(tab(name));
      expect(tab(name).getAttribute("aria-selected")).toBe("true");
    }
  });

  it("does not flash the notice before the settings have come back", async () => {
    const release = world.hold("/api/payroll-settings");
    world.settings.compensationFeatureEnabled = false;
    mountPage("/hr/compensation");
    await waitFor(() => !!q("ctc-row-E11"), "the CTC rows");
    expect(q("compensation-features-off")).toBeNull();
    release();
    await waitFor(() => !!q("compensation-features-off"), "the notice");
  });
});

describe("CTC Breakdown, unchanged", () => {
  it("lists the staff with the 50% + 50% split, and says when the split is the automatic one", async () => {
    mountPage("/hr/compensation");
    await waitFor(() => !!q("ctc-row-E11"), "the CTC rows");
    const row = text(q("ctc-row-E11"));
    expect(row).toContain("Asha Kumar");
    expect(row).toContain("Sales");
    expect(row).toContain("₹6,000"); // Basic
    expect(row).toContain("₹1,440"); // employer PF
    expect(row).toContain("₹3,05,280"); // annual CTC, in Indian grouping
    expect(text(q("ctc-auto-split"))).toBe("Auto split");
    expect(text(q("ctc-summary"))).toContain("1 showing the automatic split (not recorded yet)");
  });

  it("asks the server with its filters, and offers the Excel export", async () => {
    mountPage("/hr/compensation");
    await waitFor(() => !!q("ctc-row-E11"), "the CTC rows");
    expect(world.requests()).toContain("/api/compensation?");
    const exportButton = [...document.body.querySelectorAll("button")].find((b) => text(b) === "Export to Excel");
    expect(exportButton).toBeTruthy();
    expect((exportButton as HTMLButtonElement).disabled).toBe(false);
  });

  it("hides the branch filter from a login that sees one branch only", async () => {
    h.user.current = { branchId: 2 };
    mountPage("/hr/compensation");
    await waitFor(() => !!q("ctc-row-E11"), "the CTC rows");
    expect(world.requests().some((r) => r.startsWith("/api/branches"))).toBe(false);
  });
});
