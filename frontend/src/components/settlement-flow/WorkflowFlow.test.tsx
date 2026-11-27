// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import WorkflowFlow, { historyLabel, type FlowFacts, type FlowStep } from "./WorkflowFlow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
function render(ui: ReactElement): HTMLDivElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(ui));
  return host;
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});
const byId = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);

const KEYS: [string, string][] = [
  ["received", "Employee Requests Received"],
  ["hr_review", "HR Review"],
  ["md_review", "MD Review & Approval"],
  ["md_changes", "HR Rework (MD Changes)"],
  ["hr_final", "HR Final Settlement"],
  ["auditor_send", "Send to Auditor"],
  ["auditor_review", "Auditor Review"],
  ["auditor_changes", "HR Rework (Auditor Changes)"],
  ["accounts_send", "Send Bank File to Accounts"],
  ["completed", "Settlement Workflow Completed"],
];

const steps = (states: Record<string, FlowStep["state"]>, cycles: Record<string, number> = {}): FlowStep[] =>
  KEYS.map(([key, label]) => ({
    key,
    label,
    state: states[key] ?? "pending",
    at: null,
    by: null,
    action: states[key] === "current" ? "Do the next thing." : null,
    loop: key.endsWith("_changes"),
    cycles: key.endsWith("_changes") ? (cycles[key] ?? 0) : null,
  }));

const flow = (over: Partial<FlowFacts> = {}): FlowFacts => ({
  mdRound: 1,
  auditorRound: 1,
  mdCycles: 0,
  auditorCycles: 0,
  mdPath: null,
  accountsVia: null,
  mdReturn: null,
  ...over,
});

describe("WorkflowFlow", () => {
  it("while HR reworks the first return, the loop is returned once and not yet resubmitted", () => {
    const el = render(
      <WorkflowFlow
        steps={steps(
          { received: "done", hr_review: "done", md_review: "done", md_changes: "current" },
          { md_changes: 1 },
        )}
        flow={flow({ mdCycles: 1 })}
        received={2}
      />,
    );
    const loop = byId(el, "tracker-step-md_changes")!;
    expect(loop.getAttribute("data-state")).toBe("current");
    expect(el.textContent).toContain("Returned once");
    expect(el.textContent).not.toContain("Resubmitted");
    expect(loop.textContent).toContain("Rework now");
  });

  it("after the resubmission the loop reads returned and resubmitted once; the direct path is drawn as taken", () => {
    const el = render(
      <WorkflowFlow
        steps={steps(
          {
            received: "done",
            hr_review: "done",
            md_review: "done",
            md_changes: "done",
            hr_final: "skipped",
            auditor_send: "current",
            auditor_changes: "pending",
          },
          { md_changes: 1 },
        )}
        flow={flow({ mdCycles: 1, mdRound: 2, mdPath: "direct" })}
        received={2}
      />,
    );
    expect(el.textContent).toContain("Returned once");
    expect(el.textContent).toContain("Resubmitted once");
    expect(byId(el, "flow-direct-path")!.getAttribute("data-taken")).toBe("yes");
    expect(byId(el, "flow-chip-md-cycles")!.textContent).toBe("MD rework cycles: 1");
    expect(byId(el, "tracker-next-action")!.textContent).toContain("Do the next thing.");
  });

  it("words the history of the cycles", () => {
    expect(historyLabel({ at: "", by: "", action: "md_returned", round: 1 }).text).toBe(
      "MD returned it to HR for rework (round 1)",
    );
    expect(historyLabel({ at: "", by: "", action: "auditor_resubmitted", round: 2 })).toEqual({
      text: "HR resubmitted it to the auditor (round 2)",
      tone: "send",
    });
    expect(historyLabel({ at: "", by: "", action: "md_confirmed", direct: true }).text).toBe(
      "MD approved it and sent it directly to the auditor",
    );
  });
});
