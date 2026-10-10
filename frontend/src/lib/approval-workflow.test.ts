import { afterEach, describe, expect, it } from "vitest";
import {
  addStep,
  availableChoices,
  canAddStep,
  choiceOf,
  explainsWaiting,
  hodCanAct,
  hodCanReject,
  hrCanAct,
  hrCanReject,
  moveStep,
  normalise,
  pipelineText,
  remainingAfter,
  removeStep,
  setStepChoice,
  setStepMandatory,
  setViewOnlyWorkflows,
  stepFromChoice,
  stepsEqual,
  trailLine,
  validateSteps,
  waitingText,
  wouldFinish,
  type ApprovalProgress,
  type ApprovalProgressStep,
  type ApprovalRole,
  type ApprovalStep,
} from "./approval-workflow";

const BOTH: ApprovalRole[] = ["hod", "hr"];
const either = (): ApprovalStep[] => [stepFromChoice("either")];
const hodHr = (): ApprovalStep[] => [stepFromChoice("hod"), stepFromChoice("hr")];

describe("pipeline text and choices", () => {
  it("writes a pipeline the way HR reads it", () => {
    expect(pipelineText("Employee", either())).toBe("Employee → HOD or HR");
    expect(pipelineText("Employee", hodHr())).toBe("Employee → HOD → HR");
    expect(pipelineText("HR", [stepFromChoice("hod")])).toBe("HR → HOD");
  });

  it("maps a step to its selector value and back", () => {
    expect(choiceOf(stepFromChoice("hod"))).toBe("hod");
    expect(choiceOf(stepFromChoice("either"))).toBe("either");
    expect(stepFromChoice("either").roles).toEqual(["hod", "hr"]);
  });

  it("offers only the roles no other step already holds, and 'either' only for a lone step", () => {
    expect(availableChoices(BOTH, either(), 0)).toEqual(["hod", "hr", "either"]);
    expect(availableChoices(BOTH, [stepFromChoice("hod")], 0)).toEqual(["hod", "hr", "either"]);
    expect(availableChoices(BOTH, hodHr(), 0)).toEqual(["hod"]);
    expect(availableChoices(BOTH, hodHr(), 1)).toEqual(["hr"]);
    expect(availableChoices(["hr"], [stepFromChoice("hr")], 0)).toEqual(["hr"]);
    expect(availableChoices(["hod"], [stepFromChoice("hod")], 0)).toEqual(["hod"]);
  });
});

describe("editing steps", () => {
  it("adds the missing role as a new last step, until both roles are in", () => {
    expect(canAddStep(BOTH, [stepFromChoice("hod")])).toBe(true);
    const added = addStep(BOTH, [stepFromChoice("hod")]);
    expect(added.map(choiceOf)).toEqual(["hod", "hr"]);
    expect(canAddStep(BOTH, added)).toBe(false);
    expect(canAddStep(BOTH, either())).toBe(false); // 'HOD or HR' already uses both
    expect(canAddStep(["hr"], [stepFromChoice("hr")])).toBe(false);
    expect(addStep(BOTH, hodHr())).toEqual(hodHr());
  });

  it("removes a step but never the last one", () => {
    expect(removeStep(hodHr(), 0).map(choiceOf)).toEqual(["hr"]);
    expect(removeStep([stepFromChoice("hr")], 0)).toHaveLength(1);
  });

  it("swaps the order (HOD then HR becomes HR then HOD)", () => {
    expect(moveStep(hodHr(), 0, 1).map(choiceOf)).toEqual(["hr", "hod"]);
    expect(moveStep(hodHr(), 1, -1).map(choiceOf)).toEqual(["hr", "hod"]);
    expect(moveStep(hodHr(), 0, -1).map(choiceOf)).toEqual(["hod", "hr"]); // already first
    expect(moveStep(hodHr(), 1, 1).map(choiceOf)).toEqual(["hod", "hr"]); // already last
  });

  it("changes a step's responsible role and its mandatory flag", () => {
    expect(setStepChoice(either(), 0, "hr").map(choiceOf)).toEqual(["hr"]);
    const optional = setStepMandatory(hodHr(), 0, false);
    expect(optional[0].mandatory).toBe(false);
    expect(optional[1].mandatory).toBe(true);
  });

  it("keeps the last step mandatory whatever is asked", () => {
    expect(setStepMandatory(hodHr(), 1, false)[1].mandatory).toBe(true);
    expect(
      normalise([
        { roles: ["hod"], mandatory: false },
        { roles: ["hr"], mandatory: false },
      ])[1].mandatory,
    ).toBe(true);
  });

  it("compares pipelines ignoring the always-mandatory last flag and the label", () => {
    expect(stepsEqual(hodHr(), hodHr())).toBe(true);
    expect(stepsEqual(hodHr(), [stepFromChoice("hr"), stepFromChoice("hod")])).toBe(false);
    expect(stepsEqual(hodHr(), setStepMandatory(hodHr(), 0, false))).toBe(false);
    expect(stepsEqual([{ roles: ["hr"], mandatory: false }], [{ roles: ["hr"], mandatory: true }])).toBe(true);
    expect(stepsEqual(either(), [stepFromChoice("hod")])).toBe(false);
  });
});

