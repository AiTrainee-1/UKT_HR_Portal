import { afterEach, describe, expect, it } from "vitest";
import { setViewOnlyWorkflows, type ApprovalProgress } from "@/lib/approval-workflow";
import { isMutatingControl } from "@/lib/view-only-lock";
import { decisionCall } from "./api";
import {
  EXPORT_HEADERS,
  NO_FILTERS,
  activeFilterCount,
  buildTabs,
  daysText,
  decisionsHere,
  exportRows,
  filterItems,
  filtersActive,
  haystack,
  matchesQuery,
  normalizeHub,
  periodRange,
  rangeInvalid,
  serverParams,
  sortItems,
  statusChip,
  tabFromAddress,
  toCsv,
  waitingDays,
  waitingLine,
  type Filters,
  type HubItem,
  type HubKind,
  type HubStats,
} from "./logic";

const approval = (over: Partial<ApprovalProgress> & Pick<ApprovalProgress, "workflow">): ApprovalProgress => ({
  label: over.workflow,
  enabled: true,
  steps: [{ index: 0, roles: ["hod", "hr"], mandatory: true, state: "pending", label: "HOD or HR" }],
  currentStep: 0,
  waitingFor: ["hod", "hr"],
  canAct: { hod: true, hr: true },
  canReject: { hod: true, hr: true },
  ...over,
});

let counter = 0;
const item = (over: Partial<Omit<HubItem, "employee">> & { employee?: Partial<HubItem["employee"]> } = {}): HubItem => {
  const { employee, ...rest } = over;
  counter += 1;
  return {
    key: `leave-${counter}`,
    kind: "leave",
    id: counter,
    employee: {
      id: 1,
      code: "E001",
      name: "Asha Kumar",
      department: "Cutting",
      departmentId: 5,
      designation: "Operator",
      branch: "Unit1",
      branchId: 10,
      type: "staff",
      photoUrl: null,
      ...employee,
    },
    label: "Casual Leave",
    summary: "2026-10-12 → 2026-10-14 · 3 days",
    reason: "family function",
    date: "2026-10-12",
    details: [{ label: "From", value: "2026-10-12" }],
    status: "pending",
    rawStatus: "pending",
    statusLabel: null,
    queue: "hr",
    approval: approval({ workflow: "leave" }),
    submittedAt: "2026-10-10T08:00:00Z",
    decided: null,
    extra: {},
    ...rest,
  };
};

const kind = (over: Partial<HubKind> & Pick<HubKind, "key">): HubKind => ({
  label: over.key,
  group: "Requests",
  access: "edit",
  mode: "quick",
  openPath: null,
  openLabel: null,
  pipeline: "Employee → HOD or HR",
  enabled: true,
  waiting: 0,
  waitingHr: 0,
  waitingHod: 0,
  matched: null,
  truncated: false,
  ...over,
});

const filters = (over: Partial<Filters> = {}): Filters => ({ ...NO_FILTERS, ...over });

afterEach(() => setViewOnlyWorkflows(null));

describe("normalizeHub", () => {
  it("fills in everything a partial response leaves out", () => {
    const hub = normalizeHub({ items: [item()] });
    expect(hub.kinds).toEqual([]);
    expect(hub.items).toHaveLength(1);
    expect(hub.stats.waiting).toBe(0);
    expect(hub.stats.oldestWaiting).toBeNull();
    expect(hub.options).toEqual({ branches: [], departments: [] });
    expect(normalizeHub(null).items).toEqual([]);
  });

  it("keeps the figures the server sent and defaults the rest", () => {
    const hub = normalizeHub({ stats: { waitingHr: 4 } as HubStats });
    expect(hub.stats.waitingHr).toBe(4);
    expect(hub.stats.approvedThisMonth).toBe(0);
  });
});

