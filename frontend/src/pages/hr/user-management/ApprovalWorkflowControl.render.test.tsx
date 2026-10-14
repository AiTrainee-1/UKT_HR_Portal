import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ApprovalWorkflowItem, ApprovalWorkflowsResponse } from "@/lib/api-client/custom-hooks";
import ApprovalWorkflowControl from "./ApprovalWorkflowControl";

// Approval Workflow Control draws whatever /api/approval-workflows sends. The Holiday / Sunday work compensation workflow
// (key holiday_work) arrives like Attendance correction: HR raises it, only the HOD decides, the pipeline is fixed, and it
// can still be switched off.

const api = vi.hoisted(() => ({
  data: undefined as unknown,
  isLoading: false,
  isError: false,
  update: vi.fn(),
  reset: vi.fn(),
}));

vi.mock("@/lib/api-client/custom-hooks", () => ({
  useApprovalWorkflows: () => ({ data: api.data, isLoading: api.isLoading, isError: api.isError }),
  useUpdateApprovalWorkflow: () => ({ mutateAsync: api.update, isPending: false }),
  useResetApprovalWorkflow: () => ({ mutateAsync: api.reset, isPending: false }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: () => {} }) }));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
});

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  api.data = undefined;
  api.isLoading = false;
  api.isError = false;
  api.update.mockReset();
  api.reset.mockReset();
});

const hodOnly = [{ roles: ["hod" as const], mandatory: true, label: "HOD" }];

const workflow = (over: Partial<ApprovalWorkflowItem>): ApprovalWorkflowItem => ({
  key: "leave",
  label: "Leave",
  group: "Leave & attendance",
  purpose: "An employee asks for leave.",
  requestedBy: "Employee",
  enabled: true,
  steps: [{ roles: ["hod", "hr"], mandatory: true, label: "HOD or HR" }],
  defaultSteps: [{ roles: ["hod", "hr"], mandatory: true, label: "HOD or HR" }],
  customised: false,
  path: "Employee → HOD or HR",
  editable: true,
  canDisable: true,
  allowedRoles: ["hod", "hr"],
  fixedNote: null,
  note: null,
  onOffEffect: "New requests cannot be submitted while it is off; requests already waiting can still be decided.",
  hodSwitch: "Can approve leaves",
  warnings: [],
  hints: ['The Department Head\'s own switch "Can approve leaves" must also be on.'],
  waiting: { total: 0, hod: 0, hr: 0 },
  updatedBy: null,
  updatedAt: null,
  ...over,
});

const ATTENDANCE = workflow({
  key: "attendance_correction",
  label: "Attendance correction",
  purpose: "HR proposes a manual change to an employee's attendance.",
  requestedBy: "HR",
  steps: hodOnly,
  defaultSteps: hodOnly,
  path: "HR → HOD",
  editable: false,
  allowedRoles: ["hod"],
  fixedNote: "HR is the one who asks for the change, so the Department Head is always the approver.",
  hodSwitch: "Can approve attendance",
  hints: ['The Department Head\'s own switch "Can approve attendance" must also be on.'],
  onOffEffect: "HR cannot raise new corrections while it is off; corrections already waiting can still be decided.",
});

const HOLIDAY_WORK = workflow({
  key: "holiday_work",
  label: "Holiday / Sunday work compensation",
  purpose:
    "HR records that a staff member worked on a Sunday or a company holiday and asks for 0.25 to 1 shift of compensation.",
  requestedBy: "HR",
  steps: hodOnly,
  defaultSteps: hodOnly,
  path: "HR → HOD",
  editable: false,
  allowedRoles: ["hod"],
  fixedNote: "HR is the one who raises the claim, so the Department Head always decides it.",
  hodSwitch: "Can approve compensation",
  hints: ['The Department Head\'s own switch "Can approve compensation" must also be on.'],
  onOffEffect: "HR cannot raise new holiday-work claims while it is off; claims already waiting can still be decided.",
  waiting: { total: 2, hod: 2, hr: 0 },
});

const response = (...workflows: ApprovalWorkflowItem[]): ApprovalWorkflowsResponse => ({
  roles: [
    { key: "hod", label: "HOD", long: "Department Head (HOD)" },
    { key: "hr", label: "HR", long: "HR" },
  ],
  maxSteps: 2,
  workflows,
});

function mount(...workflows: ApprovalWorkflowItem[]): HTMLElement {
  api.data = response(...workflows);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(ApprovalWorkflowControl)));
  return host;
}

