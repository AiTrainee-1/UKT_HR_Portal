// The MD portal's report library lists the saved custom reports read-only: they open inside /md/reports like any other
// report, and the MD portal has no builder (no Create / Edit / Duplicate / Delete, no /hr/reports/customise links).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeAssistant, setAssistantContext } from "@/lib/md/assistant-store";
import { _resetPrefsCache } from "@/lib/report-prefs";
import MdReports from "@/pages/md/MdReports";
import { renderMdPage, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import { catalogFixture, savedItem } from "./test-fixtures";

let page: RenderedPage | undefined;

beforeEach(() => {
  localStorage.clear();
  _resetPrefsCache();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  page?.unmount();
  page = undefined;
  closeAssistant();
  setAssistantContext(null);
});

describe("saved custom reports in the MD portal", () => {
  it("are listed under Customise, open inside the MD portal, and cannot be built or changed there", async () => {
    const catalog = catalogFixture({ saved: [savedItem()] });
    page = await renderMdPage(MdReports, { "/api/reports/catalog": catalog }, { path: "/md/reports" });

    expect(page.container.querySelector('[data-testid="md-chip-customise"]')?.textContent).toContain("Customise");
    expect(page.container.querySelector('[data-testid="md-category-customise"]')?.textContent).toContain(
      "Monthly Employee Performance Report",
    );
    const hrefs = Array.from(page.container.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? "");
    expect(hrefs).toContain("/md/reports?report=custom-7");
    expect(hrefs.some((h) => h.startsWith("/hr/"))).toBe(false);
    expect(page.text()).not.toContain("Create custom report");
    expect(page.container.querySelector('[data-testid^="delete-"]')).toBeNull();
    // the MD library reads only the catalog: no builder calls
    expect(page.requests().some((r) => r.startsWith("/api/reports/custom"))).toBe(false);
  });
});
