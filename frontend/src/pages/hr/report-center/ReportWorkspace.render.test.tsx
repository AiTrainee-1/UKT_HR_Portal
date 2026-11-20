// The Report Center workspace, rendered (jsdom): the fixes of the 2026-11-19 round, one block each. The page is the
// workspace inside a box that scrolls (as HrLayout's main does), driven by the URL like /hr/reports.

import { act, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSearchParams } from "wouter";
import { useReportCatalog } from "@/lib/api-client/custom-hooks";
import type { ReportCatalog, ReportFilter, ReportMeta, ReportRunResult } from "@/lib/report-center";
import { _resetPrefsCache } from "@/lib/report-prefs";
import { renderMdPage, type Fixtures, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import { ReportNavRail } from "./ReportNavRail";
import { ReportWorkspace } from "./ReportWorkspace";

const toastSpy = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastSpy }), toast: toastSpy }));

const ID = "late-detection";
const RUN = `/api/reports/run/${ID}`;
const EXPORT = `/api/reports/export/${ID}`;

const filter = (over: Partial<ReportFilter> & Pick<ReportFilter, "key" | "kind" | "label">): ReportFilter => ({
  required: false,
  multi: false,
  default: null,
  ...over,
});

const FILTERS: ReportFilter[] = [
  filter({ key: "period", kind: "period", label: "Month", required: true, default: "2026-11" }),
  filter({ key: "department", kind: "department", label: "Department", multi: true, default: [] }),
  filter({ key: "employee", kind: "employee", label: "Employees", multi: true, default: [] }),
  filter({ key: "employeeStatus", kind: "employeeStatus", label: "Employee status", default: "active" }),
  filter({ key: "includeOffDays", kind: "boolean", label: "Include days off", default: true }),
  filter({ key: "q", kind: "text", label: "Name contains" }),
];

const spec = (over: Partial<ReportMeta> = {}): ReportMeta => ({
  id: ID,
  title: "Late Detection Report",
  description: "Every late arrival with its arrival zone.",
  category: "attendance",
  icon: "Clock",
  tags: [],
  family: null,
  variant: null,
  landscape: true,
  filters: FILTERS,
  columns: [],
  dynamicColumns: false,
  exports: ["xlsx", "pdf"],
  exportLimits: { screen: 10_000, xlsx: 30_000, pdf: 5_000 },
  autoRun: true,
  ...over,
});

const catalog = (over: Partial<ReportMeta> = {}): ReportCatalog => ({
  generatedAt: "2026-11-19 10:00",
  branchScoped: false,
  categories: [
    { id: "attendance", label: "Attendance", description: "", icon: "CalendarCheck", count: 1 },
    { id: "shift", label: "Shift", description: "", icon: "Clock", count: 0 },
  ],
  reports: [spec(over)],
  options: {
    departments: [
      { id: 3, name: "CUTTING" },
      { id: 4, name: "SEWING" },
    ],
    designations: [],
    branches: [],
  },
});

const ROWS = [
  { code: "E001", name: "Asha Kumar", day: "2026-11-05", minutes: 12, zone: "Late" },
  { code: "E002", name: "Ravi Nair", day: "2026-11-06", minutes: 40, zone: "Quarter" },
  { code: "E003", name: "Meena Das", day: "2026-11-07", minutes: 5, zone: "Excused" },
];

const result = (over: Partial<ReportRunResult> = {}): ReportRunResult => ({
  id: ID,
  title: "Late Detection Report",
  category: "attendance",
  generatedAt: "2026-11-19 10:00",
  generatedBy: "HR Admin",
  filters: [
    { label: "Month", value: "November 2026" },
    { label: "Employee status", value: "Active" },
  ],
  columns: [
    { key: "code", label: "Code", type: "text", width: 1, total: null, align: null },
    { key: "name", label: "Name", type: "text", width: 2, total: null, align: null },
    { key: "day", label: "Date", type: "date", width: 1, total: null, align: null },
    { key: "minutes", label: "Minutes late", type: "minutes", width: 1, total: "sum", align: null },
    { key: "zone", label: "Arrival zone", type: "badge", width: 1, total: null, align: null },
  ],
  rows: ROWS,
  totals: { minutes: 57 },
  summary: [
    { label: "Late arrivals", value: 3, format: "integer" },
    { label: "Fine total", value: 18605345.68, format: "currency" },
  ],
  notes: [],
  rowCount: ROWS.length,
  truncated: false,
  limit: 10_000,
  ...over,
});