const byId = (id: string) => document.body.querySelector(`[data-testid="${id}"]`);
const click = (el: Element | null) => act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
/** A click whose handler awaits a request: let the state it sets afterwards settle inside act. */
const clickAndSettle = (el: Element | null) =>
  act(async () => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

describe("the Holiday / Sunday work workflow on Approval Workflow Control", () => {
  it("is a card in the Leave & attendance group, next to Attendance correction", () => {
    const el = mount(workflow({}), ATTENDANCE, HOLIDAY_WORK);
    const cards = Array.from(el.querySelectorAll('[data-testid^="wf-card-"]')).map((c) =>
      c.getAttribute("data-testid"),
    );
    expect(cards).toEqual(["wf-card-leave", "wf-card-attendance_correction", "wf-card-holiday_work"]);
    // one group heading for all three
    const headings = Array.from(el.querySelectorAll("section > p")).map((p) => p.textContent?.trim());
    expect(headings).toEqual(["Leave & attendance"]);
    const card = byId("wf-card-holiday_work")!;
    expect(card.textContent).toContain("Holiday / Sunday work compensation");
    expect(card.textContent).toContain("worked on a Sunday or a company holiday");
  });

  it("shows the path HR → HOD, as a fixed pipeline with its reason and no editor", () => {
    mount(HOLIDAY_WORK);
    const strip = byId("wf-path-holiday_work")!;
    expect(strip.textContent).toContain("HR");
    expect(strip.textContent).toContain("HOD");
    expect(strip.textContent).toContain("mandatory");
    expect(byId("wf-path-text-holiday_work")?.textContent).toBe("HR → HOD");
    expect(byId("wf-card-holiday_work")?.textContent).toContain("Fixed pipeline");
    expect(byId("wf-fixed-holiday_work")?.textContent).toContain("the Department Head always decides it");
    expect(byId("wf-edit-holiday_work")).toBeNull();
    expect(byId("wf-customised-holiday_work")).toBeNull();
  });

  it("tells HR about the Department Head's own 'Can approve compensation' switch", () => {
    mount(HOLIDAY_WORK);
    expect(byId("wf-hint-holiday_work")?.textContent).toContain("Can approve compensation");
    expect(byId("wf-warnings-holiday_work")).toBeNull();
  });

  it("can be switched off (it is not one of the always-on workflows), and says what OFF does first", async () => {
    mount(HOLIDAY_WORK);
    const toggle = byId("wf-toggle-holiday_work") as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(byId("wf-card-holiday_work")?.textContent).toContain("ON");

    click(toggle);
    const dialog = document.body.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain("Switch off Holiday / Sunday work compensation?");
    expect(dialog.textContent).toContain("HR cannot raise new holiday-work claims while it is off");
    expect(api.update).not.toHaveBeenCalled();
    api.update.mockResolvedValue({});
    await clickAndSettle(byId("wf-confirm-holiday_work"));
    expect(api.update).toHaveBeenCalledWith({ key: "holiday_work", data: { enabled: false } });
  });

  it("shows the OFF badge and an unchecked switch when HR has switched it off, and ON needs no confirmation", async () => {
    mount({ ...HOLIDAY_WORK, enabled: false, customised: true });
    expect(byId("wf-off-badge-holiday_work")?.textContent).toBe("OFF");
    expect(byId("wf-customised-holiday_work")).not.toBeNull();
    const toggle = byId("wf-toggle-holiday_work") as HTMLButtonElement;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    api.update.mockResolvedValue({});
    await clickAndSettle(toggle);
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    expect(api.update).toHaveBeenCalledWith({ key: "holiday_work", data: { enabled: true } });
  });

  it("says how many claims are waiting and with whom", () => {
    mount(HOLIDAY_WORK);
    expect(byId("wf-waiting-holiday_work")?.textContent).toBe("2 waiting now · HOD can decide 2 · HR can decide 0");
  });

  it("draws Attendance correction the same way (the pattern the new workflow follows)", () => {
    mount(ATTENDANCE);
    expect(byId("wf-path-text-attendance_correction")?.textContent).toBe("HR → HOD");
    expect(byId("wf-fixed-attendance_correction")).not.toBeNull();
    expect(byId("wf-edit-attendance_correction")).toBeNull();
    expect((byId("wf-toggle-attendance_correction") as HTMLButtonElement).disabled).toBe(false);
  });

  it("a backend that does not know the workflow yet simply has no card for it", () => {
    mount(workflow({}), ATTENDANCE);
    expect(byId("wf-card-holiday_work")).toBeNull();
  });
});
