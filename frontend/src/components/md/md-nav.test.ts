import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MD_NAV, MD_NAV_BY_ID, MD_NAV_GROUPS, mdPageForPath } from "./md-nav";

describe("md-nav", () => {
  it("has one page per id and per path, all inside /md", () => {
    expect(new Set(MD_NAV.map((p) => p.id)).size).toBe(MD_NAV.length);
    expect(new Set(MD_NAV.map((p) => p.path.toLowerCase())).size).toBe(MD_NAV.length);
    for (const page of MD_NAV) expect(page.path).toMatch(/^\/md\/[A-Za-z0-9\-/]+$/);
    expect(MD_NAV.length).toBe(MD_NAV_GROUPS.flatMap((g) => g.items).length);
  });

  it("lists the fourteen HR pages the MD portal copies, at the addresses the MD was promised", () => {
    const paths = MD_NAV.map((p) => p.path);
    for (const wanted of [
      "/md/dashboard",
      "/md/employees",
      "/md/branches",
      "/md/attendance/staff",
      "/md/attendance/production",
      "/md/geo-attendance",
      "/md/attendance/search",
      "/md/attendance/report-log",
      "/md/outpass-visitors/outpass",
      "/md/outpass-visitors/visitors",
      "/md/outpass-visitors/tea-break",
      "/md/shifts",
      "/md/leave",
      "/md/requests",
    ]) {
      expect(paths, wanted).toContain(wanted);
    }
  });

  it("finds the page for a location, including sub-paths, and nothing outside the portal", () => {
    expect(mdPageForPath("/md/payroll")?.id).toBe("payroll");
    expect(mdPageForPath("/md/payroll/")?.id).toBe("payroll");
    expect(mdPageForPath("/md/payroll/2026-09?x=1")?.id).toBe("payroll");
    expect(mdPageForPath("/md/payrolling")).toBeUndefined();
    expect(mdPageForPath("/hr/payroll")).toBeUndefined();
  });

  it("tells the nested pages apart, whatever the case of the address", () => {
    expect(mdPageForPath("/md/attendance/staff")?.id).toBe("attendance");
    expect(mdPageForPath("/md/attendance/production")?.id).toBe("attendance-production");
    expect(mdPageForPath("/md/attendance/report-log")?.id).toBe("report-log");
    expect(mdPageForPath("/md/outpass-visitors/tea-break")?.id).toBe("tea-break");
    expect(mdPageForPath("/md/Outpass-Visitors/Visitors")?.id).toBe("visitors");
    expect(mdPageForPath("/md/employees/42/edit")?.id).toBe("employees");
    expect(mdPageForPath("/md/attendance")).toBeUndefined();
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
