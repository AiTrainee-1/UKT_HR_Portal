import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api-client/custom-fetch";
import { groupReports } from "@/lib/report-catalog";
import {
  ASK_EXAMPLES,
  PREVIEW_PER_CATEGORY,
  askAboutReport,
  buildLibrary,
  catalogFailure,
  categoryLabel,
  executiveFirst,
  libraryContext,
  libraryView,
  pickReports,
  queryWords,
  reportContext,
  searchLibrary,
  starredIdOf,
} from "./report-library";
import { CATEGORIES, DAILY_BRIEF, REPORTS, catalogFixture, employeeMasterRun, meta } from "./test-fixtures";

const library = buildLibrary(catalogFixture());
const ids = (groups: { primary: { id: string } }[]) => groups.map((g) => g.primary.id);

describe("buildLibrary", () => {
  it("folds the views of one report into one entry and keeps the catalog order", () => {
    expect(ids(library.all)).toEqual([
      "salary-register",
      "pf-statement",
      "daily-attendance",
      "late-coming-detail",
      "visitor-register",
      "employee-master",
      "md-daily-brief",
    ]);
  });

  it("separates the executive reports from the ordinary library", () => {
    expect(ids(library.executive)).toEqual(["md-daily-brief"]);
    expect(ids(library.standard)).not.toContain("md-daily-brief");
    expect(library.standard).toHaveLength(6);
  });

  it("lists the ordinary categories with their entry counts, and never the executive one", () => {
    expect(library.categories.map((c) => [c.category.id, c.count])).toEqual([
      ["payroll", 2],
      ["attendance", 2],
      ["gate", 1],
      ["employees", 1],
    ]);
    expect(library.allCategories.map((c) => c.id)).toContain("md");
  });

  it("has no executive reports yet when the backend sends none", () => {
    const today = buildLibrary(catalogFixture({ executive: false }));
    expect(today.executive).toEqual([]);
    expect(today.all).toHaveLength(6);
  });

  it("copes with an empty catalog", () => {
    const empty = buildLibrary({ ...catalogFixture(), categories: [], reports: [] });
    expect(empty.all).toEqual([]);
    expect(empty.categories).toEqual([]);
  });
});

describe("queryWords", () => {
  it("drops the filler of a natural question", () => {
    expect(queryWords("Which report shows overtime by department?")).toEqual([
      "which",
      "shows",
      "overtime",
      "department",
    ]);
  });

  it("splits on punctuation and ignores case", () => {
    expect(queryWords("  PF/ESI  statement ")).toEqual(["pf", "esi", "statement"]);
  });

  it("keeps the filler when it is all there is", () => {
    expect(queryWords("report")).toEqual(["report"]);
    expect(queryWords("   ")).toEqual([]);
  });
});

describe("searchLibrary", () => {
  const search = (q: string) => ids(searchLibrary(library.all, library.allCategories, q));

  it("returns everything for an empty search", () => {
    expect(searchLibrary(library.all, library.allCategories, "  ")).toBe(library.all);
  });

  it("finds a report by its title, its description, its tags and the name of a view", () => {
    expect(search("salary")).toContain("salary-register");
    expect(search("minutes late")).toEqual(["late-coming-detail"]); // description of the Detail view
    expect(search("epf")).toEqual(["pf-statement"]); // a tag
    expect(search("counts")).toEqual(["late-coming-detail"]); // the name of the other view
  });

  it("finds a report by its category", () => {
    expect(search("gate")).toEqual(["visitor-register"]);
    expect(search("executive")).toEqual(["md-daily-brief"]);
    // a tag and the Daily Brief's description both say "payroll" (2 each, catalog order), the category name only 1
    expect(search("payroll")).toEqual(["salary-register", "md-daily-brief", "pf-statement"]);
  });

  it("needs every word, wherever each one is found", () => {
    expect(search("attendance late")).toEqual(["daily-attendance", "late-coming-detail"]);
    expect(search("salary zebra")).toEqual([]);
  });

  it("ranks a title match above a description match above a category match", () => {
    // 'attendance': in the title of Daily Attendance (3), the Daily Brief's description (2), the late-coming category (1)
    expect(search("attendance")).toEqual(["daily-attendance", "md-daily-brief", "late-coming-detail"]);
  });

  it("matches a plural against its singular", () => {
    expect(search("visitors")).toEqual(["visitor-register", "md-daily-brief"]);
    expect(search("registers")).toEqual(["salary-register", "visitor-register"]);
  });

  it("answers a natural question when the words are there", () => {
    expect(search("which report shows employee department")).toEqual([]); // 'which' and 'shows' are in no report
    expect(search("employee department")).toEqual(["employee-master"]);
  });

  it("keeps the catalog order for equal scores", () => {
    // 'with' alone is kept (nothing else is left of the query); three descriptions say it, so they tie
    expect(search("with")).toEqual(["salary-register", "late-coming-detail", "employee-master"]);
  });
});