describe("validateSteps (the same check the server makes)", () => {
  it("accepts the shapes the page can build", () => {
    for (const steps of [either(), hodHr(), [stepFromChoice("hr"), stepFromChoice("hod")], [stepFromChoice("hod")]]) {
      expect(validateSteps(BOTH, steps)).toBeNull();
    }
  });

  it("refuses what cannot work", () => {
    expect(validateSteps(BOTH, [])).toMatch(/at least one/);
    expect(validateSteps(BOTH, [stepFromChoice("hod"), stepFromChoice("hod")])).toMatch(/more than one step/);
    expect(validateSteps(BOTH, [stepFromChoice("either"), stepFromChoice("hr")])).toMatch(
      /only be used when it is the only step/,
    );
    expect(validateSteps(["hr"], [stepFromChoice("hod")])).toMatch(/cannot be responsible/);
    expect(validateSteps(BOTH, [{ roles: [], mandatory: true }])).toMatch(/needs a responsible role/);
    expect(validateSteps(BOTH, [stepFromChoice("hod"), stepFromChoice("hr"), stepFromChoice("hod")])).toMatch(
      /at most 2/,
    );
  });
});

describe("a request's progress", () => {
  const progress = (over: Partial<ApprovalProgress> = {}): ApprovalProgress => ({
    workflow: "leave",
    label: "Leave",
    enabled: true,
    steps: [],
    currentStep: 0,
    waitingFor: ["hod"],
    canAct: { hod: true, hr: false },
    ...over,
  });

  it("reads who can act from the pipeline, and falls back to the older rule when the server sent none", () => {
    expect(hrCanAct(progress(), true)).toBe(false);
    expect(hodCanAct(progress(), false)).toBe(true);
    expect(hrCanAct(undefined, true)).toBe(true);
    expect(hrCanAct(null, false)).toBe(false);
  });

  it("says who a request is waiting for", () => {
    expect(waitingText(progress())).toBe("Waiting for HOD");
    expect(waitingText(progress({ waitingFor: ["hod", "hr"] }))).toBe("Waiting for HOD or HR");
    expect(waitingText(progress({ currentStep: null, waitingFor: [] }))).toBeNull();
    expect(waitingText(null)).toBeNull();
  });
});

describe("rejecting is told apart from approving", () => {
  const block = (canAct: ApprovalProgress["canAct"], canReject?: ApprovalProgress["canReject"]): ApprovalProgress => ({
    workflow: "resignation",
    label: "Resignation",
    enabled: true,
    steps: [],
    currentStep: 0,
    waitingFor: ["hod"],
    canAct,
    canReject,
  });

  it("uses canReject when the server sent it (a resignation's HR may reject out of turn)", () => {
    const a = block({ hod: true, hr: false }, { hod: true, hr: true });
    expect(hrCanAct(a, false)).toBe(false);
    expect(hrCanReject(a, false)).toBe(true);
    expect(hodCanReject(a, false)).toBe(true);
  });

  it("follows canAct when an older backend sent no canReject, and the fallback when there is no block", () => {
    expect(hrCanReject(block({ hod: true, hr: false }), true)).toBe(false);
    expect(hodCanReject(block({ hod: true, hr: false }), false)).toBe(true);
    expect(hrCanReject(undefined, true)).toBe(true);
    expect(hodCanReject(null, false)).toBe(false);
  });
});

describe("workflows a screen only shows (the Managing Director's view-only requests)", () => {
  const request = (workflow: string): ApprovalProgress => ({
    workflow,
    label: workflow,
    enabled: true,
    steps: [],
    currentStep: 0,
    waitingFor: ["hr"],
    canAct: { hod: false, hr: true },
    canReject: { hod: false, hr: true },
  });

  afterEach(() => setViewOnlyWorkflows(null));

  it("changes nothing until it is switched on", () => {
    expect(hrCanAct(request("leave"), false)).toBe(true);
    expect(hrCanReject(request("leave"), false)).toBe(true);
    expect(hrCanAct(null, true)).toBe(true);
  });

  it("takes the HR buttons away for the listed workflows only", () => {
    setViewOnlyWorkflows(["leave", "permission", "outpass"]);
    for (const w of ["leave", "permission", "outpass"]) {
      expect(hrCanAct(request(w), true), w).toBe(false);
      expect(hrCanReject(request(w), true), w).toBe(false);
    }
    // another workflow keeps its buttons (the on-duty approvals on the Geo page)
    expect(hrCanAct(request("on_duty"), false)).toBe(true);
    expect(hrCanReject(request("on_duty"), false)).toBe(true);
  });

  it("treats a request with no progress as view-only while it is on (an outpass raised at the gate)", () => {
    setViewOnlyWorkflows(["outpass"]);
    expect(hrCanAct(null, true)).toBe(false);
    expect(hrCanReject(undefined, true)).toBe(false);
  });

  it("does not touch the HOD's view, and switching it off puts everything back", () => {
    setViewOnlyWorkflows(["leave"]);
    expect(hodCanAct({ ...request("leave"), canAct: { hod: true, hr: true } }, false)).toBe(true);
    setViewOnlyWorkflows([]);
    expect(hrCanAct(request("leave"), false)).toBe(true);
  });
});