describe("period and server parameters", () => {
  const now = new Date(2026, 9, 10, 15, 30); // 10 Oct 2026

  it("turns each period into a submitted-date window", () => {
    expect(periodRange("all", now)).toEqual({});
    expect(periodRange("today", now)).toEqual({ since: "2026-10-10", until: "2026-10-10" });
    expect(periodRange("week", now)).toEqual({ since: "2026-10-04", until: "2026-10-10" });
    expect(periodRange("month", now)).toEqual({ since: "2026-10-01", until: "2026-10-10" });
    expect(periodRange("custom", now, "2026-09-01", "")).toEqual({ since: "2026-09-01" });
    expect(periodRange("custom", now, "2026-09-01", "2026-09-30")).toEqual({
      since: "2026-09-01",
      until: "2026-09-30",
    });
  });

  it("a week that crosses a month end starts in the month before", () => {
    expect(periodRange("week", new Date(2026, 10, 3)).since).toBe("2026-10-28");
  });

  it("sends only what the server filters on", () => {
    expect(serverParams(NO_FILTERS, now)).toEqual({ kind: "all" });
    expect(
      serverParams(filters({ status: "approved", period: "today", branch: "10", department: "5", type: "staff" }), now),
    ).toEqual({
      kind: "all",
      status: "approved",
      since: "2026-10-10",
      until: "2026-10-10",
      branchId: "10",
      departmentId: "5",
      employeeType: "staff",
    });
  });

  it("'waiting for HR / HOD' asks the server for the waiting ones and splits them here", () => {
    for (const status of ["waiting", "waiting_hr", "waiting_hod"] as const) {
      expect(serverParams(filters({ status }), now).status, status).toBe("waiting");
    }
    expect(serverParams(filters({ query: "asha", sort: "oldest", requestType: "general" }), now)).toEqual({
      kind: "all",
    });
  });

  it("notices a range that ends before it starts", () => {
    expect(rangeInvalid(filters({ period: "custom", from: "2026-10-05", to: "2026-10-01" }))).toBe(true);
    expect(rangeInvalid(filters({ period: "custom", from: "2026-10-01", to: "2026-10-05" }))).toBe(false);
    expect(rangeInvalid(filters({ period: "month", from: "2026-10-05", to: "2026-10-01" }))).toBe(false);
  });

  it("counts the filters that narrow the list, not the search or the order", () => {
    expect(activeFilterCount(NO_FILTERS)).toBe(0);
    expect(activeFilterCount(filters({ status: "waiting", branch: "10", sort: "oldest", query: "x" }))).toBe(2);
    expect(filtersActive(filters({ query: " " }))).toBe(false);
    expect(filtersActive(filters({ query: "asha" }))).toBe(true);
    expect(filtersActive(filters({ type: "production" }))).toBe(true);
    expect(filtersActive(filters({ sort: "oldest" }))).toBe(false);
  });
});

