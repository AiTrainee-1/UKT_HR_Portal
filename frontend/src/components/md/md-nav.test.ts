import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MD_NAV, MD_NAV_BY_ID, MD_NAV_GROUPS, mdPageForPath } from "./md-nav";

describe("md-nav", () => {
  it("has one page per id, at /md/<id>", () => {
    expect(new Set(MD_NAV.map((p) => p.id)).size).toBe(MD_NAV.length);
    for (const page of MD_NAV) expect(page.path).toBe(`/md/${page.id}`);
    expect(MD_NAV.length).toBe(MD_NAV_GROUPS.flatMap((g) => g.items).length);
  });

  it("finds the page for a location, including sub-paths, and nothing outside the portal", () => {
    expect(mdPageForPath("/md/payroll")?.id).toBe("payroll");
    expect(mdPageForPath("/md/payroll/")?.id).toBe("payroll");
    expect(mdPageForPath("/md/payroll/2026-09?x=1")?.id).toBe("payroll");
    expect(mdPageForPath("/md/payrolling")).toBeUndefined();
    expect(mdPageForPath("/hr/payroll")).toBeUndefined();
  });

  it("stays in step with the backend's page list (api/md_portal/pages.py), which the assistant suggests pages from", () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, "../../../../backend/api/md_portal/pages.py"),
      "utf-8",
    );
    const backend = [...source.matchAll(/"id":\s*"([^"]+)",\s*"title":\s*"([^"]+)",\s*"path":\s*"([^"]+)"/g)].map(
      (m) => ({
        id: m[1],
        title: m[2],
        path: m[3],
      }),
    );
    expect(backend.length).toBeGreaterThan(0);
    expect(backend.map((p) => p.id)).toEqual(MD_NAV.map((p) => p.id));
    for (const page of backend) {
      expect(MD_NAV_BY_ID[page.id].title).toBe(page.title);
      expect(MD_NAV_BY_ID[page.id].path).toBe(page.path);
    }
  });
});
