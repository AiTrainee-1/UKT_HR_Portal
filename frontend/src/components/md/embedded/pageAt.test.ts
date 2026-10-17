import { describe, expect, it } from "vitest";
import { pageAt } from "./pageAt";

// The MD portal draws its Operations / Insights frame around an HR page's own address only. Outpass and Tea Break keep their
// tabs in the path, so an address on one of their tabs is still the page; a record of an employee is not.

describe("the page an address is", () => {
  it("is the page for its own address", () => {
    expect(pageAt("/hr/outpass-visitors/outpass")?.id).toBe("outpass");
    expect(pageAt("/hr/outpass-visitors/visitors")?.id).toBe("visitors");
    expect(pageAt("/hr/outpass-visitors/tea-break")?.id).toBe("tea-break");
    expect(pageAt("/hr/employees")?.id).toBe("employees");
  });

  it("is still the page on every tab and nested tab of Outpass and Tea Break", () => {
    for (const path of [
      "/hr/outpass-visitors/outpass/overview/passes",
      "/hr/outpass-visitors/outpass/overview/qr-submissions",
      "/hr/outpass-visitors/outpass/requests",
      "/hr/outpass-visitors/outpass/in-out",
    ])
      expect(pageAt(path)?.id, path).toBe("outpass");
    expect(pageAt("/hr/outpass-visitors/tea-break/records")?.id).toBe("tea-break");
    expect(pageAt("/hr/outpass-visitors/tea-break/rule?x=1")?.id).toBe("tea-break");
  });

  it("is nothing on a deeper address of a page that has no tabs in its path, and for the MD's own dashboard", () => {
    expect(pageAt("/hr/employees/5")).toBeUndefined();
    expect(pageAt("/hr/outpass-visitors/visitors/anything")).toBeUndefined();
    expect(pageAt("/hr/dashboard")).toBeUndefined();
  });
});