describe("libraryView", () => {
  it("browses by category and leaves the executive reports to the shelf", () => {
    const view = libraryView(library, "", null);
    expect(view.mode).toBe("browse");
    if (view.mode !== "browse") return;
    expect(view.sections.map((s) => s.category.id)).toEqual(["payroll", "attendance", "gate", "employees"]);
    expect(view.total).toBe(6);
  });

  it("browses one category when a chip is chosen", () => {
    const view = libraryView(library, "", "attendance");
    if (view.mode !== "browse") throw new Error("expected browse");
    expect(view.sections.map((s) => s.category.id)).toEqual(["attendance"]);
    expect(view.total).toBe(2);
  });

  it("searches everything, the executive reports included, as one ranked list", () => {
    const view = libraryView(library, "daily", null);
    if (view.mode !== "results") throw new Error("expected results");
    expect(ids(view.groups)).toEqual(["daily-attendance", "md-daily-brief"]);
    expect(view.total).toBe(2);
  });

  it("limits a search to the chosen category", () => {
    const view = libraryView(library, "daily", "attendance");
    if (view.mode !== "results") throw new Error("expected results");
    expect(ids(view.groups)).toEqual(["daily-attendance"]);
  });

  it("previews a handful per category", () => {
    expect(PREVIEW_PER_CATEGORY).toBeGreaterThanOrEqual(3);
  });

  it("is empty, not broken, for a library with no ordinary reports", () => {
    const only = buildLibrary({ ...catalogFixture(), categories: [CATEGORIES[0]], reports: [DAILY_BRIEF] });
    const view = libraryView(only, "", null);
    if (view.mode !== "browse") throw new Error("expected browse");
    expect(view.sections).toEqual([]);
    expect(view.total).toBe(0);
  });
});

describe("executiveFirst", () => {
  it("puts the executive category first and leaves the others in order", () => {
    const catalog = catalogFixture();
    const reordered = executiveFirst(catalog);
    expect(reordered.categories.map((c) => c.id)).toEqual(["md", "payroll", "attendance", "gate", "employees"]);
    expect(reordered.reports).toBe(catalog.reports);
    expect(catalog.categories.map((c) => c.id)).toEqual(["payroll", "attendance", "gate", "employees", "md"]); // untouched
  });

  it("returns the catalog itself when there is no executive category, or it is first already", () => {
    const none = catalogFixture({ executive: false });
    expect(executiveFirst(none)).toBe(none);
    const first = executiveFirst(catalogFixture());
    expect(executiveFirst(first)).toBe(first);
  });
});

describe("categoryLabel", () => {
  it("names a category, and falls back to its id", () => {
    expect(categoryLabel(library.allCategories, "gate")).toBe("Gate & Visitors");
    expect(categoryLabel(library.allCategories, "new-one")).toBe("new-one");
  });
});

