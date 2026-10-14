import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ApprovalSummaryItem } from "@/lib/api-client/custom-hooks";
import { ApprovalPermissionPicker } from "./ApprovalPermissionPicker";
import { PERM_KEYS, allPermissions, type PermKey } from "./approval-permissions";

// The switches of a Department Head: eight now, the eighth being Compensation (Holiday / Sunday work that HR raises).

const pipelines = vi.hoisted(() => ({ summary: undefined as Record<string, unknown> | undefined }));
vi.mock("@/lib/api-client/custom-hooks", () => ({ useApprovalSummary: () => ({ data: pipelines.summary }) }));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  pipelines.summary = undefined;
});

function mount(props: Partial<Parameters<typeof ApprovalPermissionPicker>[0]> = {}) {
  const onToggle = vi.fn();
  const onSetAll = vi.fn();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      createElement(ApprovalPermissionPicker, { values: allPermissions(true), onToggle, onSetAll, ...props }),
    ),
  );
  return { el: host, onToggle, onSetAll };
}

const click = (el: Element | null) => act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));

const item = (over: Partial<ApprovalSummaryItem>): ApprovalSummaryItem => ({
  label: "Holiday / Sunday work compensation",
  enabled: true,
  requestedBy: "HR",
  steps: [{ roles: ["hod"], mandatory: true }],
  path: "HR → HOD",
  ...over,
});

describe("the approval permissions picker", () => {
  it("draws eight switches, Compensation last, and counts them", () => {
    const { el } = mount();
    const switches = Array.from(el.querySelectorAll('[role="switch"]'));
    expect(switches).toHaveLength(8);
    expect(switches.map((s) => s.getAttribute("data-testid"))).toEqual(PERM_KEYS.map((k) => `perm-${k}`));
    expect(switches[7].getAttribute("data-testid")).toBe("perm-canApproveCompensation");
    expect(el.querySelector('[data-testid="permission-count"]')?.textContent).toBe("8 of 8 switched on");
    const compensation = el.querySelector('[data-testid="perm-canApproveCompensation"]')!;
    expect(compensation.textContent).toContain("Compensation");
    expect(compensation.textContent).toContain("Holiday / Sunday work");
    expect(compensation.getAttribute("aria-checked")).toBe("true");
    expect(compensation.getAttribute("title")).toBe("Disable: Compensation");
  });

  it("shows a switched-off Compensation switch and counts seven", () => {
    const { el } = mount({ values: { ...allPermissions(true), canApproveCompensation: false } });
    expect(el.querySelector('[data-testid="perm-canApproveCompensation"]')?.getAttribute("aria-checked")).toBe("false");
    expect(el.querySelector('[data-testid="perm-canApproveCompensation"]')?.getAttribute("title")).toBe(
      "Enable: Compensation",
    );
    expect(el.querySelector('[data-testid="permission-count"]')?.textContent).toBe("7 of 8 switched on");
  });

  it("toggles the Compensation switch by its key", () => {
    const { el, onToggle } = mount();
    click(el.querySelector('[data-testid="perm-canApproveCompensation"]'));
    expect(onToggle).toHaveBeenCalledWith("canApproveCompensation" satisfies PermKey);
  });

  it("'Disable all' and 'Enable all' cover the new switch too", () => {
    const { el, onSetAll } = mount();
    const buttons = Array.from(el.querySelectorAll("button")).filter((b) => b.getAttribute("role") !== "switch");
    const enableAll = buttons.find((b) => b.textContent === "Enable all") as HTMLButtonElement;
    const disableAll = buttons.find((b) => b.textContent === "Disable all") as HTMLButtonElement;
    expect(enableAll.disabled).toBe(true); // all eight are on
    click(disableAll);
    expect(onSetAll).toHaveBeenCalledWith(false);
  });

  it("says how a Holiday / Sunday work request is routed: HR raises it, the Department Head approves", () => {
    pipelines.summary = { holiday_work: item({}) };
    const { el } = mount();
    expect(el.querySelector('[data-testid="perm-note-canApproveCompensation"]')?.textContent).toBe(
      "HR raises it, the Department Head approves (HR → HOD)",
    );
  });

  it("says when the Holiday / Sunday work approval is switched off, and when the HOD has no step", () => {
    pipelines.summary = { holiday_work: item({ enabled: false }) };
    expect(mount().el.querySelector('[data-testid="perm-note-canApproveCompensation"]')?.textContent).toContain(
      "Switched off in Approval Workflow Control",
    );
    act(() => root!.unmount());
    host!.remove();

    pipelines.summary = { holiday_work: item({ steps: [{ roles: ["hr"], mandatory: true }], path: "HR → HR" }) };
    expect(mount().el.querySelector('[data-testid="perm-note-canApproveCompensation"]')?.textContent).toContain(
      "no step",
    );
  });

  it("disables every switch for a view-only role and marks the one being saved", () => {
    const { el } = mount({ disabled: true });
    expect(Array.from(el.querySelectorAll('[role="switch"]')).every((s) => (s as HTMLButtonElement).disabled)).toBe(
      true,
    );
    act(() => root!.unmount());
    host!.remove();
    const saving = mount({ pendingKey: "canApproveCompensation" }).el;
    expect((saving.querySelector('[data-testid="perm-canApproveCompensation"]') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((saving.querySelector('[data-testid="perm-canApproveLeaves"]') as HTMLButtonElement).disabled).toBe(false);
  });
});
