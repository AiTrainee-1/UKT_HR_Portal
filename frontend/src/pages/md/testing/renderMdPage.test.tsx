import { afterEach, describe, expect, it } from "vitest";
import PlaceholderPage from "@/components/md/PlaceholderPage";
import { renderMdPage, type RenderedPage } from "./renderMdPage";

let page: RenderedPage | undefined;
afterEach(() => {
  page?.unmount();
  page = undefined;
});

describe("renderMdPage", () => {
  it("mounts a page inside the shell and shows its content", async () => {
    page = await renderMdPage(() => <PlaceholderPage id="payroll" />, {}, { path: "/md/payroll" });
    expect(page.text()).toContain("Payroll Analysis");
    expect(page.text()).toContain("Test MD"); // the signed-in MD in the sidebar
    expect(page.text()).toContain("Managing Director");
  });

  it("lists the navigation of every MD page", async () => {
    page = await renderMdPage(() => <PlaceholderPage id="dashboard" />, {});
    for (const title of [
      "Dashboard",
      "Attendance",
      "Employees",
      "Outpass & Visitors",
      "Tea Break",
      "Payroll",
      "Reports",
      "Recruitment",
      "Activity Logs",
    ]) {
      expect(page.text()).toContain(title);
    }
  });

  it("fails loudly when the page asks for something with no fixture", async () => {
    const Greedy = () => {
      void fetch("/api/md/nobody-answers-this");
      return <PlaceholderPage id="reports" />;
    };
    await expect(renderMdPage(Greedy, {})).rejects.toThrow(/no fixture/);
  });
});
