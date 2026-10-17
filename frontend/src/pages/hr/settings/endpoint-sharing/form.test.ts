import { describe, expect, it } from "vitest";
import { readCatalog, readEndpoint, DEFAULT_LIMITS } from "@/lib/api-client/custom-hooks";
import {
  blankDraft,
  draftFrom,
  filterProblem,
  newSensitiveFields,
  orderedFields,
  sameDraft,
  slugify,
  toInput,
  validateDraft,
} from "./form";
import { CATALOG, DEPARTMENTS_ENDPOINT, EMPLOYEES_ENDPOINT } from "./testing";

const catalog = readCatalog(CATALOG);
const employees = catalog.datasets.find((d) => d.key === "employees")!;
const departments = catalog.datasets.find((d) => d.key === "departments")!;
const payroll = catalog.datasets.find((d) => d.key === "payroll-summary")!;
const limits = DEFAULT_LIMITS;

const draftOf = (over: Partial<ReturnType<typeof blankDraft>> = {}) => ({
  ...blankDraft(),
  name: "Departments",
  slug: "hr-departments",
  dataset: "departments",
  fields: ["id"],
  ...over,
});
const check = (draft: ReturnType<typeof blankDraft>, creating = true, dataset = departments) =>
  validateDraft(draft, { creating, dataset, limits });

describe("slugify", () => {
  it("makes a suggestion that follows the address rules", () => {
    expect(slugify("Departments for the Intranet!")).toBe("departments-for-the-intranet");
    expect(slugify("  --Hello__World--  ")).toBe("hello-world");
    expect(slugify("x".repeat(80)).length).toBe(60);
    expect(slugify("???")).toBe("");
  });
});

describe("validateDraft", () => {
  it("accepts a complete draft", () => {
    expect(check(draftOf())).toEqual({ ok: true, errors: {}, first: undefined });
  });

  it("asks for a name, an address, a dataset and at least one field, in that order", () => {
    const blank = check(blankDraft(), true, undefined as never);
    expect(blank.ok).toBe(false);
    expect(Object.keys(blank.errors)).toEqual(expect.arrayContaining(["name", "slug", "dataset", "fields"]));
    expect(blank.first).toMatch(/name/);
    expect(check(draftOf({ name: "  " })).errors.name).toMatch(/name/);
    expect(check(draftOf({ name: "n".repeat(101) })).errors.name).toMatch(/100/);
    expect(check(draftOf({ fields: [] })).errors.fields).toMatch(/at least one field/);
    expect(check(draftOf({ fields: ["nope"] })).errors.fields).toMatch(/not in this dataset/);
  });

  it("checks the address only while creating", () => {
    for (const slug of ["", "ab", "UPPER", "has space", "under_score", "x".repeat(61)]) {
      expect(check(draftOf({ slug })).errors.slug, slug).toMatch(/3 to 60/);
    }
    for (const slug of ["abc", "hr-departments", "a1-b2", "x".repeat(60)]) {
      expect(check(draftOf({ slug })).errors.slug, slug).toBeUndefined();
    }
    // an existing endpoint's address cannot change, so it is not judged again
    expect(check(draftOf({ slug: "" }), false).errors.slug).toBeUndefined();
  });

  it("checks the limits like the server: rate, page sizes and the number of websites", () => {
    expect(check(draftOf({ rateLimit: "0" })).errors.rateLimit).toMatch(/1 to 6000/);
    expect(check(draftOf({ rateLimit: "6001" })).errors.rateLimit).toMatch(/1 to 6000/);
    expect(check(draftOf({ rateLimit: "abc" })).errors.rateLimit).toBeDefined();
    expect(check(draftOf({ rateLimit: "6000" })).errors.rateLimit).toBeUndefined();
    expect(check(draftOf({ pageSizeMax: "501" })).errors.pageSizeMax).toMatch(/500/);
    expect(check(draftOf({ pageSizeMax: "0" })).errors.pageSizeMax).toBeDefined();
    expect(check(draftOf({ pageSizeDefault: "300", pageSizeMax: "200" })).errors.pageSizeDefault).toMatch(/bigger/);
    expect(check(draftOf({ pageSizeDefault: "0" })).errors.pageSizeDefault).toBeDefined();
    const many = Array.from({ length: 21 }, (_, i) => `https://s${i}.example.com`);
    expect(check(draftOf({ origins: many })).errors.origins).toMatch(/20/);
    expect(check(draftOf({ origins: ["http://intranet.example.com"] })).errors.origins).toMatch(/not a valid origin/);
  });

  it("checks each locked filter against the dataset's own type", () => {
    const run = (key: string, value: string, dataset = employees) =>
      validateDraft(
        draftOf({ dataset: dataset.key, fields: [dataset.fields[0].key], lockedFilters: { [key]: value } }),
        {
          creating: true,
          dataset,
          limits,
        },
      ).errors[`filter:${key}`];
    expect(run("status", "active")).toBeUndefined();
    expect(run("status", "banana")).toMatch(/one of: active, inactive, all/);
    expect(run("status", "  ")).toMatch(/Type a value/);
    expect(run("departmentId", "12")).toBeUndefined();
    expect(run("departmentId", "1.5")).toMatch(/whole number/);
    expect(run("month", "2026-09", payroll)).toBeUndefined();
    expect(run("month", "2026-13", payroll)).toMatch(/month written like/);
    expect(run("nothing", "x")).toMatch(/not a filter/);
    expect(filterProblem({ ...employees.filters[0], type: "date" }, "2026-02-30")).toMatch(/date/);
    expect(filterProblem({ ...employees.filters[0], type: "year", values: [] }, "1999")).toMatch(/2000 to 2100/);
  });
});

