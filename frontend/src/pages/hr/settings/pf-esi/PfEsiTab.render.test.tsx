import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderMdPage, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import type { PfEsiRule, PfEsiSettings } from "@/lib/api-client/custom-hooks";
import PfEsiTab from "../PfEsiTab";
import { PF_ESI_SETTINGS, PF_ESI_SUB_TAB_OF } from "../PfEsiTab.meta";

// jsdom render checks of Settings -> PF & ESI with a small in-memory copy of the server (backend/api/pf_esi_views.py): the
// four lists, the explanation and its live example, adding / editing / deleting rules, the checks that mirror the server's,
// the exact request a save sends, a refused save shown on its row, a stale copy, the scope picker (global / a unit's own
// rules / reset to global) and the read-only look for every login that is not the Super Admin.

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }), toast }));

const rule = (id: string, over: Partial<PfEsiRule> = {}): PfEsiRule => ({
  id,
  label: "PF below 25,000",
  basis: "basic",
  minAmount: 0,
  maxAmount: 25_000,
  ratePercent: 12,
  ...over,
});

type Lists = Pick<PfEsiSettings, "staff" | "production">;

const GLOBAL: Lists = {
  staff: {
    pfRules: [rule("s1")],
    esiRules: [rule("s2", { label: "ESI below 30,000", maxAmount: 30_000, ratePercent: 0.75 })],
  },
  production: {
    pfRules: [rule("p1", { label: "Production PF", basis: "total", maxAmount: 0 })],
    esiRules: [],
  },
};

const BASIS_OPTIONS = [
  { value: "basic", label: "Basic salary", description: "The Basic component of the employee's salary split." },
  { value: "first_portion", label: "Basic + DA + Retaining Allowance", description: "The whole first 50% portion." },
  { value: "total", label: "Full monthly salary", description: "The employee's whole monthly salary." },
] as const;

type Reply = { status: number; body: unknown };

/**
 * The server in a few lines: one list of rules for everybody, an optional own set per branch, a version that changes with the
 * content, ids for new rules, the stale-version check, and a hook to refuse the next save.
 */
function makeServer(options: { canEdit?: boolean; ownBranch?: number | null; noBranches?: boolean } = {}) {
  const server = {
    global: structuredClone(GLOBAL) as Lists,
    branches: [
      { id: 1, name: "Unit 1", override: null as Lists | null },
      { id: 2, name: "Unit 2", override: structuredClone(GLOBAL) as Lists | null },
    ],
    canEdit: options.canEdit ?? true,
    /** A non-super-admin login sees its own branch's rules. */
    ownBranch: options.ownBranch ?? null,
    puts: [] as Record<string, unknown>[],
    deletes: [] as string[],
    gets: [] as string[],
    refuseNext: null as Reply | null,
    nextId: 100,
    down: false,
  };
  const versionOf = (lists: Lists) =>
    `v${JSON.stringify(lists).length}-${JSON.stringify(lists)
      .split("")
      .reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)}`;
  const listsFor = (branchId: number | null): Lists => {
    if (branchId === null) return server.global;
    return server.branches.find((b) => b.id === branchId)?.override ?? server.global;
  };
  const payload = (branchId: number | null): PfEsiSettings => {
    const branch = server.branches.find((b) => b.id === branchId);
    const lists = listsFor(branchId);
    return {
      scope: { branchId, branchName: branch?.name ?? null, isOverride: !!branch?.override },
      canEdit: server.canEdit,
      version: versionOf(lists),
      staff: structuredClone(lists.staff),
      production: structuredClone(lists.production),
      branches: server.canEdit
        ? server.branches.map((b) => ({ id: b.id, name: b.name, hasOverride: !!b.override }))
        : [],
      basisOptions: [...BASIS_OPTIONS],
      limits: { maxRulesPerList: 50, maxAmount: 99_999_999.99, maxRatePercent: 100 },
    };
  };
  if (options.noBranches) server.branches.length = 0;
  const handler = (params: URLSearchParams, init?: RequestInit) => {
    if (server.down) return { status: 500, body: { error: "boom" } };
    const method = init?.method ?? "GET";
    if (method === "GET") {
      server.gets.push(params.toString());
      const raw = params.get("branchId");
      const branchId = server.canEdit ? (raw ? Number(raw) : null) : server.ownBranch;
      if (branchId !== null && !server.branches.some((b) => b.id === branchId)) {
        return { status: 404, body: { error: "No such branch" } };
      }
      return payload(branchId);
    }
    if (!server.canEdit)
      return {
        status: 403,
        body: { error: "permission_denied", message: "Only the Super Admin can change PF / ESI rules." },
      };
    if (method === "DELETE") {
      const id = Number(params.get("branchId"));
      server.deletes.push(String(id));
      const branch = server.branches.find((b) => b.id === id);
      if (branch) branch.override = null;
      return payload(id);
    }
    const body = JSON.parse(String(init?.body)) as {
      branchId: number | null;
      expectedVersion: string;
      staff?: { pfRules?: PfEsiRule[]; esiRules?: PfEsiRule[] };
      production?: { pfRules?: PfEsiRule[]; esiRules?: PfEsiRule[] };
    };
    server.puts.push(body);
    if (server.refuseNext) {
      const reply = server.refuseNext;
      server.refuseNext = null;
      return reply;
    }
    const branchId = body.branchId ?? null;
    if (body.expectedVersion !== versionOf(listsFor(branchId))) {
      return {
        status: 409,
        body: {
          error: "stale_version",
          message: "These rules were changed by someone else since you opened them.",
          currentVersion: "x",
        },
      };
    }
    const next = structuredClone(listsFor(branchId));
    const give = (list: PfEsiRule[]) =>
      list.map((r) => ({ ...r, id: r.id || `id-${server.nextId++}`, label: r.label || "Rule" }));
    for (const cls of ["staff", "production"] as const) {
      for (const kind of ["pfRules", "esiRules"] as const) {
        const sent = body[cls]?.[kind];
        if (sent) next[cls][kind] = give(sent);
      }
    }
    if (branchId === null) server.global = next;
    else server.branches.find((b) => b.id === branchId)!.override = next;
    return payload(branchId);
  };
  return { server, handler };
}

