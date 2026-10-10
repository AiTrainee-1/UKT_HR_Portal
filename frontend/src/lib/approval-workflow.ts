// Approval pipelines as the UI works with them: who is responsible for each step, in what order, and which edits are
// allowed. The rules live in backend/api/approval_workflow.py (which decides every real request); this is its twin for
// the Approval Workflow Control page and for the screens that explain where a request is, and both are tested against
// the same worked examples.
//
// A pipeline is 1 or 2 steps (HR and the Department Head are the only approver roles, and a role can sit in only one
// step). A step's responsible role is HOD, HR, or "HOD or HR" (whoever acts first, only as the single step). A step is
// MANDATORY (cannot be skipped) or optional (the next step's role may decide first). The last step is always mandatory.

export type ApprovalRole = "hod" | "hr";
export type StepChoice = ApprovalRole | "either";

export type ApprovalStep = {
  roles: ApprovalRole[];
  mandatory: boolean;
  /** Set by the server ("HOD", "HR", "HOD or HR"); the UI recomputes it from `roles` when it edits. */
  label?: string;
};

export const MAX_STEPS = 2;
export const ROLE_LABEL: Record<ApprovalRole, string> = { hod: "HOD", hr: "HR" };
export const ROLE_LONG: Record<ApprovalRole, string> = { hod: "Department Head (HOD)", hr: "HR" };
export const CHOICE_LABEL: Record<StepChoice, string> = {
  hod: "HOD",
  hr: "HR",
  either: "HOD or HR (whoever acts first)",
};

export const stepLabel = (step: ApprovalStep): string => step.roles.map((r) => ROLE_LABEL[r]).join(" or ");

/** What the step's responsible-role selector shows. */
export function choiceOf(step: ApprovalStep): StepChoice {
  return step.roles.length > 1 ? "either" : step.roles[0];
}

export function stepFromChoice(choice: StepChoice, mandatory = true): ApprovalStep {
  const roles: ApprovalRole[] = choice === "either" ? ["hod", "hr"] : [choice];
  return { roles, mandatory, label: roles.map((r) => ROLE_LABEL[r]).join(" or ") };
}

/** 'Employee → HOD → HR' (or 'HR → HOD' for a request HR starts). */
export function pipelineText(requestedBy: string, steps: ApprovalStep[]): string {
  return [requestedBy, ...steps.map(stepLabel)].join(" → ");
}