describe("the fields", () => {
  it("are sent in the dataset's own order, whatever order they were ticked in", () => {
    const draft = draftOf({ dataset: "employees", fields: ["phone", "employeeCode", "department"] });
    expect(orderedFields(draft, employees)).toEqual(["employeeCode", "department", "phone"]);
  });

  it("name the personal and financial fields a save newly shares", () => {
    const draft = draftOf({ dataset: "employees", fields: ["employeeCode", "phone", "email", "salaryAmount"] });
    expect(newSensitiveFields(draft, [], employees).map((f) => f.key)).toEqual(["phone", "email", "salaryAmount"]);
    // what was already shared does not ask again; a basic field never asks
    expect(newSensitiveFields(draft, ["phone", "employeeCode"], employees).map((f) => f.key)).toEqual([
      "email",
      "salaryAmount",
    ]);
    expect(newSensitiveFields(draftOf({ fields: ["id", "name"] }), [], departments)).toEqual([]);
  });
});

describe("toInput", () => {
  it("sends one body: a create carries the address and the dataset, a save the version", () => {
    const draft = draftOf({
      description: "  notes ",
      origins: ["https://intranet.example.com"],
      rateLimit: "120",
      pageSizeDefault: "25",
      pageSizeMax: "100",
      allowNoOrigin: false,
      enabled: false,
    });
    const created = toInput(draft, { creating: true, dataset: departments });
    expect(created).toEqual({
      slug: "hr-departments",
      dataset: "departments",
      name: "Departments",
      description: "notes",
      fields: ["id"],
      lockedFilters: {},
      origins: ["https://intranet.example.com"],
      allowNoOrigin: false,
      pageSizeDefault: 25,
      pageSizeMax: 100,
      rateLimitPerMinute: 120,
      enabled: false,
    });
    const saved = toInput(draft, {
      creating: false,
      dataset: departments,
      version: "ver3",
      acknowledgeSensitive: true,
    });
    expect(saved).not.toHaveProperty("slug");
    expect(saved).not.toHaveProperty("dataset");
    expect(saved.expectedVersion).toBe("ver3");
    expect(saved.acknowledgeSensitive).toBe(true);
    expect(created).not.toHaveProperty("acknowledgeSensitive");
  });

  it("sends locked filters as text, exactly as the server stores them", () => {
    const body = toInput(
      draftOf({
        dataset: "employees",
        fields: ["employeeCode"],
        lockedFilters: { status: "active", departmentId: " 12 " },
      }),
      { creating: true, dataset: employees },
    );
    expect(body.lockedFilters).toEqual({ status: "active", departmentId: "12" });
  });
});

describe("the draft of a saved endpoint", () => {
  it("round-trips, and ignores the order of the ticks and of the websites", () => {
    const saved = readEndpoint(DEPARTMENTS_ENDPOINT);
    const draft = draftFrom(saved);
    expect(draft.slug).toBe("hr-departments");
    expect(draft.fields).toEqual(["id", "name"]);
    expect(sameDraft(draft, draftFrom(saved))).toBe(true);
    expect(sameDraft(draft, { ...draft, fields: ["name", "id"] })).toBe(true);
    expect(sameDraft(draft, { ...draft, fields: ["id"] })).toBe(false);
    expect(sameDraft(draft, { ...draft, origins: [] })).toBe(false);
    expect(sameDraft(draft, { ...draft, rateLimit: "61" })).toBe(false);
    expect(sameDraft(draft, { ...draft, enabled: false })).toBe(false);
    const locked = draftFrom(readEndpoint(EMPLOYEES_ENDPOINT));
    expect(locked.lockedFilters).toEqual({ status: "active" });
    expect(sameDraft(locked, { ...locked, lockedFilters: {} })).toBe(false);
    // the helper flag that follows the name does not count as a change
    expect(sameDraft(draft, { ...draft, slugTouched: !draft.slugTouched })).toBe(true);
  });
});