let page: RenderedPage | undefined;
let server: ReturnType<typeof makeServer>["server"];

beforeEach(() => {
  toast.mockClear();
  window.history.replaceState(null, "", "/hr/settings?tab=pf_esi");
});
afterEach(() => {
  page?.unmount();
  page = undefined;
  window.history.replaceState(null, "", "/");
});

async function open(
  options: {
    canEdit?: boolean;
    ownBranch?: number | null;
    noBranches?: boolean;
    readOnly?: boolean;
    hash?: string;
  } = {},
) {
  const made = makeServer(options);
  server = made.server;
  if (options.hash) window.history.replaceState(null, "", `/hr/settings?tab=pf_esi#${options.hash}`);
  page = await renderMdPage(
    () => <PfEsiTab readOnly={options.readOnly} />,
    {
      "/api/auth/me": {
        role: "hr",
        employeeId: null,
        name: "Test HR",
        isSuperAdmin: options.canEdit !== false,
        permissions: {},
      },
      "/api/pf-esi-settings": made.handler,
    },
    { path: "/hr/settings?tab=pf_esi" },
  );
  return page;
}

const q = (selector: string) => document.body.querySelector<HTMLElement>(selector);
const qa = (selector: string) => [...document.body.querySelectorAll<HTMLElement>(selector)];
const text = (selector: string) => (q(selector)?.textContent ?? "").replace(/\s+/g, " ");
const aria = (label: string) => `[aria-label="${label}"]`;
const value = (selector: string) => (q(selector) as HTMLInputElement | HTMLSelectElement).value;
const buttonNamed = (name: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name);
const tabNamed = (name: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (b) => b.querySelector(".ptab-label")?.textContent?.trim() === name,
  );
const saveButton = () => buttonNamed("Save PF & ESI Rules")!;