describe("filterItems", () => {
  const leave = item({ label: "Casual Leave" });
  const waitingHod = item({
    kind: "missing_punch",
    label: "Missing Punch",
    queue: "hod",
    employee: {
      name: "Ravi Shankar",
      code: "P007",
      branchId: 11,
      branch: "Unit2",
      departmentId: 6,
      department: "Stitching",
      type: "production",
    },
  });
  const approved = item({
    status: "approved",
    rawStatus: "approved",
    queue: null,
    label: "Outpass",
    kind: "outpass",
    reason: "bank visit",
    decided: { by: "Meena", role: "hr", at: "2026-10-10T09:00:00Z", comment: "ok" },
  });
  const rejected = item({
    status: "rejected",
    rawStatus: "rejected",
    queue: null,
    kind: "request",
    label: "Salary enquiry",
    summary: "Slip query",
    extra: { requestType: "salary_enquiry" },
  });
  const general = item({ kind: "request", label: "General query", extra: { requestType: "general" } });
  const all = [leave, waitingHod, approved, rejected, general];
  const ids = (list: HubItem[]) => list.map((i) => i.key);

  it("shows everything on the All tab and one kind on a kind's tab", () => {
    expect(filterItems(all, NO_FILTERS, "all")).toHaveLength(5);
    expect(ids(filterItems(all, NO_FILTERS, "missing_punch"))).toEqual([waitingHod.key]);
    expect(ids(filterItems(all, NO_FILTERS, "request"))).toEqual([rejected.key, general.key]);
  });

  it("filters by status, splitting the waiting ones by who they are with", () => {
    expect(ids(filterItems(all, filters({ status: "waiting" }), "all"))).toEqual([
      leave.key,
      waitingHod.key,
      general.key,
    ]);
    expect(ids(filterItems(all, filters({ status: "waiting_hr" }), "all"))).toEqual([leave.key, general.key]);
    expect(ids(filterItems(all, filters({ status: "waiting_hod" }), "all"))).toEqual([waitingHod.key]);
    expect(ids(filterItems(all, filters({ status: "decided" }), "all"))).toEqual([approved.key, rejected.key]);
    expect(ids(filterItems(all, filters({ status: "approved" }), "all"))).toEqual([approved.key]);
    expect(ids(filterItems(all, filters({ status: "rejected" }), "all"))).toEqual([rejected.key]);
  });

  it("filters by branch, department and employee type", () => {
    expect(ids(filterItems(all, filters({ branch: "11" }), "all"))).toEqual([waitingHod.key]);
    expect(ids(filterItems(all, filters({ department: "6" }), "all"))).toEqual([waitingHod.key]);
    expect(ids(filterItems(all, filters({ type: "production" }), "all"))).toEqual([waitingHod.key]);
    expect(filterItems(all, filters({ type: "staff" }), "all")).toHaveLength(4);
  });

  it("filters general requests by their type and leaves other kinds alone", () => {
    expect(ids(filterItems(all, filters({ requestType: "general" }), "all"))).toEqual([
      leave.key,
      waitingHod.key,
      approved.key,
      general.key,
    ]);
    expect(ids(filterItems(all, filters({ requestType: "salary_enquiry" }), "request"))).toEqual([rejected.key]);
  });

  it("searches by employee name, code, reason, label and who decided it, every word having to match", () => {
    expect(ids(filterItems(all, filters({ query: "ravi" }), "all"))).toEqual([waitingHod.key]);
    expect(ids(filterItems(all, filters({ query: "p007" }), "all"))).toEqual([waitingHod.key]);
    expect(ids(filterItems(all, filters({ query: "bank" }), "all"))).toEqual([approved.key]);
    expect(ids(filterItems(all, filters({ query: "meena" }), "all"))).toEqual([approved.key]);
    expect(ids(filterItems(all, filters({ query: "salary slip" }), "all"))).toEqual([rejected.key]);
    expect(filterItems(all, filters({ query: "asha nobody" }), "all")).toEqual([]);
    expect(filterItems(all, filters({ query: "   " }), "all")).toHaveLength(5);
  });

  it("ANDs the search with every filter", () => {
    expect(ids(filterItems(all, filters({ query: "asha", status: "waiting_hr" }), "request"))).toEqual([general.key]);
  });

  it("the search looks at the details too", () => {
    const withDetail = item({ details: [{ label: "Destination", value: "Tirupur Court" }] });
    expect(haystack(withDetail)).toContain("tirupur court");
    expect(matchesQuery(withDetail, "court tirupur")).toBe(true);
    expect(matchesQuery(withDetail, "madurai")).toBe(false);
  });
});

describe("sortItems", () => {
  const a = item({ employee: { name: "Zoya" }, label: "Leave", submittedAt: "2026-10-01T08:00:00Z" });
  const b = item({ employee: { name: "Asha" }, label: "Outpass", submittedAt: "2026-10-05T08:00:00Z" });
  const c = item({
    employee: { name: "Meena" },
    label: "Advance",
    status: "approved",
    rawStatus: "approved",
    queue: null,
    submittedAt: "2026-10-07T08:00:00Z",
  });
  const d = item({ employee: { name: "Bala" }, label: "Permission", submittedAt: "2026-10-03T08:00:00Z" });
  const keys = (list: HubItem[]) => list.map((i) => i.key);

  it("orders by submission time either way", () => {
    expect(keys(sortItems([a, b, c, d], "latest"))).toEqual([c.key, b.key, d.key, a.key]);
    expect(keys(sortItems([a, b, c, d], "oldest"))).toEqual([a.key, d.key, b.key, c.key]);
  });

  it("puts the longest-waiting request first, and decided ones after the waiting ones", () => {
    expect(keys(sortItems([c, b, a, d], "waiting"))).toEqual([a.key, d.key, b.key, c.key]);
  });

  it("orders by employee and by request type", () => {
    expect(keys(sortItems([a, b, c, d], "employee"))).toEqual([b.key, d.key, c.key, a.key]);
    expect(keys(sortItems([a, b, c, d], "kind"))).toEqual([c.key, a.key, b.key, d.key]);
  });

  it("does not change the list it was given", () => {
    const list = [a, b];
    sortItems(list, "oldest");
    expect(list).toEqual([a, b]);
  });
});

