import { describe, expect, it } from "vitest";
import {
  GATE_BASE,
  GATE_NESTED,
  GATE_PAGES,
  GATE_SUBS,
  cleanGatePath,
  gateKey,
  gateLanding,
  gatePageOf,
  gatePagePath,
  gateTabPath,
  nestedOf,
  readGatePath,
  resolveGatePath,
  subsOf,
} from "./routes";

// The addresses of Outpass / Visitors: the three first-level pages keep their addresses, the tabs are path segments, and a
// path that stops early (or names something unknown) is replaced by the first tab.

describe("the three first-level addresses", () => {
  it("are exactly the ones the sidebar has always linked to", () => {
    expect(GATE_PAGES.map(gatePagePath)).toEqual([
      "/hr/outpass-visitors/outpass",
      "/hr/outpass-visitors/visitors",
      "/hr/outpass-visitors/tea-break",
    ]);
    expect(GATE_BASE).toBe("/hr/outpass-visitors");
  });

  it("each opens on its first tab (Visitors has none, so it stays where it is)", () => {
    expect(gateLanding("outpass")).toBe("/hr/outpass-visitors/outpass/overview/passes");
    expect(gateLanding("visitors")).toBe("/hr/outpass-visitors/visitors");
    expect(gateLanding("tea-break")).toBe("/hr/outpass-visitors/tea-break/records");
  });
});

describe("the route table", () => {
  it("lists the tabs of each page in order, and the nested tabs of the subtabs that have sections", () => {
    expect(subsOf("outpass").map((s) => s.value)).toEqual(["overview", "requests", "in-out"]);
    expect(subsOf("visitors")).toEqual([]);
    expect(subsOf("tea-break").map((s) => s.value)).toEqual(["records", "rule"]);
    expect(nestedOf("outpass", "overview").map((n) => n.value)).toEqual(["passes", "qr-submissions"]);
    // one section: no nested level, so no one-pill strip
    expect(nestedOf("outpass", "requests")).toEqual([]);
    expect(nestedOf("outpass", "in-out")).toEqual([]);
    expect(nestedOf("tea-break", "records")).toEqual([]);
    expect(nestedOf("tea-break", "rule")).toEqual([]);
  });

  it("never has a one-pill strip, anywhere", () => {
    for (const page of GATE_PAGES) {
      expect(subsOf(page).length, page).not.toBe(1);
      for (const sub of Object.keys(GATE_NESTED[page]))
        expect(nestedOf(page, sub).length, `${page}/${sub}`).toBeGreaterThan(1);
    }
    expect(Object.keys(GATE_SUBS)).toEqual([...GATE_PAGES]);
  });

  it("builds an address from a page, a subtab and a nested subtab", () => {
    expect(gateTabPath("outpass")).toBe("/hr/outpass-visitors/outpass");
    expect(gateTabPath("outpass", "requests")).toBe("/hr/outpass-visitors/outpass/requests");
    expect(gateTabPath("outpass", "overview", "qr-submissions")).toBe(
      "/hr/outpass-visitors/outpass/overview/qr-submissions",
    );
    // a nested subtab with no subtab is dropped
    expect(gateTabPath("outpass", undefined, "passes")).toBe("/hr/outpass-visitors/outpass");
  });
});

describe("what an address names", () => {
  it("reads the page, the subtab and the nested subtab, each only when real", () => {
    expect(readGatePath("/hr/outpass-visitors/outpass/overview/qr-submissions")).toEqual({
      page: "outpass",
      sub: "overview",
      nested: "qr-submissions",
    });
    expect(readGatePath("/hr/outpass-visitors/outpass/requests")).toEqual({
      page: "outpass",
      sub: "requests",
      nested: null,
    });
    expect(readGatePath("/hr/outpass-visitors/tea-break/rule").sub).toBe("rule");
    expect(readGatePath("/hr/outpass-visitors/outpass/nope")).toEqual({ page: "outpass", sub: null, nested: null });
    expect(readGatePath("/hr/outpass-visitors/outpass/overview/nope").nested).toBeNull();
    // a nested name under a subtab that has no nested level is nothing
    expect(readGatePath("/hr/outpass-visitors/outpass/requests/passes").nested).toBeNull();
  });

  it("knows the page of every address under the prefix, and says Outpass for the bare one", () => {
    expect(gatePageOf("/hr/outpass-visitors")).toBe("outpass");
    expect(gatePageOf("/hr/outpass-visitors/visitors")).toBe("visitors");
    expect(gatePageOf("/hr/outpass-visitors/tea-break/records")).toBe("tea-break");
    expect(gatePageOf("/hr/outpass-visitors/unknown")).toBe("outpass");
    expect(gatePageOf("/hr/outpass-visitors/Tea-Break/Rule")).toBe("tea-break");
  });
});

