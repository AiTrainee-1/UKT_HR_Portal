import { afterEach, describe, expect, it } from "vitest";
import { renderMdPage, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import type { ProductionShiftRules } from "@/lib/api-client/custom-hooks";
import { SEEDED } from "@/pages/hr/settings/production-shifts/fixtures";
import ProductionRulesSummary from "./ProductionRulesSummary";

// Manage Shifts -> Production no longer edits the punch times: it shows a short read-only summary of the production shift rules
// and a link to where they are edited.

let page: RenderedPage | undefined;
afterEach(() => {
  page?.unmount();
  page = undefined;
});

const text = (selector: string) =>
  (document.body.querySelector(selector)?.textContent ?? "").replace(/\s+/g, " ").trim();

async function open(rules: unknown) {
  page = await renderMdPage(() => <ProductionRulesSummary />, {
    "/api/auth/me": { role: "hr", employeeId: null, name: "Test HR", isSuperAdmin: true, permissions: {} },
    "/api/production-shift-rules": rules as object,
  });
  return page;
}

describe("Manage Shifts -> Production: the rules summary", () => {
  it("says the rules are on from their date, lists each group and the breaks, and links to Settings", async () => {
    await open(SEEDED);
    expect(text('[data-testid="production-rules-summary-status"]')).toBe(
      "On from 14 Oct 2026. Shifts earned come from these rules, not from this page: grace 5 minutes. Earlier days keep the old calculation.",
    );
    expect(text('[data-testid="production-rules-summary-groups"]')).toBe(
      "Day shift: starts 8:30 AM, standard departure 8:00 PM; 8 rows, up to 3.00 shifts." +
        "Night shift: starts 9:00 PM, standard departure 5:30 AM next day; 2 rows, up to 1.50 shifts." +
        "Sunday shift: starts 8:30 AM, standard departure 5:00 PM; 1 row, up to 1.00 shift.",
    );
    expect(text('[data-testid="production-rules-summary-breaks"]')).toBe(
      "Unpaid breaks: Morning tea 10:30 AM to 10:45 AM, Lunch 12:45 PM to 1:30 PM, Afternoon tea 3:30 PM to 3:45 PM, Evening tea 5:45 PM to 6:00 PM, Night dinner 8:00 PM to 9:00 PM.",
    );
    const link = document.body.querySelector('[data-testid="production-rules-edit-link"]');
    expect(link?.getAttribute("href")).toBe("/hr/settings?tab=production_shifts");
    expect(link?.textContent).toContain("Edit in Settings");
    // it is only a summary: nothing to type into and nothing to save
    expect(document.body.querySelectorAll("input, select, textarea")).toHaveLength(0);
    expect([...document.body.querySelectorAll("button")].map((b) => b.textContent)).toEqual([]);
  });

  it("says when the rules are off, and marks a group that is off", async () => {
    const rules: ProductionShiftRules = {
      ...SEEDED,
      enabled: false,
      groups: [{ ...SEEDED.groups[0], enabled: false }],
      breaks: [],
    };
    await open(rules);
    expect(text('[data-testid="production-rules-summary-status"]')).toContain(
      "Off: every production day uses the old calculation.",
    );
    expect(text('[data-testid="production-rules-summary-groups"]')).toContain("Day shift (off): starts 8:30 AM");
    expect(text('[data-testid="production-rules-summary-breaks"]')).toBe("No unpaid breaks.");
  });

  it("says where to look when the rules cannot be read here, and still links to Settings", async () => {
    await open({ status: 403, body: { error: "permission_denied" } });
    expect(text('[data-testid="production-rules-summary-error"]')).toContain("could not be loaded here");
    expect(document.body.querySelector('[data-testid="production-rules-edit-link"]')).not.toBeNull();
  });
});