describe("tabs", () => {
  const kinds = [
    kind({ key: "leave", label: "Leave", waiting: 3 }),
    kind({ key: "advance", label: "Advance", waiting: 0 }),
  ];
  const stats = { ...normalizeHub(null).stats, waiting: 3 };

  it("an All tab and one per kind, each with its waiting count and no badge when nothing waits", () => {
    expect(buildTabs(kinds, stats)).toEqual([
      { value: "all", label: "All", count: 3 },
      { value: "leave", label: "Leave", count: 3 },
      { value: "advance", label: "Advance", count: undefined },
    ]);
    expect(buildTabs([], normalizeHub(null).stats)).toEqual([{ value: "all", label: "All", count: undefined }]);
  });

  it("reads the tab from the address only when it names a kind on offer", () => {
    expect(tabFromAddress("leave", kinds)).toBe("leave");
    expect(tabFromAddress("resignation", kinds)).toBe("all");
    expect(tabFromAddress(null, kinds)).toBe("all");
  });
});

describe("status chip and waiting", () => {
  it("says approved / rejected plainly and uses the request's own words while waiting", () => {
    expect(statusChip(item({ status: "approved", rawStatus: "approved" }))).toEqual({
      label: "approved",
      tone: "success",
    });
    expect(statusChip(item({ status: "rejected", rawStatus: "rejected" }))).toEqual({
      label: "rejected",
      tone: "danger",
    });
    expect(statusChip(item())).toEqual({ label: "pending", tone: "warning" });
    expect(statusChip(item({ kind: "request", statusLabel: "More info needed" })).label).toBe("More info needed");
  });

  it("a permission speaks the policy's words", () => {
    const base = {
      kind: "permission" as const,
      extra: { typeKey: "morning_late_in", statusLabel: "Allowed", capStatus: "within_cap" },
    };
    expect(statusChip(item({ ...base, status: "approved", rawStatus: "approved" }))).toEqual({
      label: "Allowed",
      tone: "success",
    });
    expect(
      statusChip(
        item({ kind: "permission", status: "rejected", rawStatus: "rejected", extra: { statusLabel: "Not Allowed" } }),
      ).tone,
    ).toBe("danger");
  });

  it("counts whole days of waiting, and none once decided", () => {
    const now = new Date("2026-10-13T09:00:00Z");
    expect(waitingDays(item({ submittedAt: "2026-10-10T08:00:00Z" }), now)).toBe(3);
    expect(waitingDays(item({ submittedAt: "2026-10-13T08:00:00Z" }), now)).toBe(0);
    expect(
      waitingDays(item({ status: "approved", rawStatus: "approved", submittedAt: "2026-09-01T08:00:00Z" }), now),
    ).toBe(0);
    expect(daysText(0)).toBe("today");
    expect(daysText(1)).toBe("1 day");
    expect(daysText(9)).toBe("9 days");
  });

  it("names who a waiting request is with, and nobody once it is decided", () => {
    const hodFirst = approval({ workflow: "missing_punch", waitingFor: ["hod"], canAct: { hod: true, hr: false } });
    expect(waitingLine(item({ approval: hodFirst }))).toBe("Waiting for HOD");
    expect(
      waitingLine(
        item({
          status: "approved",
          rawStatus: "approved",
          approval: { ...hodFirst, currentStep: null, waitingFor: [] },
        }),
      ),
    ).toBeNull();
  });
});

