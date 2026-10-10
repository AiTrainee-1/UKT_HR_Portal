import { describe, expect, it } from "vitest";
import {
  ADMIN_ONLY_HR_PAGES,
  EMBEDDED_HR_PREFIXES,
  HR_TO_MD_PAGES,
  adminOnlyPageName,
  hrToMd,
  isEmbeddedHrPath,
  mdToHr,
} from "./embed";

describe("hrToMd: where the browser goes when an HR page navigates", () => {
  it("moves every page the MD portal copies from /hr to /md, with its sub-pages and query", () => {
    expect(hrToMd("/hr/dashboard")).toBe("/md/dashboard");
    expect(hrToMd("/hr/employees")).toBe("/md/employees");
    expect(hrToMd("/hr/employees/42/edit")).toBe("/md/employees/42/edit");
    expect(hrToMd("/hr/employees/new")).toBe("/md/employees/new");
    expect(hrToMd("/hr/attendance/staff")).toBe("/md/attendance/staff");
    expect(hrToMd("/hr/attendance/report-log?from=2026-10-01#top")).toBe(
      "/md/attendance/report-log?from=2026-10-01#top",
    );
    expect(hrToMd("/hr/outpass-visitors/tea-break")).toBe("/md/outpass-visitors/tea-break");
    expect(hrToMd("/hr/Biometric-Connectors/device-status")).toBe("/md/Biometric-Connectors/device-status");
  });

  it("matches without regard to case, as the router does", () => {
    expect(hrToMd("/hr/Employees/5")).toBe("/md/Employees/5");
    expect(hrToMd("/hr/biometric-connectors/device-status")).toBe("/md/biometric-connectors/device-status");
  });

  it("does not mistake a page that merely starts with the same letters", () => {
    expect(hrToMd("/hr/employees-extra")).toBe("/hr/employees-extra");
    expect(hrToMd("/hr/leavex")).toBe("/hr/leavex");
  });

  it("sends a link to an HR page with no copy here to the nearest MD page, and leaves other addresses alone", () => {
    expect(hrToMd("/hr/payroll")).toBe("/md/payroll");
    expect(hrToMd("/hr/production-payroll")).toBe("/md/payroll");
    expect(hrToMd("/hr/recruitment/resume-screening")).toBe("/md/recruitment");
    expect(hrToMd("/hr/activity-logs")).toBe("/md/activity");
    expect(hrToMd("/hr/settlement")).toBe("/md/requests");
    expect(hrToMd("/md/payroll")).toBe("/md/payroll");
    expect(hrToMd("/hr/settings")).toBe("/hr/settings");
    expect(hrToMd("/employee/dashboard")).toBe("/employee/dashboard");
  });
});

describe("mdToHr: what the pages see", () => {
  it("shows an MD address as the HR address the page was written for", () => {
    expect(mdToHr("/md/employees/5")).toBe("/hr/employees/5");
    expect(mdToHr("/md/attendance/staff")).toBe("/hr/attendance/staff");
    expect(mdToHr("/md")).toBe("/hr");
    expect(mdToHr("/MD/leave")).toBe("/hr/leave");
  });

  it("leaves a non-MD address alone", () => {
    expect(mdToHr("/hr/leave")).toBe("/hr/leave");
    expect(mdToHr("/mdx/leave")).toBe("/mdx/leave");
  });

  it("is the inverse of hrToMd for every copied page", () => {
    for (const prefix of EMBEDDED_HR_PREFIXES) {
      for (const address of [prefix, `${prefix}/sub`, `${prefix}/sub/7?x=1`]) {
        expect(mdToHr(hrToMd(address)), address).toBe(address);
      }
    }
  });
});

describe("the tables", () => {
  it("copy fourteen pages' worth of prefixes and no more than the MD is given access to", () => {
    expect(EMBEDDED_HR_PREFIXES).toContain("/hr/dashboard");
    expect(EMBEDDED_HR_PREFIXES).not.toContain("/hr/payroll");
    expect(EMBEDDED_HR_PREFIXES).not.toContain("/hr/settings");
    // a page cannot be both copied and redirected
    for (const prefix of Object.keys(HR_TO_MD_PAGES)) expect(isEmbeddedHrPath(prefix), prefix).toBe(false);
  });
});

describe("adminOnlyPageName: a link inside a copied page to somewhere the MD cannot go", () => {
  it("names the Admin-only pages, even under a page that is otherwise mapped", () => {
    expect(adminOnlyPageName("/hr/user-management")).toBe("User Management");
    expect(adminOnlyPageName("/hr/user-management/7?tab=hod")).toBe("User Management");
    expect(adminOnlyPageName("/hr/settings")).toBe("Settings");
    expect(adminOnlyPageName("/hr/Settings")).toBe("Settings");
    expect(adminOnlyPageName("/hr/recruitment/documents")).toBe("Employee Documents");
    expect(adminOnlyPageName("/hr/recruitment")).toBeNull();
    expect(adminOnlyPageName("/hr/recruitment/resume-screening")).toBeNull();
  });

  it("treats any other HR page the portal neither copies nor maps as the Admin's, and nothing else as one", () => {
    expect(adminOnlyPageName("/hr/some-new-page")).toBe("That page");
    expect(adminOnlyPageName("/hr/employees/5")).toBeNull();
    expect(adminOnlyPageName("/hr/payroll")).toBeNull();
    expect(adminOnlyPageName("/hr/missing-punch")).toBeNull();
    expect(adminOnlyPageName("/md/employees")).toBeNull();
    expect(adminOnlyPageName("/employee/dashboard")).toBeNull();
  });

  it("never rewrites an Admin-only address, and the new pairs go to the MD pages they belong to", () => {
    expect(hrToMd("/hr/recruitment/documents")).toBe("/hr/recruitment/documents");
    expect(hrToMd("/hr/missing-punch")).toBe("/md/requests");
    expect(hrToMd("/hr/casual-leave")).toBe("/md/leave");
    expect(hrToMd("/hr/reports")).toBe("/md/reports");
    for (const prefix of Object.keys(ADMIN_ONLY_HR_PAGES)) expect(isEmbeddedHrPath(prefix), prefix).toBe(false);
  });
});