function Host() {
  const [params, setParams] = useSearchParams();
  const cat = useReportCatalog();
  const id = params.get("report");
  if (!cat.data || !id) return null;
  return (
    <div style={{ overflowY: "auto" }} data-testid="scroll-box">
      <h2>Reports</h2>
      <ReportNavRail catalog={cat.data} activeId={id} />
      <ReportWorkspace reportId={id} params={params} setParams={(n, o) => setParams(n, o)} catalog={cat.data} />
    </div>
  );
}

let page: RenderedPage | undefined;
let scrollTo: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  _resetPrefsCache();
  toastSpy.mockReset();
  scrollTo = vi.fn();
  Element.prototype.scrollTo = scrollTo as unknown as typeof Element.prototype.scrollTo;
  Element.prototype.scrollIntoView = vi.fn();
  // "today" is 19 Nov 2026 for the relative dates (only Date is faked: the page's timers run as usual)
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 19, 10, 0));
});

afterEach(() => {
  page?.unmount();
  page = undefined;
  vi.useRealTimers();
});

function open(path: string, fixtures: Fixtures = {}, cat: ReportCatalog = catalog()) {
  return renderMdPage(
    Host,
    { "/api/reports/catalog": cat, "/api/reports/options/employees": [], [RUN]: result(), ...fixtures },
    { path },
  );
}

const q = (selector: string) => page!.container.querySelector<HTMLElement>(selector);
const runs = () => page!.requests().filter((r) => r.startsWith(RUN));
const lastRun = () => new URLSearchParams(runs().at(-1)!.split("?")[1] ?? "");
const button = (label: string) =>
  Array.from(page!.container.querySelectorAll("button")).find((b) => b.textContent?.trim() === label);

describe("a tick box that is on by default", () => {
  it("can be switched off: it is sent as false and stays off after the run", async () => {
    page = await open(`/hr/reports?report=${ID}`);
    expect(lastRun().get("includeOffDays")).toBe("true");

    await page.click('button[aria-label="Include days off"]');
    await page.click('[data-testid="report-show"]');
    expect(lastRun().get("includeOffDays")).toBe("false");
    // the URL now says false, so the form does not tick the box again
    expect(q('button[aria-label="Include days off"]')?.getAttribute("aria-checked")).toBe("false");
  });
});

describe("last used filters", () => {
  it("restores who the report covers and a relative month, says so, and Reset goes back to the defaults", async () => {
    localStorage.setItem(
      `hr_reports_last:${ID}`,
      JSON.stringify({ query: "departmentIds=3", relative: { period: "lastMonth" } }),
    );
    page = await open(`/hr/reports?report=${ID}`);
    expect(lastRun().get("period")).toBe("2026-10"); // "last month", worked out for 19 Nov
    expect(lastRun().get("departmentIds")).toBe("3");
    expect(q('[data-testid="report-restored"]')?.textContent).toContain(
      "Restored your last filters (Month, Department)",
    );

    await page.click('[data-testid="report-restored"] button');
    expect(q('[data-testid="report-restored"]')).toBeNull();
    expect(lastRun().get("period")).toBe("2026-11");
    expect(lastRun().has("departmentIds")).toBe(false);
    expect(localStorage.getItem(`hr_reports_last:${ID}`)).toBeNull();
  });

  it("never replays an old fixed month (an entry from before), only its scope", async () => {
    localStorage.setItem(`hr_reports_last:${ID}`, "period=2026-09&departmentIds=4&employeeIds=12");
    page = await open(`/hr/reports?report=${ID}`);
    expect(lastRun().get("period")).toBe("2026-11");
    expect(lastRun().get("departmentIds")).toBe("4");
    expect(lastRun().has("employeeIds")).toBe(false);
    expect(q('[data-testid="report-restored"]')?.textContent).toContain("(Department)");
  });

  it("remembers a run as relative choices, not fixed dates", async () => {
    page = await open(`/hr/reports?report=${ID}&period=2026-10&departmentIds=3&employeeIds=9&run=1`);
    await page.click('[data-testid="report-show"]');
    const kept = JSON.parse(localStorage.getItem(`hr_reports_last:${ID}`)!);
    expect(kept).toEqual({ query: "departmentIds=3", relative: { period: "lastMonth" } });
  });

  it("keeps the filters a link carries instead of the remembered ones", async () => {
    localStorage.setItem(`hr_reports_last:${ID}`, JSON.stringify({ query: "departmentIds=3", relative: {} }));
    page = await open(`/hr/reports?report=${ID}&departmentIds=4`);
    expect(lastRun().get("departmentIds")).toBe("4");
    expect(q('[data-testid="report-restored"]')).toBeNull();
  });
});