describe("decisionsHere: what HR may press on this page", () => {
  const quick = kind({ key: "leave", mode: "quick" });
  const nothing = { approve: false, reject: false, needsType: false, notes: false };

  it("approve and reject when it is HR's turn", () => {
    expect(decisionsHere(item(), quick)).toMatchObject({ approve: true, reject: true });
  });

  it("nothing while the request is with the HOD, and it says why", () => {
    const waiting = approval({
      workflow: "missing_punch",
      steps: [
        { index: 0, roles: ["hod"], mandatory: true, state: "pending", label: "HOD" },
        { index: 1, roles: ["hr"], mandatory: true, state: "waiting", label: "HR" },
      ],
      waitingFor: ["hod"],
      canAct: { hod: true, hr: false },
      canReject: { hod: true, hr: false },
    });
    const here = decisionsHere(item({ approval: waiting }), quick);
    expect(here).toMatchObject(nothing);
    expect(here.why).toContain("Waiting for HOD");
  });

  it("HR may reject a resignation-like request out of turn but not approve it", () => {
    const outOfTurn = approval({
      workflow: "leave",
      canAct: { hod: true, hr: false },
      canReject: { hod: true, hr: true },
    });
    expect(decisionsHere(item({ approval: outOfTurn }), quick)).toMatchObject({ approve: false, reject: true });
  });

  it("nothing once decided", () => {
    expect(decisionsHere(item({ status: "approved", rawStatus: "approved" }), quick)).toMatchObject(nothing);
  });

  it("nothing for a role that may only view the kind", () => {
    const here = decisionsHere(item(), kind({ key: "leave", access: "view" }));
    expect(here).toMatchObject(nothing);
    expect(here.why).toContain("view");
  });

  it("nothing when the Managing Director's pages mark the workflow view-only", () => {
    setViewOnlyWorkflows(["leave"]);
    expect(decisionsHere(item(), quick)).toMatchObject(nothing);
    setViewOnlyWorkflows(null);
    expect(decisionsHere(item(), quick).approve).toBe(true);
  });

  it("kinds that need their own page never offer a button here", () => {
    for (const key of ["resignation", "advance", "on_duty_punch", "attendance_correction"] as const) {
      expect(
        decisionsHere(item({ kind: key }), kind({ key, mode: "link", openPath: "/hr/x", openLabel: "X" })),
        key,
      ).toMatchObject(nothing);
    }
  });

  it("general requests get the status-and-notes form instead of Approve / Reject", () => {
    const here = decisionsHere(
      item({ kind: "request", approval: approval({ workflow: "request", canAct: { hod: false, hr: true } }) }),
      kind({ key: "request", mode: "notes" }),
    );
    expect(here).toMatchObject({ approve: false, reject: false, notes: true });
  });

  it("a permission with no type is approved on the Leave page, where its type can be set", () => {
    const untyped = item({ kind: "permission", extra: { typeKey: null } });
    expect(decisionsHere(untyped, kind({ key: "permission" }))).toMatchObject({
      approve: false,
      needsType: true,
      reject: true,
    });
    const typed = item({ kind: "permission", extra: { typeKey: "morning_late_in" } });
    expect(decisionsHere(typed, kind({ key: "permission" }))).toMatchObject({ approve: true, needsType: false });
  });

  it("a request from an older backend with no approval block falls back to its status", () => {
    expect(decisionsHere(item({ approval: null }), quick)).toMatchObject({ approve: true, reject: true });
  });
});

