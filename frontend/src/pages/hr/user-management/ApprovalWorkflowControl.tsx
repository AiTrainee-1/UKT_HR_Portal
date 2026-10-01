import { Fragment, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  GitBranch,
  Info,
  Lock,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import {
  useApprovalWorkflows,
  useResetApprovalWorkflow,
  useUpdateApprovalWorkflow,
  type ApprovalWorkflowItem,
} from "@/lib/api-client/custom-hooks";
import {
  CHOICE_LABEL,
  addStep,
  availableChoices,
  canAddStep,
  choiceOf,
  moveStep,
  pipelineText,
  removeStep,
  setStepChoice,
  setStepMandatory,
  stepLabel,
  stepsEqual,
  validateSteps,
  type ApprovalRole,
  type ApprovalStep,
} from "@/lib/approval-workflow";

// Approval Workflow Control: every approval in the HRMS with its pipeline (who is responsible for each step and in what
// order), an ON/OFF switch, and an editor. The rules and the storage are in backend/api/approval_workflow.py; the HR portal,
// the Employee Web App, the mobile app and the backend all follow what is saved here. Nobody is assigned on this page:
// which Department Head an employee reports to stays in HOD Assignment.

const ROLE_STYLE: Record<ApprovalRole, string> = {
  hod: "bg-amber-50 text-amber-800 border-amber-200",
  hr: "bg-teal-50 text-teal-800 border-teal-200",
};

function roleStyle(step: ApprovalStep): string {
  if (step.roles.length > 1) return "bg-indigo-50 text-indigo-800 border-indigo-200";
  return ROLE_STYLE[step.roles[0]];
}

function PipelineStrip({
  requestedBy,
  steps,
  testId,
}: {
  requestedBy: string;
  steps: ApprovalStep[];
  testId?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid={testId}>
      <span className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-700">
        {requestedBy}
      </span>
      {steps.map((step, i) => (
        <Fragment key={`${i}-${step.roles.join("")}`}>
          <ArrowRight size={13} className="text-slate-300" aria-hidden />
          <span
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold ${roleStyle(step)} ${
              !step.mandatory && i < steps.length - 1 ? "border-dashed" : ""
            }`}
          >
            {stepLabel(step)}
            <span className="text-[10px] font-medium opacity-70">
              {step.roles.length > 1
                ? "whoever acts first"
                : step.mandatory || i === steps.length - 1
                  ? "mandatory"
                  : "optional"}
            </span>
          </span>
        </Fragment>
      ))}
    </div>
  );
}

type ConfirmKind = "off" | "save" | "reset";

function WorkflowCard({ w }: { w: ApprovalWorkflowItem }) {
  const { toast } = useToast();
  const update = useUpdateApprovalWorkflow();
  const reset = useResetApprovalWorkflow();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ApprovalStep[]>(w.steps);
  // `kind` stays put while the dialog fades out, so its text does not blank before it is gone
  const [confirm, setConfirm] = useState<{ open: boolean; kind: ConfirmKind }>({ open: false, kind: "off" });
  const ask = (kind: ConfirmKind) => setConfirm({ open: true, kind });
  const closeConfirm = () => setConfirm((c) => ({ ...c, open: false }));

  const busy = update.isPending || reset.isPending;
  const problem = editing ? validateSteps(w.allowedRoles, draft) : null;
  const changed = editing && !stepsEqual(draft, w.steps);
  const waiting = w.waiting?.total ?? 0;

  const fail = (title: string, err: unknown) =>
    toast({ title, description: err instanceof Error ? err.message : undefined, variant: "destructive" });

  const startEditing = () => {
    setDraft(w.steps.map((s) => ({ ...s })));
    setEditing(true);
  };

  const saveSteps = async () => {
    try {
      await update.mutateAsync({
        key: w.key,
        data: { steps: draft.map((s) => ({ roles: s.roles, mandatory: s.mandatory })) },
      });
      toast({
        title: `${w.label} pipeline updated`,
        description: waiting > 0 ? `${waiting} request(s) already waiting now follow the new pipeline.` : undefined,
      });
      setEditing(false);
    } catch (err) {
      fail("Could not save the pipeline", err);
    } finally {
      closeConfirm();
    }
  };

  const setEnabled = async (enabled: boolean) => {
    try {
      await update.mutateAsync({ key: w.key, data: { enabled } });
      toast({
        title: enabled ? `${w.label} switched ON` : `${w.label} switched OFF`,
        description: enabled
          ? "New requests are accepted again."
          : "New requests are refused until it is switched back on.",
      });
    } catch (err) {
      fail("Could not change the switch", err);
    } finally {
      closeConfirm();
    }
  };

  const doReset = async () => {
    try {
      await reset.mutateAsync(w.key);
      toast({ title: `${w.label} is back to its built-in pipeline` });
      setEditing(false);
    } catch (err) {
      fail("Could not reset the pipeline", err);
    } finally {
      closeConfirm();
    }
  };

  return (
    <Card className={`border ${w.enabled ? "" : "bg-slate-50/70"}`} data-testid={`wf-card-${w.key}`}>
      <CardContent className="space-y-3 p-4">
        {/* ── title, badges and the ON/OFF switch ── */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-sm font-bold text-gray-900">{w.label}</h4>
              {w.customised && (
                <Badge
                  className="border-blue-200 bg-blue-50 text-[10px] text-blue-700"
                  data-testid={`wf-customised-${w.key}`}
                >
                  Customised
                </Badge>
              )}
              {!w.enabled && (
                <Badge
                  className="border-red-200 bg-red-50 text-[10px] text-red-700"
                  data-testid={`wf-off-badge-${w.key}`}
                >
                  OFF
                </Badge>
              )}
              {!w.editable && (
                <Badge className="border-slate-200 bg-slate-100 text-[10px] text-slate-600">
                  <Lock size={9} className="mr-1" /> Fixed pipeline
                </Badge>
              )}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-gray-500">{w.purpose}</p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <div className="flex items-center gap-2">
              <span className={`text-[11px] font-bold ${w.enabled ? "text-green-700" : "text-red-600"}`}>
                {w.enabled ? "ON" : "OFF"}
              </span>
              <Switch
                aria-label={`Enable or disable ${w.label}`}
                data-testid={`wf-toggle-${w.key}`}
                checked={w.enabled}
                disabled={!w.canDisable || busy}
                onCheckedChange={(on) => (on ? setEnabled(true) : ask("off"))}
              />
            </div>
            {!w.canDisable && <span className="text-[10px] text-gray-400">Follows another workflow</span>}
          </div>
        </div>

        {/* ── the pipeline as it runs today ── */}
        <div className="space-y-1.5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Current approval pipeline</p>
          <PipelineStrip requestedBy={w.requestedBy} steps={w.steps} testId={`wf-path-${w.key}`} />
          <span className="sr-only" data-testid={`wf-path-text-${w.key}`}>
            {w.path}
          </span>
          {w.note && <p className="text-[11px] text-gray-500">{w.note}</p>}
          {w.hints.map((text) => (
            <p
              key={text}
              className="flex items-start gap-1.5 text-[11px] text-gray-500"
              data-testid={`wf-hint-${w.key}`}
            >
              <Info size={11} className="mt-0.5 shrink-0" /> {text}
            </p>
          ))}
          {!w.editable && (
            <p className="flex items-center gap-1 text-[11px] text-slate-500" data-testid={`wf-fixed-${w.key}`}>
              <Lock size={11} /> {w.fixedNote}
            </p>
          )}
        </div>

        {/* ── waiting counts and warnings ── */}
        {waiting > 0 && (
          <p className="text-[11px] text-gray-500" data-testid={`wf-waiting-${w.key}`}>
            {waiting} waiting now &middot; HOD can decide {w.waiting?.hod ?? 0} &middot; HR can decide{" "}
            {w.waiting?.hr ?? 0}
          </p>
        )}
        {w.warnings.length > 0 && (
          <ul className="space-y-1" data-testid={`wf-warnings-${w.key}`}>
            {w.warnings.map((text) => (
              <li key={text} className="flex items-start gap-1.5 text-[11px] text-amber-700">
                <AlertTriangle size={11} className="mt-0.5 shrink-0" /> {text}
              </li>
            ))}
          </ul>
        )}

        {/* ── the editor ── */}
        {editing ? (
          <div
            className="space-y-3 rounded-xl border border-blue-100 bg-blue-50/40 p-3"
            data-testid={`wf-editor-${w.key}`}
          >
            <div className="space-y-2">
              {draft.map((step, i) => {
                const last = i === draft.length - 1;
                return (
                  <div
                    key={i}
                    className="flex flex-wrap items-center gap-2 rounded-lg border bg-white p-2.5"
                    data-testid={`wf-step-${w.key}-${i}`}
                  >
                    <span className="w-14 text-xs font-bold text-gray-500">Step {i + 1}</span>
                    <label className="sr-only" htmlFor={`wf-role-${w.key}-${i}`}>
                      Responsible role for step {i + 1}
                    </label>
                    <select
                      id={`wf-role-${w.key}-${i}`}
                      data-testid={`wf-role-${w.key}-${i}`}
                      className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                      value={choiceOf(step)}
                      onChange={(e) => setDraft((d) => setStepChoice(d, i, e.target.value as ApprovalRole | "either"))}
                    >
                      {availableChoices(w.allowedRoles, draft, i).map((c) => (
                        <option key={c} value={c}>
                          {CHOICE_LABEL[c]}
                        </option>
                      ))}
                    </select>
                    <label className="flex items-center gap-1.5 text-xs text-gray-600">
                      <Switch
                        aria-label={`Step ${i + 1} mandatory`}
                        data-testid={`wf-mandatory-${w.key}-${i}`}
                        checked={step.mandatory || last}
                        disabled={last}
                        onCheckedChange={(v) => setDraft((d) => setStepMandatory(d, i, v))}
                      />
                      Mandatory
                    </label>
                    {last && draft.length > 1 && (
                      <span className="text-[10px] text-gray-400">last step is always mandatory</span>
                    )}
                    <div className="ml-auto flex items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        aria-label={`Move step ${i + 1} up`}
                        data-testid={`wf-up-${w.key}-${i}`}
                        disabled={i === 0}
                        onClick={() => setDraft((d) => moveStep(d, i, -1))}
                      >
                        <ArrowUp size={13} />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        aria-label={`Move step ${i + 1} down`}
                        data-testid={`wf-down-${w.key}-${i}`}
                        disabled={last}
                        onClick={() => setDraft((d) => moveStep(d, i, 1))}
                      >
                        <ArrowDown size={13} />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-red-400 hover:text-red-600"
                        aria-label={`Remove step ${i + 1}`}
                        data-testid={`wf-remove-${w.key}-${i}`}
                        disabled={draft.length <= 1}
                        onClick={() => setDraft((d) => removeStep(d, i))}
                      >
                        <Trash2 size={13} />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5"
                data-testid={`wf-add-${w.key}`}
                disabled={!canAddStep(w.allowedRoles, draft)}
                onClick={() => setDraft((d) => addStep(w.allowedRoles, d))}
              >
                <Plus size={13} /> Add step
              </Button>
              <span className="text-[11px] text-gray-500" data-testid={`wf-preview-${w.key}`}>
                {pipelineText(w.requestedBy, draft)}
              </span>
            </div>

            {problem && (
              <p role="alert" className="text-[11px] font-medium text-red-600" data-testid={`wf-error-${w.key}`}>
                {problem}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                data-testid={`wf-save-${w.key}`}
                disabled={!changed || !!problem || busy}
                onClick={() => (waiting > 0 ? ask("save") : saveSteps())}
              >
                {update.isPending ? "Saving…" : "Save pipeline"}
              </Button>
              <Button size="sm" variant="ghost" data-testid={`wf-cancel-${w.key}`} onClick={() => setEditing(false)}>
                Cancel
              </Button>
              {w.customised && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto gap-1.5 text-gray-500"
                  data-testid={`wf-reset-${w.key}`}
                  disabled={busy}
                  onClick={() => ask("reset")}
                >
                  <RotateCcw size={12} /> Restore the built-in pipeline
                </Button>
              )}
            </div>
            <p className="text-[11px] text-gray-500">
              A mandatory step cannot be skipped. An optional step can be skipped when the next step's role decides
              first. Requests already waiting follow the new pipeline from where they are.
            </p>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {w.editable && (
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                data-testid={`wf-edit-${w.key}`}
                onClick={startEditing}
              >
                <GitBranch size={13} /> Edit pipeline
              </Button>
            )}
            {w.customised && w.editable && (
              <Button
                size="sm"
                variant="ghost"
                className="gap-1.5 text-gray-500"
                data-testid={`wf-reset-${w.key}`}
                disabled={busy}
                onClick={() => ask("reset")}
              >
                <RotateCcw size={12} /> Restore the built-in pipeline
              </Button>
            )}
            {w.updatedBy && w.updatedAt && (
              <span className="ml-auto text-[10px] text-gray-400">
                Last changed by {w.updatedBy} &middot; {new Date(w.updatedAt).toLocaleString()}
              </span>
            )}
          </div>
        )}

        {/* ── confirmations ── */}
        <AlertDialog open={confirm.open} onOpenChange={(o) => !o && closeConfirm()}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {confirm.kind === "off" && `Switch off ${w.label}?`}
                {confirm.kind === "save" && `Apply the new ${w.label} pipeline?`}
                {confirm.kind === "reset" && `Put ${w.label} back to its built-in pipeline?`}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {confirm.kind === "off" && w.onOffEffect}
                {confirm.kind === "save" &&
                  `${waiting} request(s) are waiting right now. They will follow the new pipeline from where they are: nothing is approved or rejected by this change.`}
                {confirm.kind === "reset" &&
                  `The pipeline goes back to ${pipelineText(w.requestedBy, w.defaultSteps)} and the workflow is switched on.`}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                data-testid={`wf-confirm-${w.key}`}
                onClick={() =>
                  confirm.kind === "off" ? setEnabled(false) : confirm.kind === "save" ? saveSteps() : doReset()
                }
              >
                {confirm.kind === "off" ? "Switch off" : confirm.kind === "save" ? "Apply" : "Reset"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}

export default function ApprovalWorkflowControl() {
  const { data, isLoading, isError } = useApprovalWorkflows();

  const groups = useMemo(() => {
    const order: string[] = [];
    const byGroup = new Map<string, ApprovalWorkflowItem[]>();
    for (const w of data?.workflows ?? []) {
      if (!byGroup.has(w.group)) {
        byGroup.set(w.group, []);
        order.push(w.group);
      }
      byGroup.get(w.group)!.push(w);
    }
    return order.map((name) => ({ name, items: byGroup.get(name)! }));
  }, [data]);

  return (
    <div className="space-y-6" data-testid="approval-workflow-control">
      <div className="flex gap-3 rounded-2xl border border-blue-100 bg-blue-50/60 p-4">
        <Info size={16} className="mt-0.5 shrink-0 text-blue-500" />
        <div className="space-y-1.5 text-xs leading-relaxed text-gray-600">
          <p className="font-bold text-blue-700">One place for how every request is approved</p>
          <p>
            Each approval below has a pipeline: who is responsible for each step and in what order. What you set here is
            followed by the HR portal, the Employee Web App, the mobile app and the backend alike, so a request can
            never be approved one way on one screen and another way on another. Nothing is assigned here: which
            Department Head an employee reports to is set in <strong>HOD Assignment</strong>.
          </p>
          <ul className="list-disc space-y-0.5 pl-4">
            <li>
              <strong>HOD</strong> is the employee's own Department Head. <strong>HOD or HR</strong> means whoever acts
              first decides it.
            </li>
            <li>
              A <strong>mandatory</strong> step cannot be skipped. An <strong>optional</strong> step can be skipped when
              the next step's role decides first.
            </li>
            <li>
              <strong>OFF</strong> stops new requests of that kind; requests already waiting can still be decided.
            </li>
          </ul>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : isError || !data ? (
        <p className="rounded-xl border border-red-100 bg-red-50 p-4 text-sm text-red-700">
          The approval workflows could not be loaded.
        </p>
      ) : (
        groups.map((group) => (
          <section key={group.name} className="space-y-3">
            <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
              <GitBranch size={13} /> {group.name}
            </p>
            <div className="space-y-3">
              {group.items.map((w) => (
                <WorkflowCard key={w.key} w={w} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