async function press(name: string) {
  const b = buttonNamed(name);
  if (!b) throw new Error(`no button "${name}"`);
  await act(async () => b.click());
  await page!.settle();
}
async function openSubTab(name: string) {
  const b = tabNamed(name);
  if (!b) throw new Error(`no sub-tab "${name}"`);
  await act(async () => b.click());
  await page!.settle();
}
async function choose(selector: string, next: string) {
  await act(async () => {
    const select = q(selector) as HTMLSelectElement;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, next);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page!.settle();
}
async function confirmSave() {
  await press("Save PF & ESI Rules");
  await page!.click('[data-testid="confirm-pf-esi-confirm"]');
}

describe("Settings -> PF & ESI: what it shows", () => {
  it("draws the scope block, the Staff page with its explanation and both lists, from the saved rules", async () => {
    await open();
    expect(q('[data-testid="pf-esi-readonly"]')).toBeNull();
    expect(text('[data-setting-id="pf-esi-scope"]')).toContain("Whose rules these are");
    expect(tabNamed("Staff")?.getAttribute("aria-selected")).toBe("true");
    expect(tabNamed("Production")?.getAttribute("aria-selected")).toBe("false");
    // the settings the page has, and each says what it is for
    expect(qa("[data-setting-id]").map((e) => e.getAttribute("data-setting-id"))).toEqual([
      "pf-esi-scope",
      "staff-pf-esi-how",
      "staff-pf-rules",
      "staff-esi-rules",
    ]);
    for (const block of qa("[data-setting-id]")) {
      expect(block.querySelector('[data-testid="setting-purpose"]')?.textContent?.length).toBeGreaterThan(25);
    }
    // the rules as saved
    expect(qa('[data-testid="rule-row"][data-list="staff.pfRules"]')).toHaveLength(1);
    expect(qa('[data-testid="rule-row"][data-list="staff.esiRules"]')).toHaveLength(1);
    expect(value(aria("Staff PF rule 1: name"))).toBe("PF below 25,000");
    expect(value(aria("Staff PF rule 1: range based on"))).toBe("basic");
    expect(value(aria("Staff PF rule 1: from amount"))).toBe("0");
    expect(value(aria("Staff PF rule 1: to amount"))).toBe("25000");
    expect(value(aria("Staff PF rule 1: percentage"))).toBe("12");
    expect(value(aria("Staff ESI rule 1: percentage"))).toBe("0.75");
    // the basis options and their words come from the server
    const options = [...(q(aria("Staff PF rule 1: range based on")) as HTMLSelectElement).options].map((o) => o.text);
    expect(options).toEqual(["Basic salary", "Basic + DA + Retaining Allowance", "Full monthly salary"]);
    expect(text('[data-testid="rules-staff-pf-legend"]')).toContain("The employee's whole monthly salary.");
    expect(text('[data-testid="rules-staff-pf-legend"]')).toContain("To = 0 means there is no upper limit");
    // saved: no Save dock changes yet
    expect(q('[data-testid="save-bar"]')?.getAttribute("data-dirty")).toBe("false");
    expect(saveButton().disabled).toBe(true);
  });

  it("says in plain words who is subject to the rules, how the amount is worked out and what no match means", async () => {
    await open();
    const how = text('[data-testid="pf-esi-how-staff"]');
    expect(how).toContain("Only employees switched ON in Employees - Co Emp are subject to these rules");
    expect(how).toContain("Basic + DA + Retaining Allowance");
    expect(how).toContain("first 50% portion");
    expect(how).toContain("first one whose range fits applies");
    expect(how).toContain("When no rule fits, nothing is deducted");
    expect(q('[data-testid="pf-esi-how-staff"] a')?.getAttribute("href")).toBe("/hr/employees");
    expect(text('[data-setting-id="staff-pf-esi-how"]')).toContain("not switched ON in Co Emp pays no PF or ESI");
  });

  it("works the live example from the rules on screen: a 30,000 salary, Basic 5,000, PF 12% of 15,000", async () => {
    await open();
    const example = "pf-esi-example-staff";
    expect(text(`[data-testid="${example}"]`)).toContain("automatic 50% split");
    expect(text(`[data-testid="${example}-amounts"]`)).toContain("Basic ₹5,000.00");
    expect(text(`[data-testid="${example}-amounts"]`)).toContain("Basic + DA + Retaining ₹15,000.00");
    expect(text(`[data-testid="${example}-pf"]`)).toContain('rule 1 "PF below 25,000" fits');
    expect(text(`[data-testid="${example}-pf"]`)).toContain("12% of ₹15,000.00 = ₹1,800.00");
    expect(text(`[data-testid="${example}-esi"]`)).toContain("0.75% of ₹15,000.00 = ₹112.50");
    expect(text(`[data-testid="${example}-total"]`)).toContain("₹1,912.50");

    // it follows the percentage being typed ...
    await page!.type(aria("Staff PF rule 1: percentage"), "10");
    expect(text(`[data-testid="${example}-pf"]`)).toContain("10% of ₹15,000.00 = ₹1,500.00");
    // ... and the salary being tried: a Basic above the range matches no rule
    await page!.type("#staff-example-salary", "150006");
    expect(text(`[data-testid="${example}-pf"]`)).toContain("no PF rule fits this amount");
    expect(text(`[data-testid="${example}-pf"]`)).toContain("no PF");
    // the top of the range is included
    await page!.type("#staff-example-salary", "150000");
    expect(text(`[data-testid="${example}-pf"]`)).toContain('rule 1 "PF below 25,000" fits - Basic salary ₹25,000.00');
    // days paid prorate the first portion
    await page!.type("#staff-example-days", "13");
    expect(text(`[data-testid="${example}-pf"]`)).toContain("10% of ₹37,500.00");
    // nothing here was saved
    expect(server.puts).toHaveLength(0);
  });

  it("leaves a rule with a problem out of the example, and says so", async () => {
    await open();
    await page!.type(aria("Staff PF rule 1: percentage"), "");
    const example = "pf-esi-example-staff";
    expect(text(`[data-testid="${example}"]`)).toContain("1 left out of this example");
    expect(text(`[data-testid="${example}-pf"]`)).toContain("there are no PF rules");
  });

  it("shows the Production page with its own explanation and a pay-cycle example", async () => {
    await open();
    await openSubTab("Production");
    expect(tabNamed("Production")?.getAttribute("aria-selected")).toBe("true");
    expect(qa("[data-setting-id]").map((e) => e.getAttribute("data-setting-id"))).toEqual([
      "pf-esi-scope",
      "prod-pf-esi-how",
      "prod-pf-rules",
      "prod-esi-rules",
    ]);
    expect(value(aria("Production PF rule 1: range based on"))).toBe("total");
    expect(text('[data-testid="rules-production-esi-empty"]')).toContain("No ESI rules: nobody pays ESI.");
    expect(text('[data-testid="pf-esi-how-production"]')).toContain("x 4 on Weekly, x 2 on BiWeekly, x 1 on Monthly");
    // 7,500 a week is a monthly estimate of 30,000 (the rule is on the full monthly salary, 0 = no limit)
    const example = "pf-esi-example-production";
    expect(text(`[data-testid="${example}"]`)).toContain("monthly estimate of ₹30,000.00");
    expect(text(`[data-testid="${example}-pf"]`)).toContain(
      'rule 1 "Production PF" fits - Full monthly salary ₹30,000.00',
    );
    expect(text(`[data-testid="${example}-pf"]`)).toContain("12% of ₹3,750.00 = ₹450.00");
    expect(text(`[data-testid="${example}-esi"]`)).toContain("there are no ESI rules");
    await choose("#prod-example-cycle", "monthly");
    expect(text(`[data-testid="${example}"]`)).toContain("monthly estimate of ₹7,500.00");
    expect(text(`[data-testid="${example}-pf"]`)).toContain("12% of ₹3,750.00 = ₹450.00");
  });

  it("opens the page that holds the setting named in the address", async () => {
    await open({ hash: "prod-esi-rules" });
    expect(tabNamed("Production")?.getAttribute("aria-selected")).toBe("true");
    expect(q('[data-setting-id="prod-esi-rules"]')).not.toBeNull();
    expect(PF_ESI_SUB_TAB_OF["prod-esi-rules"]).toBe("production");
  });

  it("has a search entry for every setting it draws, with the same title and section", async () => {
    await open();
    const ids = [...PF_ESI_SETTINGS.map((m) => m.id)];
    expect(ids).toEqual([
      "pf-esi-scope",
      "staff-pf-esi-how",
      "staff-pf-rules",
      "staff-esi-rules",
      "prod-pf-esi-how",
      "prod-pf-rules",
      "prod-esi-rules",
    ]);
    for (const meta of PF_ESI_SETTINGS.filter((m) => m.id.startsWith("staff") || m.id === "pf-esi-scope")) {
      expect(text(`[data-setting-id="${meta.id}"] h4`)).toBe(meta.title);
    }
  });
});

describe("Settings -> PF & ESI: adding, editing and deleting rules", () => {
  it("adds a rule starting where the last one ends, and the Save bar wants the percentage first", async () => {
    await open();
    await page!.click('[data-testid="rules-staff-pf-add"]');
    expect(qa('[data-testid="rule-row"][data-list="staff.pfRules"]')).toHaveLength(2);
    expect(value(aria("Staff PF rule 2: from amount"))).toBe("25000.01");
    expect(value(aria("Staff PF rule 2: to amount"))).toBe("0");
    expect(text('[data-testid="staff-pf-1-no-limit"]')).toBe("No limit");
    expect((q(aria("Staff PF rule 2: name")) as HTMLInputElement).placeholder).toBe("Rule 2");
    expect(text('[data-testid="staff-pf-1-rate-error"]')).toBe("Enter the percentage.");
    expect(saveButton().disabled).toBe(true);
    expect(text('[data-testid="save-bar"]')).toContain("Fix this first: Staff PF rule 2: Enter the percentage.");
    expect(q('[data-testid="pf-esi-attention"]')?.textContent).toContain("Needs attention: Staff");

    await page!.type(aria("Staff PF rule 2: percentage"), "8");
    expect(q('[data-testid="staff-pf-1-rate-error"]')).toBeNull();
    expect(q('[data-testid="pf-esi-attention"]')).toBeNull();
    expect(saveButton().disabled).toBe(false);
    expect(q('[data-testid="save-bar"]')?.getAttribute("data-dirty")).toBe("true");
    expect(text('[data-testid="rules-staff-pf-words"]')).toContain(
      "Rule 2: Basic salary ₹25,000.01 and above pays 8% PF.",
    );
  });

  it("shows an overlap on the later rule's From box, naming the other rule, and blocks the save", async () => {
    await open();
    await page!.click('[data-testid="rules-staff-pf-add"]');
    await page!.type(aria("Staff PF rule 2: from amount"), "20000");
    await page!.type(aria("Staff PF rule 2: percentage"), "8");
    expect(text('[data-testid="staff-pf-1-from-error"]')).toBe(
      'Overlaps rule 1 ("PF below 25,000"): it covers up to ₹25,000 and this rule covers ₹20,000 and above. Ranges in one list must not overlap.',
    );
    expect(q(aria("Staff PF rule 2: from amount"))?.getAttribute("aria-invalid")).toBe("true");
    expect(q('[data-testid="staff-pf-0-from-error"]')).toBeNull();
    expect(saveButton().disabled).toBe(true);
    // the same range on another basis does not overlap
    await choose(aria("Staff PF rule 2: range based on"), "total");
    expect(q('[data-testid="staff-pf-1-from-error"]')).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it("checks To against From, the percentage against 0-100 and the decimals, on each box", async () => {
    await open();
    await page!.type(aria("Staff PF rule 1: from amount"), "30000");
    expect(text('[data-testid="staff-pf-0-to-error"]')).toBe("Must be 0 (no upper limit) or at least the From amount.");
    await page!.type(aria("Staff PF rule 1: to amount"), "0");
    expect(q('[data-testid="staff-pf-0-to-error"]')).toBeNull();
    expect(text('[data-testid="staff-pf-0-no-limit"]')).toBe("No limit");
    await page!.type(aria("Staff PF rule 1: percentage"), "101");
    expect(text('[data-testid="staff-pf-0-rate-error"]')).toBe("Must be from 0 to 100.");
    await page!.type(aria("Staff PF rule 1: percentage"), "12.345");
    expect(text('[data-testid="staff-pf-0-rate-error"]')).toBe("Use at most 2 decimals.");
    await page!.type(aria("Staff PF rule 1: from amount"), "1.234");
    expect(text('[data-testid="staff-pf-0-from-error"]')).toBe("Use at most 2 decimals.");
    expect(saveButton().disabled).toBe(true);
  });

  it("asks before deleting a rule, and the delete is only a draft until Save", async () => {
    await open();
    await page!.click(aria("Delete Staff ESI rule 1"));
    const dialog = q('[data-testid="confirm-delete-rule-dialog"]')!;
    expect(dialog.textContent).toContain("Delete Staff ESI rule 1?");
    expect(dialog.textContent).toContain('"ESI below 30,000": Basic salary up to ₹30,000 → 0.75%');
    expect(dialog.textContent).toContain("saved only when you press Save PF & ESI Rules");
    // keeping it changes nothing
    await press("Keep the rule");
    expect(qa('[data-testid="rule-row"][data-list="staff.esiRules"]')).toHaveLength(1);
    expect(server.puts).toHaveLength(0);

    await page!.click(aria("Delete Staff ESI rule 1"));
    await page!.click('[data-testid="confirm-delete-rule"]');
    expect(qa('[data-testid="rule-row"][data-list="staff.esiRules"]')).toHaveLength(0);
    expect(text('[data-testid="rules-staff-esi-empty"]')).toContain("No ESI rules: nobody pays ESI.");
    expect(server.puts).toHaveLength(0);
    expect(saveButton().disabled).toBe(false);
  });
});

describe("Settings -> PF & ESI: saving", () => {
  it("asks first, listing what changes, then sends only the lists that changed with the version it loaded", async () => {
    await open();
    await page!.click('[data-testid="rules-staff-pf-add"]');
    await page!.type(aria("Staff PF rule 2: name"), "Over 25,000");
    await page!.type(aria("Staff PF rule 2: percentage"), "8");
    await press("Save PF & ESI Rules");
    const dialog = q('[data-testid="confirm-pf-esi"]')!;
    expect(dialog.textContent).toContain("Save these PF & ESI rules?");
    expect(dialog.textContent).toContain("Staff PF rule 2");
    expect(dialog.textContent).toContain('"Over 25,000": Basic salary ₹25,000.01 and above → 8%');
    expect(dialog.textContent).toContain("every unit that has no rule set of its own");
    expect(dialog.textContent).toContain("employees switched ON in Co Emp only");
    expect(server.puts).toHaveLength(0);

    await page!.click('[data-testid="confirm-pf-esi-confirm"]');
    expect(server.puts).toHaveLength(1);
    const body = server.puts[0] as { branchId: unknown; expectedVersion: string; staff: { pfRules: unknown[] } };
    expect(Object.keys(body).sort()).toEqual(["branchId", "expectedVersion", "staff"]);
    expect(body.branchId).toBeNull();
    expect(body.expectedVersion).toMatch(/^v\d+-\d+$/);
    expect(Object.keys(body.staff)).toEqual(["pfRules"]);
    expect(body.staff.pfRules).toEqual([
      { id: "s1", label: "PF below 25,000", basis: "basic", minAmount: 0, maxAmount: 25_000, ratePercent: 12 },
      { label: "Over 25,000", basis: "basic", minAmount: 25_000.01, maxAmount: 0, ratePercent: 8 },
    ]);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "PF & ESI rules saved" }));
    // the form now holds what the server answered (the new rule has its id) and is clean again
    expect(q('[data-testid="save-bar"]')?.getAttribute("data-dirty")).toBe("false");
    expect(qa('[data-testid="rule-row"][data-list="staff.pfRules"]').map((r) => r.getAttribute("data-saved"))).toEqual([
      "true",
      "true",
    ]);
    expect(saveButton().disabled).toBe(true);
  });

  it("sends nothing when the question is cancelled, and keeps the edits", async () => {
    await open();
    await page!.type(aria("Staff PF rule 1: percentage"), "11");
    await press("Save PF & ESI Rules");
    await press("Cancel");
    expect(server.puts).toHaveLength(0);
    expect(value(aria("Staff PF rule 1: percentage"))).toBe("11");
    expect(q('[data-testid="save-bar"]')?.getAttribute("data-dirty")).toBe("true");
  });

  it("saves a Production change and a Staff change in one request, each list whole", async () => {
    await open();
    await page!.type(aria("Staff ESI rule 1: percentage"), "1");
    await openSubTab("Production");
    await page!.click('[data-testid="rules-production-esi-add"]');
    await page!.type(aria("Production ESI rule 1: percentage"), "0.75");
    await confirmSave();
    expect(server.puts).toHaveLength(1);
    const body = server.puts[0] as { staff: Record<string, unknown>; production: Record<string, unknown> };
    expect(Object.keys(body.staff)).toEqual(["esiRules"]);
    expect(Object.keys(body.production)).toEqual(["esiRules"]);
    expect(server.global.production.esiRules).toHaveLength(1);
    expect(server.global.staff.esiRules[0].ratePercent).toBe(1);
  });

  it("Discard puts the saved rules back", async () => {
    await open();
    await page!.type(aria("Staff PF rule 1: percentage"), "9");
    await press("Discard changes");
    expect(value(aria("Staff PF rule 1: percentage"))).toBe("12");
    expect(q('[data-testid="save-bar"]')?.getAttribute("data-dirty")).toBe("false");
  });

  it("shows the server's refusal on the row and the box it names, and moves to the page that holds it", async () => {
    await open();
    await openSubTab("Production");
    await page!.click('[data-testid="rules-production-pf-add"]');
    await page!.type(aria("Production PF rule 2: percentage"), "5");
    await page!.type(aria("Production PF rule 2: from amount"), "100");
    await choose(aria("Production PF rule 2: range based on"), "basic");
    await openSubTab("Staff");
    server.refuseNext = {
      status: 400,
      body: {
        error: "Production PF rule 2: Maximum amount must be 0 (no upper limit) or at least the minimum amount.",
        list: "production.pfRules",
        ruleIndex: 1,
        field: "maxAmount",
      },
    };
    await confirmSave();
    expect(server.puts).toHaveLength(1);
    // it opened Production and put the sentence under the box
    expect(tabNamed("Production")?.getAttribute("aria-selected")).toBe("true");
    expect(text('[data-testid="production-pf-1-to-error"]')).toContain("Maximum amount must be 0");
    expect(text('[data-testid="pf-esi-save-error"]')).toContain("Production PF rule 2");
    expect(saveButton().disabled).toBe(true);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" }));
    // changing anything clears the server's word (the checks of the screen speak again)
    await page!.type(aria("Production PF rule 2: percentage"), "6");
    expect(q('[data-testid="production-pf-1-to-error"]')).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it("says when somebody else saved first, keeps the edits, and reloads only after asking", async () => {
    await open();
    await page!.type(aria("Staff PF rule 1: percentage"), "9");
    // somebody else saves meanwhile
    server.global.staff.pfRules[0] = { ...server.global.staff.pfRules[0], ratePercent: 13 };
    await confirmSave();
    const error = text('[data-testid="pf-esi-save-error"]');
    expect(error).toContain("Someone else saved these rules while you were editing");
    expect(value(aria("Staff PF rule 1: percentage"))).toBe("9");

    await page!.click('[data-testid="pf-esi-reload"]');
    expect(q('[data-testid="pf-esi-reload-confirm"]')?.textContent).toContain("Reload and drop your edits?");
    await press("Keep editing");
    expect(value(aria("Staff PF rule 1: percentage"))).toBe("9");

    await page!.click('[data-testid="pf-esi-reload"]');
    await page!.click('[data-testid="pf-esi-reload-confirm-yes"]');
    expect(value(aria("Staff PF rule 1: percentage"))).toBe("13");
    expect(q('[data-testid="pf-esi-save-error"]')).toBeNull();
    expect(q('[data-testid="save-bar"]')?.getAttribute("data-dirty")).toBe("false");

    // the next save is made on the new version and goes through
    await page!.type(aria("Staff PF rule 1: percentage"), "14");
    await confirmSave();
    expect(server.puts).toHaveLength(2);
    expect(server.global.staff.pfRules[0].ratePercent).toBe(14);
  });

  it("explains a refusal that is not about a rule, in the server's words", async () => {
    await open();
    await page!.type(aria("Staff PF rule 1: percentage"), "9");
    server.refuseNext = {
      status: 403,
      body: { error: "permission_denied", message: "Only the Super Admin can change PF / ESI rules." },
    };
    await confirmSave();
    expect(text('[data-testid="pf-esi-save-error"]')).toContain("Only the Super Admin can change PF / ESI rules.");
  });
});

describe("Settings -> PF & ESI: whose rules", () => {
  it("offers all units and every unit to the Super Admin, with a badge on the ones that have rules of their own", async () => {
    await open();
    const picker = q('[data-testid="pf-esi-scope-picker"]')!;
    expect(
      [...picker.querySelectorAll('[role="radio"]')].map((b) => b.textContent?.replace(/\s+/g, " ").trim()),
    ).toEqual(["All units (global)", "Unit 1", "Unit 2own rules"]);
    expect(q('[data-testid="pf-esi-scope-global"]')?.getAttribute("aria-checked")).toBe("true");
    expect(q('[data-testid="pf-esi-own-badge-2"]')).not.toBeNull();
    expect(q('[data-testid="pf-esi-own-badge-1"]')).toBeNull();
    expect(text('[data-testid="pf-esi-global-notice"]')).toContain(
      "apply to every unit that has no rule set of its own",
    );
  });

  it("says a unit follows the global rules, and that saving creates its own set; the save is made for that unit", async () => {
    await open();
    await page!.click('[data-testid="pf-esi-scope-1"]');
    expect(server.gets).toContain("branchId=1");
    expect(q('[data-testid="pf-esi-scope-1"]')?.getAttribute("aria-checked")).toBe("true");
    expect(text('[data-testid="pf-esi-inherit-notice"]')).toBe(
      "Unit 1 is following global rules - saving creates this branch's own rule set.",
    );
    expect(q('[data-testid="pf-esi-reset"]')).toBeNull();
    expect(value(aria("Staff PF rule 1: percentage"))).toBe("12");

    await page!.type(aria("Staff PF rule 1: percentage"), "10");
    await press("Save PF & ESI Rules");
    expect(q('[data-testid="confirm-pf-esi"]')?.textContent).toContain("This creates Unit 1's own rule set");
    await page!.click('[data-testid="confirm-pf-esi-confirm"]');
    const body = server.puts[0] as { branchId: number };
    expect(body.branchId).toBe(1);
    expect(server.branches[0].override?.staff.pfRules[0].ratePercent).toBe(10);
    expect(server.global.staff.pfRules[0].ratePercent).toBe(12);
    // now it has its own rules: the badge, the notice and Reset to global
    expect(q('[data-testid="pf-esi-own-badge-1"]')).not.toBeNull();
    expect(text('[data-testid="pf-esi-own-notice"]')).toContain("Unit 1 has its own rule set");
    expect(q('[data-testid="pf-esi-reset"]')).not.toBeNull();
  });

  it("resets a unit with its own rules to global only after asking, and then shows the global rules", async () => {
    await open();
    await page!.click('[data-testid="pf-esi-scope-2"]');
    expect(q('[data-testid="pf-esi-reset"]')).not.toBeNull();
    server.branches[1].override!.staff.pfRules[0].ratePercent = 7;
    await page!.click('[data-testid="pf-esi-scope-1"]');
    await page!.click('[data-testid="pf-esi-scope-2"]');
    expect(value(aria("Staff PF rule 1: percentage"))).toBe("7");

    await page!.click('[data-testid="pf-esi-reset"]');
    const dialog = q('[data-testid="pf-esi-reset-confirm"]')!;
    expect(dialog.textContent).toContain("Reset Unit 2 to the all-units rules?");
    expect(dialog.textContent).toContain("This cannot be undone");
    expect(server.deletes).toHaveLength(0);
    await press("Keep its own rules");
    expect(server.deletes).toHaveLength(0);

    await page!.click('[data-testid="pf-esi-reset"]');
    await page!.click('[data-testid="pf-esi-reset-confirm-yes"]');
    expect(server.deletes).toEqual(["2"]);
    expect(server.branches[1].override).toBeNull();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Unit 2 follows the all-units rules again" }));
    expect(q('[data-testid="pf-esi-own-badge-2"]')).toBeNull();
    expect(q('[data-testid="pf-esi-inherit-notice"]')).not.toBeNull();
    expect(value(aria("Staff PF rule 1: percentage"))).toBe("12");
  });

  it("asks before switching scope while there are unsaved edits, and keeps them if told to", async () => {
    await open();
    await page!.type(aria("Staff PF rule 1: percentage"), "9");
    await page!.click('[data-testid="pf-esi-scope-1"]');
    expect(q('[data-testid="pf-esi-switch-confirm"]')?.textContent).toContain("Switch to another set of rules?");
    expect(server.gets.filter((g) => g === "branchId=1")).toHaveLength(0);
    await press("Keep editing");
    expect(value(aria("Staff PF rule 1: percentage"))).toBe("9");
    expect(q('[data-testid="pf-esi-scope-global"]')?.getAttribute("aria-checked")).toBe("true");

    await page!.click('[data-testid="pf-esi-scope-1"]');
    await page!.click('[data-testid="pf-esi-switch-confirm-yes"]');
    expect(server.gets).toContain("branchId=1");
    expect(q('[data-testid="pf-esi-scope-1"]')?.getAttribute("aria-checked")).toBe("true");
    expect(value(aria("Staff PF rule 1: percentage"))).toBe("12");
  });

  it("does not offer a picker when there are no units, and says it edits the all-units rules", async () => {
    await open({ noBranches: true });
    expect(q('[data-testid="pf-esi-scope-picker"]')).toBeNull();
    expect(text('[data-testid="pf-esi-scope-text"]')).toBe(
      "You are editing the all-units rules. They apply to every unit and show in every login.",
    );
    // it still saves the global rules
    await page!.type(aria("Staff PF rule 1: percentage"), "9");
    await confirmSave();
    expect((server.puts[0] as { branchId: unknown }).branchId).toBeNull();
  });
});

describe("Settings -> PF & ESI: for every login that is not the Super Admin", () => {
  it("shows the rules of its unit read-only, with the banner, no picker, no Save and no way to change a rule", async () => {
    await open({ canEdit: false, ownBranch: 2 });
    expect(text('[data-testid="pf-esi-readonly"]')).toBe(
      "Only the Super Admin can change PF/ESI rules. Showing the rules that apply to your unit.",
    );
    expect(q('[data-testid="pf-esi-scope-picker"]')).toBeNull();
    expect(text('[data-testid="pf-esi-scope-text"]')).toContain("Unit 2's own rule set");
    // the rules are there, but nothing can be touched
    expect(value(aria("Staff PF rule 1: percentage"))).toBe("12");
    const boxes = qa("[data-testid='rules-staff-pf'] input, [data-testid='rules-staff-pf'] select");
    expect(boxes.length).toBeGreaterThan(4);
    for (const el of boxes) expect((el as HTMLInputElement).disabled).toBe(true);
    expect(q('[data-testid="rules-staff-pf-add"]')).toBeNull();
    expect(q(aria("Delete Staff PF rule 1"))).toBeNull();
    expect(buttonNamed("Save PF & ESI Rules")).toBeUndefined();
    expect(q('[data-testid="save-footer"]')).toBeNull();
    // the live example still works: it is only an illustration
    expect(text('[data-testid="pf-esi-example-staff-pf"]')).toContain("12% of ₹15,000.00 = ₹1,800.00");
    await page!.type("#staff-example-salary", "200000");
    expect(text('[data-testid="pf-esi-example-staff-pf"]')).toContain("no PF rule fits");
    // and the request never named a unit of its own choosing
    expect(server.gets).toEqual([""]);
    expect(server.puts).toHaveLength(0);
  });

  it("says the all-units rules apply when the login has no unit", async () => {
    await open({ canEdit: false, ownBranch: null });
    expect(text('[data-testid="pf-esi-scope-text"]')).toContain("all-units rules");
  });

  it("is read-only for a view-only role even when the login could edit", async () => {
    await open({ readOnly: true });
    expect(q('[data-testid="pf-esi-readonly"]')).toBeNull();
    expect((q(aria("Staff PF rule 1: percentage")) as HTMLInputElement).disabled).toBe(true);
    expect(buttonNamed("Save PF & ESI Rules")).toBeUndefined();
  });
});

describe("Settings -> PF & ESI: when the rules cannot be read", () => {
  it("shows a retry, and the tab once they can be read", async () => {
    const made = makeServer();
    server = made.server;
    server.down = true;
    page = await renderMdPage(
      () => <PfEsiTab />,
      {
        "/api/auth/me": { role: "hr", employeeId: null, name: "Test HR", isSuperAdmin: true, permissions: {} },
        "/api/pf-esi-settings": made.handler,
      },
      { path: "/hr/settings?tab=pf_esi" },
    );
    expect(q('[data-testid="pf-esi-load-error"]')?.textContent).toContain("The PF & ESI rules could not be loaded.");
    server.down = false;
    await press("Try again");
    expect(q('[data-testid="pf-esi-load-error"]')).toBeNull();
    expect(value(aria("Staff PF rule 1: percentage"))).toBe("12");
  });
});