describe("Show report", () => {
  it("fetches afresh when pressed with unchanged filters", async () => {
    page = await open(`/hr/reports?report=${ID}&run=1`);
    const before = runs().length;
    await page.click('[data-testid="report-show"]');
    expect(runs().length).toBe(before + 1);
  });
});

describe("downloads", () => {
  it("wait while the filters are being edited, so a file always matches the table", async () => {
    page = await open(`/hr/reports?report=${ID}&run=1`);
    expect(q('[data-testid="report-download-pdf"]')).not.toHaveProperty("disabled", true);
    await page.type('input[aria-label="Name contains"]', "asha");
    expect(q('[data-testid="report-download-pdf"]')).toHaveProperty("disabled", true);
    expect(q('[data-testid="report-download-xlsx"]')).toHaveProperty("disabled", true);
    expect(page.text()).toContain("the downloads wait for it");
    await page.click('[data-testid="report-show"]');
    expect(q('[data-testid="report-download-pdf"]')).toHaveProperty("disabled", false);
  });

  it("know the export limits: a PDF over its ceiling is refused before the click, Excel offered", async () => {
    page = await open(
      `/hr/reports?report=${ID}&run=1`,
      {},
      catalog({ exportLimits: { screen: 10_000, xlsx: 30_000, pdf: 2 } }),
    );
    expect(q('[data-testid="report-download-pdf"]')).toHaveProperty("disabled", true);
    expect(q('[data-testid="report-download-xlsx"]')).toHaveProperty("disabled", false);
    expect(q('[data-testid="report-export-hint"]')?.textContent).toContain("Download Excel instead");
  });

  it("offer 'Download Excel instead' when the server refuses a PDF as too big (413)", async () => {
    page = await open(`/hr/reports?report=${ID}&run=1`, {
      [EXPORT]: (params) =>
        params.get("fmt") === "pdf"
          ? { status: 413, body: { error: "too_many_rows", message: "Too many rows for a PDF file.", limit: 5000 } }
          : { status: 400, body: { error: "invalid_filter", message: "stop here" } },
    });
    await page.click('[data-testid="report-download-pdf"]');
    const call = toastSpy.mock.calls.at(-1)![0] as { title: string; action?: ReactElement };
    expect(call.title).toBe("Could not create the PDF file");
    const action = call.action as ReactElement<{ altText: string; onClick: () => void }>;
    expect(action.props.altText).toBe("Download Excel instead");

    await act(async () => {
      action.props.onClick();
    });
    await page.settle();
    const exports = page.requests().filter((r) => r.startsWith(EXPORT));
    expect(new URLSearchParams(exports.at(-1)!.split("?")[1]).get("fmt")).toBe("xlsx");
  });

  it("offer no Excel button in the toast for any other refusal", async () => {
    page = await open(`/hr/reports?report=${ID}&run=1`, {
      [EXPORT]: { status: 400, body: { error: "invalid_filter", message: "nope" } },
    });
    await page.click('[data-testid="report-download-pdf"]');
    expect((toastSpy.mock.calls.at(-1)![0] as { action?: unknown }).action).toBeUndefined();
  });
});

describe("a refused run", () => {
  const refused = {
    [RUN]: {
      status: 400,
      body: { error: "invalid_filter", message: "A card run covers at most 200 employees", field: "employee" },
    },
  };

  it("points at the filter to change and offers no pointless Try again", async () => {
    page = await open(`/hr/reports?report=${ID}`, refused);
    const error = q('[data-testid="report-error"]')!;
    expect(error.textContent).toContain("at most 200 employees");
    expect(error.textContent).toContain("Change “Employees” above");
    expect(error.className).toContain("amber");
    expect(button("Try again")).toBeUndefined();
    expect(q('[data-filter="employee"]')?.getAttribute("data-invalid")).toBe("true");
    expect(q('[data-filter="department"]')?.getAttribute("data-invalid")).toBeNull();
  });

  it("drops the highlight once the filters are changed", async () => {
    page = await open(`/hr/reports?report=${ID}`, refused);
    await page.type('input[aria-label="Name contains"]', "x");
    expect(q('[data-filter="employee"]')?.getAttribute("data-invalid")).toBeNull();
  });

  it("still offers Try again for a server failure", async () => {
    page = await open(`/hr/reports?report=${ID}`, { [RUN]: { status: 500, body: { error: "report_failed" } } });
    // a 5xx is retried once (custom-hooks/reports.ts) about a second later before the error shows
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_300));
    });
    await page.settle();
    expect(button("Try again")).toBeDefined();
    expect(q('[data-testid="report-error"]')?.className).toContain("red");
  });
});