describe("what an approval would do, and how a waiting request reads", () => {
  const step = (
    roles: ApprovalRole[],
    mandatory: boolean,
    state: ApprovalProgressStep["state"],
    extra: Partial<ApprovalProgressStep> = {},
  ): ApprovalProgressStep => ({ roles, mandatory, index: 0, state, label: roles.join(" or "), ...extra });
  const request = (steps: ApprovalProgressStep[], over: Partial<ApprovalProgress> = {}): ApprovalProgress => ({
    workflow: "leave",
    label: "Leave",
    enabled: true,
    steps,
    currentStep: steps.findIndex((s) => s.state === "pending"),
    waitingFor: ["hod"],
    canAct: { hod: true, hr: true },
    ...over,
  });

  it("a lone step is finished by either of its roles", () => {
    const r = request([step(["hod", "hr"], true, "pending")]);
    expect(wouldFinish(r, "hod")).toBe(true);
    expect(wouldFinish(r, "hr")).toBe(true);
  });

  it("the second of two mandatory steps finishes it; the first only passes it on", () => {
    const r = request([step(["hod"], true, "pending"), step(["hr"], true, "waiting")]);
    expect(wouldFinish(r, "hod")).toBe(false);
    expect(wouldFinish(r, "hr")).toBe(false); // the mandatory HOD step cannot be jumped over
    const afterHod = request([step(["hod"], true, "approved", { decidedBy: "hod" }), step(["hr"], true, "pending")]);
    expect(wouldFinish(afterHod, "hr")).toBe(true);
  });

  it("an optional first step is jumped over by the next role, which then finishes it", () => {
    const r = request([step(["hod"], false, "pending"), step(["hr"], true, "waiting")]);
    expect(wouldFinish(r, "hr")).toBe(true);
    expect(wouldFinish(r, "hod")).toBe(false);
  });

  it("lists what would still be waiting after an approval", () => {
    const r = request([step(["hod"], true, "pending"), step(["hr"], true, "waiting")]);
    expect(remainingAfter(r, "hod").map((s) => s.roles)).toEqual([["hr"]]);
    expect(remainingAfter(r, "hr").map((s) => s.roles)).toEqual([["hod"]]); // HR alone cannot finish past a mandatory HOD
    const afterHod = request([step(["hod"], true, "approved", { decidedBy: "hod" }), step(["hr"], true, "pending")]);
    expect(remainingAfter(afterHod, "hr")).toEqual([]);
  });

  it("explains a waiting request only when the plain 'Pending' would not do", () => {
    const single = request([step(["hod", "hr"], true, "pending")]);
    expect(explainsWaiting(single)).toBe(false);
    expect(explainsWaiting({ ...single, canAct: { hod: true, hr: false } })).toBe(true); // HR cannot decide it
    expect(explainsWaiting(request([step(["hod"], true, "pending"), step(["hr"], true, "waiting")]))).toBe(true);
    expect(explainsWaiting({ ...single, currentStep: null, waitingFor: [] })).toBe(false); // decided
    expect(explainsWaiting(null)).toBe(false);
  });

  it("writes one line of who decided and what is next", () => {
    const half = request([step(["hod"], true, "approved", { by: "Suresh" }), step(["hr"], true, "pending")], {
      waitingFor: ["hr"],
    });
    expect(trailLine(half)).toBe("HOD approved by Suresh · Waiting for HR");
    const skipped = request([step(["hod"], false, "skipped"), step(["hr"], true, "approved", { by: "Priya" })], {
      currentStep: null,
      waitingFor: [],
    });
    expect(trailLine(skipped)).toBe("HOD skipped · HR approved by Priya");
    // nothing to add while nobody has decided anything (the chip says who it waits for), or without a block
    expect(trailLine(request([step(["hod", "hr"], true, "pending")], { waitingFor: ["hod", "hr"] }))).toBeNull();
    expect(trailLine(request([step(["hod"], true, "pending"), step(["hr"], true, "waiting")]))).toBeNull();
    expect(trailLine(undefined)).toBeNull();
  });
});
