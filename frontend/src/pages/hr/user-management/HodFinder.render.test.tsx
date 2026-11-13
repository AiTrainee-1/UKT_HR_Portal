import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { renderMdPage, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import { ManagerAssignmentLookup } from "@/components/ManagerAssignmentLookup";

// HOD Assignment's finder (components/ManagerAssignmentLookup.tsx): its two pills, Find user and Unassigned staff, follow
// their own permission keys (user_management.hod.find_user / .unassigned; each follows HOD Assignment while unset).

const MANAGERS = [
  {
    id: 1,
    employeeId: 11,
    employeeName: "Asha Kumar",
    employeeCode: "E11",
    department: "Stitching",
    employeeCount: 1,
    assignedEmployeeIds: [21],
    isActive: true,
  },
];
const EMPLOYEES = [
  { id: 21, firstName: "Ravi", lastName: "Nair", employeeCode: "E21", departmentName: "Stitching" },
  { id: 22, firstName: "Meena", lastName: "Das", employeeCode: "E22", departmentName: "Cutting" },
];

let page: RenderedPage | undefined;
afterEach(() => {
  page?.unmount();
  page = undefined;
});

async function open(permissions: Record<string, string>) {
  page = await renderMdPage(
    () => <ManagerAssignmentLookup managers={MANAGERS} listSearch="" onListSearchChange={() => {}} />,
    {
      "/api/auth/me": { role: "hr", employeeId: null, name: "Test HR", isSuperAdmin: false, permissions },
      "/api/employees": EMPLOYEES,
    },
    { path: "/hr/user-management" },
  );
}

const pills = () =>
  [...page!.container.querySelectorAll<HTMLElement>('[role="tab"] .ptab-label')].map((l) => l.textContent?.trim());
const pill = (name: string) =>
  [...page!.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) =>
    b.querySelector(".ptab-label")?.textContent?.includes(name),
  );

describe("HOD Assignment's finder pills", () => {
  it("offers both to a role that never set them", async () => {
    await open({ user_management: "edit" });
    expect(pills()).toEqual(["Find user", "Unassigned staff"]);
  });

  it("does not offer a hidden pill, and opens on the one that is left", async () => {
    await open({ user_management: "edit", "user_management.hod.find_user": "hidden" });
    // (the pill carries the number waiting: one staff member has no HOD)
    expect(pills()).toEqual(["Unassigned staff(1)"]);
    expect(page!.text()).toContain("active staff have no department head yet");
  });

  it("draws nothing when neither pill is open", async () => {
    await open({
      user_management: "edit",
      "user_management.hod.find_user": "hidden",
      "user_management.hod.unassigned": "hidden",
    });
    expect(page!.container.textContent).toBe("");
  });

  it("marks a View-only pill and locks its HOD picker", async () => {
    await open({ user_management: "edit", "user_management.hod.unassigned": "view" });
    expect(page!.container.querySelector('[data-testid="hod-finder-view-only"]')).toBeNull();
    const unassigned = pill("Unassigned staff");
    expect(unassigned).toBeDefined();
    await act(async () => unassigned!.click());
    await page!.settle();
    expect(page!.container.querySelector('[data-testid="hod-finder-view-only"]')).not.toBeNull();
    const picker = [...page!.container.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      b.textContent?.includes("Assign to HOD"),
    );
    expect(picker?.disabled).toBe(true);
  });
});