describe("the results table", () => {
  it("keeps its search and sort across runs", async () => {
    page = await open(`/hr/reports?report=${ID}&run=1`);
    await page.click('button[aria-label="Sort by Minutes late"]');
    await page.type('input[aria-label="Search in results"]', "a");
    await page.type('input[aria-label="Name contains"]', "x");
    await page.click('[data-testid="report-show"]');
    expect(lastRun().get("q")).toBe("x");
    expect((q('input[aria-label="Search in results"]') as HTMLInputElement).value).toBe("a");
    expect(q('th[aria-sort="ascending"]')?.textContent).toContain("Minutes late");
  });

  it("keeps its sort and search through a run that shows no table (no rows)", async () => {
    page = await open(`/hr/reports?report=${ID}&run=1`, {
      [RUN]: (params) => (params.get("q") === "nobody" ? result({ rows: [], rowCount: 0, totals: null }) : result()),
    });
    await page.click('button[aria-label="Sort by Minutes late"]');
    await page.type('input[aria-label="Search in results"]', "a");
    await page.type('input[aria-label="Name contains"]', "nobody");
    await page.click('[data-testid="report-show"]');
    expect(q('input[aria-label="Search in results"]')).toBeNull(); // the empty state, no table
    await page.type('input[aria-label="Name contains"]', "");
    await page.click('[data-testid="report-show"]');
    expect((q('input[aria-label="Search in results"]') as HTMLInputElement).value).toBe("a");
    expect(q('th[aria-sort="ascending"]')?.textContent).toContain("Minutes late");
  });

  it("finds a row by the date as it is shown", async () => {
    page = await open(`/hr/reports?report=${ID}&run=1`);
    await page.type('input[aria-label="Search in results"]', "06-Nov");
    expect(page.text()).toContain("Ravi Nair");
    expect(page.text()).not.toContain("Asha Kumar");
  });

  it("counts data rows, not subtotal lines, in the truncation banner and points at Excel", async () => {
    const rows = [
      ...ROWS,
      { code: null, name: "Subtotal", day: null, minutes: 57, zone: null, _kind: "subtotal" as const },
    ];
    page = await open(`/hr/reports?report=${ID}&run=1`, {
      [RUN]: result({ rows, rowCount: rows.length, truncated: true, limit: 3, totals: null }),
    });
    const banner = Array.from(page.container.querySelectorAll('[role="alert"]')).find((n) =>
      n.textContent?.includes("more than"),
    );
    expect(banner?.textContent).toContain("only the first 3 are shown");
    expect(banner?.textContent).toContain("Excel, which holds up to 30,000 rows");
  });
});

describe("on a phone", () => {
  it("folds the filters into one line after a run, with Edit filters to open them", async () => {
    page = await open(`/hr/reports?report=${ID}&run=1`);
    const summary = q('[data-testid="report-filters-summary"]')!;
    expect(summary.className).toContain("sm:hidden");
    expect(summary.textContent).toContain("Month: November 2026 · Employee status: Active");
    expect(q('[data-testid="report-filters-body"]')?.className).toMatch(/(^| )hidden( |$)/);
    // the downloads and Show report stay in reach; Reset (which needs the filters) folds away with them
    expect(q('[data-testid="report-download-xlsx"]')?.className).not.toMatch(/(^| )hidden( |$)/);
    expect(q('[data-testid="report-show"]')?.className).not.toMatch(/(^| )hidden( |$)/);
    expect(q('[data-testid="report-reset"]')?.className).toContain("hidden sm:inline-flex");

    await page.click('[data-testid="report-edit-filters"]');
    expect(q('[data-testid="report-filters-summary"]')).toBeNull();
    expect(q('[data-testid="report-filters-body"]')?.className).not.toMatch(/(^| )hidden( |$)/);
    expect(q('[data-testid="report-reset"]')?.className ?? "").not.toContain("hidden");
  });

  it("brings the page header into view on open, not just the workspace", async () => {
    page = await open(`/hr/reports?report=${ID}`);
    const box = q('[data-testid="scroll-box"]');
    expect(scrollTo.mock.contexts).toContain(box);
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
  });

  it("lets summary values step down a size and wrap instead of spilling over", async () => {
    page = await open(`/hr/reports?report=${ID}&run=1`);
    const value = page.container.querySelectorAll('[data-testid="report-summary"] p:nth-child(2)')[1];
    expect(value.textContent).toBe("₹1,86,05,345.68");
    expect(value.className).toContain("break-words");
    expect(value.className).toContain("text-lg");
    expect(value.className).toContain("sm:text-2xl");
  });
});