export function stepsEqual(a: ApprovalStep[], b: ApprovalStep[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((s, i) => {
    const t = b[i];
    // the last step is always mandatory whatever the flag says, so it never makes two pipelines differ
    const same = i === a.length - 1 ? true : s.mandatory === t.mandatory;
    return same && s.roles.length === t.roles.length && s.roles.every((r) => t.roles.includes(r));
  });
}

/** The last step can never be skipped (there is nothing after it to skip it), so it is always stored as mandatory. */
export function normalise(steps: ApprovalStep[]): ApprovalStep[] {
  return steps.map((s, i) => ({
    roles: [...s.roles],
    mandatory: i === steps.length - 1 ? true : s.mandatory,
    label: stepLabel(s),
  }));
}

const usedElsewhere = (steps: ApprovalStep[], index: number): Set<ApprovalRole> =>
  new Set(steps.flatMap((s, i) => (i === index ? [] : s.roles)));

/** Which roles the step at `index` may be given: those the workflow allows and no other step already holds; "HOD or HR"
 *  only when it is the only step and the workflow allows both. */
export function availableChoices(allowedRoles: ApprovalRole[], steps: ApprovalStep[], index: number): StepChoice[] {
  const taken = usedElsewhere(steps, index);
  const free = allowedRoles.filter((r) => !taken.has(r));
  const choices: StepChoice[] = [...free];
  if (steps.length === 1 && allowedRoles.length > 1) choices.push("either");
  return choices;
}

export function canAddStep(allowedRoles: ApprovalRole[], steps: ApprovalStep[]): boolean {
  if (steps.length >= MAX_STEPS) return false;
  if (steps.some((s) => s.roles.length > 1)) return false;
  return allowedRoles.some((r) => !steps.some((s) => s.roles.includes(r)));
}

/** A new last step held by the role no step holds yet (mandatory). The step that was last keeps its own flag. */
export function addStep(allowedRoles: ApprovalRole[], steps: ApprovalStep[]): ApprovalStep[] {
  if (!canAddStep(allowedRoles, steps)) return steps;
  const role = allowedRoles.find((r) => !steps.some((s) => s.roles.includes(r)))!;
  return normalise([...steps, stepFromChoice(role, true)]);
}

export function removeStep(steps: ApprovalStep[], index: number): ApprovalStep[] {
  if (steps.length <= 1) return steps;
  return normalise(steps.filter((_, i) => i !== index));
}

export function moveStep(steps: ApprovalStep[], index: number, direction: -1 | 1): ApprovalStep[] {
  const target = index + direction;
  if (target < 0 || target >= steps.length) return steps;
  const next = [...steps];
  [next[index], next[target]] = [next[target], next[index]];
  return normalise(next);
}

export function setStepChoice(steps: ApprovalStep[], index: number, choice: StepChoice): ApprovalStep[] {
  const next = steps.map((s, i) => (i === index ? stepFromChoice(choice, s.mandatory) : s));
  return normalise(next);
}

export function setStepMandatory(steps: ApprovalStep[], index: number, mandatory: boolean): ApprovalStep[] {
  return normalise(steps.map((s, i) => (i === index ? { ...s, mandatory } : s)));
}

/** Twin of the server's step check: the message to show, or null when the steps are a valid pipeline. */
export function validateSteps(allowedRoles: ApprovalRole[], steps: ApprovalStep[]): string | null {
  if (steps.length === 0) return "A pipeline needs at least one step.";
  if (steps.length > MAX_STEPS) return `A pipeline can have at most ${MAX_STEPS} steps.`;
  const seen = new Set<ApprovalRole>();
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    if (step.roles.length === 0) return `Step ${i + 1} needs a responsible role.`;
    if (step.roles.length > 1 && steps.length > 1) return "'HOD or HR' can only be used when it is the only step.";
    for (const role of step.roles) {
      if (!allowedRoles.includes(role)) return `${ROLE_LONG[role]} cannot be responsible for this approval.`;
      if (seen.has(role)) return `${ROLE_LONG[role]} appears in more than one step.`;
      seen.add(role);
    }
  }
  return null;
}

// ── a request's own progress (the `approval` block every request now carries) ──

export type ApprovalStepState = "approved" | "skipped" | "pending" | "waiting" | "rejected";

export type ApprovalProgressStep = ApprovalStep & {
  index: number;
  state: ApprovalStepState;
  by?: string | null;
  at?: string | null;
  comment?: string | null;
  decidedBy?: ApprovalRole;
};

export type ApprovalProgress = {
  workflow: string;
  label: string;
  enabled: boolean;
  steps: ApprovalProgressStep[];
  /** Index of the step the request is at while it is pending, else null. */
  currentStep: number | null;
  waitingFor: ApprovalRole[];
  /** Whether that role could decide the request right now under the pipeline (not counting who the individual HOD is). */
  canAct: Record<ApprovalRole, boolean>;
  /** Whether that role could reject it right now: canAct, plus a rejection allowed out of turn (a resignation's HR).
   *  An older backend does not send it. */
  canReject?: Record<ApprovalRole, boolean>;
};

// Requests a screen shows but does not let its user decide. The Managing Director's copies of the Leave, Requests and
// Outpass pages (components/md/embedded) switch this on: the MD only views those requests (the server refuses the MD's
// decision calls: permission_registry.MD_VIEW_ONLY), so the pages must not offer Approve / Reject. Every HR page asks
// hrCanAct / hrCanReject before it draws those buttons, which is why one switch here is enough and no HR page changes.
// Off (null) everywhere else, including the whole HR portal.
let viewOnlyWorkflows: ReadonlySet<string> | null = null;

