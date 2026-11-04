import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-client/custom-fetch";
import type { HodPending } from "@/lib/api-client/custom-hooks";
import { isMutatingControl, lockMutatingControls } from "@/lib/view-only-lock";
import { CATEGORIES, HOD_PENDING, KUMAR, MEENA, RAVI } from "../fixtures";
import HodImageSheet from "./HodImageSheet";
import HodsTab from "./HodsTab";
import ShareDialog from "./ShareDialog";

// HoD's in jsdom with the data hooks mocked (the server shapes come from ../fixtures): the four figures, the board (a dash for a
// category the head may not decide, the totals row), the search and "only with pending", the drill-down (grouped, oldest
// first, a link into Requests), the phone cards, the empty / not-there states, the exports and the share dialog.

const h = vi.hoisted(() => ({
  phone: false,
  pending: { data: undefined as HodPending | undefined, isError: false, error: null as unknown, isFetching: false },
  params: [] as unknown[],
  refetch: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => h.phone }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("../../report-log/useCompany", () => ({
  useCompany: () => ({
    excel: { company: "UK Textiles", branchLabel: "All Branches", logoDataUrl: null },
    sheet: { name: "UK Textiles", branchLabel: "All Branches", logoUrl: null },
  }),
}));
vi.mock("@/lib/api-client/custom-hooks/hod-reminders", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-hooks/hod-reminders")>()),
  useHodPending: (params: unknown) => {
    h.params.push(params);
    return { ...h.pending, refetch: h.refetch };
  },
}));
vi.mock("@/lib/api-client/custom-hooks/organization", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-hooks/organization")>()),
  useListBranches: () => ({
    data: [
      { id: 1, name: "Head Office" },
      { id: 2, name: "Unit 1" },
    ],
  }),
}));
vi.mock("@/lib/api-client/generated/api", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/generated/api")>()),
  useListDepartments: () => ({ data: [{ id: 5, name: "Cutting" }] }),
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

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  h.phone = false;
  h.pending = { data: HOD_PENDING, isError: false, error: null, isFetching: false };
  h.params = [];
  vi.clearAllMocks();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(node: React.ReactElement) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

const q = (id: string) => document.body.querySelector(`[data-testid="${id}"]`);
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const click = (el: Element | null) => act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
function typeInto(el: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const rowIds = () =>
  [...document.body.querySelectorAll('[data-testid^="hod-row-"]')].map((r) => r.getAttribute("data-testid"));

describe("the HoD's board", () => {
  it("shows the four figures from the heads", () => {
    mount(createElement(HodsTab, { onOpenRequest: vi.fn() }));
    expect(text(q("hods-figure-hods-value"))).toBe("3");
    expect(text(q("hods-figure-with-pending-value"))).toBe("2");
    expect(text(q("hods-figure-pending-value"))).toBe("5");
    expect(text(q("hods-figure-oldest-value"))).toBe("8 days");
    expect(text(q("hods-figure-oldest"))).toContain("Ravi Shankar · Missing Punch");
  });

  it("is a row per head, most pending first, a dash where a head may not decide, and the totals", () => {
    mount(createElement(HodsTab, { onOpenRequest: vi.fn() }));
    expect(rowIds()).toEqual(["hod-row-1", "hod-row-2", "hod-row-3"]);
    const ravi = q("hod-row-1")!;
    expect(text(ravi)).toContain("Ravi Shankar");
    expect(text(q("hod-total-1"))).toBe("4");
    // Ravi may not approve casual leave: a dash; Meena may, and has one
    const cells = [...ravi.querySelectorAll("td")].map(text);
    const col = 2 + CATEGORIES.findIndex((c) => c.key === "casual_leave"); // after the HoD and the Total columns
    expect(cells[col]).toBe("—");
    expect(q("hod-cell-2-casual_leave")).not.toBeNull();
    expect(text(q("hods-figure-oldest"))).toContain("Missing Punch");
    expect(text(q("hod-totals-casual_leave"))).toBe("1");
    expect(text(q("hod-totals-all"))).toBe("5");
    // only the kinds with something pending get a column: nothing is waiting in On-Duty, Outpass or Resignation
    for (const key of ["on_duty", "outpass", "resignation", "attendance"])
      expect(q(`hod-totals-${key}`), key).toBeNull();
    for (const key of ["leave", "permission", "casual_leave", "missing_punch"])
      expect(q(`hod-totals-${key}`), key).not.toBeNull();
    // the board asks the server with no narrowing at first
    expect(h.params[0]).toEqual({});
  });

  it("searches by a waiting employee, narrows to heads with pending, and clears", () => {
    mount(createElement(HodsTab, { onOpenRequest: vi.fn() }));
    typeInto(q("hods-search") as HTMLInputElement, "divya");
    expect(rowIds()).toEqual(["hod-row-2"]);
    expect(text(q("hods-count"))).toContain("Showing 1 of 3 HoDs");
    typeInto(q("hods-search") as HTMLInputElement, "");
    click(q("hods-only-pending"));
    expect(rowIds()).toEqual(["hod-row-1", "hod-row-2"]);
    expect(q("hods-figure-with-pending")?.getAttribute("aria-pressed")).toBe("true");
    typeInto(q("hods-search") as HTMLInputElement, "nobody at all");
    expect(q("hods-no-match")).not.toBeNull();
    click(q("hods-clear-filters"));
    expect(rowIds()).toHaveLength(3);
  });

  it("opens a head's detail: grouped by category, oldest first, and a link that opens the request in Requests", () => {
    const onOpenRequest = vi.fn();
    mount(createElement(HodsTab, { onOpenRequest }));
    click(q("hod-cell-1-leave"));
    const dialog = q("hod-detail")!;
    expect(dialog).not.toBeNull();
    expect(text(q("hod-detail-total"))).toBe("4 pending");
    const sections = [...dialog.querySelectorAll("section")].map((s) => s.getAttribute("aria-label"));
    expect(sections).toEqual(["Leave", "Permission", "Missing Punch"]);
    const leaves = [...dialog.querySelectorAll('section[aria-label="Leave"] li')].map((li) =>
      li.getAttribute("data-testid"),
    );
    expect(leaves).toEqual(["hod-item-leave-12", "hod-item-leave-14"]);
    expect(text(q("hod-detail-not-allowed"))).toContain("Casual Leave");
    expect(text(q("hod-reach"))).toContain("WhatsApp number on file");
    const link = q("hod-item-open-missing_punch-7") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/hr/requests?kind=missing_punch&focus=7");
    // a real click can be cancelled: the page switches in place instead of loading the address
    let followed = true;
    act(() => {
      followed = link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(followed).toBe(false);
    expect(onOpenRequest).toHaveBeenCalledWith("/hr/requests?kind=missing_punch&focus=7");
    expect(q("hod-detail")).toBeNull();
  });

  it("says when a head has nothing waiting, and how the reminder cannot reach them", () => {
    mount(createElement(HodsTab, { onOpenRequest: vi.fn() }));
    click(q("hod-open-2"));
    expect(text(q("hod-reach"))).toContain("No phone number");
    expect(text(q("hod-reach"))).toContain("No phone registered for notifications");
    act(() => root!.render(createElement(HodsTab, { onOpenRequest: vi.fn() })));
    click(document.body.querySelector('[data-testid="hod-detail"] button[class*="absolute"]'));
    click(q("hod-open-3"));
    expect(q("hod-detail-empty")).not.toBeNull();
  });

  it("is a card per head on a phone", () => {
    h.phone = true;
    mount(createElement(HodsTab, { onOpenRequest: vi.fn() }));
    expect(q("hod-table")).toBeNull();
    expect(q("hod-cards")).not.toBeNull();
    expect(rowIds()).toEqual(["hod-row-1", "hod-row-2", "hod-row-3"]);
    expect(text(q("hod-row-1"))).toContain("Leave 2");
    expect(text(q("hod-row-1"))).toContain("4 pending");
  });

  it("keeps the exports and the share button usable for a View Only role", () => {
    mount(createElement(HodsTab, { onOpenRequest: vi.fn() }));
    lockMutatingControls(document.body);
    const exportButton = q("hods-export") as HTMLButtonElement;
    expect(exportButton.closest("[data-view-safe]")).not.toBeNull();
    expect(exportButton.disabled).toBe(false);
    expect(isMutatingControl(q("hods-share") as HTMLButtonElement)).toBe(false);
    expect((q("hods-share") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("the other states", () => {
  it("shows a loader, then says plainly when the server does not have the summary yet", () => {
    h.pending = { data: undefined, isError: false, error: null, isFetching: true };
    mount(createElement(HodsTab, { onOpenRequest: vi.fn() }));
    expect(q("skeleton-kpis")).not.toBeNull();
    h.pending = {
      data: undefined,
      isError: true,
      error: new ApiError(new Response("{}", { status: 404 }), {}, { method: "GET", url: "/api/hr/hod-pending" }),
      isFetching: false,
    };
    act(() => root!.render(createElement(HodsTab, { onOpenRequest: vi.fn() })));
    expect(text(q("hods-unavailable"))).toContain("not available on this server yet");
  });

  it("offers a retry for any other failure, and an empty note when there is no HoD", () => {
    h.pending = { data: undefined, isError: true, error: new Error("offline"), isFetching: false };
    mount(createElement(HodsTab, { onOpenRequest: vi.fn() }));
    click([...document.body.querySelectorAll("button")].find((b) => text(b) === "Retry") ?? null);
    expect(h.refetch).toHaveBeenCalled();
    h.pending = { data: { ...HOD_PENDING, hods: [] }, isError: false, error: null, isFetching: false };
    act(() => root!.render(createElement(HodsTab, { onOpenRequest: vi.fn() })));
    expect(q("hods-empty")).not.toBeNull();
    expect((q("hods-share") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the picture and the share dialog", () => {
  it("draws the board for the picture: every head, a dash where not allowed, the totals", () => {
    mount(
      createElement(HodImageSheet, {
        testId: "sheet",
        input: {
          rows: [KUMAR, MEENA, RAVI],
          categories: CATEGORIES,
          company: "UK Textiles",
          branchLabel: "All Branches",
          scope: "",
          now: new Date(2026, 10, 4, 10, 30),
        },
      }),
    );
    const sheet = q("sheet")!;
    const rows = [...sheet.querySelectorAll("tbody tr")].map((r) => text(r.querySelector("td")));
    expect(rows).toEqual(["Ravi Shankar", "Meena Rani", "Kumar Vel", "Total"]);
    expect(text(sheet)).toContain("04 Nov 2026");
    expect(text(q("sheet-figures"))).toContain("5 requests waiting");
  });

  it("offers the picture and the PDF, and copies the summary", async () => {
    const onShare = vi.fn().mockResolvedValue("downloaded");
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    mount(createElement(ShareDialog, { open: true, onClose: vi.fn(), summary: "*Pending* 5", onShare }));
    // jsdom cannot share files: the buttons say they download
    expect(text(q("hod-share-png"))).toBe("Download picture (PNG)");
    expect((q("hod-share-summary") as HTMLTextAreaElement).value).toBe("*Pending* 5");
    await act(async () => {
      q("hod-share-png")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onShare).toHaveBeenCalledWith("png");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Picture downloaded" }));
    await act(async () => {
      q("hod-share-copy")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(writeText).toHaveBeenCalledWith("*Pending* 5");
    expect(q("hod-share")?.hasAttribute("data-view-safe")).toBe(true);
  });
});