describe("a report that does not run on open", () => {
  it("waits for Show report and says why", async () => {
    page = await open(`/hr/reports?report=${ID}`, {}, catalog({ autoRun: false }));
    expect(runs()).toHaveLength(0);
    expect(q('[data-testid="report-idle"]')?.textContent).toContain("waits for you");
    await page.click('[data-testid="report-show"]');
    expect(runs()).toHaveLength(1);
  });
});

describe("the header", () => {
  it("marks its icon chip for the Clean theme and uses the muted token for the applied-filter labels", async () => {
    page = await open(`/hr/reports?report=${ID}&run=1`);
    expect(q("[data-report-chip]")).not.toBeNull();
    const label = q('[data-testid="report-applied-filters"] span span');
    expect(label?.className).toContain("text-muted-foreground");
  });
});

describe("the report list beside it", () => {
  it("names its categories in the muted token, not a low-contrast gray-400", async () => {
    page = await open(`/hr/reports?report=${ID}&run=1`);
    const heading = q('nav[aria-label="Reports"] p');
    expect(heading?.textContent).toBe("Attendance");
    expect(heading?.className).toContain("text-muted-foreground");
    expect(heading?.className).not.toContain("text-gray-400");
  });
});

describe("a saved custom report", () => {
  const CUSTOM = "custom-7";
  const CUSTOM_RUN = `/api/reports/run/${CUSTOM}`;
  // the catalog gives a saved report its saved values as defaults, and marks the ones an empty value widens
  const SAVED: ReportFilter[] = [
    filter({ key: "period", kind: "period", label: "Month", required: true, default: "2026-11" }),
    filter({ key: "department", kind: "department", label: "Department", multi: true, default: [3], clearable: true }),
    filter({
      key: "requestStatus",
      kind: "select",
      label: "Status",
      default: "pending",
      clearable: true,
      placeholder: "Every status",
      options: [
        { value: "pending", label: "Pending" },
        { value: "approved", label: "Approved" },
      ],
    }),
  ];
  const customCatalog = (): ReportCatalog => ({
    ...catalog(),
    categories: [{ id: "customise", label: "Customise", description: "", icon: "SlidersHorizontal", count: 1 }],
    reports: [spec({ id: CUSTOM, category: "customise", title: "Pending leave", filters: SAVED })],
  });
  const customRuns = () =>
    page!
      .requests()
      .filter((r) => r.startsWith(CUSTOM_RUN))
      .map((r) => new URLSearchParams(r.split("?")[1] ?? ""));
  const options = () => [...document.body.querySelectorAll('[role="option"]')];

  it("opens with the saved values, offers All for a saved select and sends a cleared one empty", async () => {
    page = await open(`/hr/reports?report=${CUSTOM}`, { [CUSTOM_RUN]: result({ id: CUSTOM }) }, customCatalog());
    const opened = customRuns().at(-1)!;
    expect([opened.get("departmentIds"), opened.get("requestStatus")]).toEqual(["3", "pending"]);

    // "Every status" is offered although a status was saved (an empty status means every status to the server)
    const trigger = q('[aria-label="Status"]')!;
    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(options().map((o) => o.textContent?.trim())).toEqual(["Every status", "Pending", "Approved"]);
    await act(async () => {
      options()[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await page.click('[data-testid="report-show"]');
    const widened = customRuns().at(-1)!;
    expect(widened.has("requestStatus")).toBe(true);
    expect(widened.get("requestStatus")).toBe("");
    expect(widened.get("departmentIds")).toBe("3");
  });

  it("keeps a cleared department a link carries (sent empty, not dropped)", async () => {
    page = await open(
      `/hr/reports?report=${CUSTOM}&run=1&period=2026-11&departmentIds=&requestStatus=approved`,
      { [CUSTOM_RUN]: result({ id: CUSTOM }) },
      customCatalog(),
    );
    const run = customRuns().at(-1)!;
    expect(run.has("departmentIds")).toBe(true);
    expect(run.get("departmentIds")).toBe("");
    expect(run.get("requestStatus")).toBe("approved");
  });
});