/** Hide the decision buttons for these workflows ("leave", "permission", "outpass"...); null or [] shows them again. */
export function setViewOnlyWorkflows(workflows: readonly string[] | null): void {
  viewOnlyWorkflows = workflows && workflows.length > 0 ? new Set(workflows) : null;
}

/** A request with no approval progress is one an older backend sent, or an outpass raised at the gate: while the switch is
 *  on it counts as view-only too, because there is no telling which workflow it belongs to. */
const viewOnly = (approval: ApprovalProgress | null | undefined): boolean =>
  viewOnlyWorkflows !== null && (!approval || viewOnlyWorkflows.has(approval.workflow));

/** Can HR act on this request? Uses the pipeline when the server sent it, and the older status rule when it did not
 *  (an older backend), so a screen never loses its buttons because of a rolling deploy. */
export function hrCanAct(approval: ApprovalProgress | null | undefined, fallback: boolean): boolean {
  if (viewOnly(approval)) return false;
  return approval ? approval.canAct.hr : fallback;
}

export function hodCanAct(approval: ApprovalProgress | null | undefined, fallback: boolean): boolean {
  return approval ? approval.canAct.hod : fallback;
}

export function hrCanReject(approval: ApprovalProgress | null | undefined, fallback: boolean): boolean {
  if (viewOnly(approval)) return false;
  return approval ? (approval.canReject?.hr ?? approval.canAct.hr) : fallback;
}

export function hodCanReject(approval: ApprovalProgress | null | undefined, fallback: boolean): boolean {
  return approval ? (approval.canReject?.hod ?? approval.canAct.hod) : fallback;
}

/** The steps that would still be waiting for a decision after `role` approves this request. Same rule as the server's
 *  step check: a step is done once a role of that step approved, or when it is optional and a later step is done. */
export function remainingAfter(approval: ApprovalProgress, role: ApprovalRole): ApprovalProgressStep[] {
  const approved = new Set<ApprovalRole>([role]);
  for (const step of approval.steps) if (step.state === "approved" && step.decidedBy) approved.add(step.decidedBy);
  const steps = approval.steps;
  const done = steps.map((s) => s.roles.some((r) => approved.has(r)));
  for (let i = steps.length - 2; i >= 0; i -= 1) if (!done[i] && !steps[i].mandatory && done[i + 1]) done[i] = true;
  return steps.filter((_, i) => !done[i]);
}

/** Would this role's approval finish the request (nothing left to wait for after it)? */
export function wouldFinish(approval: ApprovalProgress, role: ApprovalRole): boolean {
  return remainingAfter(approval, role).length === 0;
}

/** A waiting request needs more than the plain 'Pending' chip when it has more than one step or HR is not who decides it. */
export function explainsWaiting(approval: ApprovalProgress | null | undefined): boolean {
  if (!approval || approval.currentStep === null) return false;
  return approval.steps.length > 1 || !approval.canAct.hr;
}

/** 'HOD approved by Suresh · Waiting for HR' for a list row: what has been decided so far and what is next; null while
 *  nobody has decided anything (the status chip already says who it waits for). */
export function trailLine(approval: ApprovalProgress | null | undefined): string | null {
  if (!approval) return null;
  const decided: string[] = [];
  for (const step of approval.steps) {
    const who = step.by ? ` by ${step.by}` : "";
    if (step.state === "approved") decided.push(`${stepLabel(step)} approved${who}`);
    else if (step.state === "rejected") decided.push(`${stepLabel(step)} rejected${who}`);
    else if (step.state === "skipped") decided.push(`${stepLabel(step)} skipped`);
  }
  if (decided.length === 0) return null;
  const next = waitingText(approval);
  return [...decided, ...(next ? [next] : [])].join(" · ");
}

/** 'Waiting for HOD', 'Waiting for HR', 'Waiting for HOD or HR' - or null when the request is not waiting. */
export function waitingText(approval: ApprovalProgress | null | undefined): string | null {
  if (!approval || approval.currentStep === null || approval.waitingFor.length === 0) return null;
  return `Waiting for ${approval.waitingFor.map((r) => ROLE_LABEL[r]).join(" or ")}`;
}