describe("pickReports", () => {
  it("returns the reports in the order of the ids, skipping unknown and repeated ones", () => {
    const picked = pickReports(["visitor-register", "gone", "salary-register", "visitor-register"], library.all);
    expect(picked.map((p) => p.report.id)).toEqual(["visitor-register", "salary-register"]);
  });

  it("finds a report that is a second view of a family, and says which one was opened", () => {
    const [hit] = pickReports(["late-coming-counts"], library.all);
    expect(hit.report.title).toBe("Late Coming Summary");
    expect(hit.group.primary.id).toBe("late-coming-detail");
  });

  it("stops at the maximum", () => {
    expect(
      pickReports(
        REPORTS.map((r) => r.id),
        library.all,
        2,
      ),
    ).toHaveLength(2);
  });

  it("returns nothing for no ids", () => {
    expect(pickReports([], library.all)).toEqual([]);
  });
});

describe("starredIdOf", () => {
  const family = groupReports(REPORTS).find((g) => g.key === "attendance:late-coming");

  it("finds the starred view of a group, whichever one it is", () => {
    expect(family && starredIdOf(family, ["late-coming-counts"])).toBe("late-coming-counts");
    expect(family && starredIdOf(family, ["pf-statement"])).toBeUndefined();
  });
});

describe("what the assistant is told", () => {
  it("lists the library by category: counts and titles, no data", () => {
    const ctx = libraryContext(library);
    expect(ctx.page).toBe("reports");
    expect(ctx.summary?.["Reports in the library"]).toBe(7);
    expect(ctx.summary?.["Executive reports"]).toBe(1);
    expect(ctx.summary?.["Payroll & Salary"]).toBe("Salary Register, PF Statement");
    expect(ctx.summary?.["Executive (MD)"]).toBe("Daily Brief");
  });

  it("caps the titles it lists per category", () => {
    const many = Array.from({ length: 20 }, (_, i) => meta(`r${i}`, "payroll", { title: `Report ${i}` }));
    const ctx = libraryContext(buildLibrary({ ...catalogFixture(), reports: many }));
    expect(String(ctx.summary?.["Payroll & Salary"]).endsWith(", and 5 more")).toBe(true);
  });

  it("describes an open report with its filters and headline figures, never its rows", () => {
    const spec = REPORTS.find((r) => r.id === "employee-master")!;
    const ctx = reportContext(spec, "Employees", employeeMasterRun());
    expect(ctx.title).toBe("Reports: Employee Master");
    expect(ctx.filters).toEqual({ Report: "Employee Master", Category: "Employees", "Employee status": "Active" });
    expect(ctx.summary).toEqual({ Records: 3, Employees: "3", "Salary bill": "₹55,000.00" });
    expect(JSON.stringify(ctx)).not.toContain("Asha");
  });

  it("describes a report that has not run yet", () => {
    const spec = REPORTS[0];
    const ctx = reportContext(spec, "Payroll & Salary", undefined);
    expect(ctx.filters).toEqual({ Report: "Salary Register", Category: "Payroll & Salary" });
    expect(ctx.summary).toBeUndefined();
  });

  it("builds the question behind 'Ask AI about this report'", () => {
    const spec = REPORTS.find((r) => r.id === "employee-master")!;
    expect(askAboutReport(spec, employeeMasterRun())).toBe(
      'Explain the "Employee Master" report (Employee status: Active): what stands out, and what should I look at first?',
    );
    expect(askAboutReport(spec, undefined)).toBe(
      'Explain the "Employee Master" report: what stands out, and what should I look at first?',
    );
  });

  it("offers the example question from the brief first", () => {
    expect(ASK_EXAMPLES[0]).toBe("Which report shows overtime by department?");
  });
});

describe("catalogFailure", () => {
  const apiError = (status: number) =>
    new ApiError(
      new Response("{}", { status, headers: { "content-type": "application/json" } }),
      {},
      { method: "GET", url: "/api/reports/catalog" },
    );

  it("explains a refusal, a server fault and a lost connection differently", () => {
    expect(catalogFailure(apiError(403))).toMatch(/cannot open the Report Center/);
    expect(catalogFailure(apiError(500))).toMatch(/server had a problem/);
    expect(catalogFailure(new TypeError("Failed to fetch"))).toMatch(/Check your connection/);
  });
});