describe("the redirect table (resolveGatePath)", () => {
  const table: [string, string][] = [
    // the bare prefix is Outpass
    ["/hr/outpass-visitors", "/hr/outpass-visitors/outpass/overview/passes"],
    // a path that stops early goes to the first tab, then the first nested tab
    ["/hr/outpass-visitors/outpass", "/hr/outpass-visitors/outpass/overview/passes"],
    ["/hr/outpass-visitors/outpass/overview", "/hr/outpass-visitors/outpass/overview/passes"],
    ["/hr/outpass-visitors/tea-break", "/hr/outpass-visitors/tea-break/records"],
    // an unknown value goes to the first
    ["/hr/outpass-visitors/outpass/nope", "/hr/outpass-visitors/outpass/overview/passes"],
    ["/hr/outpass-visitors/outpass/overview/nope", "/hr/outpass-visitors/outpass/overview/passes"],
    ["/hr/outpass-visitors/tea-break/nope", "/hr/outpass-visitors/tea-break/records"],
    ["/hr/outpass-visitors/nope", "/hr/outpass-visitors/outpass/overview/passes"],
    // a tab with one section drops whatever follows it
    ["/hr/outpass-visitors/outpass/requests/whatever", "/hr/outpass-visitors/outpass/requests"],
    ["/hr/outpass-visitors/outpass/in-out/passes", "/hr/outpass-visitors/outpass/in-out"],
    ["/hr/outpass-visitors/tea-break/rule/x/y", "/hr/outpass-visitors/tea-break/rule"],
    // Visitors has no tabs: it is only itself
    ["/hr/outpass-visitors/visitors", "/hr/outpass-visitors/visitors"],
    ["/hr/outpass-visitors/visitors/anything", "/hr/outpass-visitors/visitors"],
    // a real address is itself
    ["/hr/outpass-visitors/outpass/overview/qr-submissions", "/hr/outpass-visitors/outpass/overview/qr-submissions"],
    ["/hr/outpass-visitors/outpass/requests", "/hr/outpass-visitors/outpass/requests"],
    ["/hr/outpass-visitors/outpass/in-out", "/hr/outpass-visitors/outpass/in-out"],
    ["/hr/outpass-visitors/tea-break/rule", "/hr/outpass-visitors/tea-break/rule"],
    // the capital letters the router ignores are written the one way
    ["/hr/outpass-visitors/Outpass/Requests", "/hr/outpass-visitors/outpass/requests"],
  ];

  it.each(table)("%s -> %s", (from, to) => {
    expect(resolveGatePath(from)).toBe(to);
  });

  it("is idempotent: where a redirect lands is where it stays", () => {
    for (const [, to] of table) expect(resolveGatePath(to), to).toBe(to);
  });

  it("drops a trailing slash before looking, so the page itself is not a redirect", () => {
    expect(cleanGatePath("/hr/outpass-visitors/visitors/")).toBe("/hr/outpass-visitors/visitors");
    expect(resolveGatePath(cleanGatePath("/hr/outpass-visitors/visitors/"))).toBe("/hr/outpass-visitors/visitors");
  });
});

describe("the pages and tabs a role may see (Account Management -> Roles & Permissions)", () => {
  const hiding =
    (...hidden: string[]) =>
    (key: string) =>
      !hidden.some((h) => key === h || key.startsWith(`${h}.`));

  it("names each page and tab by its permission key", () => {
    expect(gateKey("outpass")).toBe("outpass_visitors.outpass");
    expect(gateKey("tea-break", "rule")).toBe("outpass_visitors.tea_break.rule");
    expect(gateKey("outpass", "in-out")).toBe("outpass_visitors.outpass.in_out");
    expect(gateKey("outpass", "overview", "qr-submissions")).toBe("outpass_visitors.outpass.overview.qr_submissions");
  });

  it("lands on the first page, tab and section the role may see", () => {
    const noOutpass = hiding("outpass_visitors.outpass");
    expect(resolveGatePath("/hr/outpass-visitors", noOutpass)).toBe("/hr/outpass-visitors/visitors");
    expect(resolveGatePath("/hr/outpass-visitors/nope", noOutpass)).toBe("/hr/outpass-visitors/visitors");
    const noOverview = hiding("outpass_visitors.outpass.overview");
    expect(resolveGatePath("/hr/outpass-visitors/outpass", noOverview)).toBe("/hr/outpass-visitors/outpass/requests");
    const noPasses = hiding("outpass_visitors.outpass.overview.passes");
    expect(resolveGatePath("/hr/outpass-visitors/outpass", noPasses)).toBe(
      "/hr/outpass-visitors/outpass/overview/qr-submissions",
    );
    expect(resolveGatePath("/hr/outpass-visitors/tea-break", hiding("outpass_visitors.tea_break.records"))).toBe(
      "/hr/outpass-visitors/tea-break/rule",
    );
  });

  it("stops at a level the role may see nothing of (the page says so), and stays there", () => {
    const noTabs = hiding("outpass_visitors.tea_break.records", "outpass_visitors.tea_break.rule");
    expect(resolveGatePath("/hr/outpass-visitors/tea-break/records", noTabs)).toBe("/hr/outpass-visitors/tea-break");
    expect(resolveGatePath("/hr/outpass-visitors/tea-break", noTabs)).toBe("/hr/outpass-visitors/tea-break");
    const noSections = hiding(
      "outpass_visitors.outpass.overview.passes",
      "outpass_visitors.outpass.overview.qr_submissions",
    );
    expect(resolveGatePath("/hr/outpass-visitors/outpass", noSections)).toBe("/hr/outpass-visitors/outpass/overview");
    expect(resolveGatePath("/hr/outpass-visitors/outpass/overview", noSections)).toBe(
      "/hr/outpass-visitors/outpass/overview",
    );
  });

  it("keeps a page named in the address (the route guard decides about it), and changes nothing when all may be seen", () => {
    const noOutpass = hiding("outpass_visitors.outpass");
    expect(resolveGatePath("/hr/outpass-visitors/visitors", noOutpass)).toBe("/hr/outpass-visitors/visitors");
    expect(resolveGatePath("/hr/outpass-visitors", () => true)).toBe("/hr/outpass-visitors/outpass/overview/passes");
  });
});