describe("the endpoint each kind is decided on", () => {
  it("goes to the kind's own status endpoint, so the approval pipeline decides", () => {
    const call = (k: HubItem["kind"]) =>
      decisionCall({ item: { kind: k, id: 7 }, status: "approved", comment: " fine " });
    expect(call("leave")).toEqual({
      url: "/api/leave-requests/7/status",
      method: "PATCH",
      body: { status: "approved", hrComment: "fine" },
    });
    expect(call("permission")).toMatchObject({ url: "/api/permissions/7", method: "PUT" });
    expect(call("casual_leave")).toMatchObject({
      url: "/api/casual-leaves/7",
      method: "PATCH",
      body: { comment: "fine" },
    });
    expect(call("missing_punch")).toMatchObject({ url: "/api/missing-punch-requests/7/status", method: "PATCH" });
    expect(call("on_duty")).toMatchObject({ url: "/api/on-duty-sessions/7/status", method: "PATCH" });
    expect(call("outpass")).toMatchObject({ url: "/api/outpass-requests/7/hr-status", method: "PUT" });
  });

  it("has no button endpoint for the kinds that open their own page", () => {
    for (const k of ["resignation", "advance", "on_duty_punch", "attendance_correction", "request"] as const) {
      expect(decisionCall({ item: { kind: k, id: 1 }, status: "rejected" }), k).toBeNull();
    }
  });

  it("sends no empty comment", () => {
    expect(
      decisionCall({ item: { kind: "leave", id: 1 }, status: "rejected", comment: "  " })?.body.hrComment,
    ).toBeUndefined();
  });
});

describe("export", () => {
  const decided = item({
    status: "approved",
    rawStatus: "approved",
    queue: null,
    employee: { name: 'Asha "Ace" Kumar', code: "E001", type: "production" },
    reason: "line one,\nline two",
    decided: { by: "Meena", role: "hr", at: "2026-10-10T09:15:00Z", comment: "ok" },
  });

  it("one row per request in the header's columns", () => {
    const rows = exportRows([decided, item({ kind: "advance" })], { leave: "Leave", advance: "Advance" });
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toHaveLength(EXPORT_HEADERS.length);
    expect(rows[0].slice(0, 4)).toEqual(["Leave", "Casual Leave", "E001", 'Asha "Ace" Kumar']);
    expect(rows[0][6]).toBe("Production");
    expect(rows[0][10]).toBe("approved");
    expect(rows[0].slice(12)).toEqual(["Meena", "2026-10-10 09:15", "ok"]);
    expect(rows[1][0]).toBe("Advance");
    expect(rows[1][11]).toBe("Waiting for HOD or HR");
    expect(rows[0][11]).toBe("");
  });

  it("a CSV starts with a BOM and a header, and quotes what needs it", () => {
    const csv = toCsv(exportRows([decided]));
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe(EXPORT_HEADERS.join(","));
    expect(csv).toContain('"Asha ""Ace"" Kumar"');
    expect(csv).toContain('"line one,\nline two"');
    expect(toCsv([]).slice(1)).toBe(`${EXPORT_HEADERS.join(",")}\r\n`);
  });
});

describe("the Managing Director's view-only lock and this page's controls", () => {
  const button = (label: string, attrs: Record<string, string> = {}) => {
    const el = document.createElement("button");
    el.textContent = label;
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };

  it("keeps the decision buttons recognisable so the lock can disable them", () => {
    for (const label of ["Approve", "Reject", "Confirm reject", "Set type & approve"]) {
      expect(isMutatingControl(button(label)), label).toBe(true);
    }
  });

  it("leaves every browsing control of the page alone", () => {
    const browsing = [
      "All",
      "Leave (3)",
      "Missing Punch (1)",
      "Other requests (2)",
      "Attendance correction",
      "Clear filters",
      "Show 50 more (120 left)",
      "Retry",
      "Open in Geo Attendance",
      "Open in Leave & Holiday",
      "Cancel",
      "Waiting for HR now HR can decide these today",
      "Approved this month",
      "Rejected this month",
      "Oldest waiting Asha Kumar · Leave",
      "Latest submitted",
      "Oldest submitted",
      "Longest waiting first",
      "Employee A to Z",
      "Request type",
      "Any status",
      "Waiting for HOD",
      "Decided",
      "Last 7 days",
      "Custom range",
      "Staff and production",
      "Every kind of request",
    ];
    for (const label of browsing) expect(isMutatingControl(button(label)), label).toBe(false);
  });

  it("the download is read-only, so it is marked to stay usable", () => {
    const wrapper = document.createElement("span");
    wrapper.setAttribute("data-view-safe", "");
    const exportButton = button("Export");
    wrapper.append(exportButton);
    expect(isMutatingControl(exportButton)).toBe(false);
    expect(isMutatingControl(button("Export"))).toBe(true);
  });
});
